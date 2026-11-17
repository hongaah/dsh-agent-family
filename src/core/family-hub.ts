import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { resolveNodeExecutable } from './cli-locator.ts';
import type { MemberRegistry } from './member-registry.ts';
import { composeAwakeningSoul } from './soul-composer.ts';
import type {
  BodyKind,
  FamilyMember,
  FamilyRealtimeEvent,
  MemberActivityState,
  MemberChatEntry,
  MemberRuntimeSnapshot,
  PendingApproval,
  PhoneCallIntent,
  PhoneCallRecord,
  PhoneMcpLaunchSpec,
} from './types.ts';
import type { BodyDriver, LiveMemberSession } from '../drivers/driver.ts';
import type { GroupChatEngine } from './group-chat.ts';
import type { FamilyPhoneBus } from '../phone/phone-bus.ts';

export const MAX_CALL_HOPS = 3;

interface MemberActor {
  readonly scopeId: string;
  readonly memberId: string;
  session: LiveMemberSession | null;
  cwd: string;
  state: MemberActivityState;
  statusText?: string;
  entries: MemberChatEntry[];
  lastActiveAt?: string;
  queueTail: Promise<void>;
  queueLength: number;
  activeAbort: AbortController | null;
  currentTurnCallChain: readonly string[];
  currentTurnGroupHold: string | null;
}

export interface SendMemberMessageInput {
  readonly scopeId: string;
  readonly memberId: string;
  readonly senderRole: 'human' | 'lead' | 'peer' | 'system';
  readonly senderName: string;
  readonly message: string;
  readonly cwd: string;
  readonly fresh?: boolean;
  readonly callChain?: readonly string[];
  readonly activeGroupHold?: string | null;
  readonly recordInFeed?: boolean;
  readonly signal?: AbortSignal;
}

export interface SendMemberMessageResult {
  readonly member: FamilyMember;
  readonly finalText: string;
  readonly phoneCallsDuringTurn: readonly PhoneCallRecord[];
}

export class FamilyHub {
  private readonly registry: MemberRegistry;
  private readonly drivers = new Map<BodyKind, BodyDriver>();
  private readonly actors = new Map<string, MemberActor>();
  private readonly pendingApprovals = new Map<
    string,
    {
      readonly approval: PendingApproval;
      readonly actor: MemberActor;
    }
  >();
  private readonly callRecords: PhoneCallRecord[] = [];
  private readonly listeners = new Set<(event: FamilyRealtimeEvent) => void>();
  private phoneBus: FamilyPhoneBus | null = null;
  private groupEngine: GroupChatEngine | null = null;

  public constructor(options: {
    readonly registry: MemberRegistry;
    readonly drivers: readonly BodyDriver[];
  }) {
    this.registry = options.registry;
    for (const driver of options.drivers) {
      this.drivers.set(driver.kind, driver);
    }
    this.registry.subscribe((members) => {
      this.emit({ type: 'roster_updated', members });
    });
  }

  public getRegistry(): MemberRegistry {
    return this.registry;
  }

  public attachPhoneBus(bus: FamilyPhoneBus): void {
    this.phoneBus = bus;
  }

  public attachGroupEngine(engine: GroupChatEngine): void {
    this.groupEngine = engine;
  }

  public getGroupEngine(): GroupChatEngine | null {
    return this.groupEngine;
  }

  public subscribe(listener: (event: FamilyRealtimeEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  public emit(event: FamilyRealtimeEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }

  public listSnapshots(scopeId?: string): readonly MemberRuntimeSnapshot[] {
    const snapshots: MemberRuntimeSnapshot[] = [];
    for (const actor of this.actors.values()) {
      if (scopeId && actor.scopeId !== scopeId) continue;
      snapshots.push(this.toSnapshot(actor));
    }
    return snapshots;
  }

  public getMemberSnapshot(scopeId: string, memberId: string): MemberRuntimeSnapshot {
    const actor = this.actors.get(this.actorKey(scopeId, memberId));
    if (!actor) {
      return {
        scopeId,
        memberId,
        state: 'sleeping',
        queueLength: 0,
        entries: [],
      };
    }
    return this.toSnapshot(actor);
  }

  public listPendingApprovals(scopeId?: string): readonly PendingApproval[] {
    const list: PendingApproval[] = [];
    for (const entry of this.pendingApprovals.values()) {
      if (scopeId && entry.approval.scopeId !== scopeId) continue;
      list.push(entry.approval);
    }
    return list;
  }

  public listPhoneCallRecords(scopeId?: string): readonly PhoneCallRecord[] {
    const filtered = scopeId
      ? this.callRecords.filter((item) => item.scopeId === scopeId)
      : this.callRecords;
    return [...filtered].slice(-100);
  }

  public async replyApproval(approvalId: string, optionId: string): Promise<boolean> {
    const found = this.pendingApprovals.get(approvalId);
    if (!found) return false;
    this.pendingApprovals.delete(approvalId);
    const { approval, actor } = found;
    if (actor.session?.isAlive()) {
      await actor.session.replyApproval(approval.requestId, optionId);
    }
    if (actor.state === 'awaiting_approval') {
      actor.state = actor.currentTurnCallChain.length > 0 ? 'in_call' : 'working';
      actor.statusText = '已收到批示，继续执行…';
      this.emit({ type: 'member_runtime', snapshot: this.toSnapshot(actor) });
    }
    this.emit({ type: 'approval_closed', approvalId, selectedOptionId: optionId });
    return true;
  }

  public interruptMember(scopeId: string, memberId: string): boolean {
    const actor = this.actors.get(this.actorKey(scopeId, memberId));
    if (!actor?.activeAbort) return false;
    actor.activeAbort.abort();
    return true;
  }

  public async resetMemberSession(scopeId: string, memberId: string): Promise<void> {
    const actor = this.actors.get(this.actorKey(scopeId, memberId));
    if (!actor) return;
    actor.activeAbort?.abort();
    if (actor.session) {
      const oldSession = actor.session;
      actor.session = null;
      await oldSession.dispose().catch(() => undefined);
    }
    actor.state = 'sleeping';
    actor.statusText = '已重置休眠，下次派活将唤醒全新身体';
    this.clearActorApprovals(actor);
    this.emit({ type: 'member_runtime', snapshot: this.toSnapshot(actor) });
  }

  public async sendMemberMessage(input: SendMemberMessageInput): Promise<SendMemberMessageResult> {
    const member = this.registry.get(input.memberId);
    if (!member) {
      throw new Error(`未找到家庭成员 "${input.memberId}"。`);
    }
    if (!member.enabled) {
      throw new Error(`家庭成员「${member.name} (@${member.id})」当前处于休假停用状态。`);
    }
    const driver = this.drivers.get(member.body.kind);
    if (!driver) {
      throw new Error(`尚未注册身体类型 "${member.body.kind}" 的驱动器。`);
    }

    const actor = this.ensureActor(input.scopeId, member.id, input.cwd);
    actor.queueLength += 1;
    this.emit({ type: 'member_runtime', snapshot: this.toSnapshot(actor) });

    const run = async (): Promise<SendMemberMessageResult> => {
      actor.queueLength = Math.max(0, actor.queueLength - 1);
      if (input.fresh && actor.session) {
        const previous = actor.session;
        actor.session = null;
        await previous.dispose().catch(() => undefined);
      }

      const callRecordIndexBefore = this.callRecords.length;
      const turnController = new AbortController();
      const forwardAbort = () => turnController.abort();
      if (input.signal?.aborted) {
        throw new Error('任务在启动前已被取消。');
      }
      input.signal?.addEventListener('abort', forwardAbort, { once: true });

      actor.activeAbort = turnController;
      actor.cwd = input.cwd;
      actor.currentTurnCallChain = input.callChain ?? [];
      actor.currentTurnGroupHold = input.activeGroupHold ?? null;
      actor.state = actor.currentTurnCallChain.length > 0 ? 'in_call' : 'working';
      actor.statusText =
        actor.currentTurnCallChain.length > 0 ? '正在接听家庭来电…' : '正在专注思考与执行…';
      actor.lastActiveAt = new Date().toISOString();

      const shouldRecordFeed = input.recordInFeed !== false;
      if (shouldRecordFeed) {
        this.appendEntry(actor, {
          id: randomUUID(),
          role: input.senderRole,
          authorName: input.senderName,
          content: input.message,
          createdAt: new Date().toISOString(),
        });
      }

      const replyEntryId = randomUUID();
      if (shouldRecordFeed) {
        this.appendEntry(actor, {
          id: replyEntryId,
          role: 'member',
          authorName: member.name,
          content: '',
          streaming: true,
          createdAt: new Date().toISOString(),
        });
      }
      this.emit({ type: 'member_runtime', snapshot: this.toSnapshot(actor) });

      try {
        if (!actor.session || !actor.session.isAlive()) {
          actor.statusText = `正在唤醒 ${member.body.kind} 身体…`;
          this.emit({ type: 'member_runtime', snapshot: this.toSnapshot(actor) });
          const composedSoul = composeAwakeningSoul(member, this.registry.listEnabled());
          actor.session = await driver.awaken({
            scopeId: input.scopeId,
            member,
            composedSoul,
            cwd: input.cwd,
            phoneMcp: this.buildPhoneMcpSpec(input.scopeId, member.id),
            signal: turnController.signal,
          });
        }

        let streamedText = '';
        let finalText = '';

        for await (const ev of actor.session.sendTurn(input.message, turnController.signal)) {
          if (ev.kind === 'text_delta') {
            streamedText += ev.delta;
            if (shouldRecordFeed) {
              this.updateEntry(actor, replyEntryId, {
                content: streamedText,
                streaming: true,
              });
              this.emit({ type: 'member_runtime', snapshot: this.toSnapshot(actor) });
            }
          } else if (ev.kind === 'status') {
            actor.statusText = ev.summary;
            if (shouldRecordFeed) {
              this.updateEntry(actor, replyEntryId, { statusSummary: ev.summary });
            }
            this.emit({ type: 'member_runtime', snapshot: this.toSnapshot(actor) });
          } else if (ev.kind === 'approval_requested') {
            const approvalId = randomUUID();
            const approval: PendingApproval = {
              approvalId,
              scopeId: input.scopeId,
              memberId: member.id,
              memberName: member.name,
              memberAvatar: member.avatar,
              bodyKind: member.body.kind,
              requestId: ev.requestId,
              title: ev.title,
              detail: ev.detail,
              options: ev.options,
              createdAt: new Date().toISOString(),
            };
            this.pendingApprovals.set(approvalId, { approval, actor });
            actor.state = 'awaiting_approval';
            actor.statusText = `举手等待批示：${ev.title}`;
            this.emit({ type: 'approval_opened', approval });
            this.emit({ type: 'member_runtime', snapshot: this.toSnapshot(actor) });
          } else if (ev.kind === 'turn_done') {
            finalText = ev.finalText || streamedText;
          }
        }

        if (!finalText && streamedText) {
          finalText = streamedText;
        }

        if (shouldRecordFeed) {
          this.updateEntry(actor, replyEntryId, {
            content: finalText,
            streaming: false,
            statusSummary: undefined,
          });
        }

        actor.state = 'idle';
        actor.statusText = '空闲待命';
        actor.lastActiveAt = new Date().toISOString();
        this.clearActorApprovals(actor);
        this.emit({ type: 'member_runtime', snapshot: this.toSnapshot(actor) });

        const phoneCallsDuringTurn = this.callRecords
          .slice(callRecordIndexBefore)
          .filter((rec) => rec.scopeId === input.scopeId);

        return {
          member,
          finalText,
          phoneCallsDuringTurn,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.clearActorApprovals(actor);
        if (actor.session && !actor.session.isAlive()) {
          const broken = actor.session;
          actor.session = null;
          await broken.dispose().catch(() => undefined);
        }
        actor.state = actor.session?.isAlive() ? 'idle' : 'error';
        actor.statusText = `执行异常：${message}`;
        if (shouldRecordFeed) {
          this.updateEntry(actor, replyEntryId, {
            content: `[异常中断] ${message}`,
            streaming: false,
          });
        }
        this.emit({ type: 'member_runtime', snapshot: this.toSnapshot(actor) });
        throw err;
      } finally {
        input.signal?.removeEventListener('abort', forwardAbort);
        actor.activeAbort = null;
        actor.currentTurnCallChain = [];
        actor.currentTurnGroupHold = null;
      }
    };

    const resultPromise = actor.queueTail.then(run, run);
    actor.queueTail = resultPromise.then(
      () => undefined,
      () => undefined
    );
    return resultPromise;
  }

  public handlePhoneContacts(scopeId: string, callerId: string): string {
    const enabled = this.registry.listEnabled();
    if (enabled.length === 0) {
      return '当前家庭暂无在岗成员。';
    }
    const lines = enabled.map((item) => {
      const snap = this.getMemberSnapshot(scopeId, item.id);
      const selfTag = item.id === callerId ? '（你自己）' : '';
      return `- ${item.avatar} ${item.name} (@${item.id})${selfTag} | 身体: ${item.body.kind} | 状态: ${snap.state} | 专长: ${item.specialty}`;
    });
    const rooms = this.groupEngine?.listRooms(scopeId) ?? [];
    const roomLines =
      rooms.length > 0
        ? [
            '',
            '可用家庭群聊：',
            ...rooms.map((r) => `- ${r.title} (groupId: "${r.id}", 消息数: ${r.messages.length})`),
          ]
        : [];
    return ['【智能体家庭通讯录】', ...lines, ...roomLines].join('\n');
  }

  public async handlePhoneCall(params: {
    readonly scopeId: string;
    readonly callerId: string;
    readonly toMemberId: string;
    readonly intent: PhoneCallIntent;
    readonly message: string;
    readonly signal?: AbortSignal;
  }): Promise<string> {
    const normalizedTo = params.toMemberId.replace(/^@/u, '').trim();
    const caller = this.registry.get(params.callerId);
    const callee = this.registry.get(normalizedTo);

    if (!callee || !callee.enabled) {
      return `拨号失败：未找到在岗家庭成员 "${normalizedTo}"。请先用 phone_contacts 查看有效代号。`;
    }
    if (normalizedTo === params.callerId) {
      return '无需给自己打电话，请直接继续你手头的工作。';
    }

    const callerActor = this.actors.get(this.actorKey(params.scopeId, params.callerId));
    const activeChain = callerActor?.currentTurnCallChain ?? [];
    const callerName = caller ? `${caller.name} (@${caller.id})` : `@${params.callerId}`;
    const cwd = callerActor?.cwd || process.cwd();

    // 1. 占线回环防死锁：目标已经在当前同步呼叫链上游等待
    if (activeChain.includes(normalizedTo)) {
      const busyRecord: PhoneCallRecord = {
        id: randomUUID(),
        scopeId: params.scopeId,
        fromMemberId: params.callerId,
        fromMemberName: caller?.name ?? params.callerId,
        toMemberId: callee.id,
        toMemberName: callee.name,
        intent: params.intent,
        message: params.message,
        status: 'busy_rejected',
        reply: '占线回环拦截：对方正在电话线上等待你的本次回复。',
        createdAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
      };
      this.recordCall(busyRecord);
      return `成员「${callee.name} (@${callee.id})」正拿着电话等待你的本次回复，无需反向拨号。请直接在当前回复中向 TA 提出你的反问、修改建议或拒绝理由。`;
    }

    // 2. 最大跳数保护：超过 MAX_CALL_HOPS 熔断
    if (activeChain.length >= MAX_CALL_HOPS) {
      const hopRecord: PhoneCallRecord = {
        id: randomUUID(),
        scopeId: params.scopeId,
        fromMemberId: params.callerId,
        fromMemberName: caller?.name ?? params.callerId,
        toMemberId: callee.id,
        toMemberName: callee.name,
        intent: params.intent,
        message: params.message,
        status: 'hop_limited',
        reply: `连续转拨已达 ${MAX_CALL_HOPS} 跳上限。`,
        createdAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
      };
      this.recordCall(hopRecord);
      return `本次连续跨成员转拨已达到 ${MAX_CALL_HOPS} 跳上限，为防止循环转包，请先基于现有信息向你的上游呼叫方反馈阶段结论或分歧点。`;
    }

    const callId = randomUUID();
    const ringingRecord: PhoneCallRecord = {
      id: callId,
      scopeId: params.scopeId,
      fromMemberId: params.callerId,
      fromMemberName: caller?.name ?? params.callerId,
      toMemberId: callee.id,
      toMemberName: callee.name,
      intent: params.intent,
      message: params.message,
      status: 'ringing',
      createdAt: new Date().toISOString(),
    };
    this.recordCall(ringingRecord);

    const intentLabel =
      params.intent === 'request_help'
        ? '请求协助'
        : params.intent === 'sync'
          ? '同步进展'
          : '探讨方案';

    const framedIncoming = [
      `📞 【家庭手机来电 · ${intentLabel}】`,
      `来电成员：${callerName}`,
      `对方说：`,
      params.message,
      ``,
      `（提示：${callerName} 正拿着电话等你回复。请结合你的灵魂准则与专业判断独立回应——赞同则直接分析或动手协助；若认为不合理或越界，请明确拒绝并说明理由与替代建议，无需反向拨打给 ${callerName}。）`,
    ].join('\n');

    try {
      const nextChain = [...activeChain, params.callerId];
      const outcome = await this.sendMemberMessage({
        scopeId: params.scopeId,
        memberId: callee.id,
        senderRole: 'peer',
        senderName: `📞 ${caller?.name ?? params.callerId}`,
        message: framedIncoming,
        cwd,
        callChain: nextChain,
        signal: params.signal,
      });

      this.updateCall(callId, {
        status: 'completed',
        reply: outcome.finalText,
        finishedAt: new Date().toISOString(),
      });

      return `【来自 ${callee.avatar} ${callee.name} (@${callee.id}) 的电话回复】\n${outcome.finalText}`;
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      this.updateCall(callId, {
        status: 'failed',
        reply: errMsg,
        finishedAt: new Date().toISOString(),
      });
      return `与 ${callee.name} (@${callee.id}) 通话中断：${errMsg}`;
    }
  }

  public async handlePhoneGroupDiscuss(params: {
    readonly scopeId: string;
    readonly callerId: string;
    readonly groupId?: string;
    readonly title?: string;
    readonly participants?: readonly string[];
    readonly message: string;
  }): Promise<string> {
    if (!this.groupEngine) {
      return '当前家庭群聊引擎尚未挂载，请改用 phone_call 一对一联系。';
    }
    const caller = this.registry.get(params.callerId);
    const callerActor = this.actors.get(this.actorKey(params.scopeId, params.callerId));
    const cwd = callerActor?.cwd || process.cwd();

    if (callerActor?.currentTurnGroupHold && (!params.groupId || params.groupId === callerActor.currentTurnGroupHold)) {
      return `你当前正拿着群聊「${callerActor.currentTurnGroupHold}」的话筒发言，无需再调 phone_group_discuss，请直接把你想在群里说的话写在本次回复正文里即可！`;
    }

    const activeChain = callerActor?.currentTurnCallChain ?? [];
    if (activeChain.length >= MAX_CALL_HOPS) {
      return `跨成员协作转接已达 ${MAX_CALL_HOPS} 跳上限，请先完成当前轮次回复。`;
    }

    let targetGroupId = params.groupId?.trim() || '';
    if (!targetGroupId) {
      if (params.participants && params.participants.length > 0) {
        const uniqueMembers = Array.from(
          new Set([params.callerId, ...params.participants.map((p) => p.replace(/^@/u, '').trim())])
        );
        const created = this.groupEngine.createRoom({
          scopeId: params.scopeId,
          title: params.title?.trim() || `${caller?.name ?? params.callerId} 发起的讨论组`,
          memberIds: uniqueMembers,
        });
        targetGroupId = created.id;
      } else {
        targetGroupId = 'family-main';
      }
    }

    const beforeCount = this.groupEngine.getOrCreateMainRoom(params.scopeId);
    const existingRoom = this.groupEngine.getRoom(params.scopeId, targetGroupId) ?? beforeCount;
    const startIdx = existingRoom.messages.length;

    const updatedRoom = await this.groupEngine.postMessage({
      scopeId: params.scopeId,
      groupId: existingRoom.id,
      senderId: params.callerId,
      senderName: caller?.name ?? params.callerId,
      senderAvatar: caller?.avatar ?? '🤖',
      content: params.message,
      cwd,
      blockedMemberIds: [...activeChain, params.callerId],
      parentCallChain: [...activeChain, params.callerId],
    });

    const newMessages = updatedRoom.messages.slice(startIdx + 1);
    if (newMessages.length === 0) {
      return `群聊「${updatedRoom.title}」中其他成员已阅（暂无额外异议或补充）。`;
    }
    return [
      `【群聊「${updatedRoom.title}」本轮讨论纪要】`,
      ...newMessages.map((m) => `- ${m.senderAvatar} ${m.senderName} (@${m.senderId}): ${m.content}`),
    ].join('\n');
  }

  public async dispose(): Promise<void> {
    const disposals: Promise<void>[] = [];
    for (const actor of this.actors.values()) {
      actor.activeAbort?.abort();
      this.clearActorApprovals(actor);
      if (actor.session) {
        const live = actor.session;
        actor.session = null;
        disposals.push(live.dispose().catch(() => undefined));
      }
    }
    this.actors.clear();
    await Promise.all(disposals);
  }

  private buildPhoneMcpSpec(scopeId: string, callerId: string): PhoneMcpLaunchSpec {
    if (this.phoneBus) {
      return this.phoneBus.buildLaunchSpec(scopeId, callerId);
    }
    const fallbackScript = resolve(import.meta.dirname, '../../dist/phone-mcp.js');
    const nodeExec = resolveNodeExecutable();
    return {
      command: nodeExec.command,
      args: [existsSync(fallbackScript) ? fallbackScript : ''],
      env: {
        ...nodeExec.env,
        NO_PROXY: '127.0.0.1,localhost,::1',
        no_proxy: '127.0.0.1,localhost,::1',
        DSH_FAMILY_SCOPE_ID: scopeId,
        DSH_FAMILY_CALLER_ID: callerId,
      },
      httpUrl: 'http://127.0.0.1:0/mcp',
      bearerToken: '',
    };
  }

  private ensureActor(scopeId: string, memberId: string, cwd: string): MemberActor {
    const key = this.actorKey(scopeId, memberId);
    const existing = this.actors.get(key);
    if (existing) return existing;
    const created: MemberActor = {
      scopeId,
      memberId,
      session: null,
      cwd,
      state: 'sleeping',
      entries: [],
      queueTail: Promise.resolve(),
      queueLength: 0,
      activeAbort: null,
      currentTurnCallChain: [],
      currentTurnGroupHold: null,
    };
    this.actors.set(key, created);
    return created;
  }

  private actorKey(scopeId: string, memberId: string): string {
    return `${scopeId}::${memberId}`;
  }

  private appendEntry(actor: MemberActor, entry: MemberChatEntry): void {
    actor.entries = [...actor.entries.slice(-79), entry];
  }

  private updateEntry(
    actor: MemberActor,
    entryId: string,
    patch: Partial<Pick<MemberChatEntry, 'content' | 'statusSummary' | 'streaming'>>
  ): void {
    actor.entries = actor.entries.map((item) =>
      item.id === entryId ? { ...item, ...patch } : item
    );
  }

  private clearActorApprovals(actor: MemberActor): void {
    for (const [id, entry] of this.pendingApprovals) {
      if (entry.actor === actor) {
        this.pendingApprovals.delete(id);
        this.emit({ type: 'approval_closed', approvalId: id });
      }
    }
  }

  private recordCall(record: PhoneCallRecord): void {
    this.callRecords.push(record);
    if (this.callRecords.length > 200) {
      this.callRecords.shift();
    }
    this.emit({ type: 'phone_call_updated', record });
  }

  private updateCall(
    id: string,
    patch: Partial<Pick<PhoneCallRecord, 'status' | 'reply' | 'finishedAt'>>
  ): void {
    const idx = this.callRecords.findIndex((item) => item.id === id);
    if (idx === -1) return;
    const updated: PhoneCallRecord = {
      ...this.callRecords[idx]!,
      ...patch,
    };
    this.callRecords[idx] = updated;
    this.emit({ type: 'phone_call_updated', record: updated });
  }

  private toSnapshot(actor: MemberActor): MemberRuntimeSnapshot {
    return {
      scopeId: actor.scopeId,
      memberId: actor.memberId,
      state: actor.state,
      statusText: actor.statusText,
      cwd: actor.cwd,
      queueLength: actor.queueLength,
      entries: [...actor.entries],
      lastActiveAt: actor.lastActiveAt,
    };
  }
}
