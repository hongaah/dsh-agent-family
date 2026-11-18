import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { buildMainSessionHandoffDraft } from '../src/client/ChangedFilesDeliverableCard.tsx';
import { rewriteMemberMentionsForHostMarkdown } from '../src/client/RichMessageContent.tsx';
import {
  FamilyAttachmentStore,
  searchWorkspaceFiles,
} from '../src/core/attachment-store.ts';
import { DshSessionContextBridge } from '../src/core/dsh-context-bridge.ts';
import { FamilyHub } from '../src/core/family-hub.ts';
import {
  FamilyProfileStore,
  formatFamilySharedProfileSection,
  resolveHumanDisplayLabel,
} from '../src/core/family-profile.ts';
import { GroupChatEngine } from '../src/core/group-chat.ts';
import { MemberRegistry } from '../src/core/member-registry.ts';
import {
  captureWorkspaceSnapshot,
  diffWorkspaceSnapshots,
} from '../src/core/workspace-changes.ts';
import type { BodyDriver } from '../src/drivers/driver.ts';

describe('WorkspaceChangeTracker & DshSessionContextBridge', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function createTempDir(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
  }

  it('accurately detects added, modified, re-modified dirty, and deleted files in a Git repo (including Chinese paths and subdirectories)', async () => {
    const repo = createTempDir('dsh-fam-git-');
    execFileSync('git', ['init'], { cwd: repo });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo });
    execFileSync('git', ['config', 'user.name', 'Tester'], { cwd: repo });

    mkdirSync(join(repo, 'pkg/src'), { recursive: true });
    writeFileSync(join(repo, 'pkg/src/app.ts'), 'const a = 1;\nconst b = 2;\n', 'utf8');
    writeFileSync(join(repo, 'pkg/src/already-dirty.ts'), 'export const v = 1;\n', 'utf8');
    writeFileSync(join(repo, 'pkg/src/to-delete.ts'), 'export const old = true;\n', 'utf8');
    execFileSync('git', ['add', '.'], { cwd: repo });
    execFileSync('git', ['commit', '-m', 'init'], { cwd: repo });

    // 让 already-dirty.ts 在本轮开始前就已经处于工作区修改态
    writeFileSync(join(repo, 'pkg/src/already-dirty.ts'), 'export const v = 2;\n', 'utf8');

    const subCwd = join(repo, 'pkg');
    const before = await captureWorkspaceSnapshot(subCwd);
    expect(before.mode).toBe('git');

    // 模拟家庭成员在本轮内：1. 修改干净文件 app.ts；2. 再次修改原本就 dirty 的 already-dirty.ts；3. 新建含中文文件；4. 删除 to-delete.ts
    writeFileSync(
      join(repo, 'pkg/src/app.ts'),
      'const a = 1;\nconst b = 20;\nconst c = 30;\n',
      'utf8'
    );
    writeFileSync(
      join(repo, 'pkg/src/already-dirty.ts'),
      'export const v = 3;\nexport const extra = true;\n',
      'utf8'
    );
    mkdirSync(join(repo, 'pkg/references'), { recursive: true });
    writeFileSync(join(repo, 'pkg/references/说明文档.md'), '# 标题\n第一行\n第二行\n', 'utf8');
    unlinkSync(join(repo, 'pkg/src/to-delete.ts'));

    const after = await captureWorkspaceSnapshot(subCwd);
    const changes = await diffWorkspaceSnapshots(before, after, '大前端 (@fe-claude)');

    expect(changes).toEqual([
      {
        path: 'references/说明文档.md',
        kind: 'added',
        additions: 3,
        deletions: 0,
        byMemberName: '大前端 (@fe-claude)',
      },
      {
        path: 'src/already-dirty.ts',
        kind: 'modified',
        additions: 2,
        deletions: 1,
        byMemberName: '大前端 (@fe-claude)',
      },
      {
        path: 'src/app.ts',
        kind: 'modified',
        additions: 2,
        deletions: 1,
        byMemberName: '大前端 (@fe-claude)',
      },
      {
        path: 'src/to-delete.ts',
        kind: 'deleted',
        additions: 0,
        deletions: 1,
        byMemberName: '大前端 (@fe-claude)',
      },
    ]);
  });

  it('tracks added, modified, and deleted files in a non-Git Skill directory while ignoring node_modules', async () => {
    const dir = createTempDir('dsh-fam-fs-');
    mkdirSync(join(dir, 'references'), { recursive: true });
    mkdirSync(join(dir, 'node_modules/pkg'), { recursive: true });
    writeFileSync(join(dir, 'SKILL.md'), '# English Skill\n', 'utf8');
    writeFileSync(join(dir, 'references/old.md'), 'old\n', 'utf8');
    writeFileSync(join(dir, 'node_modules/pkg/index.js'), 'module.exports = 1;\n', 'utf8');

    const before = await captureWorkspaceSnapshot(dir);
    expect(before.mode).toBe('fs');

    writeFileSync(join(dir, 'SKILL.md'), '# 中文技能说明\n详细步骤\n', 'utf8');
    writeFileSync(join(dir, 'references/report-format.md'), 'line1\nline2\nline3\nline4\n', 'utf8');
    unlinkSync(join(dir, 'references/old.md'));
    writeFileSync(join(dir, 'node_modules/pkg/index.js'), 'module.exports = 2;\n', 'utf8');

    const after = await captureWorkspaceSnapshot(dir);
    const changes = await diffWorkspaceSnapshots(before, after, '大前端');

    expect(changes).toEqual([
      {
        path: 'SKILL.md',
        kind: 'modified',
        byMemberName: '大前端',
      },
      {
        path: 'references/old.md',
        kind: 'deleted',
        byMemberName: '大前端',
      },
      {
        path: 'references/report-format.md',
        kind: 'added',
        additions: 4,
        deletions: 0,
        byMemberName: '大前端',
      },
    ]);
  });

  it('filters casual greetings, deduplicates file changes, cancels transient temp files, and emits Stale-Read Guard', () => {
    const syncEvents: number[] = [];
    const bridge = new DshSessionContextBridge(() => undefined, {
      onSyncSummaryChange: (summary) => {
        syncEvents.push(summary.changedFiles.length);
      },
    });

    // 1. 纯寒暄不产生任何回执
    const casual = bridge.recordCollaborationActivity({
      sessionId: 'sess-1',
      actorLabel: '家庭总群',
      userPrompt: '大家好！',
      conclusion: '小前端: 哈喽！ | 大前端: 你好呀',
      changedFiles: [],
    });
    expect(casual).toBeNull();
    expect(bridge.consumePendingReceipts('sess-1')).toBe('');

    // 2. 第一轮：新增临时脚本 + 新增业务文件 + 修改已有文件
    bridge.recordCollaborationActivity({
      sessionId: 'sess-1',
      actorLabel: '大前端 (@fe-claude)',
      userPrompt: '把 clean-set 汉化成中文',
      conclusion: '已完成 SKILL.md 翻译',
      changedFiles: [
        { path: '_tmp_translate.py', kind: 'added', additions: 20 },
        { path: 'references/zh.md', kind: 'added', additions: 50 },
        { path: 'SKILL.md', kind: 'modified', additions: 40, deletions: 35 },
      ],
    });

    // 3. 第二轮：清理了刚才新建的 _tmp_translate.py，并继续补充了 references/zh.md
    const summary = bridge.recordCollaborationActivity({
      sessionId: 'sess-1',
      actorLabel: '小前端 (@fe-codex)',
      userPrompt: '润色一下 zh.md 并清理临时脚本',
      conclusion: '已润色并移除临时文件',
      changedFiles: [
        { path: '_tmp_translate.py', kind: 'deleted' },
        { path: 'references/zh.md', kind: 'modified', additions: 65, deletions: 0 },
      ],
    });

    // _tmp_translate.py 新增后删除自动抵消，references/zh.md 保持 added 且更新行数
    expect(summary?.changedFiles).toEqual([
      {
        path: 'references/zh.md',
        kind: 'added',
        additions: 65,
        deletions: 0,
        byMemberName: '小前端 (@fe-codex)',
      },
      {
        path: 'SKILL.md',
        kind: 'modified',
        additions: 40,
        deletions: 35,
        byMemberName: '大前端 (@fe-claude)',
      },
    ]);

    const receipt = bridge.consumePendingReceipts('sess-1');
    expect(receipt).toContain('<family_workspace_changes>');
    expect(receipt).toContain('[新增] `references/zh.md` (+65)');
    expect(receipt).toContain('[修改] `SKILL.md` (+40 / -35)');
    expect(receipt).toContain('家庭协作纪要-');
    expect(receipt).not.toContain('_tmp_translate.py');
    expect(receipt).toContain('强制重读守卫（Stale-Read Guard）');

    // 验证完整详情已独立落盘为可读的 .md 文件，且消费后 latestReceiptPath 仍可供左屏胶囊一键预览
    const afterSummary = bridge.getPendingSyncSummary('sess-1');
    expect(afterSummary.changedFiles).toHaveLength(0);
    expect(afterSummary.latestReceiptPath).toBeTruthy();
    expect(existsSync(afterSummary.latestReceiptPath!)).toBe(true);
    const mdBody = readFileSync(afterSummary.latestReceiptPath!, 'utf8');
    expect(mdBody).toContain('已完成 SKILL.md 翻译');
    expect(mdBody).toContain('已润色并移除临时文件');
    expect(syncEvents.at(-1)).toBe(0);
  });

  it('persists and formats FamilySharedProfile (userName, userHonorific, sharedPrompt) across restarts', () => {
    const dir = createTempDir('dsh-fam-profile-');
    const store = new FamilyProfileStore(dir);
    expect(store.getRevision()).toBe(0);
    expect(formatFamilySharedProfileSection(store.get())).toBe('');

    const updated = store.update({
      userName: '杨杰',
      userHonorific: '杰哥',
      sharedPrompt: '1. 代码一律使用 TypeScript 严格模式；\n2. 回答先给结论再展开细节。',
    });
    expect(store.getRevision()).toBe(1);
    expect(resolveHumanDisplayLabel(updated)).toBe('杰哥（杨杰）');

    const section = formatFamilySharedProfileSection(updated);
    expect(section).toContain('杨杰');
    expect(section).toContain('杰哥');
    expect(section).toContain('TypeScript 严格模式');

    // 重新实例化后从磁盘恢复
    const restored = new FamilyProfileStore(dir);
    expect(restored.get()).toMatchObject({
      userName: '杨杰',
      userHonorific: '杰哥',
    });
    expect(restored.getRevision()).toBe(1);
  });

  it('injects FamilySharedProfile on awaken, hot-updates live members when profile changes, and attaches changedFiles to direct & group messages', async () => {
    const storageDir = createTempDir('dsh-fam-hub-');
    const workDir = createTempDir('dsh-fam-work-');
    writeFileSync(join(workDir, 'SKILL.md'), '# Original\n', 'utf8');

    const profileStore = new FamilyProfileStore(storageDir);
    profileStore.update({
      userName: '杨杰',
      userHonorific: '杰哥',
      sharedPrompt: '统一用中文回答。',
    });

    const registry = new MemberRegistry(storageDir);
    registry.create({
      id: 'fe-claude',
      name: '大前端',
      specialty: '前端架构',
      body: { kind: 'claude', permissionMode: 'auto' },
      soulPrompt: '负责前端与技能重构。',
    });

    const awakenedSouls: string[] = [];
    const receivedPrompts: string[] = [];
    let turnCounter = 0;

    const fakeClaudeDriver: BodyDriver = {
      kind: 'claude',
      awaken: async (params) => {
        awakenedSouls.push(params.composedSoul);
        let alive = true;
        return {
          bodyKind: 'claude',
          isAlive: () => alive,
          sendTurn: async function* (prompt) {
            turnCounter += 1;
            receivedPrompts.push(prompt);
            if (turnCounter === 1) {
              writeFileSync(join(workDir, 'SKILL.md'), '# 已翻译中文版\n内容行\n', 'utf8');
            } else if (turnCounter === 2) {
              writeFileSync(join(workDir, 'NEW_NOTE.md'), '群聊新增说明\n', 'utf8');
            }
            yield { kind: 'text_delta', delta: '搞定啦！' };
            yield { kind: 'turn_done', finalText: '搞定啦！' };
          },
          replyApproval: async () => undefined,
          interruptTurn: async () => undefined,
          dispose: async () => {
            alive = false;
          },
        };
      },
    };

    const hub = new FamilyHub({
      registry,
      drivers: [fakeClaudeDriver],
      storageDir,
    });
    hub.attachProfileStore(profileStore);
    const groupEngine = new GroupChatEngine(hub, registry, storageDir);
    hub.attachGroupEngine(groupEngine);

    // 第 1 轮私聊：首次唤醒注入「杰哥」且捕获 SKILL.md 修改
    const directRes = await hub.sendMemberMessage({
      scopeId: 'sess-main',
      memberId: 'fe-claude',
      senderRole: 'human',
      senderName: '杰哥',
      message: '帮我汉化 SKILL.md',
      cwd: workDir,
    });

    expect(awakenedSouls[0]).toContain('杰哥');
    expect(awakenedSouls[0]).toContain('统一用中文回答。');
    expect(directRes.changedFiles).toEqual([
      {
        path: 'SKILL.md',
        kind: 'modified',
        byMemberName: '大前端 (@fe-claude)',
      },
    ]);
    const snap = hub.getMemberSnapshot('sess-main', 'fe-claude');
    expect(snap.entries.at(-1)?.changedFiles).toHaveLength(1);

    // 在线修改称呼为「船长」——不重启进程，第 2 轮群聊发言时应自动收到热更新通知并记录群消息 changedFiles
    profileStore.update({ userHonorific: '船长' });
    const room = await groupEngine.postMessage({
      scopeId: 'sess-main',
      groupId: 'family-main',
      senderId: 'human',
      senderName: '船长',
      content: '@fe-claude 再补一份 NEW_NOTE.md',
      cwd: workDir,
    });

    expect(awakenedSouls).toHaveLength(1); // 未重启进程
    expect(receivedPrompts[1]).toContain('<family_shared_profile_update>');
    expect(receivedPrompts[1]).toContain('船长');
    expect(receivedPrompts[1]).toContain('[船长（杨杰）]: @fe-claude 再补一份 NEW_NOTE.md');
    expect(room.messages.at(-1)?.changedFiles).toEqual([
      {
        path: 'NEW_NOTE.md',
        kind: 'added',
        additions: 1,
        deletions: 0,
        byMemberName: '大前端 (@fe-claude)',
      },
    ]);

    await hub.dispose();
  });

  it('rewrites @member IDs & names to highlighted display names outside code blocks, and stores attachments + searches workspace files', async () => {
    const valid = new Set(['fe-claude', 'fe-codex']);
    const membersMap = new Map([
      [
        'fe-claude',
        {
          id: 'fe-claude',
          name: '小克',
          avatar: 'lobe:claudecode',
          specialty: '前端负责人',
          body: { kind: 'claude' as const },
          soulPrompt: '严谨',
          enabled: true,
          createdAt: '',
          updatedAt: '',
        },
      ],
      [
        'fe-codex',
        {
          id: 'fe-codex',
          name: '小G',
          avatar: 'lobe:codex',
          specialty: '快手',
          body: { kind: 'codex' as const },
          soulPrompt: '幽默',
          enabled: true,
          createdAt: '',
          updatedAt: '',
        },
      ],
    ]);

    const md =
      '请 @fe-claude 和 @小G 以及 `@fe-codex` 看看 `@unknown`\n```ts\nconst a = "@fe-claude";\n```';
    const rewritten = rewriteMemberMentionsForHostMarkdown(md, valid, true, membersMap);
    // @fe-claude 自动高亮显示为名称 [@小克]，@小G 同样识别为 [@小克/@小G]
    expect(rewritten).toContain('[@小克](__family_member__/fe-claude)');
    expect(rewritten).toContain('[@小G](__family_member__/fe-codex)');
    expect(rewritten).toContain('`@fe-codex`');
    expect(rewritten).toContain('const a = "@fe-claude";');

    const draft = buildMainSessionHandoffDraft('小克', [
      { path: 'SKILL.md', kind: 'modified', additions: 40, deletions: 12 },
      { path: 'references/zh.md', kind: 'added', additions: 88 },
    ]);
    expect(draft).toContain('- [修改] `SKILL.md` (+40 / -12)');
    expect(draft).toContain('- [新增] `references/zh.md` (+88)');

    // 验证附件存储保留原始干净文件名（供 DSH openResource 预览显示原名）与工作区文件检索
    const attDir = createTempDir('dsh-att-');
    const store = new FamilyAttachmentStore(attDir);
    const saved = store.saveUploadedFile({
      name: '架构草图.png',
      mimeType: 'image/png',
      dataBase64: Buffer.from('fake-png-bytes').toString('base64'),
    });
    expect(saved.kind).toBe('image');
    expect(saved.filePath.endsWith('/架构草图.png')).toBe(true);
    expect(store.readAttachmentBytes(saved.id)?.buffer.toString('utf8')).toBe('fake-png-bytes');

    mkdirSync(join(attDir, 'ws/src'), { recursive: true });
    writeFileSync(join(attDir, 'ws/src/LoginModal.tsx'), 'export const x = 1;\n', 'utf8');
    const files = await searchWorkspaceFiles(join(attDir, 'ws'), 'login');
    expect(files[0]).toEqual({
      path: 'src/LoginModal.tsx',
      name: 'LoginModal.tsx',
      parentDir: 'src',
    });
  });
});
