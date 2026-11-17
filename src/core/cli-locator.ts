import { accessSync, constants, existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path';

import { BODY_KINDS, type BodyHealthStatus, type BodyKind, type BodySpec } from './types.ts';

const BODY_LABELS: Readonly<Record<BodyKind, string>> = {
  claude: 'Claude Code CLI',
  codex: 'OpenAI Codex CLI',
  opencode: 'OpenCode CLI',
  dsh: 'DeepSeek Harness (自身)',
};

const DEFAULT_COMMANDS: Readonly<Record<BodyKind, string>> = {
  claude: 'claude',
  codex: 'codex',
  opencode: 'opencode',
  dsh: 'dsh',
};

export interface LocatorOptions {
  /** 是否运行在具备原生子代理能力的 DSH 宿主内 */
  readonly hasDshHostRuntime?: boolean;
  /** 优先查找的额外目录（用于测试或自定义注入） */
  readonly extraSearchDirs?: readonly string[];
  /** 是否扫描系统 PATH / NVM / Homebrew 默认目录（默认 true） */
  readonly includeSystemPaths?: boolean;
}

function isExecutableFile(filePath: string): boolean {
  try {
    const stat = statSync(filePath);
    if (!stat.isFile()) return false;
    accessSync(filePath, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function collectNvmBinDirs(home: string): string[] {
  const versionsDir = join(home, '.nvm', 'versions', 'node');
  if (!existsSync(versionsDir)) return [];
  try {
    const entries = readdirSync(versionsDir).sort().reverse();
    return entries
      .map((ver) => join(versionsDir, ver, 'bin'))
      .filter((binPath) => existsSync(binPath));
  } catch {
    return [];
  }
}

export function buildCandidateBinDirs(options: LocatorOptions = {}): string[] {
  const dirs: string[] = [];
  const pushUnique = (dir: string | undefined) => {
    if (!dir) return;
    const trimmed = dir.trim();
    if (trimmed && !dirs.includes(trimmed)) {
      dirs.push(trimmed);
    }
  };

  for (const extra of options.extraSearchDirs ?? []) {
    pushUnique(extra);
  }

  if (options.includeSystemPaths !== false) {
    const envPath = process.env.PATH ?? '';
    for (const part of envPath.split(delimiter)) {
      pushUnique(part);
    }
    const home = homedir();
    for (const nvmBin of collectNvmBinDirs(home)) {
      pushUnique(nvmBin);
    }
    pushUnique(join(home, '.local', 'bin'));
    pushUnique(join(home, '.opencode', 'bin'));
    pushUnique(join(home, '.bun', 'bin'));
    pushUnique('/opt/homebrew/bin');
    pushUnique('/usr/local/bin');
    pushUnique('/usr/bin');
    pushUnique('/bin');
    pushUnique(dirname(process.execPath));
  }

  return dirs;
}

export async function resolveBodyExecutable(
  spec: BodySpec,
  options: LocatorOptions = {}
): Promise<string | undefined> {
  const requested = spec.command?.trim() || DEFAULT_COMMANDS[spec.kind];
  if (!requested) return undefined;

  if (isAbsolute(requested) || requested.includes('/')) {
    const abs = resolve(requested);
    return isExecutableFile(abs) ? abs : undefined;
  }

  const candidateDirs = buildCandidateBinDirs(options);
  for (const dir of candidateDirs) {
    const candidate = join(dir, requested);
    if (isExecutableFile(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

/**
 * 为外部 CLI 子进程构造增强 PATH 但剥离易污染的内部控制变量的干净环境。
 */
export function buildChildProcessEnv(
  extraEnv: Readonly<Record<string, string>> = {},
  executablePath?: string
): Record<string, string> {
  const baseEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value !== 'string') continue;
    // 防止宿主嵌套 Claude Code 时触发 CLAUDECODE=1 拒绝启动检测
    if (key === 'CLAUDECODE' || key === 'CLAUDE_CODE_ENTRYPOINT') continue;
    baseEnv[key] = value;
  }

  const pathDirs = buildCandidateBinDirs();
  if (executablePath) {
    const execDir = dirname(executablePath);
    if (!pathDirs.includes(execDir)) {
      pathDirs.unshift(execDir);
    }
  }
  const nodeDir = dirname(process.execPath);
  if (!pathDirs.includes(nodeDir)) {
    pathDirs.unshift(nodeDir);
  }
  baseEnv.PATH = pathDirs.join(delimiter);

  for (const [key, value] of Object.entries(extraEnv)) {
    baseEnv[key] = value;
  }
  return baseEnv;
}

export async function probeAllBodies(
  options: LocatorOptions = {}
): Promise<readonly BodyHealthStatus[]> {
  const results: BodyHealthStatus[] = [];
  for (const kind of BODY_KINDS) {
    const resolved = await resolveBodyExecutable({ kind }, options);
    if (kind === 'dsh') {
      if (options.hasDshHostRuntime) {
        results.push({
          kind,
          label: BODY_LABELS[kind],
          available: true,
          executablePath: resolved ?? 'dsh://in-process-host',
          mode: 'dsh-native',
          note: '复用当前运行中的 DeepSeek Harness 原生进程大脑与审批流',
        });
        continue;
      }
      results.push({
        kind,
        label: BODY_LABELS[kind],
        available: Boolean(resolved),
        executablePath: resolved,
        mode: 'cli',
        note: resolved ? '通过本地 dsh CLI 连接' : '在 DSH 桌面端/Web 宿主加载插件后将自动就绪',
      });
      continue;
    }

    results.push({
      kind,
      label: BODY_LABELS[kind],
      available: Boolean(resolved),
      executablePath: resolved,
      mode: 'cli',
      note: resolved ? `已就绪 (${resolved})` : `未在本机发现 ${DEFAULT_COMMANDS[kind]} 命令`,
    });
  }
  return results;
}
