import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { FamilyHub } from '../src/core/family-hub.ts';
import { MemberRegistry } from '../src/core/member-registry.ts';
import type {
  BodyKind,
  FamilyRealtimeEvent,
  MemberStreamEvent,
  PhoneMcpLaunchSpec,
} from '../src/core/types.ts';
import {
  AsyncEventQueue,
  type AwakenMemberContext,
  type BodyDriver,
  type LiveMemberSession,
} from '../src/drivers/driver.ts';
import { FamilyPhoneBus, resolvePhoneMcpScriptPath } from '../src/phone/phone-bus.ts';

type ScriptedBehavior = (ctx: {
  prompt: string;
  phoneMcp: PhoneMcpLaunchSpec;
  emitApproval?: () => Promise<string>;
}) => Promise<string>;

function createScriptedDriver(
  kind: BodyKind,
  behaviors: Readonly<Record<string, ScriptedBehavior>>
): BodyDriver {
  return {
    kind,
    awaken: async (context: AwakenMemberContext): Promise<LiveMemberSession> => {
      let alive = true;
      const pendingApprovals = new Map<string, (optionId: string) => void>();

      return {
        bodyKind: kind,
        isAlive: () => alive,
        sendTurn: (prompt: string): AsyncIterable<MemberStreamEvent> => {
          const queue = new AsyncEventQueue<MemberStreamEvent>();
          const handler = behaviors[context.member.id];
          if (!handler) {
            queue.fail(new Error(`No scripted behavior for ${context.member.id}`));
            return queue;
          }

          void handler({
            prompt,
            phoneMcp: context.phoneMcp,
            emitApproval: () =>
              new Promise<string>((resolveChoice) => {
                const reqId = `req-${Date.now()}`;
                pendingApprovals.set(reqId, resolveChoice);
                queue.push({
                  kind: 'approval_requested',
                  requestId: reqId,
                  title: '执行敏感命令确认',
                  options: [
                    { optionId: 'allow', label: '同意', kind: 'allow' },
                    { optionId: 'deny', label: '拒绝', kind: 'deny' },
                  ],
                });
              }),
          })
            .then((reply) => {
              queue.push({ kind: 'text_delta', delta: reply });
              queue.push({ kind: 'turn_done', finalText: reply });
              queue.close();
            })
            .catch((err: unknown) => {
              queue.fail(err instanceof Error ? err : new Error(String(err)));
            });

          return queue;
        },
        replyApproval: async (requestId: string, optionId: string): Promise<void> => {
          const resolver = pendingApprovals.get(requestId);
          pendingApprovals.delete(requestId);
          resolver?.(optionId);
        },
        dispose: async (): Promise<void> => {
          alive = false;
        },
      };
    },
  };
}

async function callMcpTool(
  spec: PhoneMcpLaunchSpec,
  name: string,
  args: Record<string, unknown> = {}
): Promise<string> {
  const res = await fetch(spec.httpUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${spec.bearerToken}`,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name, arguments: args },
    }),
  });
  expect(res.status).toBe(200);
  const json = (await res.json()) as {
    result?: { content?: Array<{ type: string; text: string }> };
  };
  return json.result?.content?.[0]?.text ?? '';
}

describe('FamilyHub & FamilyPhoneBus (Collaboration, Refusal, Anti-Deadlock & Approvals)', () => {
  let tempDir: string;
  let registry: MemberRegistry;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'dsh-agent-family-phone-'));
    registry = new MemberRegistry(tempDir);
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('supports member-to-member phone_contacts + phone_call and preserves callee autonomy to refuse unreasonable requests', async () => {
    registry.create({
      id: 'arch-bro',
      name: '架构师大哥',
      avatar: '🏛️',
      specialty: '架构设计',
      body: { kind: 'claude' },
      soulPrompt: '负责统筹协调。',
    });
    registry.create({
      id: 'fe-sis',
      name: '前端妹妹',
      avatar: '🎨',
      specialty: '前端组件与交互',
      body: { kind: 'claude' },
      soulPrompt: '坚守前端边界，拒绝直接修改生产数据库脚本。',
    });

    const driver = createScriptedDriver('claude', {
      'arch-bro': async ({ phoneMcp }) => {
        const contacts = await callMcpTool(phoneMcp, 'phone_contacts');
        expect(contacts).toContain('fe-sis');
        const callRes = await callMcpTool(phoneMcp, 'phone_call', {
          to: 'fe-sis',
          intent: 'request_help',
          message: '顺手帮我把生产库 DROP TABLE 迁移脚本执行一下吧',
        });
        return `大哥收到妹妹答复 => ${callRes}`;
      },
      'fe-sis': async ({ prompt }) => {
        expect(prompt).toContain('架构师大哥');
        return '我拒绝执行：生产数据库迁移超出前端职责边界且风险极高，请联系后端处理。';
      },
    });

    const hub = new FamilyHub({
      registry,
      drivers: [driver],
    });
    const phoneBus = new FamilyPhoneBus(hub);
    await phoneBus.start();
    hub.attachPhoneBus(phoneBus);

    const events: FamilyRealtimeEvent[] = [];
    hub.subscribe((ev) => events.push(ev));

    const outcome = await hub.sendMemberMessage({
      scopeId: 'sess-1',
      memberId: 'arch-bro',
      senderRole: 'human',
      senderName: '家长',
      message: '推进改版并找妹妹帮忙',
      cwd: tempDir,
    });

    expect(outcome.finalText).toContain('我拒绝执行');
    const phoneEvents = events.filter((e) => e.type === 'phone_call_updated');
    expect(phoneEvents.some((e) => e.record.status === 'completed')).toBe(true);

    await hub.dispose();
    await phoneBus.stop();
  });

  it('prevents A -> B -> A synchronous deadlock by returning immediate busy notice on re-entrant callback', async () => {
    registry.create({
      id: 'arch-bro',
      name: '架构师大哥',
      avatar: '🏛️',
      specialty: '架构',
      body: { kind: 'claude' },
      soulPrompt: '架构',
    });
    registry.create({
      id: 'be-bro',
      name: '后端二哥',
      avatar: '⚙️',
      specialty: '后端',
      body: { kind: 'claude' },
      soulPrompt: '后端',
    });

    const driver = createScriptedDriver('claude', {
      'arch-bro': async ({ phoneMcp }) => {
        const reply = await callMcpTool(phoneMcp, 'phone_call', {
          to: 'be-bro',
          intent: 'discuss',
          message: '接口字段定了吗？',
        });
        return `未死锁完成:${reply}`;
      },
      'be-bro': async ({ phoneMcp }) => {
        // 试图在接听大哥电话期间反向拨给大哥
        const callbackAttempt = await callMcpTool(phoneMcp, 'phone_call', {
          to: 'arch-bro',
          intent: 'discuss',
          message: '我反拨问你一句',
        });
        expect(callbackAttempt).toContain('正拿着电话等待你的本次回复');
        return '我直接在电话里回你：定好了用 userId。';
      },
    });

    const hub = new FamilyHub({ registry, drivers: [driver] });
    const phoneBus = new FamilyPhoneBus(hub);
    await phoneBus.start();
    hub.attachPhoneBus(phoneBus);

    const res = await hub.sendMemberMessage({
      scopeId: 'sess-deadlock',
      memberId: 'arch-bro',
      senderRole: 'human',
      senderName: '家长',
      message: '对齐接口',
      cwd: tempDir,
    });

    expect(res.finalText).toContain('未死锁完成');
    expect(res.finalText).toContain('定好了用 userId');

    await hub.dispose();
    await phoneBus.stop();
  });

  it('enforces MAX_CALL_HOPS = 3 to prevent infinite call forwarding chains and rejects unauthorized bus requests', async () => {
    for (const id of ['m-one', 'm-two', 'm-three', 'm-four', 'm-five']) {
      registry.create({
        id,
        name: id,
        avatar: '🧑',
        specialty: '研发',
        body: { kind: 'claude' },
        soulPrompt: '研发',
      });
    }

    let capturedUrl = '';
    const driver = createScriptedDriver('claude', {
      'm-one': async ({ phoneMcp }) => {
        capturedUrl = phoneMcp.httpUrl;
        return callMcpTool(phoneMcp, 'phone_call', { to: 'm-two', intent: 'discuss', message: 'hop1' });
      },
      'm-two': async ({ phoneMcp }) =>
        callMcpTool(phoneMcp, 'phone_call', { to: 'm-three', intent: 'discuss', message: 'hop2' }),
      'm-three': async ({ phoneMcp }) =>
        callMcpTool(phoneMcp, 'phone_call', { to: 'm-four', intent: 'discuss', message: 'hop3' }),
      'm-four': async ({ phoneMcp }) =>
        callMcpTool(phoneMcp, 'phone_call', { to: 'm-five', intent: 'discuss', message: 'hop4-blocked' }),
      'm-five': async () => '绝不应到达第5人',
    });

    const hub = new FamilyHub({ registry, drivers: [driver] });
    const phoneBus = new FamilyPhoneBus(hub);
    await phoneBus.start();
    hub.attachPhoneBus(phoneBus);

    const res = await hub.sendMemberMessage({
      scopeId: 'sess-hops',
      memberId: 'm-one',
      senderRole: 'human',
      senderName: '家长',
      message: '开始链式请教',
      cwd: tempDir,
    });

    expect(res.finalText).toContain('上限');
    expect(res.finalText).not.toContain('绝不应到达第5人');

    const unauth = await fetch(capturedUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer wrong-token' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(unauth.status).toBe(401);

    await hub.dispose();
    await phoneBus.stop();
  });

  it('tracks pending approvals in FamilyHub and forwards user choice back to waiting member', async () => {
    registry.create({
      id: 'ops-bro',
      name: '运维大哥',
      avatar: '🔧',
      specialty: '部署',
      body: { kind: 'claude' },
      soulPrompt: '部署',
    });

    const driver = createScriptedDriver('claude', {
      'ops-bro': async ({ emitApproval }) => {
        const decision = await emitApproval!();
        return `用户批复=${decision}`;
      },
    });

    const hub = new FamilyHub({ registry, drivers: [driver] });
    const phoneBus = new FamilyPhoneBus(hub);
    await phoneBus.start();
    hub.attachPhoneBus(phoneBus);

    hub.subscribe((ev) => {
      if (ev.type === 'approval_opened') {
        expect(hub.listPendingApprovals()).toHaveLength(1);
        void hub.replyApproval(ev.approval.approvalId, 'allow');
      }
    });

    const res = await hub.sendMemberMessage({
      scopeId: 'sess-app',
      memberId: 'ops-bro',
      senderRole: 'human',
      senderName: '家长',
      message: '执行部署',
      cwd: tempDir,
    });

    expect(res.finalText).toBe('用户批复=allow');
    expect(hub.listPendingApprovals()).toHaveLength(0);

    await hub.dispose();
    await phoneBus.stop();
  });

  it('proxies stdio MCP JSON-RPC calls through phone-mcp-stdio entrypoint end-to-end', async () => {
    registry.create({
      id: 'fe-sis',
      name: '前端妹妹',
      avatar: '🎨',
      specialty: '前端架构',
      body: { kind: 'claude' },
      soulPrompt: '前端',
    });

    const hub = new FamilyHub({ registry, drivers: [] });
    const phoneBus = new FamilyPhoneBus(hub);
    await phoneBus.start();
    hub.attachPhoneBus(phoneBus);

    const spec = phoneBus.buildLaunchSpec('sess-stdio', 'fe-sis');
    const child = spawn(spec.command, [...spec.args], {
      env: { ...process.env, ...spec.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const responseLine = await new Promise<string>((resolveLine, rejectLine) => {
      child.stdout.once('data', (chunk: Buffer) => {
        resolveLine(chunk.toString('utf8').trim());
      });
      child.once('error', rejectLine);
      child.stdin.write(
        `${JSON.stringify({
          jsonrpc: '2.0',
          id: 99,
          method: 'tools/call',
          params: { name: 'phone_contacts', arguments: {} },
        })}\n`
      );
    });

    child.kill();
    const parsed = JSON.parse(responseLine) as {
      id: number;
      result?: { content?: Array<{ text: string }> };
    };
    expect(parsed.id).toBe(99);
    expect(parsed.result?.content?.[0]?.text).toContain('前端妹妹');

    await hub.dispose();
    await phoneBus.stop();
  });

  it('resolves phone-mcp.js accurately from bundled dist directory, awaits unstarted phoneBus automatically, and persists callRecords', async () => {
    // 1. 模拟生产环境打包后的 ~/.dsh/profiles/desktop/node_modules/dsh-agent-family/dist 目录结构
    const simulatedPkgRoot = join(tempDir, 'simulated-pkg');
    const simulatedDist = join(simulatedPkgRoot, 'dist');
    mkdirSync(simulatedDist, { recursive: true });
    const bundledMcp = join(simulatedDist, 'phone-mcp.js');
    writeFileSync(bundledMcp, '#!/usr/bin/env node\n', 'utf8');

    expect(resolvePhoneMcpScriptPath(simulatedDist)).toBe(bundledMcp);

    // 2. 验证即使 phoneBus 尚未显式 await start()，首次唤醒成员时也会自动等待端口就绪并生成真实存在的脚本路径
    registry.create({
      id: 'fe-codex',
      name: '小前端',
      avatar: 'lobe:codex',
      specialty: '前端快手',
      body: { kind: 'codex' },
      soulPrompt: '幽默接地气',
    });
    registry.create({
      id: 'dsh-chihuo',
      name: '肥鱼酱',
      avatar: 'lobe:deepseek',
      specialty: '干大白饭',
      body: { kind: 'codex' },
      soulPrompt: '嘴馋小鲸鱼',
    });

    const driver = createScriptedDriver('codex', {
      'fe-codex': async ({ phoneMcp }) => {
        expect(phoneMcp.httpUrl).not.toContain(':0/');
        expect(existsSync(phoneMcp.args[0] ?? '')).toBe(true);
        const callReply = await callMcpTool(phoneMcp, 'phone_call', {
          to: 'dsh-chihuo',
          intent: 'sync',
          message: '肥鱼酱在干饭吗？',
        });
        return `拨通成功:${callReply}`;
      },
      'dsh-chihuo': async () => '在吃大白饭 Token 呢！',
    });

    const hub1 = new FamilyHub({
      registry,
      drivers: [driver],
      storageDir: tempDir,
    });
    const unstartedBus = new FamilyPhoneBus(hub1);
    hub1.attachPhoneBus(unstartedBus);

    const outcome = await hub1.sendMemberMessage({
      scopeId: 'scope-persist',
      memberId: 'fe-codex',
      senderRole: 'human',
      senderName: '你',
      message: '给肥鱼酱打个电话',
      cwd: tempDir,
    });

    expect(outcome.finalText).toContain('在吃大白饭 Token 呢');
    expect(hub1.listPhoneCallRecords('scope-persist')).toHaveLength(1);

    await hub1.dispose();
    await unstartedBus.stop();

    // 3. 重建 FamilyHub 验证通话历史已落盘恢复
    const hub2 = new FamilyHub({
      registry,
      drivers: [],
      storageDir: tempDir,
    });
    const restoredCalls = hub2.listPhoneCallRecords('scope-persist');
    expect(restoredCalls).toHaveLength(1);
    expect(restoredCalls[0]?.toMemberName).toBe('肥鱼酱');
    expect(restoredCalls[0]?.status).toBe('completed');
    await hub2.dispose();
  });
});
