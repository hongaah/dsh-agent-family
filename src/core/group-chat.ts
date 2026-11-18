import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { FamilyHub } from './family-hub.ts';
import { resolveHumanDisplayLabel } from './family-profile.ts';
import type { MemberRegistry } from './member-registry.ts';
import { MemberTurnStallError } from './turn-watchdog.ts';
import type {
  FamilyGroupRoom,
  FamilyMember,
  GroupMessage,
  GroupStreamingDraft,
  WorkspaceFileChange,
} from './types.ts';

export const MAX_GROUP_RELAY_TURNS = 6;
export const MAIN_GROUP_ID = 'family-main';

interface MutableGroupRoom {
  readonly id: string;
  title: string;
  readonly scopeId: string;
  memberIds: 'all_enabled' | readonly string[];
  messages: GroupMessage[];
  readCursors: Record<string, number>;
  lastHumanReadCount: number;
  activeSpeakerId: string | null;
  streamingDraft: GroupStreamingDraft | null;
  lastPassMemberName?: string;
  running: boolean;
  relayAbort: AbortController | null;
}

function computeRoomUnreadCount(room: MutableGroupRoom): number {
  const start = Math.max(0, Math.min(room.lastHumanReadCount, room.messages.length));
  let count = 0;
  for (let i = start; i < room.messages.length; i += 1) {
    if (room.messages[i]?.senderId !== 'human') {
      count += 1;
    }
  }
  return count;
}

export function extractMemberMentions(
  text: string,
  validMemberIds: ReadonlySet<string>
): string[] {
  const found: string[] = [];
  const regex = /@([a-z][a-z0-9-]{0,31})\b/gu;
  for (const match of text.matchAll(regex)) {
    const candidate = match[1];
    if (candidate && validMemberIds.has(candidate) && !found.includes(candidate)) {
      found.push(candidate);
    }
  }
  return found;
}

function isPassReply(text: string): boolean {
  const trimmed = text.trim();
  return trimmed === '' || /^\[?\s*PASS\s*\]?[。.!！]*$/iu.test(trimmed);
}

export class GroupChatEngine {
  private readonly hub: FamilyHub;
  private readonly registry: MemberRegistry;
  private readonly storageDir?: string;
  private readonly rooms = new Map<string, MutableGroupRoom>();

  public constructor(hub: FamilyHub, registry: MemberRegistry, storageDir?: string) {
    this.hub = hub;
    this.registry = registry;
    this.storageDir = storageDir;
    this.restoreRoomsFromDisk();
  }

  public getOrCreateMainRoom(scopeId: string): FamilyGroupRoom {
    return this.toImmutable(this.ensureMainRoom(scopeId));
  }

  public getRoom(scopeId: string, groupId: string): FamilyGroupRoom | undefined {
    if (groupId === MAIN_GROUP_ID) {
      return this.getOrCreateMainRoom(scopeId);
    }
    const found = this.rooms.get(this.roomKey(scopeId, groupId));
    return found ? this.toImmutable(found) : undefined;
  }

  public listRooms(scopeId: string): readonly FamilyGroupRoom[] {
    if (!scopeId.startsWith('family-')) {
      this.ensureMainRoom(scopeId);
    }
    const list: FamilyGroupRoom[] = [];
    for (const room of this.rooms.values()) {
      if (room.scopeId === scopeId) {
        list.push(this.toImmutable(room));
      }
    }
    return list;
  }

  public listAllRooms(ensureScopeId?: string): readonly FamilyGroupRoom[] {
    if (ensureScopeId && !ensureScopeId.startsWith('family-')) {
      this.ensureMainRoom(ensureScopeId);
    }
    const list: FamilyGroupRoom[] = [];
    for (const room of this.rooms.values()) {
      if (room.scopeId.startsWith('family-')) continue;
      list.push(this.toImmutable(room));
    }
    return list;
  }

  public createRoom(input: {
    readonly scopeId: string;
    readonly title: string;
    readonly memberIds: 'all_enabled' | readonly string[];
  }): FamilyGroupRoom {
    const id = `grp-${randomUUID().slice(0, 8)}`;
    const room: MutableGroupRoom = {
      id,
      title: input.title.trim() || '专题讨论群',
      scopeId: input.scopeId,
      memberIds: input.memberIds === 'all_enabled' ? 'all_enabled' : [...input.memberIds],
      messages: [],
      readCursors: {},
      lastHumanReadCount: 0,
      activeSpeakerId: null,
      streamingDraft: null,
      running: false,
      relayAbort: null,
    };
    this.rooms.set(this.roomKey(input.scopeId, id), room);
    this.persistRoomsToDisk();
    const snapshot = this.toImmutable(room);
    this.hub.emit({ type: 'group_updated', room: snapshot });
    return snapshot;
  }

  public clearRoomMessages(scopeId: string, groupId: string): FamilyGroupRoom {
    const room =
      groupId === MAIN_GROUP_ID
        ? this.ensureMainRoom(scopeId)
        : (this.rooms.get(this.roomKey(scopeId, groupId)) ?? this.ensureMainRoom(scopeId));
    room.relayAbort?.abort();
    room.relayAbort = null;
    room.messages = [];
    room.readCursors = {};
    room.lastHumanReadCount = 0;
    room.activeSpeakerId = null;
    room.streamingDraft = null;
    room.lastPassMemberName = undefined;
    room.running = false;
    this.persistRoomsToDisk();
    this.broadcast(room);
    return this.toImmutable(room);
  }

  public markRoomRead(scopeId: string, groupId: string): FamilyGroupRoom {
    const room =
      groupId === MAIN_GROUP_ID
        ? this.ensureMainRoom(scopeId)
        : (this.rooms.get(this.roomKey(scopeId, groupId)) ?? this.ensureMainRoom(scopeId));
    if (room.lastHumanReadCount !== room.messages.length) {
      room.lastHumanReadCount = room.messages.length;
      this.persistRoomsToDisk();
      this.broadcast(room);
    }
    return this.toImmutable(room);
  }

  public deleteRoom(scopeId: string, groupId: string): boolean {
    if (groupId === MAIN_GROUP_ID) return false;
    const key = this.roomKey(scopeId, groupId);
    const existing = this.rooms.get(key);
    if (!existing) return false;
    existing.relayAbort?.abort();
    this.rooms.delete(key);
    this.persistRoomsToDisk();
    return true;
  }

  public interruptRoom(scopeId: string, groupId: string): boolean {
    const room = this.rooms.get(this.roomKey(scopeId, groupId));
    if (!room || !room.relayAbort) return false;
    room.relayAbort.abort();
    return true;
  }

  public async postMessage(input: {
    readonly scopeId: string;
    readonly groupId: string;
    readonly senderId: string;
    readonly senderName: string;
    readonly senderAvatar?: string;
    readonly content: string;
    readonly cwd: string;
    readonly blockedMemberIds?: readonly string[];
    readonly parentCallChain?: readonly string[];
  }): Promise<FamilyGroupRoom> {
    const room =
      input.groupId === MAIN_GROUP_ID
        ? this.ensureMainRoom(input.scopeId)
        : (this.rooms.get(this.roomKey(input.scopeId, input.groupId)) ??
          this.ensureMainRoom(input.scopeId));

    if (room.relayAbort) {
      room.relayAbort.abort();
      room.relayAbort = null;
    }

    const activeMembers = this.resolveRoomMembers(room);
    const memberIdSet = new Set(activeMembers.map((m) => m.id));
    const blockedSet = new Set(input.blockedMemberIds ?? []);

    const mentions = extractMemberMentions(input.content, memberIdSet);
    const triggerMsg: GroupMessage = {
      id: randomUUID(),
      groupId: room.id,
      senderId: input.senderId,
      senderName: input.senderName,
      senderAvatar: input.senderAvatar ?? 'human',
      content: input.content.trim(),
      mentions,
      createdAt: new Date().toISOString(),
    };
    room.messages.push(triggerMsg);
    if (input.senderId === 'human') {
      room.lastHumanReadCount = room.messages.length;
    }
    if (memberIdSet.has(input.senderId)) {
      room.readCursors[input.senderId] = room.messages.length;
    }
    room.lastPassMemberName = undefined;
    room.streamingDraft = null;
    this.persistRoomsToDisk();

    const relayController = new AbortController();
    room.relayAbort = relayController;
    room.running = true;
    this.broadcast(room);

    const speakerQueue: string[] = [];
    const enqueueSpeaker = (memberId: string) => {
      if (!memberIdSet.has(memberId)) return;
      if (blockedSet.has(memberId)) return;
      if (!speakerQueue.includes(memberId)) {
        speakerQueue.push(memberId);
      }
    };

    if (mentions.length > 0) {
      for (const mId of mentions) {
        if (mId !== input.senderId) enqueueSpeaker(mId);
      }
    } else {
      for (const member of activeMembers) {
        if (member.id !== input.senderId) enqueueSpeaker(member.id);
      }
    }

    // 并行预热排在后面的未唤醒成员 CLI 身体，消除群聊串行冷启动延迟
    for (const upcomingId of speakerQueue.slice(1)) {
      void this.hub.prewarmMember(input.scopeId, upcomingId, input.cwd);
    }

    let substantiveTurns = 0;
    let totalChecks = 0;
    const maxTotalChecks = MAX_GROUP_RELAY_TURNS + activeMembers.length + 2;

    try {
      while (
        speakerQueue.length > 0 &&
        substantiveTurns < MAX_GROUP_RELAY_TURNS &&
        totalChecks < maxTotalChecks &&
        !relayController.signal.aborted
      ) {
        const nextSpeakerId = speakerQueue.shift()!;
        const speaker = this.registry.get(nextSpeakerId);
        if (!speaker || !speaker.enabled || blockedSet.has(speaker.id)) {
          continue;
        }

        const unreadStart = room.readCursors[speaker.id] ?? 0;
        const unreadMessages = room.messages.slice(unreadStart);
        if (unreadMessages.length === 0) {
          continue;
        }

        totalChecks += 1;
        room.activeSpeakerId = speaker.id;
        room.streamingDraft = {
          senderId: speaker.id,
          senderName: speaker.name,
          senderAvatar: speaker.avatar,
          content: '',
          statusSummary: '思考中…',
        };
        this.broadcast(room);

        room.readCursors[speaker.id] = room.messages.length;
        const allowPass = substantiveTurns > 0 || speakerQueue.length > 0;
        const promptForSpeaker = this.formatUnreadGroupDelta(
          room,
          speaker,
          unreadMessages,
          activeMembers,
          allowPass
        );

        let replyText = '';
        let turnChangedFiles: readonly WorkspaceFileChange[] = [];
        try {
          const outcome = await this.hub.sendMemberMessage({
            scopeId: input.scopeId,
            memberId: speaker.id,
            senderRole: 'peer',
            senderName: room.title,
            message: promptForSpeaker,
            cwd: input.cwd,
            callChain: input.parentCallChain ?? [],
            activeGroupHold: room.id,
            recordInFeed: false,
            onDelta: (accumulated) => {
              if (relayController.signal.aborted) return;
              // 若正在输出 [PASS] 前缀则暂不闪现废话草稿
              if (/^\[?\s*P(?:A(?:S(?:S)?)?)?\s*\]?$/iu.test(accumulated.trim())) {
                return;
              }
              room.streamingDraft = {
                senderId: speaker.id,
                senderName: speaker.name,
                senderAvatar: speaker.avatar,
                content: accumulated,
                statusSummary: room.streamingDraft?.statusSummary,
              };
              this.broadcast(room);
            },
            onStatus: (summary) => {
              if (relayController.signal.aborted) return;
              room.streamingDraft = {
                senderId: speaker.id,
                senderName: speaker.name,
                senderAvatar: speaker.avatar,
                content: room.streamingDraft?.content ?? '',
                statusSummary: summary,
              };
              this.broadcast(room);
            },
            signal: relayController.signal,
          });
          replyText = outcome.finalText.trim();
          turnChangedFiles = outcome.changedFiles;
        } catch (err) {
          room.streamingDraft = null;
          if (relayController.signal.aborted) break;
          if (err instanceof MemberTurnStallError) {
            room.messages.push({
              id: randomUUID(),
              groupId: room.id,
              senderId: 'system',
              senderName: '家庭管家',
              senderAvatar: '⏱️',
              content: `💤 ${speaker.name} (@${speaker.id}) 思考超时未响应，已自动重启恢复身体并跳过，由下一位家人继续接力。`,
              mentions: [],
              createdAt: new Date().toISOString(),
            });
            this.persistRoomsToDisk();
            this.broadcast(room);
          }
          continue;
        }

        room.streamingDraft = null;
        if (relayController.signal.aborted) break;

        if (isPassReply(replyText) && turnChangedFiles.length === 0) {
          room.lastPassMemberName = speaker.name;
          this.persistRoomsToDisk();
          this.broadcast(room);
          continue;
        }

        const effectiveReplyText =
          isPassReply(replyText) && turnChangedFiles.length > 0
            ? `已完成 ${turnChangedFiles.length} 个工作区文件的修改。`
            : replyText;

        substantiveTurns += 1;
        const replyMentions = extractMemberMentions(effectiveReplyText, memberIdSet).filter(
          (id) => id !== speaker.id
        );
        const speakerMsg: GroupMessage = {
          id: randomUUID(),
          groupId: room.id,
          senderId: speaker.id,
          senderName: speaker.name,
          senderAvatar: speaker.avatar,
          content: effectiveReplyText,
          mentions: replyMentions,
          ...(turnChangedFiles.length > 0 ? { changedFiles: turnChangedFiles } : {}),
          createdAt: new Date().toISOString(),
        };
        room.messages.push(speakerMsg);
        room.readCursors[speaker.id] = room.messages.length;
        this.persistRoomsToDisk();
        this.broadcast(room);

        for (const mentionedId of replyMentions) {
          enqueueSpeaker(mentionedId);
        }
      }
    } finally {
      if (room.relayAbort === relayController) {
        room.relayAbort = null;
        room.activeSpeakerId = null;
        room.streamingDraft = null;
        room.running = false;
        this.broadcast(room);
      }
    }

    return this.toImmutable(room);
  }

  private ensureMainRoom(scopeId: string): MutableGroupRoom {
    const key = this.roomKey(scopeId, MAIN_GROUP_ID);
    const existing = this.rooms.get(key);
    if (existing) return existing;
    const created: MutableGroupRoom = {
      id: MAIN_GROUP_ID,
      title: '家庭总群',
      scopeId,
      memberIds: 'all_enabled',
      messages: [],
      readCursors: {},
      lastHumanReadCount: 0,
      activeSpeakerId: null,
      streamingDraft: null,
      running: false,
      relayAbort: null,
    };
    this.rooms.set(key, created);
    return created;
  }

  private resolveRoomMembers(room: MutableGroupRoom): readonly FamilyMember[] {
    const enabled = this.registry.listEnabled();
    if (room.memberIds === 'all_enabled') {
      return enabled;
    }
    const allowed = new Set(room.memberIds);
    return enabled.filter((m) => allowed.has(m.id));
  }

  private formatUnreadGroupDelta(
    room: MutableGroupRoom,
    receiver: FamilyMember,
    unread: readonly GroupMessage[],
    roomMembers: readonly FamilyMember[],
    allowPass: boolean
  ): string {
    const peersDesc = roomMembers
      .filter((m) => m.id !== receiver.id)
      .map((m) => `${m.name}(@${m.id})`)
      .join('、');

    const humanLabel = resolveHumanDisplayLabel(this.hub.getSharedProfile());
    const transcript = unread
      .map((m) => {
        if (m.senderId === 'human') {
          return `[${humanLabel}]: ${m.content}`;
        }
        const handle = m.senderId === 'lead' ? '' : ` (@${m.senderId})`;
        return `[${m.senderName}${handle}]: ${m.content}`;
      })
      .join('\n\n');

    const passGuideline = allowPass
      ? `- 若前面的家人已经接得很自然到位、你没什么特别想补充或吐槽的，请只回复 \`[PASS]\` 安静旁听，不必硬凑客套话。`
      : `- 当前群里还没人接话，请用你自己的性格自然回应，不要回复 \`[PASS]\`。`;

    return [
      `🏠 【家庭群聊「${room.title}」新消息】`,
      `群里的家人：${peersDesc || '暂无其他成员'}`,
      `---`,
      transcript,
      `---`,
      `（群聊发言默契：`,
      `- 你现在直接在「${room.title}」群里说话，直接输出你想说的话即可，无需调用 phone_group_discuss 工具；`,
      `- **自动分辨「日常闲聊」与「正经干活」**：如果上面只是问候、日常闲聊、吐槽、聊生活或活跃气氛，请彻底卸下工作包袱和班味，按你自己的脾气性格自然接梗、关心或跟家人互怼逗乐（口语化、简短有温度），**严禁主动扯代码/架构/工作内容，更严禁在群里给别人派活或安排任务**！只有当大家明确提出具体开发任务、Bug 或技术方案探讨时，再结合你的看家手艺（${receiver.specialty}）认真发表见解或推进；`,
      `- 像真人一家人聊天一样自然互动，除非确实有话要专门问某位家人，否则不要乱 \`@成员ID\` 点名派活；`,
      `${passGuideline}）`,
    ].join('\n');
  }

  private broadcast(room: MutableGroupRoom): void {
    this.hub.emit({ type: 'group_updated', room: this.toImmutable(room) });
  }

  private toImmutable(room: MutableGroupRoom): FamilyGroupRoom {
    return {
      id: room.id,
      title: room.title,
      scopeId: room.scopeId,
      memberIds: room.memberIds === 'all_enabled' ? 'all_enabled' : [...room.memberIds],
      messages: [...room.messages],
      readCursors: { ...room.readCursors },
      unreadCount: computeRoomUnreadCount(room),
      activeSpeakerId: room.activeSpeakerId,
      streamingDraft: room.streamingDraft ? { ...room.streamingDraft } : null,
      lastPassMemberName: room.lastPassMemberName,
      running: room.running,
    };
  }

  private roomKey(scopeId: string, groupId: string): string {
    return `${scopeId}::${groupId}`;
  }

  private persistRoomsToDisk(): void {
    if (!this.storageDir) return;
    try {
      mkdirSync(this.storageDir, { recursive: true });
      const filePath = join(this.storageDir, 'group-rooms.json');
      const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
      const roomsData = Array.from(this.rooms.values()).map((r) => ({
        id: r.id,
        title: r.title,
        scopeId: r.scopeId,
        memberIds: r.memberIds,
        messages: r.messages.slice(-120),
        readCursors: r.readCursors,
        lastHumanReadCount: Math.max(
          0,
          r.lastHumanReadCount - Math.max(0, r.messages.length - 120)
        ),
      }));
      writeFileSync(tmpPath, `${JSON.stringify({ version: 1, rooms: roomsData }, null, 2)}\n`, 'utf8');
      renameSync(tmpPath, filePath);
    } catch {
      // ignore UI transcript persistence errors
    }
  }

  private restoreRoomsFromDisk(): void {
    if (!this.storageDir) return;
    const filePath = join(this.storageDir, 'group-rooms.json');
    if (!existsSync(filePath)) return;
    try {
      const raw = JSON.parse(readFileSync(filePath, 'utf8')) as Record<string, unknown>;
      const roomsList = Array.isArray(raw.rooms) ? raw.rooms : [];
      for (const item of roomsList) {
        if (!item || typeof item !== 'object') continue;
        const r = item as Record<string, unknown>;
        if (typeof r.id !== 'string' || typeof r.scopeId !== 'string' || typeof r.title !== 'string') {
          continue;
        }
        const memberIds: 'all_enabled' | readonly string[] =
          r.memberIds === 'all_enabled'
            ? 'all_enabled'
            : Array.isArray(r.memberIds)
              ? r.memberIds.filter((x): x is string => typeof x === 'string')
              : 'all_enabled';
        const messages = Array.isArray(r.messages)
          ? r.messages.filter(
              (m): m is GroupMessage =>
                Boolean(m && typeof m === 'object' && typeof (m as Record<string, unknown>).id === 'string')
            )
          : [];
        const rawCursors =
          r.readCursors && typeof r.readCursors === 'object' && !Array.isArray(r.readCursors)
            ? (r.readCursors as Record<string, unknown>)
            : {};
        const readCursors: Record<string, number> = {};
        for (const [k, v] of Object.entries(rawCursors)) {
          if (typeof v === 'number') readCursors[k] = v;
        }
        const lastHumanReadCount =
          typeof r.lastHumanReadCount === 'number'
            ? Math.max(0, Math.min(messages.length, r.lastHumanReadCount))
            : messages.length;
        this.rooms.set(this.roomKey(r.scopeId, r.id), {
          id: r.id,
          title: r.title,
          scopeId: r.scopeId,
          memberIds,
          messages,
          readCursors,
          lastHumanReadCount,
          activeSpeakerId: null,
          streamingDraft: null,
          running: false,
          relayAbort: null,
        });
      }
    } catch {
      // ignore
    }
  }
}
