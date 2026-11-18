import {
  Check,
  ChevronDown,
  ChevronRight,
  CornerDownLeft,
  ExternalLink,
  FileCode2,
} from 'lucide-react';
import React, { useState } from 'react';

import type { WorkspaceFileChange } from '../core/types.ts';

export interface ChangedFilesDeliverableCardProps {
  readonly authorLabel: string;
  readonly files: readonly WorkspaceFileChange[];
  readonly onOpenFile?: (filePath: string) => void;
  readonly onHandoffToMainSession?: (prefillText: string) => void;
}

function kindMeta(kind: WorkspaceFileChange['kind']): {
  readonly badge: string;
  readonly label: string;
  readonly color: string;
  readonly bg: string;
} {
  switch (kind) {
    case 'added':
      return {
        badge: 'A',
        label: '新增',
        color: '#10b981',
        bg: 'rgba(16, 185, 129, 0.14)',
      };
    case 'deleted':
      return {
        badge: 'D',
        label: '删除',
        color: '#ef4444',
        bg: 'rgba(239, 68, 68, 0.14)',
      };
    default:
      return {
        badge: 'M',
        label: '修改',
        color: '#3b82f6',
        bg: 'rgba(59, 130, 246, 0.14)',
      };
  }
}

export function buildMainSessionHandoffDraft(
  authorLabel: string,
  files: readonly WorkspaceFileChange[]
): string {
  const lines = files.slice(0, 20).map((f) => {
    const m = kindMeta(f.kind);
    const stat =
      f.kind !== 'deleted' && f.additions !== undefined
        ? f.deletions && f.deletions > 0
          ? ` (+${f.additions} / -${f.deletions})`
          : ` (+${f.additions})`
        : '';
    return `- [${m.label}] \`${f.path}\`${stat}`;
  });
  if (files.length > 20) {
    lines.push(`- …以及另外 ${files.length - 20} 个文件`);
  }
  return [
    `「${authorLabel}」刚刚在工作区完成了以下文件修改：`,
    ...lines,
    '',
    '请先读取上述最新文件内容，接着帮我：',
  ].join('\n');
}

export function ChangedFilesDeliverableCard({
  authorLabel,
  files,
  onOpenFile,
  onHandoffToMainSession,
}: ChangedFilesDeliverableCardProps): React.ReactElement | null {
  const [expanded, setExpanded] = useState<boolean>(() => files.length <= 6);
  const [handedOff, setHandedOff] = useState<boolean>(false);

  if (!files || files.length === 0) return null;

  const totalAdditions = files.reduce((sum, f) => sum + (f.additions ?? 0), 0);
  const totalDeletions = files.reduce((sum, f) => sum + (f.deletions ?? 0), 0);

  const handleHandoff = (ev: React.MouseEvent) => {
    ev.stopPropagation();
    if (!onHandoffToMainSession) return;
    const draft = buildMainSessionHandoffDraft(authorLabel, files);
    onHandoffToMainSession(draft);
    setHandedOff(true);
    setTimeout(() => setHandedOff(false), 2000);
  };

  return (
    <div className="sh-deliverable-card">
      <div
        className="sh-deliverable-head"
        role="button"
        tabIndex={0}
        onClick={() => setExpanded((v) => !v)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            setExpanded((v) => !v);
          }
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
          {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
          <FileCode2 size={13} style={{ color: 'var(--sh-muted-fg)', flexShrink: 0 }} />
          <span style={{ fontWeight: 600, fontSize: 12 }}>已变更 {files.length} 个文件</span>
          {(totalAdditions > 0 || totalDeletions > 0) && (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, fontFamily: 'var(--sh-font-mono)' }}>
              {totalAdditions > 0 && <span style={{ color: '#10b981' }}>+{totalAdditions}</span>}
              {totalDeletions > 0 && <span style={{ color: '#ef4444' }}>-{totalDeletions}</span>}
            </span>
          )}
        </div>

        {onHandoffToMainSession && (
          <button
            type="button"
            className="sh-btn sh-btn-outline sh-btn-sm"
            style={{ height: 23, padding: '0 8px', fontSize: 11, gap: 4, flexShrink: 0 }}
            title="将本次变更文件清单预填入左屏 DSH 主会话输入框并聚焦，方便你补充指令后发送"
            onClick={handleHandoff}
          >
            {handedOff ? <Check size={11} style={{ color: '#10b981' }} /> : <CornerDownLeft size={11} />}
            <span>{handedOff ? '已填入主会话' : '交由主会话继续'}</span>
          </button>
        )}
      </div>

      {expanded && (
        <div className="sh-deliverable-list">
          {files.map((file) => {
            const meta = kindMeta(file.kind);
            const clickable = Boolean(onOpenFile) && file.kind !== 'deleted';
            return (
              <div
                key={file.path}
                className="sh-deliverable-row"
                data-clickable={String(clickable)}
                role={clickable ? 'button' : undefined}
                tabIndex={clickable ? 0 : undefined}
                title={clickable ? `点击在侧边栏打开 ${file.path}` : file.path}
                onClick={() => {
                  if (clickable) onOpenFile?.(file.path);
                }}
                onKeyDown={(e) => {
                  if (clickable && e.key === 'Enter') onOpenFile?.(file.path);
                }}
              >
                <span
                  className="sh-deliverable-kind"
                  style={{ color: meta.color, background: meta.bg }}
                  title={meta.label}
                >
                  {meta.badge}
                </span>
                <span className="sh-deliverable-path">{file.path}</span>
                <span className="sh-deliverable-stats">
                  {file.kind !== 'deleted' && file.additions !== undefined && file.additions > 0 && (
                    <span style={{ color: '#10b981' }}>+{file.additions}</span>
                  )}
                  {file.kind !== 'deleted' && file.deletions !== undefined && file.deletions > 0 && (
                    <span style={{ color: '#ef4444' }}>-{file.deletions}</span>
                  )}
                  {clickable && <ExternalLink size={11} className="sh-deliverable-open-icon" />}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
