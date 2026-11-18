import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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

interface CollaborationLogRecord {
  readonly timeIso: string;
  readonly actorLabel: string;
  readonly userPrompt?: string;
  readonly bodyText: string;
  readonly changedFiles: readonly WorkspaceFileChange[];
}

interface PendingSessionLedger {
  readonly batchId: string;
  readonly filesByPath: Map<string, WorkspaceFileChange>;
  readonly records: CollaborationLogRecord[];
  receiptFilePath: string;
  receiptTitle: string;
  updatedAt: string;
}

const CASUAL_CHITCHAT_RE =
  /^(?:大家好|哈喽|嗨|你好|早|早上好|中午好|下午好|晚上好|晚安|在吗|有人吗|hi|hello|hey|yo|thanks|thank\s*you|谢谢|多谢|辛苦了|收到|好的|ok|okay)[!！~～。.，,\s]*$/iu;

export function isCasualGreetingPrompt(prompt: string): boolean {
  const clean = prompt
    .replace(/@[^\s@]+/giu, '')
    .trim();
  if (!clean) return true;
  return clean.length <= 24 && CASUAL_CHITCHAT_RE.test(clean);
}

function stripInternalXmlBlocks(text: string): string {
  return text
    .replace(/<family_direct_mention>[\s\S]*?<\/family_direct_mention>/gu, '')
    .replace(/<family_collaboration_receipt>[\s\S]*?<\/family_collaboration_receipt>/gu, '')
    .replace(/<family_collaboration_index>[\s\S]*?<\/family_collaboration_index>/gu, '')
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

function sanitizePathSegment(raw: string): string {
  return raw.replace(/[^a-zA-Z0-9_\u4e00-\u9fa5.-]/gu, '_').slice(0, 64) || 'session';
}

function formatTimeStampForFile(date: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

/**
 * 负责 DSH 主工作台会话与家庭成员之间的双向轻量上下文桥接：
 * 1. 正向（DSH -> 家庭成员）：按 `(sessionId, memberId)` 维护游标 `lastSyncedSeq`，仅注入增量核心脉络；
 * 2. 按需深挖：提供 `readRecentTranscript` 供随身手机 `phone_read_dsh_session` 查阅；
 * 3. 反向（家庭成员 -> DSH 主会话）：将完整对话记录与操作变更写入独立的 Markdown 纪要文件（`receipts/<sessionId>/家庭协作纪要-*.md`），
 *    向主会话仅注入轻量文件索引与脏文件防覆盖重读守卫，彻底告别长段文本撑爆用户气泡。
 */
export class DshSessionContextBridge {
  private readonly getSession: (sessionId: string) => BridgeableSessionLike | undefined;
  private readonly receiptsBaseDir: string;
  private readonly onSyncSummaryChange?: (summary: PendingMainSyncSummary) => void;
  private readonly lastSyncedSeqByActor = new Map<string, number>();
  private readonly pendingLedgersBySession = new Map<string, PendingSessionLedger>();
  private readonly latestSavedReceiptBySession = new Map<
    string,
    { readonly path: string; readonly title: string; readonly updatedAt: string }
  >();
  private batchCounter = 0;

  public constructor(
    getSession: (sessionId: string) => BridgeableSessionLike | undefined,
    options?: {
      readonly storageDir?: string;
      readonly onSyncSummaryChange?: (summary: PendingMainSyncSummary) => void;
    }
  ) {
    this.getSession = getSession;
    const base = options?.storageDir ?? join(tmpdir(), 'dsh-agent-family');
    this.receiptsBaseDir = join(base, 'receipts');
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
        const srcKind =
          ev.data.source && typeof ev.data.source === 'object'
            ? (ev.data.source as Record<string, unknown>).kind
            : 'user';
        if (srcKind && srcKind !== 'user') continue;
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
        const srcKind =
          ev.data.source && typeof ev.data.source === 'object'
            ? (ev.data.source as Record<string, unknown>).kind
            : 'user';
        if (srcKind && srcKind !== 'user') continue;
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
      this.batchCounter += 1;
      const now = new Date();
      const stamp = formatTimeStampForFile(now);
      const sessionDir = join(this.receiptsBaseDir, sanitizePathSegment(sessionId));
      const fileName = `家庭协作纪要-${stamp}-${this.batchCounter}.md`;
      ledger = {
        batchId: `${stamp}-${this.batchCounter}`,
        filesByPath: new Map(),
        records: [],
        receiptFilePath: join(sessionDir, fileName),
        receiptTitle: fileName,
        updatedAt: now.toISOString(),
      };
      this.pendingLedgersBySession.set(sessionId, ledger);
    }
    return ledger;
  }

  private writeLedgerMarkdownFile(sessionId: string, ledger: PendingSessionLedger): void {
    try {
      const session = this.getSession(sessionId);
      const sessionDir = join(this.receiptsBaseDir, sanitizePathSegment(sessionId));
      mkdirSync(sessionDir, { recursive: true });

      const changedFiles = Array.from(ledger.filesByPath.values());
      const mdLines: string[] = [
        `# 🏠 智能体家庭协作纪要`,
        ``,
        `- **关联会话**：\`${sessionId}\`${session?.header.title ? `（${String(session.header.title)}）` : ''}`,
        `- **工作目录**：\`${session?.header.cwd ?? '当前工作区'}\``,
        `- **更新时间**：${ledger.updatedAt}`,
        ``,
      ];

      if (changedFiles.length > 0) {
        mdLines.push(`## 📄 工作区文件变更清单（共 ${changedFiles.length} 个文件）`, ``);
        for (const f of changedFiles) {
          const who = f.byMemberName ? ` — *${f.byMemberName}*` : '';
          mdLines.push(
            `- **[${formatChangeKindLabel(f.kind)}]** \`${f.path}\`${formatChangeStats(f)}${who}`
          );
        }
        mdLines.push(``);
      }

      mdLines.push(`## 💬 对话与协作全记录（共 ${ledger.records.length} 条）`, ``);
      for (const [idx, rec] of ledger.records.entries()) {
        mdLines.push(`### ${idx + 1}. ${rec.actorLabel}（${rec.timeIso}）`, ``);
        if (rec.userPrompt) {
          mdLines.push(`> **诉求 / 议题**：${rec.userPrompt.replace(/\n+/gu, ' ')}`, ``);
        }
        if (rec.bodyText) {
          mdLines.push(rec.bodyText, ``);
        }
        if (rec.changedFiles.length > 0) {
          mdLines.push(
            `**本轮变更文件**：${rec.changedFiles.map((c) => `\`${c.path}\` (${formatChangeKindLabel(c.kind)})`).join('、')}`,
            ``
          );
        }
      }

      const tmpPath = `${ledger.receiptFilePath}.tmp-${process.pid}-${Date.now()}`;
      writeFileSync(tmpPath, `${mdLines.join('\n')}\n`, 'utf8');
      renameSync(tmpPath, ledger.receiptFilePath);

      this.latestSavedReceiptBySession.set(sessionId, {
        path: ledger.receiptFilePath,
        title: ledger.receiptTitle,
        updatedAt: ledger.updatedAt,
      });
    } catch {
      // ignore disk failure in read-only sandbox
    }
  }

  private toSummary(sessionId: string, ledger?: PendingSessionLedger): PendingMainSyncSummary {
    const latestSaved = this.latestSavedReceiptBySession.get(sessionId);
    return {
      scopeId: sessionId,
      changedFiles: ledger ? Array.from(ledger.filesByPath.values()) : [],
      noteCount: ledger ? ledger.records.length : 0,
      ...(ledger?.receiptFilePath
        ? { latestReceiptPath: ledger.receiptFilePath, latestReceiptTitle: ledger.receiptTitle }
        : latestSaved
          ? { latestReceiptPath: latestSaved.path, latestReceiptTitle: latestSaved.title }
          : {}),
      updatedAt: ledger?.updatedAt ?? latestSaved?.updatedAt ?? new Date().toISOString(),
    };
  }

  public getPendingSyncSummary(sessionId: string): PendingMainSyncSummary {
    return this.toSummary(sessionId, this.pendingLedgersBySession.get(sessionId));
  }

  public listAllPendingSyncSummaries(): PendingMainSyncSummary[] {
    const seen = new Set<string>([
      ...this.pendingLedgersBySession.keys(),
      ...this.latestSavedReceiptBySession.keys(),
    ]);
    const list: PendingMainSyncSummary[] = [];
    for (const sessionId of seen) {
      const summary = this.getPendingSyncSummary(sessionId);
      if (
        summary.changedFiles.length > 0 ||
        summary.noteCount > 0 ||
        Boolean(summary.latestReceiptPath)
      ) {
        list.push(summary);
      }
    }
    return list;
  }

  /**
   * 分级记录家庭成员或群聊与用户的协作进展，并实时落盘为独立 Markdown 纪要文件。
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

    const nowIso = new Date().toISOString();
    ledger.records.push({
      timeIso: nowIso,
      actorLabel,
      userPrompt: userPrompt.trim(),
      bodyText: conclusion.trim(),
      changedFiles,
    });
    if (ledger.records.length > 20) {
      ledger.records.shift();
    }

    ledger.updatedAt = nowIso;
    this.writeLedgerMarkdownFile(sessionId, ledger);

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
    const nowIso = new Date().toISOString();
    if (trimmed || (changedFiles && changedFiles.length > 0)) {
      ledger.records.push({
        timeIso: nowIso,
        actorLabel: '智能体家庭协作',
        bodyText: trimmed,
        changedFiles: changedFiles ?? [],
      });
      if (ledger.records.length > 20) {
        ledger.records.shift();
      }
    }
    ledger.updatedAt = nowIso;
    this.writeLedgerMarkdownFile(sessionId, ledger);
    this.onSyncSummaryChange?.(this.toSummary(sessionId, ledger));
  }

  /**
   * 消费当前待同步账本：不直接灌入长篇聊天记录，仅返回指向独立 `.md` 纪要文件的紧凑索引与脏文件重读守卫。
   */
  public consumePendingReceipts(sessionId: string): string {
    const ledger = this.pendingLedgersBySession.get(sessionId);
    if (!ledger || (ledger.filesByPath.size === 0 && ledger.records.length === 0)) {
      return '';
    }
    const changedFiles = Array.from(ledger.filesByPath.values());
    const actors = Array.from(new Set(ledger.records.map((r) => r.actorLabel)));
    const receiptPath = ledger.receiptFilePath;
    const recordCount = ledger.records.length;

    this.pendingLedgersBySession.delete(sessionId);
    this.onSyncSummaryChange?.(this.toSummary(sessionId, undefined));

    if (changedFiles.length > 0) {
      const fileItems = changedFiles.map(
        (f) => `- [${formatChangeKindLabel(f.kind)}] \`${f.path}\`${formatChangeStats(f)}${f.byMemberName ? ` (${f.byMemberName})` : ''}`
      );
      return [
        '<family_workspace_changes>',
        '【智能体家庭协作纪要索引与文件防覆盖守卫】',
        `- 参与协作：${actors.join('、')}（共 ${recordCount} 条记录）`,
        `- 完整对话与修改详情已归档至 Markdown 文件：\`${receiptPath}\`（若用户询问家庭成员刚才说了什么或需了解讨论细节，请直接读取该文件，切勿凭空猜测）。`,
        `- 已落盘工作区变更文件（共 ${changedFiles.length} 个）：`,
        ...fileItems,
        '⚠️ 强制重读守卫（Stale-Read Guard）：上述「新增 / 修改」的文件已在磁盘更新，你此前历史上下文中缓存的旧内容已失效；若需引用或继续编辑这些文件，你【必须】先重新调用读取文件工具获取最新内容，严禁凭旧记忆覆盖。',
        '</family_workspace_changes>',
      ].join('\n');
    }

    return [
      '<family_collaboration_index>',
      '【智能体家庭最新讨论纪要索引】',
      `- 参与讨论：${actors.join('、')}（共 ${recordCount} 条互动，未修改工作区文件）`,
      `- 完整讨论内容已归档至 Markdown 文件：\`${receiptPath}\`（当用户问及家庭成员的观点、结论或刚才聊了什么时，请调用读取文件工具阅读该纪要文件获取完整原话）。`,
      '</family_collaboration_index>',
    ].join('\n');
  }
}
