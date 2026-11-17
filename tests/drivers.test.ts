import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { FamilyMember, MemberStreamEvent, PhoneMcpLaunchSpec } from '../src/core/types.ts';
import { ClaudeDriver } from '../src/drivers/claude-driver.ts';
import { CodexDriver } from '../src/drivers/codex-driver.ts';
import { DshNativeDriver, type DshHostBridge } from '../src/drivers/dsh-native-driver.ts';
import { OpenCodeDriver } from '../src/drivers/opencode-driver.ts';

function makePhoneSpec(): PhoneMcpLaunchSpec {
  return {
    command: process.execPath,
    args: ['/fake/phone-mcp.js'],
    env: {
      DSH_FAMILY_BUS_URL: 'http://127.0.0.1:45678',
      DSH_FAMILY_BUS_TOKEN: 'secret-token',
      DSH_FAMILY_SCOPE_ID: 'session-1',
      DSH_FAMILY_CALLER_ID: 'member-1',
    },
    httpUrl: 'http://127.0.0.1:45678/mcp?scopeId=session-1&callerId=member-1',
    bearerToken: 'secret-token',
  };
}

function makeMember(
  id: string,
  kind: FamilyMember['body']['kind'],
  command?: string
): FamilyMember {
  return {
    id,
    name: `成员-${id}`,
    avatar: '🤖',
    specialty: '专项开发',
    body: { kind, ...(command ? { command } : {}) },
    soulPrompt: `灵魂守则-${id}`,
    enabled: true,
    createdAt: '2026-11-17T00:00:00.000Z',
    updatedAt: '2026-11-17T00:00:00.000Z',
  };
}

function writeExecutableScript(dir: string, filename: string, jsBody: string): string {
  const filePath = join(dir, filename);
  writeFileSync(filePath, `#!${process.execPath}\n${jsBody}\n`, 'utf8');
  chmodSync(filePath, 0o755);
  return filePath;
}

describe('Four Bidirectional Body Drivers', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'dsh-agent-family-drivers-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('ClaudeDriver drives persistent stream-json session, relays host permission approval, and keeps multi-turn memory in one process', async () => {
    const fakeClaude = writeExecutableScript(
      tempDir,
      'mock-claude.mjs',
      `
      import readline from 'node:readline';
      const args = process.argv.slice(2);
      const soulIdx = args.indexOf('--append-system-prompt');
      const soul = soulIdx >= 0 ? args[soulIdx + 1] : '';
      let turnCount = 0;
      let pendingPrompt = '';
      const rl = readline.createInterface({ input: process.stdin });
      rl.on('line', (line) => {
        const frame = JSON.parse(line);
        if (frame.type === 'user') {
          turnCount += 1;
          pendingPrompt = frame.message.content[0].text;
          if (turnCount === 1) {
            process.stdout.write(JSON.stringify({
              type: 'control_request',
              request_id: 'req-perm-1',
              request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'rm -rf tmp' } }
            }) + '\\n');
          } else {
            process.stdout.write(JSON.stringify({
              type: 'stream_event',
              event: { type: 'content_block_delta', delta: { type: 'text_delta', text: '第2轮记得:' + turnCount } }
            }) + '\\n');
            process.stdout.write(JSON.stringify({
              type: 'result',
              result: '第2轮记得:' + turnCount
            }) + '\\n');
          }
        } else if (frame.type === 'control_response') {
          const behavior = frame.response?.response?.behavior ?? 'deny';
          const text = '灵魂=' + (soul.includes('灵魂守则-claude') ? 'OK' : 'MISS') + '|审批=' + behavior + '|输入=' + pendingPrompt;
          process.stdout.write(JSON.stringify({
            type: 'stream_event',
            event: { type: 'content_block_delta', delta: { type: 'text_delta', text } }
          }) + '\\n');
          process.stdout.write(JSON.stringify({
            type: 'result',
            result: text
          }) + '\\n');
        }
      });
      `
    );

    const driver = new ClaudeDriver();
    const member = makeMember('claude-bro', 'claude', fakeClaude);
    const controller = new AbortController();
    const session = await driver.awaken({
      scopeId: 's1',
      member,
      composedSoul: '灵魂守则-claude',
      cwd: tempDir,
      phoneMcp: makePhoneSpec(),
      signal: controller.signal,
    });

    const events1: MemberStreamEvent[] = [];
    for await (const ev of session.sendTurn('清理临时目录', controller.signal)) {
      events1.push(ev);
      if (ev.kind === 'approval_requested') {
        expect(ev.title).toContain('Bash');
        await session.replyApproval(ev.requestId, 'allow');
      }
    }

    const done1 = events1.find((item) => item.kind === 'turn_done');
    expect(done1?.kind === 'turn_done' ? done1.finalText : '').toBe(
      '灵魂=OK|审批=allow|输入=清理临时目录'
    );

    const events2: MemberStreamEvent[] = [];
    for await (const ev of session.sendTurn('继续跟进', controller.signal)) {
      events2.push(ev);
    }
    const done2 = events2.find((item) => item.kind === 'turn_done');
    expect(done2?.kind === 'turn_done' ? done2.finalText : '').toBe('第2轮记得:2');

    await session.dispose();
  });

  it('CodexDriver drives app-server --stdio, injects developerInstructions without overriding approvalPolicy, and relays server approval requests', async () => {
    const fakeCodex = writeExecutableScript(
      tempDir,
      'mock-codex.mjs',
      `
      import readline from 'node:readline';
      let savedSoul = '';
      let hadApprovalOverride = false;
      let turnSeq = 0;
      const rl = readline.createInterface({ input: process.stdin });
      rl.on('line', (line) => {
        const msg = JSON.parse(line);
        if (msg.method === 'initialize') {
          process.stdout.write(JSON.stringify({ id: msg.id, result: { userAgent: 'mock-codex' } }) + '\\n');
        } else if (msg.method === 'thread/start') {
          savedSoul = msg.params.developerInstructions || '';
          hadApprovalOverride = msg.params.approvalPolicy !== undefined && msg.params.approvalPolicy !== null;
          process.stdout.write(JSON.stringify({
            id: msg.id,
            result: { thread: { id: 'thr_123' } }
          }) + '\\n');
        } else if (msg.method === 'turn/start') {
          turnSeq += 1;
          const userText = msg.params.input[0]?.text ?? '';
          const hasTextElements = Array.isArray(msg.params.input[0]?.text_elements);
          process.stdout.write(JSON.stringify({ id: msg.id, result: { turn: { id: 'turn_' + turnSeq } } }) + '\\n');
          if (turnSeq === 1) {
            process.stdout.write(JSON.stringify({
              id: 9001,
              method: 'item/commandExecution/requestApproval',
              params: { command: 'git commit -m test', cwd: '.' }
            }) + '\\n');
          } else {
            process.stdout.write(JSON.stringify({
              method: 'item/agentMessage/delta',
              params: { threadId: 'thr_123', turnId: 'turn_2', itemId: 'i2', delta: 'Codex轮次=' + turnSeq + ':' + userText }
            }) + '\\n');
            process.stdout.write(JSON.stringify({
              method: 'turn/completed',
              params: { threadId: 'thr_123', turn: { id: 'turn_2', status: 'completed' } }
            }) + '\\n');
          }
          globalThis.__hasTextElements = hasTextElements;
        } else if (msg.id === 9001 && msg.result) {
          const summary = 'Codex灵魂=' + (savedSoul.includes('灵魂守则-codex') ? 'OK' : 'NO')
            + '|零权限篡改=' + (!hadApprovalOverride)
            + '|textElements=' + Boolean(globalThis.__hasTextElements)
            + '|决策=' + msg.result.decision;
          process.stdout.write(JSON.stringify({
            method: 'item/agentMessage/delta',
            params: { threadId: 'thr_123', turnId: 'turn_1', itemId: 'i1', delta: summary }
          }) + '\\n');
          process.stdout.write(JSON.stringify({
            method: 'turn/completed',
            params: { threadId: 'thr_123', turn: { id: 'turn_1', status: 'completed' } }
          }) + '\\n');
        }
      });
      `
    );

    const driver = new CodexDriver();
    const member = makeMember('codex-bro', 'codex', fakeCodex);
    const controller = new AbortController();
    const session = await driver.awaken({
      scopeId: 's1',
      member,
      composedSoul: '灵魂守则-codex',
      cwd: tempDir,
      phoneMcp: makePhoneSpec(),
      signal: controller.signal,
    });

    const events: MemberStreamEvent[] = [];
    for await (const ev of session.sendTurn('提交代码', controller.signal)) {
      events.push(ev);
      if (ev.kind === 'approval_requested') {
        expect(ev.options.map((o) => o.optionId)).toContain('accept');
        await session.replyApproval(ev.requestId, 'acceptForSession');
      }
    }

    const done = events.find((item) => item.kind === 'turn_done');
    expect(done?.kind === 'turn_done' ? done.finalText : '').toBe(
      'Codex灵魂=OK|零权限篡改=true|textElements=true|决策=acceptForSession'
    );

    const events2: MemberStreamEvent[] = [];
    for await (const ev of session.sendTurn('查日志', controller.signal)) {
      events2.push(ev);
    }
    const done2 = events2.find((item) => item.kind === 'turn_done');
    expect(done2?.kind === 'turn_done' ? done2.finalText : '').toBe('Codex轮次=2:查日志');

    await session.dispose();
  });

  it('OpenCodeDriver drives opencode acp, attaches HTTP family_phone MCP, injects soul once, and forwards native permission options verbatim', async () => {
    const fakeOpenCode = writeExecutableScript(
      tempDir,
      'mock-opencode.mjs',
      `
      import readline from 'node:readline';
      let mcpCount = 0;
      let promptCalls = 0;
      let pendingPromptId = null;
      let firstText = '';
      const rl = readline.createInterface({ input: process.stdin });
      rl.on('line', (line) => {
        const msg = JSON.parse(line);
        if (msg.method === 'initialize') {
          process.stdout.write(JSON.stringify({
            jsonrpc: '2.0',
            id: msg.id,
            result: { protocolVersion: 1, agentCapabilities: { mcpCapabilities: { http: true } } }
          }) + '\\n');
        } else if (msg.method === 'session/new') {
          mcpCount = Array.isArray(msg.params.mcpServers) ? msg.params.mcpServers.length : 0;
          process.stdout.write(JSON.stringify({
            jsonrpc: '2.0',
            id: msg.id,
            result: { sessionId: 'ses_abc' }
          }) + '\\n');
        } else if (msg.method === 'session/prompt') {
          promptCalls += 1;
          const fullText = msg.params.prompt.map(b => b.text).join('\\n');
          if (promptCalls === 1) {
            firstText = fullText;
            pendingPromptId = msg.id;
            process.stdout.write(JSON.stringify({
              jsonrpc: '2.0',
              id: 'perm_77',
              method: 'session/request_permission',
              params: {
                sessionId: 'ses_abc',
                toolCall: { title: '编辑 App.vue' },
                options: [
                  { optionId: 'allow_once_native', name: '仅允许本次', kind: 'allow_once' },
                  { optionId: 'reject_native', name: '拒绝此修改', kind: 'reject_once' }
                ]
              }
            }) + '\\n');
          } else {
            const hasDuplicateSoul = fullText.includes('灵魂守则-opencode');
            process.stdout.write(JSON.stringify({
              jsonrpc: '2.0',
              method: 'session/update',
              params: {
                sessionId: 'ses_abc',
                update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '第2轮无重复灵魂=' + (!hasDuplicateSoul) } }
              }
            }) + '\\n');
            process.stdout.write(JSON.stringify({
              jsonrpc: '2.0',
              id: msg.id,
              result: { stopReason: 'end_turn' }
            }) + '\\n');
          }
        } else if (msg.id === 'perm_77' && msg.result) {
          const chosen = msg.result.outcome?.optionId;
          const reply = 'MCP=' + mcpCount + '|首轮含灵魂=' + firstText.includes('灵魂守则-opencode') + '|选项=' + chosen;
          process.stdout.write(JSON.stringify({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: 'ses_abc',
              update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: reply } }
            }
          }) + '\\n');
          process.stdout.write(JSON.stringify({
            jsonrpc: '2.0',
            id: pendingPromptId,
            result: { stopReason: 'end_turn' }
          }) + '\\n');
        }
      });
      `
    );

    const driver = new OpenCodeDriver();
    const member = makeMember('fe-sis', 'opencode', fakeOpenCode);
    const controller = new AbortController();
    const session = await driver.awaken({
      scopeId: 's1',
      member,
      composedSoul: '灵魂守则-opencode',
      cwd: tempDir,
      phoneMcp: makePhoneSpec(),
      signal: controller.signal,
    });

    const events1: MemberStreamEvent[] = [];
    for await (const ev of session.sendTurn('优化按钮圆角', controller.signal)) {
      events1.push(ev);
      if (ev.kind === 'approval_requested') {
        expect(ev.options.map((o) => o.optionId)).toEqual(['allow_once_native', 'reject_native']);
        await session.replyApproval(ev.requestId, 'allow_once_native');
      }
    }

    const done1 = events1.find((item) => item.kind === 'turn_done');
    expect(done1?.kind === 'turn_done' ? done1.finalText : '').toBe(
      'MCP=1|首轮含灵魂=true|选项=allow_once_native'
    );

    const events2: MemberStreamEvent[] = [];
    for await (const ev of session.sendTurn('再调下间距', controller.signal)) {
      events2.push(ev);
    }
    const done2 = events2.find((item) => item.kind === 'turn_done');
    expect(done2?.kind === 'turn_done' ? done2.finalText : '').toBe('第2轮无重复灵魂=true');

    await session.dispose();
  });

  it('DshNativeDriver delegates turns through DshHostBridge and preserves per-member continuity', async () => {
    const calls: string[] = [];
    const bridge: DshHostBridge = {
      isAvailable: () => true,
      runTurn: async ({ member, prompt, isFirstTurn, composedSoul }) => {
        calls.push(`${member.id}:${isFirstTurn ? 'init' : 'cont'}:${prompt}`);
        return `DSH回执(${isFirstTurn ? composedSoul : '续聊'}):${prompt}`;
      },
    };

    const driver = new DshNativeDriver(bridge);
    const member = makeMember('qa-guard', 'dsh');
    const controller = new AbortController();
    const session = await driver.awaken({
      scopeId: 's1',
      member,
      composedSoul: '灵魂守则-dsh',
      cwd: tempDir,
      phoneMcp: makePhoneSpec(),
      signal: controller.signal,
    });

    const out1: MemberStreamEvent[] = [];
    for await (const ev of session.sendTurn('检查单测', controller.signal)) {
      out1.push(ev);
    }
    expect(out1.find((e) => e.kind === 'turn_done')).toEqual({
      kind: 'turn_done',
      finalText: 'DSH回执(灵魂守则-dsh):检查单测',
    });

    const out2: MemberStreamEvent[] = [];
    for await (const ev of session.sendTurn('复核覆盖率', controller.signal)) {
      out2.push(ev);
    }
    expect(out2.find((e) => e.kind === 'turn_done')).toEqual({
      kind: 'turn_done',
      finalText: 'DSH回执(续聊):复核覆盖率',
    });
    expect(calls).toHaveLength(2);

    await session.dispose();
  });

  it('surfaces unexpected CLI crash cleanly without hanging the caller', async () => {
    const crashingCli = writeExecutableScript(
      tempDir,
      'crash-claude.mjs',
      `
      process.stdin.once('data', () => {
        process.stderr.write('simulated fatal panic\\n');
        process.exit(42);
      });
      `
    );

    const driver = new ClaudeDriver();
    const member = makeMember('crasher', 'claude', crashingCli);
    const controller = new AbortController();
    const session = await driver.awaken({
      scopeId: 's1',
      member,
      composedSoul: '灵魂',
      cwd: tempDir,
      phoneMcp: makePhoneSpec(),
      signal: controller.signal,
    });

    await expect(async () => {
      for await (const _ev of session.sendTurn('触发崩溃', controller.signal)) {
        // consume
      }
    }).rejects.toThrow(/42|panic|退出/i);

    await session.dispose();
  });
});
