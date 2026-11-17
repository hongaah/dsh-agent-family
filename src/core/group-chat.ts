import { randomUUID } from 'node:crypto';

import type { FamilyHub } from './family-hub.ts';
import type { MemberRegistry } from './member-registry.ts';
import type { FamilyGroupRoom, FamilyMember, GroupMessage } from './types.ts';

export const MAX_GROUP_RELAY_TURNS = 6;
export const MAIN_GROUP_ID = 'family-main';

interface MutableGroupRoom {
  readonly id: string;
  title: string;
  readonly scopeId: string;
  memberIds: 'all_enabled' | readonly string[];
  messages: GroupMessage[];
  readCursors: Record<string, number>;
  activeSpeakerId: string | null;
  lastPassMemberName?: string;
  running: boolean;
  relayAbort: AbortController | null;
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
  private readonly rooms = new Map<string, MutableGroupRoom>();

  public constructor(hub: FamilyHub, registry: MemberRegistry) {
    this.hub = hub;
    this.registry = registry;
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
    this.ensureMainRoom(scopeId);
    const list: FamilyGroupRoom[] = [];
    for (const room of this.rooms.values()) {
      if (room.scopeId === scopeId) {
        list.push(this.toImmutable(room));
      }
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
      activeSpeakerId: null,
      running: false,
      relayAbort: null,
    };
    this.rooms.set(this.roomKey(input.scopeId, id), room);
    const snapshot = this.toImmutable(room);
    this.hub.emit({ type: 'group_updated', room: snapshot });
    return snapshot;
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

    // 若群内上一轮接龙仍在跑，人类或新消息插话先中止上一轮未完接龙
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
      senderAvatar: input.senderAvatar ?? '🧑‍💻',
      content: input.content.trim(),
      mentions,
      createdAt: new Date().toISOString(),
    };
    room.messages.push(triggerMsg);
    // 发言者本人自然已读截至自己发出的这条消息
    if (memberIdSet.has(input.senderId)) {
      room.readCursors[input.senderId] = room.messages.length;
    }
    room.lastPassMemberName = undefined;

    const relayController = new AbortController();
    room.relayAbort = relayController;
    room.running = true;
    this.broadcast(room);

    // 初始化发言话筒队列：有点名则仅唤醒被点名成员；无点名则群内其他在岗成员依次看群
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
        this.broadcast(room);

        // 标记该成员已读到当前群消息末尾
        room.readCursors[speaker.id] = room.messages.length;
        const promptForSpeaker = this.formatUnreadGroupDelta(room, speaker, unreadMessages, activeMembers);

        let replyText = '';
        try {
          const outcome = await this.hub.sendMemberMessage({
            scopeId: input.scopeId,
            memberId: speaker.id,
            senderRole: 'peer',
            senderName: `👥 ${room.title}`,
            message: promptForSpeaker,
            cwd: input.cwd,
            callChain: input.parentCallChain ?? [],
            activeGroupHold: room.id,
            recordInFeed: true,
            signal: relayController.signal,
          });
          replyText = outcome.finalText.trim();
        } catch {
          if (relayController.signal.aborted) break;
          continue;
        }

        if (relayController.signal.aborted) break;

        if (isPassReply(replyText)) {
          room.lastPassMemberName = speaker.name;
          this.broadcast(room);
          continue;
        }

        substantiveTurns += 1;
        const replyMentions = extractMemberMentions(replyText, memberIdSet).filter(
          (id) => id !== speaker.id
        );
        const speakerMsg: GroupMessage = {
          id: randomUUID(),
          groupId: room.id,
          senderId: speaker.id,
          senderName: speaker.name,
          senderAvatar: speaker.avatar,
          content: replyText,
          mentions: replyMentions,
          createdAt: new Date().toISOString(),
        };
        room.messages.push(speakerMsg);
        // 成员自己刚刚发出的群消息标记为本人已读
        room.readCursors[speaker.id] = room.messages.length;
        this.broadcast(room);

        // 将其 @ 点名的其他群成员加入话筒接龙队列
        for (const mentionedId of replyMentions) {
          enqueueSpeaker(mentionedId);
        }
      }
    } finally {
      if (room.relayAbort === relayController) {
        room.relayAbort = null;
        room.activeSpeakerId = null;
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
      title: '🏠 家庭总群',
      scopeId,
      memberIds: 'all_enabled',
      messages: [],
      readCursors: {},
      activeSpeakerId: null,
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
    roomMembers: readonly FamilyMember[]
  ): string {
    const peersDesc = roomMembers
      .filter((m) => m.id !== receiver.id)
      .map((m) => `${m.name}(@${m.id})`)
      .join('、');

    const transcript = unread
      .map((m) => {
        const handle = m.senderId === 'human' || m.senderId === 'lead' ? '' : ` (@${m.senderId})`;
        return `[${m.senderName}${handle}]: ${m.content}`;
      })
      .join('\n\n');

    return [
      `👥 【家庭群聊「${room.title}」未读新消息】`,
      `群内其他在岗成员：${peersDesc || '暂无其他成员'}`,
      `---`,
      transcript,
      `---`,
      `【你的群聊回应准则】`,
      `1. 你现在正拿着群聊话筒，回复内容将直接发到「${room.title}」群里，无需再调用 phone_group_discuss 工具；`,
      `2. 请结合你的专长（${receiver.specialty}）直接发表具体方案、认领动作、指出前面成员方案的问题或明确拒绝不合理诉求；`,
      `3. 若需要群里某位成员接着表态或配合，请在回复中用 \`@成员ID\` 点名 TA；`,
      `4. 若前面成员已经说得很完善、当前不需要你插话，请只回复 \`[PASS]\` 保持安静旁听。`,
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
      activeSpeakerId: room.activeSpeakerId,
      lastPassMemberName: room.lastPassMemberName,
      running: room.running,
    };
  }

  private roomKey(scopeId: string, groupId: string): string {
    return `${scopeId}::${groupId}`;
  }
}
