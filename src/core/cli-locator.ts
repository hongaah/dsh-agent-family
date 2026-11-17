import { accessSync, constants, existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, delimiter, dirname, isAbsolute, join, resolve } from 'node:path';

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

const LOOPBACK_NO_PROXY = '127.0.0.1,localhost,::1';

export interface LocatorOptions {
  /** 是否运行在具备原生 Agent 能力的 DSH 宿主内 */
  readonly hasDshHostRuntime?: boolean;
  /** 优先查找的额外目录（用于测试或自定义注入） */
  readonly extraSearchDirs?: readonly string[];
  /** 是否扫描系统 PATH / NVM / Homebrew 默认目录（默认 true） */
  readonly includeSystemPaths?: boolean;
  /** 测试覆盖当前进程 execPath（模拟 Electron 二进制路径） */
  readonly execPathOverride?: string;
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
    pushUnique('/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin');
    pushUnique('/Applications/DeepSeek Harness.app/Contents/Resources/runtime/bin');
    pushUnique('/usr/bin');
    pushUnique('/bin');
  }

  return dirs;
}

/**
 * 解析可用于启动 JS 脚本（如 `dist/phone-mcp.js`）的真实 Node 可执行程序。
 * 在 Electron 桌面宿主内，`process.execPath` 指向 GUI 应用二进制，直接由外部 CLI（如 Codex）拉起会误启动 GUI 窗口导致卡死；
 * 因此优先查找系统真实 `node`，若回退到 Electron 二进制则强制附带 `ELECTRON_RUN_AS_NODE=1`。
 */
export function resolveNodeExecutable(options: LocatorOptions = {}): {
  readonly command: string;
  readonly env: Readonly<Record<string, string>>;
} {
  const currentExec = options.execPathOverride ?? process.execPath;
  const execBase = basename(currentExec).toLowerCase();
  if (execBase === 'node' || execBase === 'node.exe') {
    return { command: currentExec, env: {} };
  }

  const candidateDirs = buildCandidateBinDirs(options);
  for (const dir of candidateDirs) {
    const candidate = join(dir, 'node');
    if (isExecutableFile(candidate)) {
      return { command: candidate, env: {} };
    }
  }

  return {
    command: currentExec,
    env: { ELECTRON_RUN_AS_NODE: '1' },
  };
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

function mergeNoProxy(existing: string | undefined): string {
  if (!existing || !existing.trim()) return LOOPBACK_NO_PROXY;
  const parts = existing
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  for (const host of LOOPBACK_NO_PROXY.split(',')) {
    if (!parts.includes(host)) parts.push(host);
  }
  return parts.join(',');
}

/**
 * 为外部 CLI 子进程构造增强 PATH、绕过本地代理劫持 `127.0.0.1`、且剥离父进程内部控制变量的干净环境。
 */
export function buildChildProcessEnv(
  extraEnv: Readonly<Record<string, string>> = {},
  executablePath?: string
): Record<string, string> {
  const baseEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value !== 'string') continue;
    if (
      key === 'CLAUDECODE' ||
      key === 'CLAUDE_CODE_ENTRYPOINT' ||
      key === 'ELECTRON_RUN_AS_NODE'
    ) {
      continue;
    }
    baseEnv[key] = value;
  }

  const pathDirs = buildCandidateBinDirs();
  if (executablePath) {
    const execDir = dirname(executablePath);
    if (!pathDirs.includes(execDir)) {
      pathDirs.unshift(execDir);
    }
  }
  const resolvedNode = resolveNodeExecutable();
  const nodeDir = dirname(resolvedNode.command);
  if (!pathDirs.includes(nodeDir)) {
    pathDirs.unshift(nodeDir);
  }
  baseEnv.PATH = pathDirs.join(delimiter);
  baseEnv.NO_PROXY = mergeNoProxy(baseEnv.NO_PROXY);
  baseEnv.no_proxy = mergeNoProxy(baseEnv.no_proxy);

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
          executablePath: 'dsh://in-process-host',
          mode: 'dsh-native',
          note: '直接复用当前 DeepSeek Harness 宿主进程大脑、模型配置与原生审批流',
        });
        continue;
      }
      results.push({
        kind,
        label: BODY_LABELS[kind],
        available: Boolean(resolved),
        executablePath: resolved,
        mode: 'cli',
        note: resolved ? `已就绪 (${resolved})` : '在 DSH 桌面端/Web 宿主加载插件后将自动就绪',
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
