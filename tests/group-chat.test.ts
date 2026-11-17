import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { FamilyHub } from '../src/core/family-hub.ts';
import { GroupChatEngine } from '../src/core/group-chat.ts';
import { MemberRegistry } from '../src/core/member-registry.ts';
import type { MemberStreamEvent, PhoneMcpLaunchSpec } from '../src/core/types.ts';
import {
  AsyncEventQueue,
  type AwakenMemberContext,
  type BodyDriver,
  type LiveMemberSession,
} from '../src/drivers/driver.ts';
import { FamilyPhoneBus } from '../src/phone/phone-bus.ts';

function makeMockDriver(
  responder: (memberId: string, prompt: string, phoneMcp: PhoneMcpLaunchSpec) => Promise<string>
): BodyDriver {
  return {
    kind: 'claude',
    awaken: async (context: AwakenMemberContext): Promise<LiveMemberSession> => ({
      bodyKind: 'claude',
      isAlive: () => true,
      sendTurn: (prompt: string): AsyncIterable<MemberStreamEvent> => {
        const q = new AsyncEventQueue<MemberStreamEvent>();
        void responder(context.member.id, prompt, context.phoneMcp)
          .then((text) => {
            q.push({ kind: 'text_delta', delta: text });
            q.push({ kind: 'turn_done', finalText: text });
            q.close();
          })
          .catch((err: unknown) => q.fail(err instanceof Error ? err : new Error(String(err))));
        return q;
      },
      replyApproval: async () => undefined,
      dispose: async () => undefined,
    }),
  };
}

describe('GroupChatEngine (Family Group Chat, Unread Delta, @Relay, [PASS], and Relay Cap)', () => {
  let tempDir: string;
  let registry: MemberRegistry;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'dsh-agent-family-group-'));
    registry = new MemberRegistry(tempDir);
    registry.create({
      id: 'arch-bro',
      name: '架构师大哥',
      avatar: '🏛️',
      specialty: '架构',
      body: { kind: 'claude' },
      soulPrompt: '架构师',
    });
    registry.create({
      id: 'fe-sis',
      name: '前端妹妹',
      avatar: '🎨',
      specialty: '前端',
      body: { kind: 'claude' },
      soulPrompt: '前端',
    });
    registry.create({
      id: 'qa-guard',
      name: '审查小弟',
      avatar: '🛡️',
      specialty: '测试',
      body: { kind: 'claude' },
      soulPrompt: '测试',
    });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('delivers unread group deltas so later speakers see earlier speakers proposals, and suppresses [PASS] bubbles', async () => {
    const promptsSeenByMember: Record<string, string[]> = {};

    const driver = makeMockDriver(async (memberId, prompt) => {
      promptsSeenByMember[memberId] ??= [];
      promptsSeenByMember[memberId]!.push(prompt);

      if (memberId === 'arch-bro') {
        return '我建议采用双 Token 方案，前端改造一下拦截器。';
      }
      if (memberId === 'fe-sis') {
        // 验证前端妹妹看到了大哥刚刚在群里发的话
        expect(prompt).toContain('双 Token 方案');
        return '不同意双 Token 存 localStorage，容易 XSS，我要求改用 HttpOnly Cookie！';
      }
      return '[PASS]';
    });

    const hub = new FamilyHub({ registry, drivers: [driver] });
    const groupEngine = new GroupChatEngine(hub, registry);
    hub.attachGroupEngine(groupEngine);

    const roomAfterRound1 = await groupEngine.postMessage({
      scopeId: 's1',
      groupId: 'family-main',
      senderId: 'human',
      senderName: '家长',
      senderAvatar: '🧑‍💻',
      content: '大家讨论一下登录鉴权方案怎么定？',
      cwd: tempDir,
    });

    // 人类 1 条 + 大哥 1 条 + 妹妹 1 条 = 3 条（qa-guard 回复 [PASS] 不产生废话气泡）
    expect(roomAfterRound1.messages).toHaveLength(3);
    expect(roomAfterRound1.messages[2]?.content).toContain('HttpOnly Cookie');
    expect(roomAfterRound1.lastPassMemberName).toBe('审查小弟');

    // 第二轮人类只点名 @arch-bro 拍板，验证大哥只收到上次自己发言之后的「未读增量」（含妹妹的反对意见 + 人类拍板，不重复包含第一条旧人类消息）
    await groupEngine.postMessage({
      scopeId: 's1',
      groupId: 'family-main',
      senderId: 'human',
      senderName: '家长',
      senderAvatar: '🧑‍💻',
      content: '@arch-bro 听妹妹的，按 HttpOnly Cookie 改方案吧',
      cwd: tempDir,
    });

    const archSecondPrompt = promptsSeenByMember['arch-bro']?.[1] ?? '';
    expect(archSecondPrompt).toContain('HttpOnly Cookie');
    expect(archSecondPrompt).not.toContain('大家讨论一下登录鉴权方案怎么定？');

    await hub.dispose();
  });

  it('relays the microphone via @mentions and caps free-for-all ping-pong at MAX_GROUP_RELAY_TURNS = 6', async () => {
    let pingCount = 0;
    const driver = makeMockDriver(async (memberId) => {
      pingCount += 1;
      if (memberId === 'arch-bro') {
        return `大哥第${pingCount}次发言，请 @fe-sis 继续说`;
      }
      return `妹妹第${pingCount}次回应，请 @arch-bro 再确认`;
    });

    const hub = new FamilyHub({ registry, drivers: [driver] });
    const groupEngine = new GroupChatEngine(hub, registry);
    hub.attachGroupEngine(groupEngine);

    const room = await groupEngine.postMessage({
      scopeId: 's2',
      groupId: 'family-main',
      senderId: 'human',
      senderName: '家长',
      senderAvatar: '🧑‍💻',
      content: '@arch-bro 开始跟妹妹对细节',
      cwd: tempDir,
    });

    expect(pingCount).toBe(6);
    const agentMessages = room.messages.filter(
      (m) => m.senderId !== 'human' && m.senderId !== 'system'
    );
    expect(agentMessages).toHaveLength(6);

    await hub.dispose();
  });

  it('allows an agent working on a private task to convene a multi-member group discussion via phone_group_discuss without deadlocking', async () => {
    const driver = makeMockDriver(async (memberId, prompt, phoneMcp) => {
      if (memberId === 'arch-bro' && prompt.includes('统筹任务')) {
        const res = await fetch(phoneMcp.httpUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${phoneMcp.bearerToken}`,
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/call',
            params: {
              name: 'phone_group_discuss',
              arguments: {
                title: '接口对齐小群',
                participants: ['arch-bro', 'fe-sis', 'qa-guard'],
                message: '请 @fe-sis 和 @qa-guard 评估新接口耗时预算，哪怕 @arch-bro 反问我也直接说在群里',
              },
            },
          }),
        });
        const payload = (await res.json()) as {
          result?: { content?: Array<{ text: string }> };
        };
        const transcript = payload.result?.content?.[0]?.text ?? '';
        return `大哥开完小会拿到结论 => ${transcript}`;
      }
      if (memberId === 'fe-sis') {
        return '前端要求首屏接口 200ms 内返回，顺便 @arch-bro 注意分页字段！';
      }
      if (memberId === 'qa-guard') {
        return '测试这周末补压测脚本。';
      }
      return '[PASS]';
    });

    const hub = new FamilyHub({ registry, drivers: [driver] });
    const groupEngine = new GroupChatEngine(hub, registry);
    hub.attachGroupEngine(groupEngine);
    const phoneBus = new FamilyPhoneBus(hub);
    await phoneBus.start();
    hub.attachPhoneBus(phoneBus);

    const outcome = await hub.sendMemberMessage({
      scopeId: 's3',
      memberId: 'arch-bro',
      senderRole: 'human',
      senderName: '家长',
      message: '统筹任务：拉小群定接口预算',
      cwd: tempDir,
    });

    expect(outcome.finalText).toContain('200ms');
    expect(outcome.finalText).toContain('补压测脚本');

    await hub.dispose();
    await phoneBus.stop();
  });

  it('does not instruct the sole or first unanswered speaker in a group to reply [PASS]', async () => {
    registry.update('fe-sis', { enabled: false });
    registry.update('qa-guard', { enabled: false });

    let capturedPrompt = '';
    const driver = makeMockDriver(async (_memberId, prompt) => {
      capturedPrompt = prompt;
      return '肥鱼酱在呢！';
    });

    const hub = new FamilyHub({ registry, drivers: [driver] });
    const groupEngine = new GroupChatEngine(hub, registry);
    hub.attachGroupEngine(groupEngine);

    const room = await groupEngine.postMessage({
      scopeId: 's-sole',
      groupId: 'family-main',
      senderId: 'human',
      senderName: '你',
      senderAvatar: '🧑‍💻',
      content: '有人在吗',
      cwd: tempDir,
    });

    expect(capturedPrompt).not.toContain('只回复 `[PASS]`');
    expect(room.messages).toHaveLength(2);
    expect(room.messages[1]?.content).toBe('肥鱼酱在呢！');
    // 群聊内部提示词不应污染成员的一对一私聊记录
    expect(hub.getMemberSnapshot('s-sole', 'arch-bro').entries).toHaveLength(0);

    await hub.dispose();
  });

  it('streams live speaker draft into FamilyGroupRoom during group speech, persists UI history across restarts, and supports clearing', async () => {
    const chunkedDriver: BodyDriver = {
      kind: 'claude',
      awaken: async (): Promise<LiveMemberSession> => ({
        bodyKind: 'claude',
        isAlive: () => true,
        sendTurn: (): AsyncIterable<MemberStreamEvent> => {
          const q = new AsyncEventQueue<MemberStreamEvent>();
          setTimeout(() => {
            q.push({ kind: 'status', summary: '读取接口文件' });
            q.push({ kind: 'text_delta', delta: '第一段、' });
            q.push({ kind: 'text_delta', delta: '第二段结论' });
            q.push({ kind: 'turn_done', finalText: '第一段、第二段结论' });
            q.close();
          }, 5);
          return q;
        },
        replyApproval: async () => undefined,
        dispose: async () => undefined,
      }),
    };

    registry.update('fe-sis', { enabled: false });
    registry.update('qa-guard', { enabled: false });

    const hub1 = new FamilyHub({ registry, drivers: [chunkedDriver], storageDir: tempDir });
    const group1 = new GroupChatEngine(hub1, registry, tempDir);
    hub1.attachGroupEngine(group1);

    const streamingDraftsSeen: string[] = [];
    hub1.subscribe((ev) => {
      if (ev.type === 'group_updated' && ev.room.streamingDraft?.content) {
        streamingDraftsSeen.push(ev.room.streamingDraft.content);
      }
    });

    const settledRoom = await group1.postMessage({
      scopeId: 'persist-scope',
      groupId: 'family-main',
      senderId: 'human',
      senderName: '你',
      content: '汇报进度',
      cwd: tempDir,
    });

    expect(streamingDraftsSeen.some((txt) => txt.includes('第一段'))).toBe(true);
    expect(settledRoom.streamingDraft).toBeNull();
    expect(settledRoom.messages).toHaveLength(2);
    await hub1.dispose();

    // 模拟重启 DSH 后重新加载客厅 UI 历史
    const hub2 = new FamilyHub({ registry, drivers: [chunkedDriver], storageDir: tempDir });
    const group2 = new GroupChatEngine(hub2, registry, tempDir);
    hub2.attachGroupEngine(group2);

    const restored = group2.getOrCreateMainRoom('persist-scope');
    expect(restored.messages).toHaveLength(2);
    expect(restored.messages[1]?.content).toBe('第一段、第二段结论');

    const cleared = group2.clearRoomMessages('persist-scope', 'family-main');
    expect(cleared.messages).toHaveLength(0);
    await hub2.dispose();
  });
});
