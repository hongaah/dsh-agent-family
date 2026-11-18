import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  buildChildProcessEnv,
  probeAllBodies,
  resolveBodyExecutable,
  resolveNodeExecutable,
} from '../src/core/cli-locator.ts';
import { MemberRegistry, STARTER_MEMBER_TEMPLATES } from '../src/core/member-registry.ts';
import { composeAwakeningSoul } from '../src/core/soul-composer.ts';

describe('MemberRegistry, SoulComposer & CliLocator', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'dsh-agent-family-registry-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('creates, persists, updates, and reloads family members without storing memory or outer permissions', () => {
    const registry = new MemberRegistry(tempDir);
    expect(registry.list()).toEqual([]);

    const created = registry.create({
      id: 'arch-bro',
      name: '架构师大哥',
      avatar: '🏛️',
      specialty: '系统边界设计与复杂重构把关',
      body: { kind: 'claude', extraArgs: ['--effort', 'high'] },
      soulPrompt: '你是家里沉稳严谨的架构师大哥，遇到破坏模块边界的设计必须果断指出并拒绝妥协。',
    });

    expect(created.id).toBe('arch-bro');
    expect(created.enabled).toBe(true);

    const reloaded = new MemberRegistry(tempDir);
    expect(reloaded.list()).toHaveLength(1);
    expect(reloaded.get('arch-bro')?.body).toEqual({
      kind: 'claude',
      extraArgs: ['--effort', 'high'],
    });

    const updated = reloaded.update('arch-bro', {
      specialty: '架构设计、跨端协议与技术评审',
      enabled: false,
    });
    expect(updated.enabled).toBe(false);
    expect(reloaded.listEnabled()).toEqual([]);
  });

  it('rejects invalid member ids, reserved lead id, and duplicate ids', () => {
    const registry = new MemberRegistry(tempDir);

    expect(() =>
      registry.create({
        id: 'lead',
        name: '管家',
        avatar: '👑',
        specialty: '总控',
        body: { kind: 'dsh' },
        soulPrompt: 'invalid',
      })
    ).toThrow(/lead/i);

    expect(() =>
      registry.create({
        id: 'Invalid Upper',
        name: '非法代号',
        avatar: '❌',
        specialty: '测试',
        body: { kind: 'codex' },
        soulPrompt: 'invalid',
      })
    ).toThrow(/id/i);

    registry.create({
      id: 'fe-sis',
      name: '前端妹妹',
      avatar: '🎨',
      specialty: 'Vue3 与精细交互体验',
      body: { kind: 'opencode' },
      soulPrompt: '专注前端交互与无障碍体验。',
    });

    expect(() =>
      registry.create({
        id: 'fe-sis',
        name: '重复成员',
        avatar: '🎨',
        specialty: '重复',
        body: { kind: 'claude' },
        soulPrompt: 'duplicate',
      })
    ).toThrow(/已存在|exists/i);
  });

  it('seeds starter templates cleanly without overwriting existing members', () => {
    const registry = new MemberRegistry(tempDir);
    expect(STARTER_MEMBER_TEMPLATES.length).toBeGreaterThanOrEqual(4);

    const seeded = registry.seedStarterTemplates();
    expect(seeded.length).toBe(STARTER_MEMBER_TEMPLATES.length);
    const secondSeed = registry.seedStarterTemplates();
    expect(secondSeed).toHaveLength(0);
    expect(registry.list().length).toBe(STARTER_MEMBER_TEMPLATES.length);
  });

  it('composes awakening soul with member identity, phone tools, refusal autonomy, and [PASS] etiquette', () => {
    const registry = new MemberRegistry(tempDir);
    const member = registry.create({
      id: 'qa-bro',
      name: '测试弟弟',
      avatar: '🛡️',
      specialty: '边界用例与回归验证',
      body: { kind: 'codex' },
      soulPrompt: '没跑通自动化测试绝不放行。',
    });

    const composed = composeAwakeningSoul(member);
    expect(composed).toContain('测试弟弟');
    expect(composed).toContain('@qa-bro');
    expect(composed).toContain('没跑通自动化测试绝不放行。');
    expect(composed).toContain('phone_call');
    expect(composed).toContain('phone_group_discuss');
    expect(composed).toContain('拒绝');
    expect(composed).toContain('[PASS]');
  });

  it('resolves CLI executables from custom search directories and probes DSH native body', async () => {
    const binDir = join(tempDir, 'bin');
    const registry = new MemberRegistry(join(tempDir, 'store'));
    expect(registry.list()).toEqual([]);

    const fakeBinDir = mkdtempSync(join(tempDir, 'fake-bin-'));
    const fakeClaude = join(fakeBinDir, 'claude');
    writeFileSync(fakeClaude, '#!/bin/sh\necho "1.0.0"\n', 'utf8');
    chmodSync(fakeClaude, 0o755);

    const resolved = await resolveBodyExecutable(
      { kind: 'claude' },
      { extraSearchDirs: [fakeBinDir], includeSystemPaths: false }
    );
    expect(resolved).toBe(fakeClaude);
    expect(binDir).toBeTruthy();

    const probes = await probeAllBodies({
      hasDshHostRuntime: true,
      extraSearchDirs: [fakeBinDir],
      includeSystemPaths: false,
    });
    expect(probes.find((item) => item.kind === 'claude')?.available).toBe(true);
    expect(probes.find((item) => item.kind === 'dsh')?.available).toBe(true);
    expect(probes.find((item) => item.kind === 'opencode')?.available).toBe(false);
  });

  it('resolves real node binary when process.execPath is an Electron GUI binary and injects NO_PROXY for loopback MCP', () => {
    const fakeBinDir = mkdtempSync(join(tempDir, 'fake-node-'));
    const fakeNode = join(fakeBinDir, 'node');
    writeFileSync(fakeNode, '#!/bin/sh\nexit 0\n', 'utf8');
    chmodSync(fakeNode, 0o755);

    const resolved = resolveNodeExecutable({
      execPathOverride: '/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness',
      extraSearchDirs: [fakeBinDir],
      includeSystemPaths: false,
    });
    expect(resolved.command).toBe(fakeNode);

    const fallback = resolveNodeExecutable({
      execPathOverride: '/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness',
      extraSearchDirs: [],
      includeSystemPaths: false,
    });
    expect(fallback.env.ELECTRON_RUN_AS_NODE).toBe('1');

    const childEnv = buildChildProcessEnv();
    expect(childEnv.NO_PROXY).toContain('127.0.0.1');
    expect(childEnv.no_proxy).toContain('127.0.0.1');
  });

  it('auto-heals from backups/members.latest.json if members.json is externally overwritten with an older snapshot while respecting intentional remove()', () => {
    const registry = new MemberRegistry(tempDir);
    registry.create({
      id: 'fe-codex',
      name: '小G',
      specialty: '前端快手',
      body: { kind: 'codex' },
      soulPrompt: '幽默快手',
    });
    registry.create({
      id: 'fe-claude',
      name: '小克',
      specialty: '前端负责人',
      body: { kind: 'claude' },
      soulPrompt: '严谨可靠',
    });

    // 模拟外部编辑器误把 members.json 回滚成了昨天的旧快照
    writeFileSync(
      join(tempDir, 'members.json'),
      JSON.stringify({
        version: 1,
        members: [
          {
            id: 'fe-codex',
            name: '小前端',
            avatar: 'lobe:codex',
            specialty: '旧数据',
            body: { kind: 'codex' },
            soulPrompt: '旧灵魂',
            enabled: true,
            createdAt: '2026-11-17T10:00:00.000Z',
            updatedAt: '2026-11-17T11:25:00.000Z',
          },
        ],
      }),
      'utf8'
    );

    // 重新读取时应自动识别旧时间戳并从 backups/members.latest.json 自愈恢复！
    const names = registry.list().map((m) => m.name);
    expect(names).toEqual(['小G', '小克']);

    // 正常通过 UI 删除成员时，主文件与备份同步推进 savedAt，不会被误恢复
    registry.remove('fe-claude');
    const reloaded = new MemberRegistry(tempDir);
    expect(reloaded.list().map((m) => m.name)).toEqual(['小G']);
  });
});
