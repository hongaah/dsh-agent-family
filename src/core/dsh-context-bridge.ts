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

function stripInternalXmlBlocks(text: string): string {
  return text
    .replace(/<family_direct_mention>[\s\S]*?<\/family_direct_mention>/gu, '')
    .replace(/<family_collaboration_receipt>[\s\S]*?<\/family_collaboration_receipt>/gu, '')
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

/**
 * 负责 DSH 主工作台会话与家庭成员之间的双向轻量上下文桥接：
 * 1. 正向（DSH -> 家庭成员）：按 `(sessionId, memberId)` 维护游标 `lastSyncedSeq`，仅注入自上次同步以来的增量核心诉求、结论与涉及文件，杜绝全量 Token 爆炸；
 * 2. 按需深挖：提供 `readRecentTranscript` 供成员随身手机 `phone_read_dsh_session` 主动查阅更多细节；
 * 3. 反向（家庭成员 -> DSH 主会话）：暂存 `/family` 或工作台协作回执，在主对话下一轮 `agent/pre-step` 中一次性同步给主模型知晓。
 */
export class DshSessionContextBridge {
  private readonly getSession: (sessionId: string) => BridgeableSessionLike | undefined;
  private readonly lastSyncedSeqByActor = new Map<string, number>();
  private readonly pendingReceiptsBySession = new Map<string, string[]>();

  public constructor(getSession: (sessionId: string) => BridgeableSessionLike | undefined) {
    this.getSession = getSession;
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

    const recentTurns = turnsSummary.slice(-8);
    const recentFiles = touchedFiles.slice(-12);
    const headerLines: string[] = ['<dsh_session_context>'];
    headerLines.push(
      `【当前关联的 DSH 主会话增量背景简报】(cwd: ${session.header.cwd ?? '当前工作区'}${session.header.title ? `, 会话标题: ${String(session.header.title)}` : ''})`
    );
    if (recentFiles.length > 0) {
      headerLines.push(`主会话近期涉及文件：${recentFiles.join(', ')}`);
    }
    if (recentTurns.length > 0) {
      headerLines.push('近期对话脉络：');
      headerLines.push(...recentTurns);
    }
    headerLines.push(
      '（提示：若需查看主会话更早或更详细的对话记录，可随时调用随身手机工具 `phone_read_dsh_session`。）'
    );
    headerLines.push('</dsh_session_context>');

    const joined = headerLines.join('\n');
    return joined.length > 2200 ? `${joined.slice(0, 2180)}…\n</dsh_session_context>` : joined;
  }

  public readRecentTranscript(sessionId: string, maxItems: number = 12): string {
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
        const text = extractBlocksText(ev.data.message ?? ev.data, 600);
        if (text) lines.push(`[用户 #${ev.seq}]: ${text}`);
      } else if (ev.type === 'assistant/message') {
        const text = extractBlocksText(ev.data.message, 700);
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

    const clamped = Math.max(1, Math.min(30, maxItems));
    const tail = lines.slice(-clamped);
    if (tail.length === 0) {
      return `当前 DSH 会话 (${sessionId}, cwd=${session.header.cwd ?? ''}) 尚无历史对话消息。`;
    }

    return [
      `【DSH 主会话 (${sessionId}) 最近 ${tail.length} 条记录】`,
      `工作目录: ${session.header.cwd ?? '未知'}`,
      ...(files.length > 0 ? [`涉及文件: ${files.slice(-15).join(', ')}`] : []),
      `---`,
      ...tail,
    ].join('\n');
  }

  public recordReceiptForMainAgent(sessionId: string, receiptLine: string): void {
    if (!sessionId || sessionId === 'default' || sessionId.startsWith('family-')) {
      return;
    }
    const trimmed = receiptLine.trim();
    if (!trimmed) return;
    const list = this.pendingReceiptsBySession.get(sessionId) ?? [];
    list.push(trimmed.length > 700 ? `${trimmed.slice(0, 700)}…` : trimmed);
    if (list.length > 10) {
      list.shift();
    }
    this.pendingReceiptsBySession.set(sessionId, list);
  }

  public consumePendingReceipts(sessionId: string): string {
    const list = this.pendingReceiptsBySession.get(sessionId);
    if (!list || list.length === 0) {
      return '';
    }
    this.pendingReceiptsBySession.delete(sessionId);
    return [
      '',
      '',
      '<family_collaboration_receipt>',
      '以下是用户在当前会话通过「智能体家庭」刚刚完成的协作进展回执（供你在后续对话中保持上下文衔接，无需重复执行已完成的工作）：',
      ...list.map((item) => `- ${item}`),
      '</family_collaboration_receipt>',
    ].join('\n');
  }
}
