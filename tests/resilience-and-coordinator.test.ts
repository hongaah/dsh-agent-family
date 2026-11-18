import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { FamilyHub } from '../src/core/family-hub.ts';
import { GroupChatEngine } from '../src/core/group-chat.ts';
import { MemberRegistry } from '../src/core/member-registry.ts';
import {
  MemberTurnStallError,
  TurnActivityWatchdog,
} from '../src/core/turn-watchdog.ts';
import { WorkspaceCoordinator } from '../src/core/workspace-coordinator.ts';
import type { BodyDriver } from '../src/drivers/driver.ts';

describe('TurnActivityWatchdog & WorkspaceCoordinator', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function makeDir(prefix: string): string {
    const d = mkdtempSync(join(tmpdir(), prefix));
    tempDirs.push(d);
    return d;
  }

  it('fires MemberTurnStallError when silent past idleTimeoutMs, resets on touch(), and freezes during pause()', async () => {
    let stallErr: MemberTurnStallError | null = null;
    const wd = new TurnActivityWatchdog({
      memberId: 'fe-codex',
      memberName: '小前端',
      scene: 'group',
      idleTimeoutMs: 70,
      onStall: (err) => {
        stallErr = err;
      },
    });

    // 1. 持续 touch 心跳不会触发超时
    await new Promise((r) => setTimeout(r, 40));
    wd.touch();
    await new Promise((r) => setTimeout(r, 40));
    expect(stallErr).toBeNull();

    // 2. 进入人类审批等待期 pause('approval')，哪怕睡 120ms 也绝不误杀
    wd.pause('approval:req-1');
    await new Promise((r) => setTimeout(r, 120));
    expect(stallErr).toBeNull();

    // 3. 审批结束 resume 后，若真正沉默超过 70ms，立即触发 MemberTurnStallError
    wd.resume('approval:req-1');
    await new Promise((r) => setTimeout(r, 105));
    expect(stallErr).toBeInstanceOf(MemberTurnStallError);
    expect(stallErr!.memberId).toBe('fe-codex');
    expect(stallErr!.scene).toBe('group');
  });

  it('enforces optimistic file leases across concurrent members, blocks destructive git commands during concurrency, and builds live workspace blackboard', () => {
    const cwd = makeDir('dsh-coord-');
    mkdirSync(join(cwd, 'src/core'), { recursive: true });
    writeFileSync(join(cwd, 'src/core/types.ts'), 'export interface A {}\n', 'utf8');

    const coord = new WorkspaceCoordinator();

    // 大前端开始执行并认领了 src/core/types.ts 的软锁
    const endClaude = coord.beginTurn({
      turnId: 'turn-1',
      scopeId: 'sess-1',
      cwd,
      memberId: 'fe-claude',
      memberName: '大前端',
      goal: '重构核心类型与权限弹窗',
    });

    const claim1 = coord.evaluateAndClaimOperation({
      cwd,
      memberId: 'fe-claude',
      memberName: '大前端',
      toolName: 'Edit',
      rawInput: { file_path: join(cwd, 'src/core/types.ts') },
    });
    expect(claim1).toEqual({
      action: 'ok',
      leasedPaths: ['src/core/types.ts'],
    });

    // 小前端同一时刻启动：首先应能在黑板简报里看到大前端正在操作 src/core/types.ts
    const endCodex = coord.beginTurn({
      turnId: 'turn-2',
      scopeId: 'sess-1',
      cwd,
      memberId: 'fe-codex',
      memberName: '小前端',
      goal: '编写底栏快捷键组件',
    });

    const briefingForCodex = coord.buildLiveWorkspaceBriefing(cwd, 'fe-codex');
    expect(briefingForCodex).toContain('<family_live_workspace>');
    expect(briefingForCodex).toContain('大前端 (@fe-claude)');
    expect(briefingForCodex).toContain('`src/core/types.ts`');

    // 小前端修改不冲突的文件 src/Footer.tsx -> 正常放行并挂入小前端自己的租约
    const claimNonConflict = coord.evaluateAndClaimOperation({
      cwd,
      memberId: 'fe-codex',
      memberName: '小前端',
      toolName: 'Write',
      rawInput: { file_path: 'src/Footer.tsx' },
    });
    expect(claimNonConflict).toEqual({
      action: 'ok',
      leasedPaths: ['src/Footer.tsx'],
    });

    // 小前端试图并发修改大前端正锁定的 src/core/types.ts -> 触发防撞锁拦截！
    const claimConflict = coord.evaluateAndClaimOperation({
      cwd,
      memberId: 'fe-codex',
      memberName: '小前端',
      toolName: 'Edit',
      rawInput: { file_path: 'src/core/types.ts' },
    });
    expect(claimConflict.action).toBe('conflict');
    if (claimConflict.action === 'conflict') {
      expect(claimConflict.conflictingPath).toBe('src/core/types.ts');
      expect(claimConflict.holderMemberId).toBe('fe-claude');
      expect(claimConflict.message).toContain('phone_call');
    }

    // 小前端在并发期间试图执行 git stash 或 git checkout -- . -> 触发同目录并发 Git 保护拦截！
    const gitHazard = coord.evaluateAndClaimOperation({
      cwd,
      memberId: 'fe-codex',
      memberName: '小前端',
      toolName: 'Bash',
      commandText: 'git stash && pnpm test',
    });
    expect(gitHazard.action).toBe('concurrent_git_hazard');

    // 大前端完成本轮并释放软锁后，记录落盘变更，此时小前端再改 src/core/types.ts 即可顺利获锁！
    coord.recordCompletedChanges(cwd, 'fe-claude', '大前端', [
      { path: 'src/core/types.ts', kind: 'modified', additions: 10, deletions: 2 },
    ]);
    endClaude();

    const claimAfterRelease = coord.evaluateAndClaimOperation({
      cwd,
      memberId: 'fe-codex',
      memberName: '小前端',
      toolName: 'Edit',
      rawInput: { file_path: 'src/core/types.ts' },
    });
    expect(claimAfterRelease).toEqual({
      action: 'ok',
      leasedPaths: ['src/core/types.ts'],
    });

    // 随身手机黑板工具也能清晰看到最近落盘记录与当前活跃占用
    const boardText = coord.formatBoardForPhoneTool(cwd, 'fe-codex');
    expect(boardText).toContain('`src/Footer.tsx`');
    expect(boardText).toContain('`src/core/types.ts` (modified) — 由 大前端 (@fe-claude)');

    endCodex();
  });

  it('auto-skips a wedged member in group chat, reaps its zombie CLI session, and continues the relay with healthy members', async () => {
    const dir = makeDir('dsh-group-stall-');
    const registry = new MemberRegistry(dir);
    registry.create({
      id: 'zombie-bro',
      name: '卡壳哥',
      specialty: '模拟卡死',
      body: { kind: 'codex' },
      soulPrompt: '会卡住',
    });
    registry.create({
      id: 'fast-sis',
      name: '快手妹',
      specialty: '秒回搭档',
      body: { kind: 'claude' },
      soulPrompt: '靠谱秒回',
    });

    let zombieAwakenCount = 0;
    let zombieDisposeCount = 0;
    let zombieShouldHang = true;

    const codexDriver: BodyDriver = {
      kind: 'codex',
      awaken: async () => {
        zombieAwakenCount += 1;
        let alive = true;
        return {
          bodyKind: 'codex',
          isAlive: () => alive,
          sendTurn: async function* (_prompt, signal) {
            if (zombieShouldHang) {
              await new Promise<void>((_, reject) => {
                signal.addEventListener(
                  'abort',
                  () => reject(new Error('aborted by watchdog')),
                  { once: true }
                );
              });
              return;
            }
            yield { kind: 'text_delta', delta: '满血复活啦！' };
            yield { kind: 'turn_done', finalText: '满血复活啦！' };
          },
          replyApproval: async () => undefined,
          dispose: async () => {
            alive = false;
            zombieDisposeCount += 1;
          },
        };
      },
    };

    const claudeDriver: BodyDriver = {
      kind: 'claude',
      awaken: async () => ({
        bodyKind: 'claude',
        isAlive: () => true,
        sendTurn: async function* () {
          yield { kind: 'text_delta', delta: '卡壳哥睡着了，这活我来接！' };
          yield { kind: 'turn_done', finalText: '卡壳哥睡着了，这活我来接！' };
        },
        replyApproval: async () => undefined,
        dispose: async () => undefined,
      }),
    };

    const hub = new FamilyHub({
      registry,
      drivers: [codexDriver, claudeDriver],
      storageDir: dir,
      watchdogTimeouts: {
        groupIdleMs: 80,
        phoneCallIdleMs: 90,
        directIdleMs: 120,
      },
    });
    const groupEngine = new GroupChatEngine(hub, registry, dir);
    hub.attachGroupEngine(groupEngine);

    const room = await groupEngine.postMessage({
      scopeId: 'sess-g',
      groupId: 'family-main',
      senderId: 'human',
      senderName: '杰哥',
      content: '大家出来看看这个问题',
      cwd: dir,
    });

    // 1. 卡壳哥超时后底层会话已被自动 dispose 回收
    expect(zombieDisposeCount).toBe(1);
    // 2. 群聊留下超时跳过提示，并且快手妹顺利接过了话筒完成发言！
    expect(room.messages.some((m) => m.senderId === 'system' && m.content.includes('思考超时未响应'))).toBe(
      true
    );
    expect(room.messages.at(-1)?.senderId).toBe('fast-sis');
    expect(room.messages.at(-1)?.content).toContain('这活我来接');

    // 3. 下次再找卡壳哥时，会自动拉起全新的健康身体完成回复
    zombieShouldHang = false;
    const recovered = await hub.sendMemberMessage({
      scopeId: 'sess-g',
      memberId: 'zombie-bro',
      senderRole: 'human',
      senderName: '杰哥',
      message: '醒醒',
      cwd: dir,
    });
    expect(zombieAwakenCount).toBe(2);
    expect(recovered.finalText).toBe('满血复活啦！');

    await hub.dispose();
  });

  it('hangs up a stalled phone_call callee cleanly without starving or falsely killing the waiting caller', async () => {
    const dir = makeDir('dsh-call-stall-');
    const registry = new MemberRegistry(dir);
    registry.create({
      id: 'caller-sis',
      name: '主叫妹妹',
      specialty: '前端',
      body: { kind: 'claude' },
      soulPrompt: '主叫',
    });
    registry.create({
      id: 'hung-bro',
      name: '失联大哥',
      specialty: '后端',
      body: { kind: 'codex' },
      soulPrompt: '卡死不接电话',
    });

    let hubRef!: FamilyHub;

    const callerDriver: BodyDriver = {
      kind: 'claude',
      awaken: async () => ({
        bodyKind: 'claude',
        isAlive: () => true,
        sendTurn: async function* () {
          // 主叫自身的 directIdleMs 设为 50ms，被叫 phoneCallIdleMs 设为 90ms：
          // 验证主叫在拿着电话等待的 90ms 期间看门狗自动挂起，绝不会被自己的 50ms 误杀！
          const phoneReply = await hubRef.handlePhoneCall({
            scopeId: 'sess-call',
            callerId: 'caller-sis',
            toMemberId: 'hung-bro',
            intent: 'request_help',
            message: '帮我对一下接口',
          });
          const summary = `电话结果：${phoneReply}`;
          yield { kind: 'text_delta', delta: summary };
          yield { kind: 'turn_done', finalText: summary };
        },
        replyApproval: async () => undefined,
        dispose: async () => undefined,
      }),
    };

    const hungDriver: BodyDriver = {
      kind: 'codex',
      awaken: async () => ({
        bodyKind: 'codex',
        isAlive: () => true,
        sendTurn: async function* (_prompt, signal) {
          await new Promise<void>((_, reject) => {
            signal.addEventListener('abort', () => reject(new Error('hung aborted')), {
              once: true,
            });
          });
        },
        replyApproval: async () => undefined,
        dispose: async () => undefined,
      }),
    };

    hubRef = new FamilyHub({
      registry,
      drivers: [callerDriver, hungDriver],
      storageDir: dir,
      watchdogTimeouts: {
        directIdleMs: 50,
        phoneCallIdleMs: 90,
        groupIdleMs: 80,
      },
    });

    const res = await hubRef.sendMemberMessage({
      scopeId: 'sess-call',
      memberId: 'caller-sis',
      senderRole: 'human',
      senderName: '杰哥',
      message: '联系大哥对接口',
      cwd: dir,
    });

    expect(res.finalText).toContain('呼叫超时自动挂断');
    expect(res.phoneCallsDuringTurn[0]?.status).toBe('failed');

    await hubRef.dispose();
  });
});
