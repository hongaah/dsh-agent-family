import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';

import type { WorkspaceFileChange, WorkspaceFileChangeKind } from './types.ts';

const execFileAsync = promisify(execFile);

const MAX_HASHABLE_FILE_BYTES = 512 * 1024;
const MAX_LINE_COUNT_FILE_BYTES = 256 * 1024;
const MAX_STAT_DIRTY_FILES = 500;
const MAX_FALLBACK_WALK_FILES = 2800;
const MAX_FALLBACK_DEPTH = 5;

const IGNORED_DIRS = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  '.next',
  '.nuxt',
  '.turbo',
  'coverage',
  'target',
  '__pycache__',
  '.venv',
  'venv',
  '.pytest_cache',
  '.DS_Store',
]);

interface FileFingerprint {
  readonly relPath: string;
  readonly absPath: string;
  readonly statusXY: string;
  readonly exists: boolean;
  readonly size: number;
  readonly mtimeMs: number;
  readonly sha1?: string;
}

export interface WorkspaceSnapshot {
  readonly mode: 'git' | 'fs' | 'none';
  readonly cwd: string;
  readonly gitRoot?: string;
  readonly headSha?: string;
  readonly files: ReadonlyMap<string, FileFingerprint>;
}

function toPosixPath(p: string): string {
  return p.split(sep).join('/');
}

async function fingerprintDiskFile(
  absPath: string,
  relPath: string,
  statusXY: string
): Promise<FileFingerprint> {
  try {
    const st = await stat(absPath);
    if (!st.isFile()) {
      return {
        relPath,
        absPath,
        statusXY,
        exists: false,
        size: 0,
        mtimeMs: 0,
      };
    }
    let sha1: string | undefined;
    if (st.size <= MAX_HASHABLE_FILE_BYTES) {
      try {
        const buf = await readFile(absPath);
        sha1 = createHash('sha1').update(buf).digest('hex');
      } catch {
        sha1 = undefined;
      }
    }
    return {
      relPath,
      absPath,
      statusXY,
      exists: true,
      size: st.size,
      mtimeMs: st.mtimeMs,
      sha1,
    };
  } catch {
    return {
      relPath,
      absPath,
      statusXY,
      exists: false,
      size: 0,
      mtimeMs: 0,
    };
  }
}

function parseGitPorcelainZ(stdout: string): Array<{ statusXY: string; repoPath: string }> {
  const tokens = stdout.split('\0');
  const entries: Array<{ statusXY: string; repoPath: string }> = [];
  let i = 0;
  while (i < tokens.length) {
    const token = tokens[i] ?? '';
    i += 1;
    if (token.length < 4 || token[2] !== ' ') continue;
    const statusXY = token.slice(0, 2);
    const repoPath = token.slice(3);
    // Git porcelain v1 -z 中，重命名/复制（R/C）后面紧跟原路径作为第二个 NUL 字段
    if (statusXY.includes('R') || statusXY.includes('C')) {
      const origPath = tokens[i];
      if (typeof origPath === 'string') {
        i += 1;
        if (origPath) {
          entries.push({ statusXY: 'D ', repoPath: origPath });
        }
      }
      entries.push({ statusXY: '??', repoPath });
      continue;
    }
    entries.push({ statusXY, repoPath });
  }
  return entries;
}

function safeRealpath(p: string): string {
  const abs = resolve(p);
  try {
    return realpathSync(abs);
  } catch {
    return abs;
  }
}

async function resolveGitContext(cwd: string): Promise<{ gitRoot: string; headSha?: string } | null> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['rev-parse', '--show-toplevel'],
      { cwd, timeout: 1800, maxBuffer: 1024 * 1024 }
    );
    const rawRoot = stdout.trim();
    if (!rawRoot) return null;
    const gitRoot = safeRealpath(rawRoot);
    let headSha: string | undefined;
    try {
      const headRes = await execFileAsync('git', ['rev-parse', '--verify', 'HEAD'], {
        cwd,
        timeout: 1200,
      });
      headSha = headRes.stdout.trim() || undefined;
    } catch {
      headSha = undefined;
    }
    return { gitRoot, headSha };
  } catch {
    return null;
  }
}

async function walkDirectoryFingerprints(
  rootCwd: string
): Promise<Map<string, FileFingerprint>> {
  const map = new Map<string, FileFingerprint>();
  const queue: Array<{ dir: string; depth: number }> = [{ dir: rootCwd, depth: 0 }];

  while (queue.length > 0 && map.size < MAX_FALLBACK_WALK_FILES) {
    const current = queue.shift()!;
    let dirents;
    try {
      dirents = await readdir(current.dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const d of dirents) {
      if (d.name === '.DS_Store' || IGNORED_DIRS.has(d.name)) continue;
      if (d.name.includes('.tmp-')) continue;
      const absPath = join(current.dir, d.name);
      if (d.isDirectory()) {
        if (current.depth + 1 <= MAX_FALLBACK_DEPTH) {
          queue.push({ dir: absPath, depth: current.depth + 1 });
        }
      } else if (d.isFile()) {
        const relPath = toPosixPath(relative(rootCwd, absPath));
        if (!relPath || relPath.startsWith('..')) continue;
        map.set(relPath, await fingerprintDiskFile(absPath, relPath, 'FS'));
        if (map.size >= MAX_FALLBACK_WALK_FILES) break;
      }
    }
  }

  return map;
}

/**
 * 捕获工作区轻量快照（Git 仓库走 `git status --porcelain=v1 -z -uall`，非 Git 目录走有界快速目录指纹）。
 * 单次耗时通常在 5ms ~ 18ms，完全异步非阻塞。
 */
export async function captureWorkspaceSnapshot(rawCwd: string): Promise<WorkspaceSnapshot> {
  const cwd = safeRealpath(rawCwd);
  if (!existsSync(cwd)) {
    return { mode: 'none', cwd, files: new Map() };
  }

  const gitCtx = await resolveGitContext(cwd);
  if (gitCtx) {
    try {
      const { stdout } = await execFileAsync(
        'git',
        ['status', '--porcelain=v1', '-z', '-uall', '--', '.'],
        { cwd, timeout: 2500, maxBuffer: 8 * 1024 * 1024 }
      );
      const parsed = parseGitPorcelainZ(stdout).slice(0, MAX_STAT_DIRTY_FILES);
      const files = new Map<string, FileFingerprint>();

      await Promise.all(
        parsed.map(async ({ statusXY, repoPath }) => {
          const absPath = resolve(gitCtx.gitRoot, repoPath);
          const rel = toPosixPath(relative(cwd, absPath));
          if (!rel || rel.startsWith('..') || rel.split('/').some((seg) => IGNORED_DIRS.has(seg))) {
            return;
          }
          const fp = await fingerprintDiskFile(absPath, rel, statusXY);
          files.set(rel, fp);
        })
      );

      return {
        mode: 'git',
        cwd,
        gitRoot: gitCtx.gitRoot,
        headSha: gitCtx.headSha,
        files,
      };
    } catch {
      // Git 异常时平滑降级到目录指纹
    }
  }

  const fsFiles = await walkDirectoryFingerprints(cwd);
  return {
    mode: 'fs',
    cwd,
    files: fsFiles,
  };
}

function hasFingerprintChanged(prev: FileFingerprint, next: FileFingerprint): boolean {
  if (prev.exists !== next.exists) return true;
  if (!prev.exists && !next.exists) return false;
  if (prev.size !== next.size) return true;
  if (prev.sha1 !== undefined && next.sha1 !== undefined) {
    return prev.sha1 !== next.sha1;
  }
  return Math.abs(prev.mtimeMs - next.mtimeMs) > 0.5;
}

async function countFileLinesSafe(absPath: string): Promise<number | undefined> {
  try {
    const st = await stat(absPath);
    if (!st.isFile() || st.size > MAX_LINE_COUNT_FILE_BYTES) return undefined;
    const buf = await readFile(absPath);
    // 跳过明显的二进制文件（包含 NUL 字节）
    if (buf.includes(0)) return undefined;
    const text = buf.toString('utf8');
    if (!text) return 0;
    const lines = text.split('\n');
    return text.endsWith('\n') ? Math.max(1, lines.length - 1) : lines.length;
  } catch {
    return undefined;
  }
}

async function collectGitChangedFilesBetweenCommits(
  cwd: string,
  gitRoot: string,
  fromSha: string,
  toSha: string
): Promise<Map<string, WorkspaceFileChangeKind>> {
  const result = new Map<string, WorkspaceFileChangeKind>();
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['diff', '--name-status', '-z', fromSha, toSha, '--', '.'],
      { cwd, timeout: 2200, maxBuffer: 4 * 1024 * 1024 }
    );
    const parts = stdout.split('\0').filter(Boolean);
    for (let i = 0; i < parts.length; i += 2) {
      const status = parts[i] ?? '';
      let repoPath = parts[i + 1] ?? '';
      if (status.startsWith('R') || status.startsWith('C')) {
        repoPath = parts[i + 2] ?? repoPath;
        i += 1;
      }
      if (!repoPath) continue;
      const absPath = resolve(gitRoot, repoPath);
      const rel = toPosixPath(relative(cwd, absPath));
      if (!rel || rel.startsWith('..')) continue;
      const kind: WorkspaceFileChangeKind = status.startsWith('A')
        ? 'added'
        : status.startsWith('D')
          ? 'deleted'
          : 'modified';
      result.set(rel, kind);
    }
  } catch {
    // ignore
  }
  return result;
}

async function enrichGitLineStats(
  cwd: string,
  gitRoot: string,
  rawChanges: ReadonlyArray<{ path: string; kind: WorkspaceFileChangeKind }>,
  byMemberName?: string
): Promise<WorkspaceFileChange[]> {
  if (rawChanges.length === 0) return [];

  const statsByRelPath = new Map<string, { additions: number; deletions: number }>();
  const trackedPaths = rawChanges
    .filter((c) => c.kind !== 'added')
    .slice(0, 40)
    .map((c) => resolve(cwd, c.path));

  if (trackedPaths.length > 0) {
    try {
      const { stdout } = await execFileAsync(
        'git',
        ['diff', 'HEAD', '--numstat', '-z', '--', ...trackedPaths],
        { cwd, timeout: 2200, maxBuffer: 4 * 1024 * 1024 }
      );
      const tokens = stdout.split('\0').filter(Boolean);
      for (const token of tokens) {
        const firstTab = token.indexOf('\t');
        const secondTab = firstTab >= 0 ? token.indexOf('\t', firstTab + 1) : -1;
        if (firstTab < 0 || secondTab < 0) continue;
        const addStr = token.slice(0, firstTab);
        const delStr = token.slice(firstTab + 1, secondTab);
        const repoPath = token.slice(secondTab + 1);
        const addNum = Number.parseInt(addStr, 10);
        const delNum = Number.parseInt(delStr, 10);
        if (Number.isNaN(addNum) || Number.isNaN(delNum)) continue;
        const abs = resolve(gitRoot, repoPath);
        const rel = toPosixPath(relative(cwd, abs));
        if (rel && !rel.startsWith('..')) {
          statsByRelPath.set(rel, { additions: addNum, deletions: delNum });
        }
      }
    } catch {
      // HEAD 不存在（如 git init 尚未提交）时忽略
    }
  }

  return Promise.all(
    rawChanges.map(async (item): Promise<WorkspaceFileChange> => {
      const numstat = statsByRelPath.get(item.path);
      if (numstat) {
        return {
          path: item.path,
          kind: item.kind,
          additions: numstat.additions,
          deletions: numstat.deletions,
          ...(byMemberName ? { byMemberName } : {}),
        };
      }
      if (item.kind === 'added') {
        const lines = await countFileLinesSafe(resolve(cwd, item.path));
        return {
          path: item.path,
          kind: 'added',
          ...(lines !== undefined ? { additions: lines, deletions: 0 } : {}),
          ...(byMemberName ? { byMemberName } : {}),
        };
      }
      return {
        path: item.path,
        kind: item.kind,
        ...(byMemberName ? { byMemberName } : {}),
      };
    })
  );
}

/**
 * 对比一轮执行前后的工作区快照，精准计算出本轮实际落盘的新增 / 修改 / 删除文件列表。
 */
export async function diffWorkspaceSnapshots(
  before: WorkspaceSnapshot,
  after: WorkspaceSnapshot,
  byMemberName?: string
): Promise<WorkspaceFileChange[]> {
  if (before.mode === 'none' || after.mode === 'none' || before.cwd !== after.cwd) {
    return [];
  }

  const detected = new Map<string, WorkspaceFileChangeKind>();

  if (before.mode === 'git' && after.mode === 'git') {
    // 1. 若成员在本轮内直接执行了 git commit 推进了 HEAD，先补齐两个 commit 之间的改动
    if (before.headSha && after.headSha && before.headSha !== after.headSha && after.gitRoot) {
      const committed = await collectGitChangedFilesBetweenCommits(
        after.cwd,
        after.gitRoot,
        before.headSha,
        after.headSha
      );
      for (const [p, k] of committed) {
        detected.set(p, k);
      }
    }

    // 2. 检查执行后处于 dirty / untracked 的文件
    for (const [relPath, nextFp] of after.files) {
      const prevFp = before.files.get(relPath);
      if (!prevFp) {
        if (!nextFp.exists || nextFp.statusXY.includes('D')) {
          detected.set(relPath, 'deleted');
        } else if (nextFp.statusXY === '??' || nextFp.statusXY.startsWith('A')) {
          detected.set(relPath, 'added');
        } else {
          detected.set(relPath, 'modified');
        }
      } else if (hasFingerprintChanged(prevFp, nextFp)) {
        if (prevFp.exists && !nextFp.exists) {
          detected.set(relPath, 'deleted');
        } else if (!prevFp.exists && nextFp.exists) {
          detected.set(
            relPath,
            nextFp.statusXY === '??' || nextFp.statusXY.startsWith('A') ? 'added' : 'modified'
          );
        } else {
          detected.set(relPath, 'modified');
        }
      }
    }

    // 3. 检查执行前在 dirty 表中，但执行后从 dirty 表中消失的文件（如删除了未跟踪文件，或还原了脏文件）
    for (const [relPath, prevFp] of before.files) {
      if (after.files.has(relPath) || detected.has(relPath)) continue;
      const absPath = resolve(after.cwd, relPath);
      if (!existsSync(absPath)) {
        if (prevFp.exists) {
          detected.set(relPath, 'deleted');
        }
      } else {
        detected.set(relPath, 'modified');
      }
    }

    const ordered = Array.from(detected.entries())
      .map(([path, kind]) => ({ path, kind }))
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

    if (after.gitRoot) {
      return enrichGitLineStats(after.cwd, after.gitRoot, ordered, byMemberName);
    }
    return ordered.map((item) => ({
      ...item,
      ...(byMemberName ? { byMemberName } : {}),
    }));
  }

  // 非 Git 普通目录对比
  for (const [relPath, nextFp] of after.files) {
    const prevFp = before.files.get(relPath);
    if (!prevFp) {
      if (nextFp.exists) detected.set(relPath, 'added');
    } else if (hasFingerprintChanged(prevFp, nextFp)) {
      detected.set(relPath, nextFp.exists ? 'modified' : 'deleted');
    }
  }
  for (const [relPath, prevFp] of before.files) {
    if (!after.files.has(relPath) && prevFp.exists) {
      detected.set(relPath, 'deleted');
    }
  }

  const ordered = Array.from(detected.entries())
    .map(([path, kind]) => ({ path, kind }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  return Promise.all(
    ordered.map(async (item): Promise<WorkspaceFileChange> => {
      if (item.kind === 'added') {
        const lines = await countFileLinesSafe(resolve(after.cwd, item.path));
        return {
          path: item.path,
          kind: 'added',
          ...(lines !== undefined ? { additions: lines, deletions: 0 } : {}),
          ...(byMemberName ? { byMemberName } : {}),
        };
      }
      return {
        path: item.path,
        kind: item.kind,
        ...(byMemberName ? { byMemberName } : {}),
      };
    })
  );
}
