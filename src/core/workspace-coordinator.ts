import { realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';

import type { WorkspaceFileChange } from './types.ts';

const RECENT_TOUCH_TTL_MS = 10 * 60 * 1000;

const FILE_MUTATION_TOOL_RE =
  /(?:^|[_./])(?:write|edit|multiedit|notebookedit|str_replace_editor|apply_patch|patch|create_file|write_file|replace_in_file|delete_file|filechange)(?:$|[_./])/iu;

const CONCURRENT_GIT_HAZARD_RULES: ReadonlyArray<{
  readonly regex: RegExp;
  readonly reason: string;
}> = [
  {
    regex: /(?:^|[;&|()\s])git\s+reset\b/iu,
    reason: '同目录有其他家人正在并发工作，禁止执行 git reset 以免抹除他人未提交改动',
  },
  {
    regex: /(?:^|[;&|()\s])git\s+clean\b/iu,
    reason: '同目录有其他家人正在并发工作，禁止执行 git clean 以免误删他人新建文件',
  },
  {
    regex: /(?:^|[;&|()\s])git\s+stash\b/iu,
    reason: '同目录有其他家人正在并发工作，禁止执行 git stash 收走共享工作区改动',
  },
  {
    regex: /(?:^|[;&|()\s])git\s+(?:checkout|restore|switch)\b/iu,
    reason: '同目录有其他家人正在并发工作，禁止执行 git checkout/restore/switch 切换分支或回滚工作区',
  },
];

function normalizeCwdKey(rawCwd: string): string {
  const abs = resolve(rawCwd);
  try {
    return realpathSync(abs);
  } catch {
    return abs;
  }
}

function toRelativePosix(baseCwd: string, candidatePath: string): string | null {
  const trimmed = candidatePath.trim().replace(/^["']|["']$/gu, '');
  if (!trimmed || trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
    return null;
  }
  const absTarget = isAbsolute(trimmed) ? resolve(trimmed) : resolve(baseCwd, trimmed);
  let normalizedTarget = absTarget;
  try {
    normalizedTarget = realpathSync(absTarget);
  } catch {
    // 新建文件尚不存在时使用 resolve 路径并在父目录存在时对齐 realpath
    const slashIdx = Math.max(absTarget.lastIndexOf('/'), absTarget.lastIndexOf('\\'));
    if (slashIdx > 0) {
      const parentDir = absTarget.slice(0, slashIdx);
      const baseName = absTarget.slice(slashIdx + 1);
      try {
        normalizedTarget = resolve(realpathSync(parentDir), baseName);
      } catch {
        normalizedTarget = absTarget;
      }
    }
  }
  const rel = relative(baseCwd, normalizedTarget).split(sep).join('/');
  if (!rel || rel.startsWith('..')) {
    return null;
  }
  return rel;
}

export function extractTargetFilesFromToolOperation(
  normalizedCwd: string,
  ctx: {
    readonly toolName?: string;
    readonly method?: string;
    readonly commandText?: string;
    readonly rawInput?: unknown;
  }
): { readonly isMutation: boolean; readonly paths: readonly string[] } {
  const toolSignal = `${ctx.toolName ?? ''} ${ctx.method ?? ''}`.trim();
  const paths = new Set<string>();
  let isMutation = FILE_MUTATION_TOOL_RE.test(toolSignal);

  const addCandidate = (val: unknown) => {
    if (typeof val !== 'string') return;
    const rel = toRelativePosix(normalizedCwd, val);
    if (rel) paths.add(rel);
  };

  if (ctx.rawInput && typeof ctx.rawInput === 'object' && !Array.isArray(ctx.rawInput)) {
    const obj = ctx.rawInput as Record<string, unknown>;
    if (typeof obj.command === 'string' && toolSignal.toLowerCase().includes('str_replace_editor')) {
      if (obj.command === 'view') {
        return { isMutation: false, paths: [] };
      }
      isMutation = true;
    }

    for (const key of ['file_path', 'path', 'filePath', 'target_file', 'file']) {
      addCandidate(obj[key]);
    }

    // Codex item/fileChange changes 数组或 MultiEdit edits
    if (Array.isArray(obj.changes)) {
      isMutation = true;
      for (const ch of obj.changes) {
        if (ch && typeof ch === 'object') {
          const rec = ch as Record<string, unknown>;
          addCandidate(rec.path ?? rec.file_path ?? rec.move_path);
        }
      }
    }

    // apply_patch 补丁文本提取: *** Update File: xxx / *** Add File: xxx / *** Delete File: xxx
    for (const patchKey of ['patch', 'diff', 'input']) {
      const patchText = obj[patchKey];
      if (typeof patchText === 'string' && patchText.includes('*** ')) {
        isMutation = true;
        for (const m of patchText.matchAll(/^\*\*\*\s+(?:Update|Add|Delete)\s+File:\s+(.+)$/gmu)) {
          addCandidate(m[1]);
        }
      }
    }
  }

  // 检查命令行重定向写文件（如 `> src/foo.ts`、`tee src/foo.ts`）
  const cmdCandidates: string[] = [];
  if (ctx.commandText) cmdCandidates.push(ctx.commandText);
  if (ctx.rawInput && typeof ctx.rawInput === 'object') {
    const rawCmd = (ctx.rawInput as Record<string, unknown>).command;
    if (typeof rawCmd === 'string') cmdCandidates.push(rawCmd);
  }
  for (const cmd of cmdCandidates) {
    for (const redir of cmd.matchAll(/(?:>{1,2}|\btee\s+(?:-a\s+)?)\s*([^\s;&|"'`]+)/gu)) {
      const target = redir[1];
      if (target && !target.startsWith('/dev/')) {
        const rel = toRelativePosix(normalizedCwd, target);
        if (rel) {
          isMutation = true;
          paths.add(rel);
        }
      }
    }
  }

  return {
    isMutation,
    paths: Array.from(paths),
  };
}

interface ActiveTurnEntry {
  readonly turnId: string;
  readonly scopeId: string;
  readonly cwdKey: string;
  readonly memberId: string;
  readonly memberName: string;
  readonly goalSummary: string;
  readonly startedAt: number;
  readonly leasedFiles: Set<string>;
}

interface RecentFileTouch {
  readonly path: string;
  readonly memberId: string;
  readonly memberName: string;
  readonly kind: WorkspaceFileChange['kind'];
  readonly touchedAt: number;
}

export type WorkspaceToolGuardVerdict =
  | { readonly action: 'ok'; readonly leasedPaths: readonly string[] }
  | {
      readonly action: 'conflict';
      readonly conflictingPath: string;
      readonly holderMemberId: string;
      readonly holderMemberName: string;
      readonly holderGoal: string;
      readonly message: string;
    }
  | {
      readonly action: 'concurrent_git_hazard';
      readonly activePeers: readonly string[];
      readonly reason: string;
      readonly message: string;
    };

/**
 * 同目录多 Agent 实时协作协调器（不造笨重 Worktree 轮子）：
 * 1. 实时在忙黑板（Live Workspace Blackboard）：记录谁正在哪个目录干什么、占用了哪些文件、刚改完哪些文件；
 * 2. 乐观文件防撞软锁（Optimistic File Lease）：成员 A 修改某文件期间自动持有该文件临时租约（Turn 结束或异常立即自动释放），阻止成员 B 同一时刻盲目并发覆写同一文件并引导其通过 `phone_call` 协商；
 * 3. 并发期全局 Git 破坏命令拦截：只要同目录此刻有其他成员也在并行执行，自动拦截 `git reset / checkout / restore / stash / clean` 以免一锅端抹掉队友未提交的半成品。
 */
export class WorkspaceCoordinator {
  private readonly activeTurns = new Map<string, ActiveTurnEntry>();
  private readonly recentTouchesByCwd = new Map<string, Map<string, RecentFileTouch>>();

  public beginTurn(params: {
    readonly turnId: string;
    readonly scopeId: string;
    readonly cwd: string;
    readonly memberId: string;
    readonly memberName: string;
    readonly goal: string;
  }): () => void {
    const cwdKey = normalizeCwdKey(params.cwd);
    const cleanGoal = params.goal
      .replace(/<[^>]+>[\s\S]*?<\/[^>]+>/gu, '')
      .replace(/\s+/gu, ' ')
      .trim()
      .slice(0, 90);
    const entry: ActiveTurnEntry = {
      turnId: params.turnId,
      scopeId: params.scopeId,
      cwdKey,
      memberId: params.memberId,
      memberName: params.memberName,
      goalSummary: cleanGoal || '处理协作任务',
      startedAt: Date.now(),
      leasedFiles: new Set(),
    };
    this.activeTurns.set(params.turnId, entry);

    return () => {
      this.activeTurns.delete(params.turnId);
    };
  }

  public recordCompletedChanges(
    cwd: string,
    memberId: string,
    memberName: string,
    changes: readonly WorkspaceFileChange[],
    now: number = Date.now()
  ): void {
    if (changes.length === 0) return;
    const cwdKey = normalizeCwdKey(cwd);
    let table = this.recentTouchesByCwd.get(cwdKey);
    if (!table) {
      table = new Map();
      this.recentTouchesByCwd.set(cwdKey, table);
    }
    this.pruneExpiredTouches(table, now);
    for (const ch of changes) {
      table.set(ch.path, {
        path: ch.path,
        memberId,
        memberName,
        kind: ch.kind,
        touchedAt: now,
      });
    }
  }

  /**
   * 在成员执行工具/命令前进行并发安全评估与文件软锁登记。
   */
  public evaluateAndClaimOperation(params: {
    readonly cwd: string;
    readonly memberId: string;
    readonly memberName: string;
    readonly toolName?: string;
    readonly method?: string;
    readonly commandText?: string;
    readonly rawInput?: unknown;
  }): WorkspaceToolGuardVerdict {
    const cwdKey = normalizeCwdKey(params.cwd);
    const otherActivePeers = Array.from(this.activeTurns.values()).filter(
      (t) => t.cwdKey === cwdKey && t.memberId !== params.memberId
    );

    // 1. 并发期全局 Git 工作区清库/切分支保护
    if (otherActivePeers.length > 0) {
      const cmds: string[] = [];
      if (params.commandText) cmds.push(params.commandText);
      if (params.rawInput && typeof params.rawInput === 'object') {
        const rawCmd = (params.rawInput as Record<string, unknown>).command;
        if (typeof rawCmd === 'string') cmds.push(rawCmd);
        if (Array.isArray(rawCmd)) {
          cmds.push(rawCmd.filter((x): x is string => typeof x === 'string').join(' '));
        }
      }
      for (const cmd of cmds) {
        for (const rule of CONCURRENT_GIT_HAZARD_RULES) {
          if (rule.regex.test(cmd)) {
            const peerLabels = Array.from(
              new Set(otherActivePeers.map((p) => `${p.memberName} (@${p.memberId})`))
            );
            return {
              action: 'concurrent_git_hazard',
              activePeers: peerLabels,
              reason: rule.reason,
              message: `⚠️ 同目录并发保护已拦截该命令：当前工作区还有 ${peerLabels.join('、')} 正在并行编码。${rule.reason}。请等队友完成或用 phone_call 与其确认后再操作。`,
            };
          }
        }
      }
    }

    // 2. 提取本次操作拟修改的文件路径，检查是否与其他正在运行成员的软租约冲突
    const extracted = extractTargetFilesFromToolOperation(cwdKey, params);
    if (!extracted.isMutation || extracted.paths.length === 0) {
      return { action: 'ok', leasedPaths: [] };
    }

    for (const relPath of extracted.paths) {
      for (const peerTurn of otherActivePeers) {
        if (peerTurn.leasedFiles.has(relPath)) {
          return {
            action: 'conflict',
            conflictingPath: relPath,
            holderMemberId: peerTurn.memberId,
            holderMemberName: peerTurn.memberName,
            holderGoal: peerTurn.goalSummary,
            message: `⚠️ 同目录文件防撞锁触发：文件 \`${relPath}\` 此刻正由家庭成员「${peerTurn.memberName} (@${peerTurn.memberId})」编辑占用中（当前任务：${peerTurn.goalSummary}）。为防止互相覆盖代码，请先用随身手机 \`phone_call\` 与 @${peerTurn.memberId} 协商接口/分工，或先修改其他不冲突的文件，稍后通过 \`phone_workspace_board\` 查看释放状态后再重新读取编辑。`,
          };
        }
      }
    }

    // 3. 无冲突：将上述文件挂载到当前成员活跃 Turn 的软租约集合中（Turn 结束自动释放）
    for (const turn of this.activeTurns.values()) {
      if (turn.cwdKey === cwdKey && turn.memberId === params.memberId) {
        for (const relPath of extracted.paths) {
          turn.leasedFiles.add(relPath);
        }
      }
    }

    return { action: 'ok', leasedPaths: extracted.paths };
  }

  /**
   * 为即将行动的成员生成精炼的 `<family_live_workspace>` 同目录实时态势简报。
   * 若当前既无并行队友、近期也无队友改动过文件，返回空字符串（零 Token 负担）。
   */
  public buildLiveWorkspaceBriefing(
    cwd: string,
    receiverMemberId: string,
    now: number = Date.now()
  ): string {
    const cwdKey = normalizeCwdKey(cwd);
    const activePeers = Array.from(this.activeTurns.values()).filter(
      (t) => t.cwdKey === cwdKey && t.memberId !== receiverMemberId
    );

    const recentTable = this.recentTouchesByCwd.get(cwdKey);
    if (recentTable) {
      this.pruneExpiredTouches(recentTable, now);
    }
    const recentPeerTouches = recentTable
      ? Array.from(recentTable.values()).filter((item) => item.memberId !== receiverMemberId)
      : [];

    if (activePeers.length === 0 && recentPeerTouches.length === 0) {
      return '';
    }

    const lines: string[] = [
      '<family_live_workspace>',
      '【同工作目录实时协作态势黑板（Shared Workspace）】',
    ];

    if (activePeers.length > 0) {
      lines.push('🟢 此刻正在同一目录并行工作的家人：');
      for (const p of activePeers) {
        const filesNote =
          p.leasedFiles.size > 0
            ? ` | 正在编辑占用文件：${Array.from(p.leasedFiles)
                .map((f) => `\`${f}\``)
                .join('、')}`
            : '';
        lines.push(`- ${p.memberName} (@${p.memberId}) 正在执行「${p.goalSummary}」${filesNote}`);
      }
    }

    if (recentPeerTouches.length > 0) {
      const recentDesc = recentPeerTouches
        .slice(-12)
        .map((t) => `\`${t.path}\` (由 ${t.memberName} ${t.kind === 'added' ? '新增' : t.kind === 'deleted' ? '删除' : '修改'})`)
        .join('、');
      lines.push(`📄 近期家人刚落盘修改的文件：${recentDesc}`);
    }

    lines.push(
      '⚠️ 同目录真人协作守则：1) 请避开队友正在编辑占用的文件，确需联动修改同一文件请先调 `phone_call` 商量（或调 `phone_workspace_board` 查看最新占用状态）；2) 修改近期队友动过的文件前必须先重新读取最新磁盘内容；3) 并行期间严禁执行 `git reset / checkout / stash / clean` 破坏共享工作区。'
    );
    lines.push('</family_live_workspace>');
    return lines.join('\n');
  }

  /**
   * 供随身手机工具 `phone_workspace_board` 主动查询当前目录完整协作黑板。
   */
  public formatBoardForPhoneTool(cwd: string, callerId: string, now: number = Date.now()): string {
    const cwdKey = normalizeCwdKey(cwd);
    const allActive = Array.from(this.activeTurns.values()).filter((t) => t.cwdKey === cwdKey);
    const recentTable = this.recentTouchesByCwd.get(cwdKey);
    if (recentTable) {
      this.pruneExpiredTouches(recentTable, now);
    }
    const recentList = recentTable ? Array.from(recentTable.values()) : [];

    const lines: string[] = [`【当前工作区实时协作黑板】(目录: ${cwdKey})`];
    if (allActive.length === 0) {
      lines.push('- 当前并行状态：除你之外暂无其他成员正在占用工作区文件。');
    } else {
      lines.push('- 当前活跃成员与文件软锁占用：');
      for (const a of allActive) {
        const selfTag = a.memberId === callerId ? '（你自己）' : '';
        const leased =
          a.leasedFiles.size > 0
            ? Array.from(a.leasedFiles)
                .map((f) => `\`${f}\``)
                .join('、')
            : '暂未锁定具体文件';
        lines.push(
          `  • ${a.memberName} (@${a.memberId})${selfTag} | 任务: ${a.goalSummary} | 占用文件: ${leased}`
        );
      }
    }

    if (recentList.length > 0) {
      lines.push('- 最近 10 分钟内家人落盘变更记录：');
      for (const item of recentList.slice(-20)) {
        const ageSec = Math.max(0, Math.round((now - item.touchedAt) / 1000));
        lines.push(
          `  • \`${item.path}\` (${item.kind}) — 由 ${item.memberName} (@${item.memberId}) 于 ${ageSec}s 前更新`
        );
      }
    } else {
      lines.push('- 最近 10 分钟内暂无其他文件落盘变更记录。');
    }

    return lines.join('\n');
  }

  private pruneExpiredTouches(table: Map<string, RecentFileTouch>, now: number): void {
    for (const [key, val] of table) {
      if (now - val.touchedAt > RECENT_TOUCH_TTL_MS) {
        table.delete(key);
      }
    }
  }
}
