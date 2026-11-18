import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { decidePermissionAction } from '../src/core/permission-policy.ts';
import type { FamilyMember, MemberStreamEvent, PhoneMcpLaunchSpec } from '../src/core/types.ts';
import { ClaudeDriver } from '../src/drivers/claude-driver.ts';
import { CodexDriver } from '../src/drivers/codex-driver.ts';

function makePhoneSpec(): PhoneMcpLaunchSpec {
  return {
    command: process.execPath,
    args: ['/fake/phone-mcp.js'],
    env: {},
    httpUrl: 'http://127.0.0.1:45678/mcp',
    bearerToken: 'secret',
  };
}

function writeScript(dir: string, name: string, code: string): string {
  const filePath = join(dir, name);
  writeFileSync(filePath, `#!${process.execPath}\n${code}\n`, 'utf8');
  chmodSync(filePath, 0o755);
  return filePath;
}

describe('Three Permission Modes (ask / auto / full_access)', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'dsh-family-perm-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('classifies safe commands, dangerous commands, and AskUser accurately across ask / auto / full_access', () => {
    const safeGrep = {
      toolName: 'Bash',
      commandText: 'cd ~/.dsh/profiles/desktop/node_modules/dshmarket && grep -rn "ghost" lib/ | head -10',
    };
    const dangerousRm = {
      toolName: 'Bash',
      commandText: 'rm -rf /Users/test/important-project',
    };
    const dangerousGit = {
      toolName: 'Bash',
      commandText: 'git reset --hard HEAD~3 && git push --force origin main',
    };
    const askUser = {
      toolName: 'AskUserQuestion',
      rawInput: { questions: [{ question: '你希望导出为 Markdown 还是 Word？' }] },
    };

    // 1. 每次询问 (ask)：全部询问
    expect(decidePermissionAction('ask', safeGrep).decision).toBe('prompt_user');
    expect(decidePermissionAction('ask', dangerousRm).decision).toBe('prompt_user');
    expect(decidePermissionAction('ask', askUser).decision).toBe('prompt_user');

    // 2. 自动模式 (auto)：常规安全命令放行，高危操作与 AskUser 询问
    expect(decidePermissionAction('auto', safeGrep).decision).toBe('auto_allow');
    expect(decidePermissionAction('auto', dangerousRm).decision).toBe('prompt_user');
    expect(decidePermissionAction('auto', dangerousRm).isDangerous).toBe(true);
    expect(decidePermissionAction('auto', dangerousGit).decision).toBe('prompt_user');
    expect(decidePermissionAction('auto', askUser).decision).toBe('prompt_user');
    expect(decidePermissionAction('auto', askUser).isAskUser).toBe(true);

    // 3. 完全访问模式 (full_access)：普通与高危命令均放行，唯独 AskUser 依然必须询问人类！
    expect(decidePermissionAction('full_access', safeGrep).decision).toBe('auto_allow');
    expect(decidePermissionAction('full_access', dangerousRm).decision).toBe('auto_allow');
    expect(decidePermissionAction('full_access', dangerousGit).decision).toBe('auto_allow');
    expect(decidePermissionAction('full_access', askUser).decision).toBe('prompt_user');
    expect(decidePermissionAction('full_access', askUser).isAskUser).toBe(true);
  });

  it('ClaudeDriver auto-allows safe Bash in auto mode, prompts on rm -rf, and in full_access mode only prompts on AskUserQuestion', async () => {
    const mockClaude = writeScript(
      tempDir,
      'mock-claude-perm.mjs',
      `
      import readline from 'node:readline';
      let turn = 0;
      const results = [];
      const rl = readline.createInterface({ input: process.stdin });
      rl.on('line', (line) => {
        const msg = JSON.parse(line);
        if (msg.type === 'user') {
          turn += 1;
          if (turn === 1) {
            // Auto mode: 1) safe grep -> should auto allow; 2) rm -rf -> should prompt user
            process.stdout.write(JSON.stringify({
              type: 'control_request',
              request_id: 'r-safe',
              request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'grep -rn foo src/' } }
            }) + '\\n');
          } else if (turn === 2) {
            // Full access mode: 1) rm -rf -> should auto allow; 2) AskUserQuestion -> MUST prompt user!
            process.stdout.write(JSON.stringify({
              type: 'control_request',
              request_id: 'r-rm-full',
              request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'rm -rf tmp_build' } }
            }) + '\\n');
          }
        } else if (msg.type === 'control_response') {
          const reqId = msg.response.request_id;
          const beh = msg.response.response.behavior;
          results.push(reqId + ':' + beh);
          if (reqId === 'r-safe') {
            process.stdout.write(JSON.stringify({
              type: 'control_request',
              request_id: 'r-danger',
              request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'rm -rf dist' } }
            }) + '\\n');
          } else if (reqId === 'r-danger') {
            const out = results.join(',');
            results.length = 0;
            process.stdout.write(JSON.stringify({ type: 'result', result: out }) + '\\n');
          } else if (reqId === 'r-rm-full') {
            process.stdout.write(JSON.stringify({
              type: 'control_request',
              request_id: 'r-askuser',
              request: {
                subtype: 'can_use_tool',
                tool_name: 'AskUserQuestion',
                input: { questions: [{ question: '使用哪种主题配色？', options: [{ label: 'Zinc' }, { label: 'Slate' }] }] }
              }
            }) + '\\n');
          } else if (reqId === 'r-askuser') {
            const answerInfo = JSON.stringify(msg.response.response.updatedInput?.answers ?? {});
            const out = results.join(',') + '|ans=' + answerInfo;
            results.length = 0;
            process.stdout.write(JSON.stringify({ type: 'result', result: out }) + '\\n');
          }
        }
      });
      `
    );

    const driver = new ClaudeDriver();
    const member: FamilyMember = {
      id: 'fe-claude',
      name: '大前端',
      avatar: 'lobe:claudecode',
      specialty: '前端架构',
      body: { kind: 'claude', command: mockClaude, permissionMode: 'auto' },
      soulPrompt: '严谨',
      enabled: true,
      createdAt: '2026-11-18T00:00:00.000Z',
      updatedAt: '2026-11-18T00:00:00.000Z',
    };

    const controller = new AbortController();
    const session = await driver.awaken({
      scopeId: 's1',
      member,
      composedSoul: '严谨',
      cwd: tempDir,
      phoneMcp: makePhoneSpec(),
      signal: controller.signal,
    });

    // Turn 1 (auto 模式)：grep 自动放行（不弹窗），rm -rf 弹窗拦截，用户拒绝
    const promptedTitles1: string[] = [];
    let final1 = '';
    for await (const ev of session.sendTurn('排查代码', controller.signal)) {
      if (ev.kind === 'approval_requested') {
        promptedTitles1.push(ev.title);
        await session.replyApproval(ev.requestId, 'deny');
      } else if (ev.kind === 'turn_done') {
        final1 = ev.finalText;
      }
    }
    expect(promptedTitles1).toHaveLength(1);
    expect(promptedTitles1[0]).toContain('高危');
    expect(final1).toBe('r-safe:allow,r-danger:deny');

    // 热切换至完全访问模式 (full_access)
    const hotSwitched = await session.reconfigure?.({
      kind: 'claude',
      command: mockClaude,
      permissionMode: 'full_access',
    });
    expect(hotSwitched).toBe(true);

    // Turn 2 (full_access 模式)：rm -rf 自动放行（不弹窗），但 AskUserQuestion 依然弹窗等待人类回答！
    const promptedTitles2: string[] = [];
    let final2 = '';
    for await (const ev of session.sendTurn('继续实现', controller.signal)) {
      if (ev.kind === 'approval_requested') {
        promptedTitles2.push(ev.title);
        await session.replyApproval(ev.requestId, 'answer:Zinc');
      } else if (ev.kind === 'turn_done') {
        final2 = ev.finalText;
      }
    }
    expect(promptedTitles2).toHaveLength(1);
    expect(promptedTitles2[0]).toContain('主题配色');
    expect(final2).toContain('r-rm-full:allow,r-askuser:allow');
    expect(final2).toContain('Zinc');

    await session.dispose();
  });

  it('CodexDriver prompts user on item/tool/requestUserInput even in full_access mode', async () => {
    const mockCodex = writeScript(
      tempDir,
      'mock-codex-perm.mjs',
      `
      import readline from 'node:readline';
      const rl = readline.createInterface({ input: process.stdin });
      let lastPolicy = '';
      rl.on('line', (line) => {
        const msg = JSON.parse(line);
        if (msg.method === 'initialize') {
          process.stdout.write(JSON.stringify({ id: msg.id, result: { userAgent: 'mock' } }) + '\\n');
        } else if (msg.method === 'thread/start') {
          process.stdout.write(JSON.stringify({ id: msg.id, result: { thread: { id: 't1' } } }) + '\\n');
        } else if (msg.method === 'turn/start') {
          lastPolicy = String(msg.params.approvalPolicy);
          process.stdout.write(JSON.stringify({ id: msg.id, result: { turn: { id: 'u1' } } }) + '\\n');
          process.stdout.write(JSON.stringify({
            id: 501,
            method: 'item/tool/requestUserInput',
            params: {
              itemId: 'i1',
              threadId: 't1',
              turnId: 'u1',
              isBlocking: true,
              questions: [{
                id: 'q_fmt',
                header: '导出格式',
                question: '需要导出 PDF 还是 Markdown？',
                options: [{ label: 'Markdown', description: '轻量文本' }, { label: 'PDF', description: '排版归档' }]
              }]
            }
          }) + '\\n');
        } else if (msg.id === 501 && msg.result) {
          const picked = msg.result.answers?.q_fmt?.answers?.[0] ?? 'none';
          process.stdout.write(JSON.stringify({
            method: 'item/agentMessage/delta',
            params: { threadId: 't1', turnId: 'u1', itemId: 'm1', delta: 'policy=' + lastPolicy + '|picked=' + picked }
          }) + '\\n');
          process.stdout.write(JSON.stringify({
            method: 'turn/completed',
            params: { threadId: 't1', turn: { id: 'u1', status: 'completed' } }
          }) + '\\n');
        }
      });
      `
    );

    const driver = new CodexDriver();
    const session = await driver.awaken({
      scopeId: 's1',
      member: {
        id: 'fe-codex',
        name: '小前端',
        avatar: 'lobe:codex',
        specialty: '前端',
        body: { kind: 'codex', command: mockCodex, permissionMode: 'full_access' },
        soulPrompt: '快手',
        enabled: true,
        createdAt: '2026-11-18T00:00:00.000Z',
        updatedAt: '2026-11-18T00:00:00.000Z',
      },
      composedSoul: '快手',
      cwd: tempDir,
      phoneMcp: makePhoneSpec(),
      signal: new AbortController().signal,
    });

    let doneText = '';
    for await (const ev of session.sendTurn('整理文档', new AbortController().signal)) {
      if (ev.kind === 'approval_requested') {
        expect(ev.title).toContain('PDF 还是 Markdown');
        await session.replyApproval(ev.requestId, 'answer:Markdown');
      } else if (ev.kind === 'turn_done') {
        doneText = ev.finalText;
      }
    }
    expect(doneText).toBe('policy=never|picked=Markdown');
    await session.dispose();
  });
});
