import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { formatAvatarPrefixForPrompt } from './avatar-utils.ts';
import { resolveNodeExecutable } from './cli-locator.ts';
import type { DshSessionContextBridge } from './dsh-context-bridge.ts';
import type { MemberRegistry } from './member-registry.ts';
import { composeAwakeningSoul } from './soul-composer.ts';
import type {
  BodyKind,
  BodySpec,
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
import { resolvePhoneMcpScriptPath, type FamilyPhoneBus } from '../phone/phone-bus.ts';

export const MAX_CALL_HOPS = 3;

interface MemberActor {
  readonly scopeId: string;
  readonly memberId: string;
  session: LiveMemberSession | null;
  awakenedBody?: BodySpec;
  needsReawaken?: boolean;
  cwd: string;
  state: MemberActivityState;
  statusText?: string;
  entries: MemberChatEntry[];
  lastHumanReadCount: number;
  lastActiveAt?: string;
  queueTail: Promise<void>;
  queueLength: number;
  activeAbort: AbortController | null;
  currentTurnCallChain: readonly string[];
  currentTurnGroupHold: string | null;
}

function sameStringArray(a: readonly string[] = [], b: readonly string[] = []): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function requiresProcessRestart(prev: BodySpec, next: BodySpec): boolean {
  return (
    prev.kind !== next.kind ||
    (prev.command ?? '') !== (next.command ?? '') ||
    !sameStringArray(prev.extraArgs, next.extraArgs)
  );
}

function hasModelOrEffortDiff(prev: BodySpec, next: BodySpec): boolean {
  return (
    (prev.permissionMode ?? 'ask') !== (next.permissionMode ?? 'ask') ||
    (prev.model ?? '') !== (next.model ?? '') ||
    (prev.reasoningEffort ?? '') !== (next.reasoningEffort ?? '')
  );
}

export interface SendMemberMessageInput {
  readonly scopeId: string;
  readonly memberId: string;
  readonly senderRole: 'human' | 'lead' | 'peer' | 'system';
  readonly senderName: string;
  readonly message: string;
  /** 可选 UI 展示文案（省略时使用 message；用于来电场景隐藏冗长系统提示语） */
  readonly displayMessage?: string;
  readonly cwd: string;
  readonly fresh?: boolean;
  readonly callChain?: readonly string[];
  readonly activeGroupHold?: string | null;
  readonly recordInFeed?: boolean;
  readonly onDelta?: (accumulatedText: string, delta: string) => void;
  readonly onStatus?: (summary: string) => void;
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
  private readonly storageDir?: string;
  private phoneBus: FamilyPhoneBus | null = null;
  private groupEngine: GroupChatEngine | null = null;
  private contextBridge: DshSessionContextBridge | null = null;

  public constructor(options: {
    readonly registry: MemberRegistry;
    readonly drivers: readonly BodyDriver[];
    readonly storageDir?: string;
  }) {
    this.registry = options.registry;
    this.storageDir = options.storageDir;
    for (const driver of options.drivers) {
      this.drivers.set(driver.kind, driver);
    }
    this.restoreFeedsFromDisk();
    this.restoreCallsFromDisk();
    this.registry.subscribe((members) => {
      this.emit({ type: 'roster_updated', members });
      void this.reconcileActorsWithRoster(members);
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

  public attachContextBridge(bridge: DshSessionContextBridge): void {
    this.contextBridge = bridge;
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

  public clearMemberEntries(scopeId: string, memberId: string): MemberRuntimeSnapshot {
    const actor = this.ensureActor(scopeId, memberId, process.cwd());
    actor.entries = [];
    actor.lastHumanReadCount = 0;
    this.persistFeedsToDisk();
    const snap = this.toSnapshot(actor);
    this.emit({ type: 'member_runtime', snapshot: snap });
    return snap;
  }

  public markMemberRead(scopeId: string, memberId: string): MemberRuntimeSnapshot {
    const actor = this.ensureActor(scopeId, memberId, process.cwd());
    if (actor.lastHumanReadCount !== actor.entries.length) {
      actor.lastHumanReadCount = actor.entries.length;
      this.persistFeedsToDisk();
      const snap = this.toSnapshot(actor);
      this.emit({ type: 'member_runtime', snapshot: snap });
      return snap;
    }
    return this.toSnapshot(actor);
  }

  public async resetMemberSession(scopeId: string, memberId: string): Promise<void> {
    this.contextBridge?.resetMemberCursor(scopeId, memberId);
    const actor = this.actors.get(this.actorKey(scopeId, memberId));
    if (!actor) return;
    actor.activeAbort?.abort();
    if (actor.session) {
      const oldSession = actor.session;
      actor.session = null;
      actor.awakenedBody = undefined;
      await oldSession.dispose().catch(() => undefined);
    }
    actor.state = 'sleeping';
    actor.statusText = '已重置休眠，下次派活将唤醒全新身体';
    this.clearActorApprovals(actor);
    this.emit({ type: 'member_runtime', snapshot: this.toSnapshot(actor) });
  }

  /**
   * 后台并行预热尚未唤醒的成员 CLI 进程（用于群聊首轮并发消除串行冷启动等待）。
   * 严格挂载在成员自身的 `queueTail` 串行队列上，杜绝重复唤醒竞态。
   */
  public prewarmMember(scopeId: string, memberId: string, cwd: string): Promise<void> {
    const member = this.registry.get(memberId);
    if (!member || !member.enabled) return Promise.resolve();
    const driver = this.drivers.get(member.body.kind);
    if (!driver) return Promise.resolve();
    const actor = this.ensureActor(scopeId, member.id, cwd);
    if (actor.session?.isAlive()) return Promise.resolve();

    const warmTask = async (): Promise<void> => {
      if (actor.session?.isAlive()) return;
      const latest = this.registry.get(member.id);
      if (!latest || !latest.enabled) return;
      actor.cwd = cwd;
      const controller = new AbortController();
      try {
        const composedSoul = composeAwakeningSoul(latest, this.registry.listEnabled());
        const phoneMcp = await this.buildPhoneMcpSpec(scopeId, latest.id);
        actor.session = await driver.awaken({
          scopeId,
          member: latest,
          composedSoul,
          cwd,
          phoneMcp,
          signal: controller.signal,
        });
        actor.awakenedBody = latest.body;
        actor.needsReawaken = false;
        if (actor.state === 'sleeping') {
          actor.state = 'idle';
          actor.statusText = '空闲待命';
          this.emit({ type: 'member_runtime', snapshot: this.toSnapshot(actor) });
        }
      } catch {
        // 预热异常留待正式发言时按标准错误处理
      }
    };

    const p = actor.queueTail.then(warmTask, warmTask);
    actor.queueTail = p.then(
      () => undefined,
      () => undefined
    );
    return p;
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
      if ((input.fresh || actor.needsReawaken) && actor.session) {
        const previous = actor.session;
        actor.session = null;
        actor.awakenedBody = undefined;
        actor.needsReawaken = false;
        this.contextBridge?.resetMemberCursor(input.scopeId, member.id);
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
          content: input.displayMessage ?? input.message,
          createdAt: new Date().toISOString(),
        });
        if (input.senderRole === 'human') {
          actor.lastHumanReadCount = actor.entries.length;
        }
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
          const phoneMcp = await this.buildPhoneMcpSpec(input.scopeId, member.id);
          actor.session = await driver.awaken({
            scopeId: input.scopeId,
            member,
            composedSoul,
            cwd: input.cwd,
            phoneMcp,
            signal: turnController.signal,
          });
          actor.awakenedBody = member.body;
          actor.needsReawaken = false;
        } else if (actor.awakenedBody && hasModelOrEffortDiff(actor.awakenedBody, member.body)) {
          const hotApplied = (await actor.session.reconfigure?.(member.body)) ?? false;
          if (hotApplied) {
            actor.awakenedBody = member.body;
          } else {
            const stale = actor.session;
            actor.session = null;
            await stale.dispose().catch(() => undefined);
            const composedSoul = composeAwakeningSoul(member, this.registry.listEnabled());
            const phoneMcp = await this.buildPhoneMcpSpec(input.scopeId, member.id);
            actor.session = await driver.awaken({
              scopeId: input.scopeId,
              member,
              composedSoul,
              cwd: input.cwd,
              phoneMcp,
              signal: turnController.signal,
            });
            actor.awakenedBody = member.body;
          }
        }

        const sessionBriefing =
          this.contextBridge?.buildIncrementalBriefing(input.scopeId, member.id) ?? '';
        const effectivePrompt = sessionBriefing
          ? `${sessionBriefing}\n\n${input.message}`
          : input.message;

        let streamedText = '';
        let finalText = '';

        for await (const ev of actor.session.sendTurn(effectivePrompt, turnController.signal)) {
          if (ev.kind === 'text_delta') {
            streamedText += ev.delta;
            input.onDelta?.(streamedText, ev.delta);
            if (shouldRecordFeed) {
              this.updateEntry(actor, replyEntryId, {
                content: streamedText,
                streaming: true,
              });
              this.emit({ type: 'member_runtime', snapshot: this.toSnapshot(actor) });
            }
          } else if (ev.kind === 'status') {
            actor.statusText = ev.summary;
            input.onStatus?.(ev.summary);
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
              ...(ev.allowCustomInput ? { allowCustomInput: true } : {}),
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
          this.persistFeedsToDisk();
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
          this.persistFeedsToDisk();
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
    const stateLabels: Readonly<Record<MemberActivityState, string>> = {
      sleeping: '在岗待命（可随时拨通唤醒）',
      idle: '在线空闲（可随时拨通）',
      working: '正在执行任务',
      in_call: '通话中',
      awaiting_approval: '等待用户批示',
      error: '上次异常（拨打将重新唤醒）',
    };
    const lines = enabled.map((item) => {
      const snap = this.getMemberSnapshot(scopeId, item.id);
      const selfTag = item.id === callerId ? '（你自己）' : '';
      return `- ${formatAvatarPrefixForPrompt(item.avatar)}${item.name} (@${item.id})${selfTag} | 身体: ${item.body.kind} | 状态: ${stateLabels[snap.state]} | 专长: ${item.specialty}`;
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

  public handlePhoneReadDshSession(
    scopeId: string,
    maxItems: number = 25,
    query?: string
  ): string {
    if (!this.contextBridge) {
      return '当前环境未挂载 DSH 主会话上下文桥接服务。';
    }
    return this.contextBridge.readRecentTranscript(scopeId, maxItems, query);
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
        senderName: `${caller?.name ?? params.callerId} 来电 (${intentLabel})`,
        message: framedIncoming,
        displayMessage: params.message,
        cwd,
        callChain: nextChain,
        signal: params.signal,
      });

      this.updateCall(callId, {
        status: 'completed',
        reply: outcome.finalText,
        finishedAt: new Date().toISOString(),
      });

      return `【来自 ${formatAvatarPrefixForPrompt(callee.avatar)}${callee.name} (@${callee.id}) 的电话回复】\n${outcome.finalText}`;
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
      ...newMessages.map(
        (m) =>
          `- ${formatAvatarPrefixForPrompt(m.senderAvatar)}${m.senderName} (@${m.senderId}): ${m.content}`
      ),
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

  private async reconcileActorsWithRoster(members: readonly FamilyMember[]): Promise<void> {
    const byId = new Map(members.map((m) => [m.id, m]));
    for (const actor of this.actors.values()) {
      if (!actor.session) continue;
      const latest = byId.get(actor.memberId);
      if (!latest || !latest.enabled) {
        if (actor.state === 'idle' || actor.state === 'sleeping') {
          const old = actor.session;
          actor.session = null;
          actor.awakenedBody = undefined;
          actor.state = 'sleeping';
          await old.dispose().catch(() => undefined);
          this.emit({ type: 'member_runtime', snapshot: this.toSnapshot(actor) });
        } else {
          actor.needsReawaken = true;
        }
        continue;
      }

      if (!actor.awakenedBody) continue;
      if (requiresProcessRestart(actor.awakenedBody, latest.body)) {
        if (actor.state === 'idle') {
          const old = actor.session;
          actor.session = null;
          actor.awakenedBody = undefined;
          actor.state = 'sleeping';
          actor.statusText = '身体配置已更新，下次对话将唤醒新身体';
          await old.dispose().catch(() => undefined);
          this.emit({ type: 'member_runtime', snapshot: this.toSnapshot(actor) });
        } else {
          actor.needsReawaken = true;
        }
        continue;
      }

      if (hasModelOrEffortDiff(actor.awakenedBody, latest.body)) {
        const applied = (await actor.session.reconfigure?.(latest.body).catch(() => false)) ?? false;
        if (applied) {
          actor.awakenedBody = latest.body;
          if (actor.state === 'idle') {
            const label = latest.body.model || '默认模型';
            const effortLabel = latest.body.reasoningEffort ? ` · ${latest.body.reasoningEffort}` : '';
            actor.statusText = `已切换至 ${label}${effortLabel}`;
            this.emit({ type: 'member_runtime', snapshot: this.toSnapshot(actor) });
          }
        } else if (actor.state === 'idle') {
          const old = actor.session;
          actor.session = null;
          actor.awakenedBody = undefined;
          actor.state = 'sleeping';
          actor.statusText = '模型/速度已切换，下次发言立即生效';
          await old.dispose().catch(() => undefined);
          this.emit({ type: 'member_runtime', snapshot: this.toSnapshot(actor) });
        } else {
          actor.needsReawaken = true;
        }
      }
    }
  }

  private async buildPhoneMcpSpec(scopeId: string, callerId: string): Promise<PhoneMcpLaunchSpec> {
    if (this.phoneBus) {
      await this.phoneBus.start();
      return this.phoneBus.buildLaunchSpec(scopeId, callerId);
    }
    const fallbackScript = resolvePhoneMcpScriptPath(import.meta.dirname);
    const nodeExec = resolveNodeExecutable();
    return {
      command: nodeExec.command,
      args: [fallbackScript],
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
      lastHumanReadCount: 0,
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
    const overflow = Math.max(0, actor.entries.length + 1 - 80);
    actor.entries = [...actor.entries.slice(-79), entry];
    if (overflow > 0) {
      actor.lastHumanReadCount = Math.max(0, actor.lastHumanReadCount - overflow);
    }
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
    this.persistCallsToDisk();
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
    this.persistCallsToDisk();
    this.emit({ type: 'phone_call_updated', record: updated });
  }

  private toSnapshot(actor: MemberActor): MemberRuntimeSnapshot {
    const start = Math.max(0, Math.min(actor.lastHumanReadCount, actor.entries.length));
    let unreadCount = 0;
    for (let i = start; i < actor.entries.length; i += 1) {
      const item = actor.entries[i];
      if (item && item.role !== 'human' && !item.streaming) {
        unreadCount += 1;
      }
    }
    return {
      scopeId: actor.scopeId,
      memberId: actor.memberId,
      state: actor.state,
      statusText: actor.statusText,
      cwd: actor.cwd,
      queueLength: actor.queueLength,
      entries: [...actor.entries],
      unreadCount,
      lastActiveAt: actor.lastActiveAt,
    };
  }

  private persistFeedsToDisk(): void {
    if (!this.storageDir) return;
    try {
      mkdirSync(this.storageDir, { recursive: true });
      const filePath = join(this.storageDir, 'member-feeds.json');
      const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
      const records: Array<{
        scopeId: string;
        memberId: string;
        entries: MemberChatEntry[];
        lastHumanReadCount?: number;
      }> = [];
      for (const actor of this.actors.values()) {
        const cleanEntries = actor.entries
          .filter((e) => !e.streaming)
          .slice(-60);
        if (cleanEntries.length > 0) {
          records.push({
            scopeId: actor.scopeId,
            memberId: actor.memberId,
            entries: cleanEntries,
            lastHumanReadCount: Math.min(cleanEntries.length, actor.lastHumanReadCount),
          });
        }
      }
      writeFileSync(tmpPath, `${JSON.stringify({ version: 1, feeds: records }, null, 2)}\n`, 'utf8');
      renameSync(tmpPath, filePath);
    } catch {
      // 忽略 UI 面板展示历史落盘异常，不影响核心流程
    }
  }

  private restoreFeedsFromDisk(): void {
    if (!this.storageDir) return;
    const filePath = join(this.storageDir, 'member-feeds.json');
    if (!existsSync(filePath)) return;
    try {
      const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as Record<string, unknown>;
      const feeds = Array.isArray(parsed.feeds) ? parsed.feeds : [];
      for (const raw of feeds) {
        if (!raw || typeof raw !== 'object') continue;
        const rec = raw as Record<string, unknown>;
        if (
          typeof rec.scopeId !== 'string' ||
          typeof rec.memberId !== 'string' ||
          !Array.isArray(rec.entries)
        ) {
          continue;
        }
        const actor = this.ensureActor(rec.scopeId, rec.memberId, process.cwd());
        actor.entries = rec.entries.filter(
          (item): item is MemberChatEntry =>
            Boolean(item && typeof item === 'object' && typeof (item as Record<string, unknown>).id === 'string')
        );
        actor.lastHumanReadCount =
          typeof rec.lastHumanReadCount === 'number'
            ? Math.max(0, Math.min(actor.entries.length, rec.lastHumanReadCount))
            : actor.entries.length;
      }
    } catch {
      // ignore
    }
  }

  private persistCallsToDisk(): void {
    if (!this.storageDir) return;
    try {
      mkdirSync(this.storageDir, { recursive: true });
      const filePath = join(this.storageDir, 'phone-calls.json');
      const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
      const records = this.callRecords.slice(-120);
      writeFileSync(tmpPath, `${JSON.stringify({ version: 1, calls: records }, null, 2)}\n`, 'utf8');
      renameSync(tmpPath, filePath);
    } catch {
      // ignore
    }
  }

  private restoreCallsFromDisk(): void {
    if (!this.storageDir) return;
    const filePath = join(this.storageDir, 'phone-calls.json');
    if (!existsSync(filePath)) return;
    try {
      const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as Record<string, unknown>;
      const calls = Array.isArray(parsed.calls) ? parsed.calls : [];
      for (const raw of calls) {
        if (!raw || typeof raw !== 'object') continue;
        const item = raw as Record<string, unknown>;
        if (typeof item.id !== 'string' || typeof item.scopeId !== 'string') continue;
        const normalized: PhoneCallRecord =
          item.status === 'ringing'
            ? ({
                ...(item as unknown as PhoneCallRecord),
                status: 'failed',
                reply: '宿主重启时通话已结束',
                finishedAt: new Date().toISOString(),
              } satisfies PhoneCallRecord)
            : (item as unknown as PhoneCallRecord);
        this.callRecords.push(normalized);
      }
    } catch {
      // ignore
    }
  }
}
