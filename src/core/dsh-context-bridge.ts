import type { PendingMainSyncSummary, WorkspaceFileChange } from './types.ts';

export interface BridgeableSessionEvent {
  readonly seq: number;
  readonly type: string;
  readonly data: Record<string, unknown>;
}

export interface BridgeableSessionLike {
  readonly id?: string;
  readonly seq?: number;
  readonly header: { readonly cwd?: string; readonly title?: string } & Record<string, unknown>;
  snapshotEvents?(fromSeq?: number): readonly BridgeableSessionEvent[];
}

export interface RecordCollaborationActivityInput {
  readonly sessionId: string;
  readonly actorLabel: string;
  readonly userPrompt: string;
  readonly conclusion: string;
  readonly changedFiles?: readonly WorkspaceFileChange[];
}

interface PendingSessionLedger {
  readonly filesByPath: Map<string, WorkspaceFileChange>;
  readonly notes: string[];
  updatedAt: string;
}

const CASUAL_CHITCHAT_RE =
  /^(?:大家好|哈喽|嗨|你好|早|早上好|中午好|下午好|晚上好|晚安|在吗|有人吗|hi|hello|hey|yo|thanks|thank\s*you|谢谢|多谢|辛苦了|收到|好的|ok|okay)[!！~～。.，,\s]*$/iu;

export function isCasualGreetingPrompt(prompt: string): boolean {
  const clean = prompt
    .replace(/@[a-z][a-z0-9-]{0,31}\b/giu, '')
    .trim();
  if (!clean) return true;
  return clean.length <= 24 && CASUAL_CHITCHAT_RE.test(clean);
}

function stripInternalXmlBlocks(text: string): string {
  return text
    .replace(/<family_direct_mention>[\s\S]*?<\/family_direct_mention>/gu, '')
    .replace(/<family_collaboration_receipt>[\s\S]*?<\/family_collaboration_receipt>/gu, '')
    .replace(/<family_workspace_changes>[\s\S]*?<\/family_workspace_changes>/gu, '')
    .replace(/<dsh_session_context>[\s\S]*?<\/dsh_session_context>/gu, '')
    .trim();
}

function extractBlocksText(messageObj: unknown, maxChars: number): string {
  if (!messageObj || typeof messageObj !== 'object') return '';
  const msg = messageObj as Record<string, unknown>;
  if (!Array.isArray(msg.content)) return '';
  const texts: string[] = [];
  for (const part of msg.content) {
    if (part && typeof part === 'object') {
      const p = part as Record<string, unknown>;
      if (p.type === 'text' && typeof p.text === 'string' && p.text.trim()) {
        texts.push(p.text.trim());
      }
    }
  }
  const clean = stripInternalXmlBlocks(texts.join('\n'));
  if (!clean) return '';
  return clean.length > maxChars ? `${clean.slice(0, maxChars)}…` : clean;
}

function extractFilePathFromToolArgs(rawArgs: unknown): string[] {
  if (!rawArgs || typeof rawArgs !== 'object' || Array.isArray(rawArgs)) return [];
  const args = rawArgs as Record<string, unknown>;
  const found: string[] = [];
  for (const key of ['path', 'file_path', 'filePath', 'target_file', 'file']) {
    const val = args[key];
    if (typeof val === 'string' && val.trim()) {
      found.push(val.trim());
    }
  }
  return found;
}

function formatChangeKindLabel(kind: WorkspaceFileChange['kind']): string {
  switch (kind) {
    case 'added':
      return '新增';
    case 'deleted':
      return '删除';
    default:
      return '修改';
  }
}

function formatChangeStats(change: WorkspaceFileChange): string {
  if (change.kind === 'deleted') return '';
  if (change.additions !== undefined && change.deletions !== undefined && change.deletions > 0) {
    return ` (+${change.additions} / -${change.deletions})`;
  }
  if (change.additions !== undefined) {
    return ` (+${change.additions})`;
  }
  return '';
}

/**
 * 负责 DSH 主工作台会话与家庭成员之间的双向轻量上下文桥接：
 * 1. 正向（DSH -> 家庭成员）：按 `(sessionId, memberId)` 维护游标 `lastSyncedSeq`，仅注入自上次同步以来的增量核心诉求、结论与涉及文件，杜绝全量 Token 爆炸；
 * 2. 按需深挖：提供 `readRecentTranscript` 供成员随身手机 `phone_read_dsh_session` 主动查阅更多细节；
 * 3. 反向（家庭成员 -> DSH 主会话）：分级沉淀工作区文件变更账本与协作结论，在主对话下一轮 `agent/pre-step` 中附带「脏文件强制重读守卫（Stale-Read Guard）」精准同步给主模型。
 */
export class DshSessionContextBridge {
  private readonly getSession: (sessionId: string) => BridgeableSessionLike | undefined;
  private readonly onSyncSummaryChange?: (summary: PendingMainSyncSummary) => void;
  private readonly lastSyncedSeqByActor = new Map<string, number>();
  private readonly pendingLedgersBySession = new Map<string, PendingSessionLedger>();

  public constructor(
    getSession: (sessionId: string) => BridgeableSessionLike | undefined,
    options?: {
      readonly onSyncSummaryChange?: (summary: PendingMainSyncSummary) => void;
    }
  ) {
    this.getSession = getSession;
    this.onSyncSummaryChange = options?.onSyncSummaryChange;
  }

  public resetMemberCursor(sessionId: string, memberId: string): void {
    this.lastSyncedSeqByActor.delete(`${sessionId}::${memberId}`);
  }

  public buildIncrementalBriefing(sessionId: string, memberId: string): string {
    if (!sessionId || sessionId === 'default' || sessionId.startsWith('family-')) {
      return '';
    }
    const session = this.getSession(sessionId);
    if (!session?.snapshotEvents) {
      return '';
    }

    const cursorKey = `${sessionId}::${memberId}`;
    const prevSeq = this.lastSyncedSeqByActor.get(cursorKey) ?? 0;
    const rawEvents = session.snapshotEvents(prevSeq);
    const newEvents = rawEvents.filter((ev) => ev.seq > prevSeq);
    if (newEvents.length === 0) {
      return '';
    }

    let maxSeq = prevSeq;
    const turnsSummary: string[] = [];
    const touchedFiles: string[] = [];

    for (const ev of newEvents) {
      if (ev.seq > maxSeq) maxSeq = ev.seq;

      if (ev.type === 'user/message') {
        const text = extractBlocksText(ev.data.message ?? ev.data, 360);
        if (text) {
          turnsSummary.push(`- [用户]: ${text}`);
        }
      } else if (ev.type === 'assistant/message') {
        const text = extractBlocksText(ev.data.message, 420);
        if (text) {
          turnsSummary.push(`- [DSH 主对话]: ${text}`);
        }
      } else if (ev.type === 'tool/call') {
        for (const p of extractFilePathFromToolArgs(ev.data.arguments)) {
          if (!touchedFiles.includes(p)) {
            touchedFiles.push(p);
          }
        }
      }
    }

    this.lastSyncedSeqByActor.set(cursorKey, maxSeq);

    if (turnsSummary.length === 0 && touchedFiles.length === 0) {
      return '';
    }

    const selectedTurns =
      turnsSummary.length <= 10
        ? turnsSummary
        : [
            ...turnsSummary.slice(0, 2),
            `  ...（中间省略 ${turnsSummary.length - 10} 条记录，如需按关键词或完整历史查阅请调用 phone_read_dsh_session）...`,
            ...turnsSummary.slice(-8),
          ];
    const recentFiles = touchedFiles.slice(-15);
    const headerLines: string[] = ['<dsh_session_context>'];
    headerLines.push(
      `【当前关联的 DSH 主会话增量背景简报】(cwd: ${session.header.cwd ?? '当前工作区'}${session.header.title ? `, 会话标题: ${String(session.header.title)}` : ''})`
    );
    if (recentFiles.length > 0) {
      headerLines.push(`主会话涉及文件：${recentFiles.join(', ')}`);
    }
    if (selectedTurns.length > 0) {
      headerLines.push('会话关键对话脉络：');
      headerLines.push(...selectedTurns);
    }
    headerLines.push(
      '（提示：若用户问及更早的讨论细节或特定关键词，请主动调用随身手机工具 `phone_read_dsh_session` 查阅完整会话记录，切勿凭空猜测。）'
    );
    headerLines.push('</dsh_session_context>');

    const joined = headerLines.join('\n');
    return joined.length > 2600 ? `${joined.slice(0, 2580)}…\n</dsh_session_context>` : joined;
  }

  public readRecentTranscript(
    sessionId: string,
    maxItems: number = 25,
    query?: string
  ): string {
    if (!sessionId || sessionId === 'default') {
      return '当前处于默认独立工作台，未绑定具体的外部 DSH 会话。';
    }
    const session = this.getSession(sessionId);
    if (!session?.snapshotEvents) {
      return `未找到会话 "${sessionId}" 的可读历史记录。`;
    }

    const allEvents = session.snapshotEvents(0);
    const lines: string[] = [];
    const files: string[] = [];

    for (const ev of allEvents) {
      if (ev.type === 'user/message') {
        const text = extractBlocksText(ev.data.message ?? ev.data, 700);
        if (text) lines.push(`[用户 #${ev.seq}]: ${text}`);
      } else if (ev.type === 'assistant/message') {
        const text = extractBlocksText(ev.data.message, 800);
        if (text) lines.push(`[DSH 主对话 #${ev.seq}]: ${text}`);
      } else if (ev.type === 'tool/call') {
        const toolName = typeof ev.data.name === 'string' ? ev.data.name : 'tool';
        const paths = extractFilePathFromToolArgs(ev.data.arguments);
        for (const p of paths) {
          if (!files.includes(p)) files.push(p);
        }
        if (paths.length > 0) {
          lines.push(`[DSH 工具 #${ev.seq}]: ${toolName}(${paths.join(', ')})`);
        }
      }
    }

    const normalizedQuery = query?.trim().toLowerCase() ?? '';
    const filtered = normalizedQuery
      ? lines.filter((line) => line.toLowerCase().includes(normalizedQuery))
      : lines;

    const clamped = Math.max(1, Math.min(60, maxItems));
    const tail = filtered.slice(-clamped);
    if (tail.length === 0) {
      return normalizedQuery
        ? `在当前 DSH 会话 (${sessionId}, 共 ${lines.length} 条记录) 中未检索到包含 "${query?.trim()}" 的记录。`
        : `当前 DSH 会话 (${sessionId}, cwd=${session.header.cwd ?? ''}) 尚无历史对话消息。`;
    }

    return [
      `【DSH 主会话 (${sessionId}) ${normalizedQuery ? `关键词 "${query?.trim()}" 匹配结果` : `最近 ${tail.length}/${lines.length} 条记录`}】`,
      `工作目录: ${session.header.cwd ?? '未知'}`,
      ...(files.length > 0 ? [`涉及文件: ${files.slice(-20).join(', ')}`] : []),
      `---`,
      ...tail,
    ].join('\n');
  }

  private ensureLedger(sessionId: string): PendingSessionLedger {
    let ledger = this.pendingLedgersBySession.get(sessionId);
    if (!ledger) {
      ledger = {
        filesByPath: new Map(),
        notes: [],
        updatedAt: new Date().toISOString(),
      };
      this.pendingLedgersBySession.set(sessionId, ledger);
    }
    return ledger;
  }

  private toSummary(sessionId: string, ledger?: PendingSessionLedger): PendingMainSyncSummary {
    return {
      scopeId: sessionId,
      changedFiles: ledger ? Array.from(ledger.filesByPath.values()) : [],
      noteCount: ledger ? ledger.notes.length : 0,
      updatedAt: ledger?.updatedAt ?? new Date().toISOString(),
    };
  }

  public getPendingSyncSummary(sessionId: string): PendingMainSyncSummary {
    return this.toSummary(sessionId, this.pendingLedgersBySession.get(sessionId));
  }

  public listAllPendingSyncSummaries(): PendingMainSyncSummary[] {
    const list: PendingMainSyncSummary[] = [];
    for (const [sessionId, ledger] of this.pendingLedgersBySession) {
      if (ledger.filesByPath.size > 0 || ledger.notes.length > 0) {
        list.push(this.toSummary(sessionId, ledger));
      }
    }
    return list;
  }

  /**
   * 分级记录家庭成员或群聊与用户的协作进展：
   * - 若无文件改动且属于日常寒暄问候，静默跳过，绝不污染主会话；
   * - 若有真实落盘文件改动，按文件路径合并更新账本（含临时文件新增后删除自动抵消）；
   * - 实时触发 `onSyncSummaryChange` 以便前端更新左屏家庭胶囊微标。
   */
  public recordCollaborationActivity(
    input: RecordCollaborationActivityInput
  ): PendingMainSyncSummary | null {
    const { sessionId, actorLabel, userPrompt, conclusion, changedFiles = [] } = input;
    if (!sessionId || sessionId === 'default' || sessionId.startsWith('family-')) {
      return null;
    }

    if (changedFiles.length === 0 && isCasualGreetingPrompt(userPrompt)) {
      return null;
    }

    const ledger = this.ensureLedger(sessionId);
    for (const change of changedFiles) {
      const existing = ledger.filesByPath.get(change.path);
      if (existing?.kind === 'added' && change.kind === 'deleted') {
        // 本批次内临时创建又自行清理的脚本/中间文件，直接抵消不打扰主会话
        ledger.filesByPath.delete(change.path);
        continue;
      }
      const mergedKind =
        existing?.kind === 'added' && change.kind === 'modified' ? 'added' : change.kind;
      ledger.filesByPath.set(change.path, {
        ...change,
        kind: mergedKind,
        byMemberName: change.byMemberName ?? actorLabel,
      });
    }

    const cleanPrompt = userPrompt.replace(/\s+/gu, ' ').trim().slice(0, 90);
    const cleanConclusion = conclusion.replace(/\s+/gu, ' ').trim().slice(0, 280);
    if (cleanConclusion || changedFiles.length > 0) {
      const noteLine = cleanConclusion
        ? `${actorLabel} 处理了「${cleanPrompt}」：${cleanConclusion}`
        : `${actorLabel} 处理了「${cleanPrompt}」并更新了 ${changedFiles.length} 个文件`;
      ledger.notes.push(noteLine);
      if (ledger.notes.length > 8) {
        ledger.notes.shift();
      }
    }

    ledger.updatedAt = new Date().toISOString();
    const summary = this.toSummary(sessionId, ledger);
    this.onSyncSummaryChange?.(summary);
    return summary;
  }

  public recordReceiptForMainAgent(
    sessionId: string,
    receiptLine: string,
    changedFiles?: readonly WorkspaceFileChange[]
  ): void {
    if (!sessionId || sessionId === 'default' || sessionId.startsWith('family-')) {
      return;
    }
    const trimmed = receiptLine.trim();
    if (!trimmed && (!changedFiles || changedFiles.length === 0)) return;
    const ledger = this.ensureLedger(sessionId);
    if (changedFiles) {
      for (const change of changedFiles) {
        const existing = ledger.filesByPath.get(change.path);
        if (existing?.kind === 'added' && change.kind === 'deleted') {
          ledger.filesByPath.delete(change.path);
          continue;
        }
        const mergedKind =
          existing?.kind === 'added' && change.kind === 'modified' ? 'added' : change.kind;
        ledger.filesByPath.set(change.path, {
          ...change,
          kind: mergedKind,
        });
      }
    }
    if (trimmed) {
      ledger.notes.push(trimmed.length > 700 ? `${trimmed.slice(0, 700)}…` : trimmed);
      if (ledger.notes.length > 10) {
        ledger.notes.shift();
      }
    }
    ledger.updatedAt = new Date().toISOString();
    this.onSyncSummaryChange?.(this.toSummary(sessionId, ledger));
  }

  public consumePendingReceipts(sessionId: string): string {
    const ledger = this.pendingLedgersBySession.get(sessionId);
    if (!ledger || (ledger.filesByPath.size === 0 && ledger.notes.length === 0)) {
      return '';
    }
    const changedFiles = Array.from(ledger.filesByPath.values());
    const notes = [...ledger.notes];
    this.pendingLedgersBySession.delete(sessionId);
    this.onSyncSummaryChange?.(this.toSummary(sessionId, undefined));

    if (changedFiles.length > 0) {
      const fileLines = changedFiles.map((f) => {
        const who = f.byMemberName ? ` — 由 ${f.byMemberName} ${formatChangeKindLabel(f.kind)}` : '';
        return `- [${formatChangeKindLabel(f.kind)}] \`${f.path}\`${formatChangeStats(f)}${who}`;
      });
      return [
        '',
        '',
        '<family_workspace_changes>',
        '【智能体家庭工作区文件变更同步与防覆盖守卫】',
        `自你上一轮执行以来，用户在当前会话通过「智能体家庭」完成了以下文件落盘修改（共 ${changedFiles.length} 个文件）：`,
        ...fileLines,
        ...(notes.length > 0 ? ['', '协作背景摘要：', ...notes.map((n) => `- ${n}`)] : []),
        '',
        '⚠️ 强制重读守卫（Stale-Read Guard）：',
        '上述「新增 / 修改」的文件已在磁盘更新，你此前上下文历史中读取过的旧文件内容已失效（Stale）。若本轮需要引用、审查或继续编辑这些文件，你【必须】先重新调用读取文件工具获取最新内容，严禁凭历史缓存覆盖修改；标记为「删除」的文件请勿按旧印象写回。',
        '</family_workspace_changes>',
      ].join('\n');
    }

    return [
      '',
      '',
      '<family_collaboration_receipt>',
      '以下是用户在当前会话通过「智能体家庭」刚刚完成的讨论进展回执（未修改工作区文件，供保持上下文衔接）：',
      ...notes.map((item) => `- ${item}`),
      '</family_collaboration_receipt>',
    ].join('\n');
  }
}
