import {
  ArrowUp,
  AtSign,
  FileText,
  Image as ImageIcon,
  Loader2,
  Paperclip,
  Slash,
  Square,
  X,
} from 'lucide-react';
import React, { useEffect, useMemo, useRef, useState } from 'react';

import type {
  FamilyMember,
  FamilyMessageAttachment,
  WorkspaceFileCandidate,
} from '../core/types.ts';
import { familyClientApi } from './api.ts';
import { MemberAvatar } from './MemberAvatar.tsx';
import {
  FileReferenceHighlightChip,
  MemberHoverCardWrap,
} from './MemberHoverChip.tsx';

export interface SmartComposerProps {
  readonly scopeId: string;
  readonly cwd?: string;
  readonly mode: 'group' | 'member';
  readonly placeholder: string;
  readonly members: readonly FamilyMember[];
  readonly isBusy: boolean;
  readonly onSubmit: (message: string, attachmentIds: readonly string[]) => void;
  readonly onStop?: () => void;
  readonly onSlashCommand: (cmd: 'clear' | 'reset') => void;
  readonly onOpenFile?: (filePath: string) => void;
  readonly disabled?: boolean;
  readonly externalInsertText?: { readonly seq: number; readonly text: string } | null;
}

interface SlashCommandItem {
  readonly id: 'all' | 'clear' | 'reset';
  readonly command: string;
  readonly label: string;
  readonly description: string;
}

type AutocompleteCandidate =
  | { readonly kind: 'member'; readonly member: FamilyMember }
  | { readonly kind: 'file'; readonly file: WorkspaceFileCandidate };

function formatShortSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function renderHighlightedMirrorNodes(
  rawText: string,
  members: readonly FamilyMember[]
): React.ReactNode[] {
  if (!rawText) return [];
  const sortedMembers = [...members]
    .filter((m) => Boolean(m.name.trim()))
    .sort((a, b) => b.name.length - a.name.length);
  const namePattern = sortedMembers.map((m) => escapeRegExp(m.name.trim())).join('|');
  const idPattern = sortedMembers.map((m) => escapeRegExp(m.id)).join('|');
  const memberAlt = [namePattern, idPattern].filter(Boolean).join('|');

  const regex = new RegExp(
    `(${memberAlt ? `@(?:${memberAlt})|` : ''}@"[^"\\n]+"|@(?:\\.\\/)?[A-Za-z0-9_.\\u4e00-\\u9fa5/-]+\\.[A-Za-z0-9]{1,10})`,
    'gu'
  );

  const out: React.ReactNode[] = [];
  let cursor = 0;
  let seq = 0;
  for (const m of rawText.matchAll(regex)) {
    const idx = m.index ?? 0;
    if (idx > cursor) {
      out.push(rawText.slice(cursor, idx));
    }
    seq += 1;
    out.push(
      <mark key={seq} className="sh-composer-inline-mark">
        {m[0]}
      </mark>
    );
    cursor = idx + m[0].length;
  }
  if (cursor < rawText.length) {
    out.push(rawText.slice(cursor));
  }
  if (rawText.endsWith('\n')) {
    out.push('\n ');
  }
  return out;
}

export function SmartComposer({
  scopeId,
  cwd,
  mode,
  placeholder,
  members,
  isBusy,
  onSubmit,
  onStop,
  onSlashCommand,
  onOpenFile,
  disabled = false,
  externalInsertText,
}: SmartComposerProps): React.ReactElement {
  const [text, setText] = useState<string>('');
  const [caretPos, setCaretPos] = useState<number>(0);
  const [highlightIdx, setHighlightIdx] = useState<number>(0);
  const [dismissedToken, setDismissedToken] = useState<string | null>(null);

  const [attachments, setAttachments] = useState<FamilyMessageAttachment[]>([]);
  const [uploadingCount, setUploadingCount] = useState<number>(0);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [dragActive, setDragActive] = useState<boolean>(false);
  const [fileCandidates, setFileCandidates] = useState<readonly WorkspaceFileCandidate[]>([]);

  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const mirrorRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const lastSeqRef = useRef<number>(0);

  // 处理外部插入（如右侧栏点 @TA 插入成员名称而非 ID！）
  useEffect(() => {
    if (externalInsertText && externalInsertText.seq !== lastSeqRef.current) {
      lastSeqRef.current = externalInsertText.seq;
      let normalizedInsert = externalInsertText.text;
      // 若外部传入了 `@memberId `，自动转换为直观的 `@成员名称 `
      const idMatch = /^@([a-z][a-z0-9-]{0,31})(\s*)$/u.exec(normalizedInsert);
      if (idMatch) {
        const found = members.find((m) => m.id === idMatch[1]);
        if (found) {
          normalizedInsert = `@${found.name}${idMatch[2] || ' '}`;
        }
      }
      setText((prev) => {
        const prefix = prev && !prev.endsWith(' ') ? `${prev} ` : prev;
        return `${prefix}${normalizedInsert}`;
      });
      requestAnimationFrame(() => {
        textareaRef.current?.focus();
      });
    }
  }, [externalInsertText, members]);

  // 检测光标前是否处于 @ 触发词中（支持 @成员名称、@成员ID、@工作区文件路径）
  const mentionTrigger = useMemo(() => {
    const before = text.slice(0, caretPos);
    const match = /(?:^|\s)@([a-zA-Z0-9_.\u4e00-\u9fa5/-]*)$/u.exec(before);
    if (!match) return null;
    const rawQuery = match[1] ?? '';
    const tokenKey = `@${rawQuery}@${caretPos}`;
    if (dismissedToken === tokenKey) return null;
    const atIndex = before.lastIndexOf('@');
    return {
      query: rawQuery,
      lowerQuery: rawQuery.toLowerCase(),
      start: atIndex,
      end: caretPos,
      tokenKey,
    };
  }, [text, caretPos, dismissedToken]);

  // 动态异步检索工作区文件候选
  useEffect(() => {
    if (!mentionTrigger) {
      setFileCandidates([]);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      void familyClientApi
        .searchWorkspaceFiles(scopeId, mentionTrigger.query, cwd)
        .then((res) => {
          if (!cancelled) {
            setFileCandidates(res.files.slice(0, 8));
          }
        })
        .catch(() => {
          if (!cancelled) setFileCandidates([]);
        });
    }, 80);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [mentionTrigger?.query, Boolean(mentionTrigger), scopeId, cwd]);

  const filteredMembers = useMemo(() => {
    if (!mentionTrigger) return [];
    const q = mentionTrigger.lowerQuery;
    return members.filter(
      (m) =>
        !q ||
        m.name.toLowerCase().includes(q) ||
        m.id.toLowerCase().includes(q) ||
        m.specialty.toLowerCase().includes(q)
    );
  }, [members, mentionTrigger]);

  const combinedCandidates = useMemo<readonly AutocompleteCandidate[]>(() => {
    if (!mentionTrigger) return [];
    return [
      ...filteredMembers.map((member): AutocompleteCandidate => ({ kind: 'member', member })),
      ...fileCandidates.map((file): AutocompleteCandidate => ({ kind: 'file', file })),
    ];
  }, [mentionTrigger, filteredMembers, fileCandidates]);

  // 提取草稿中已包含的成员与文件标签，供顶部展示可悬浮查看详情的高亮胶囊
  const activeMentionedMembers = useMemo(() => {
    if (!text.includes('@')) return [];
    return members.filter(
      (m) => text.includes(`@${m.name}`) || new RegExp(`@${escapeRegExp(m.id)}\\b`, 'u').test(text)
    );
  }, [text, members]);

  const activeReferencedFiles = useMemo(() => {
    const found: string[] = [];
    const fileRe = /@(?:"([^"\n]+)"|((?:\.\/)?[A-Za-z0-9_.\u4e00-\u9fa5/-]+\.[A-Za-z0-9]{1,10}))/gu;
    for (const m of text.matchAll(fileRe)) {
      const p = (m[1] ?? m[2] ?? '').trim();
      if (p && !members.some((mem) => mem.id === p || mem.name === p) && !found.includes(p)) {
        found.push(p);
      }
    }
    return found;
  }, [text, members]);

  const slashCommands = useMemo<readonly SlashCommandItem[]>(() => {
    return [
      ...(mode === 'group'
        ? [
            {
              id: 'all' as const,
              command: '/all',
              label: '召唤全员依次表态',
              description: '在消息前插入全体在岗成员名称',
            },
          ]
        : [
            {
              id: 'reset' as const,
              command: '/reset',
              label: '重启上下文记忆',
              description: '重启底层 CLI 进程开启全新会话记忆（保留屏幕历史）',
            },
          ]),
      {
        id: 'clear',
        command: '/clear',
        label: '清空屏幕聊天记录',
        description: '仅清除当前面板展示的气泡记录（不删成员配置）',
      },
    ];
  }, [mode]);

  const activeSlashItems = useMemo(() => {
    const trimmed = text;
    if (!trimmed.startsWith('/') || trimmed.includes(' ') || trimmed.includes('\n')) {
      return [];
    }
    if (dismissedToken === trimmed) return [];
    const q = trimmed.slice(1).toLowerCase();
    return slashCommands.filter((item) => item.command.slice(1).startsWith(q));
  }, [text, slashCommands, dismissedToken]);

  const menuOpen =
    (mentionTrigger !== null && combinedCandidates.length > 0) || activeSlashItems.length > 0;
  const menuCount =
    mentionTrigger && combinedCandidates.length > 0
      ? combinedCandidates.length
      : activeSlashItems.length;

  useEffect(() => {
    setHighlightIdx(0);
  }, [mentionTrigger?.query, combinedCandidates.length, activeSlashItems.length]);

  const insertTokenAtMention = (tokenText: string) => {
    if (!mentionTrigger) return;
    const before = text.slice(0, mentionTrigger.start);
    const after = text.slice(mentionTrigger.end);
    const inserted = `${before}${tokenText} ${after.replace(/^\s+/u, '')}`;
    const nextPos = `${before}${tokenText} `.length;
    setText(inserted);
    setCaretPos(nextPos);
    setDismissedToken(null);
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (el) {
        el.focus();
        el.setSelectionRange(nextPos, nextPos);
      }
    });
  };

  const applyCandidateSelection = (cand: AutocompleteCandidate) => {
    if (cand.kind === 'member') {
      // 直接插入可读性极高的 `@成员名称`（如 `@小克`），绝不再显示生硬的 `@fe-claude`
      insertTokenAtMention(`@${cand.member.name}`);
      return;
    }
    const formattedFile = cand.file.path.includes(' ')
      ? `@"${cand.file.path}"`
      : `@${cand.file.path}`;
    insertTokenAtMention(formattedFile);
  };

  const applySlashSelection = (item: SlashCommandItem) => {
    if (item.id === 'all') {
      const allTags = members.map((m) => `@${m.name}`).join(' ');
      const next = `${allTags} `;
      setText(next);
      setCaretPos(next.length);
      requestAnimationFrame(() => textareaRef.current?.focus());
      return;
    }
    setText('');
    setCaretPos(0);
    onSlashCommand(item.id);
  };

  const handleFilesSelected = async (fileList: readonly File[]) => {
    if (fileList.length === 0 || disabled) return;
    setUploadError(null);
    setUploadingCount((c) => c + fileList.length);
    try {
      const uploaded = await Promise.all(
        fileList.map((f) => familyClientApi.uploadAttachmentFile(f))
      );
      setAttachments((prev) => [...prev, ...uploaded.map((u) => u.attachment)]);
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : String(err));
    } finally {
      setUploadingCount((c) => Math.max(0, c - fileList.length));
    }
  };

  const removeMentionToken = (member: FamilyMember) => {
    setText((prev) =>
      prev
        .replace(new RegExp(`@${escapeRegExp(member.name)}\\s*`, 'gu'), '')
        .replace(new RegExp(`@${escapeRegExp(member.id)}\\b\\s*`, 'gu'), '')
    );
  };

  const removeFileToken = (filePath: string) => {
    setText((prev) =>
      prev
        .replace(`@"${filePath}"`, '')
        .replace(`@${filePath}`, '')
        .replace(/\s{2,}/gu, ' ')
    );
  };

  const triggerSend = () => {
    const trimmed = text.trim();
    if ((!trimmed && attachments.length === 0) || disabled || uploadingCount > 0) return;
    if (trimmed === '/clear' && attachments.length === 0) {
      setText('');
      onSlashCommand('clear');
      return;
    }
    if (trimmed === '/reset' && mode === 'member' && attachments.length === 0) {
      setText('');
      onSlashCommand('reset');
      return;
    }
    const attachmentIds = attachments.map((a) => a.id);
    setText('');
    setCaretPos(0);
    setAttachments([]);
    setUploadError(null);
    setDismissedToken(null);
    onSubmit(trimmed, attachmentIds);
  };

  const handleKeyDown = (ev: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (ev.nativeEvent.isComposing) return;

    if (menuOpen && menuCount > 0) {
      if (ev.key === 'ArrowDown') {
        ev.preventDefault();
        setHighlightIdx((prev) => (prev + 1) % menuCount);
        return;
      }
      if (ev.key === 'ArrowUp') {
        ev.preventDefault();
        setHighlightIdx((prev) => (prev - 1 + menuCount) % menuCount);
        return;
      }
      if (ev.key === 'Enter' || ev.key === 'Tab') {
        ev.preventDefault();
        if (mentionTrigger && combinedCandidates.length > 0) {
          const picked = combinedCandidates[highlightIdx] ?? combinedCandidates[0];
          if (picked) applyCandidateSelection(picked);
        } else if (activeSlashItems.length > 0) {
          const picked = activeSlashItems[highlightIdx] ?? activeSlashItems[0];
          if (picked) applySlashSelection(picked);
        }
        return;
      }
      if (ev.key === 'Escape') {
        ev.preventDefault();
        setDismissedToken(mentionTrigger?.tokenKey ?? text);
        return;
      }
    }

    if (ev.key === 'Enter' && (!ev.shiftKey || ev.metaKey || ev.ctrlKey)) {
      ev.preventDefault();
      triggerSend();
    }
  };

  const insertAtTrigger = (char: '@' | '/') => {
    const el = textareaRef.current;
    if (!el) return;
    if (char === '/') {
      setText('/');
      setCaretPos(1);
      setDismissedToken(null);
      requestAnimationFrame(() => {
        el.focus();
        el.setSelectionRange(1, 1);
      });
      return;
    }
    const prefix = text && !text.endsWith(' ') && !text.endsWith('\n') ? `${text} @` : `${text}@`;
    setText(prefix);
    setCaretPos(prefix.length);
    setDismissedToken(null);
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(prefix.length, prefix.length);
    });
  };

  const hasDraftPills =
    attachments.length > 0 ||
    uploadingCount > 0 ||
    activeMentionedMembers.length > 0 ||
    activeReferencedFiles.length > 0;

  return (
    <div className="dshfam-composer-shell">
      <div
        className="sh-composer-box"
        data-drag={String(dragActive)}
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes('Files')) {
            e.preventDefault();
            setDragActive(true);
          }
        }}
        onDragLeave={(e) => {
          if (e.currentTarget === e.target) {
            setDragActive(false);
          }
        }}
        onDrop={(e) => {
          e.preventDefault();
          setDragActive(false);
          const dropped = Array.from(e.dataTransfer.files ?? []);
          if (dropped.length > 0) {
            void handleFilesSelected(dropped);
          }
        }}
      >
        <input
          ref={fileInputRef}
          type="file"
          multiple
          style={{ display: 'none' }}
          onChange={(e) => {
            const picked = Array.from(e.target.files ?? []);
            e.target.value = '';
            if (picked.length > 0) {
              void handleFilesSelected(picked);
            }
          }}
        />

        {/* 浮动 `@` 双分组自动补全菜单（家庭成员名称 + 工作区文件） */}
        {mentionTrigger && combinedCandidates.length > 0 && (
          <div className="sh-autocomplete-popover" role="listbox" aria-label="点名成员或引用文件">
            {combinedCandidates.map((cand, idx) => {
              const prevKind = idx > 0 ? combinedCandidates[idx - 1]?.kind : null;
              const showHeader = cand.kind !== prevKind;
              return (
                <React.Fragment
                  key={cand.kind === 'member' ? `m:${cand.member.id}` : `f:${cand.file.path}`}
                >
                  {showHeader && (
                    <div
                      style={{
                        padding: '4px 8px 3px',
                        fontSize: 10.5,
                        color: 'var(--sh-muted-fg)',
                        fontWeight: 600,
                      }}
                    >
                      {cand.kind === 'member' ? '智能体家庭成员' : '工作区文件'}
                    </div>
                  )}
                  <button
                    type="button"
                    role="option"
                    aria-selected={idx === highlightIdx}
                    className="sh-menu-item"
                    data-highlighted={String(idx === highlightIdx)}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      applyCandidateSelection(cand);
                    }}
                  >
                    {cand.kind === 'member' ? (
                      <>
                        <MemberAvatar
                          avatar={cand.member.avatar}
                          bodyKind={cand.member.body.kind}
                          alt={cand.member.name}
                          size={22}
                        />
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                            <span style={{ fontWeight: 600 }}>{cand.member.name}</span>
                            <span style={{ fontSize: 10.5, color: 'var(--sh-muted-fg)' }}>
                              @{cand.member.id}
                            </span>
                          </div>
                          <div
                            style={{
                              fontSize: 11,
                              color: 'var(--sh-muted-fg)',
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                              whiteSpace: 'nowrap',
                            }}
                          >
                            {cand.member.specialty}
                          </div>
                        </div>
                        <span className="sh-badge">{cand.member.body.kind}</span>
                      </>
                    ) : (
                      <>
                        <FileText size={14} style={{ color: '#3b82f6', flexShrink: 0 }} />
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div
                            style={{
                              fontWeight: 500,
                              fontSize: 12,
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                              whiteSpace: 'nowrap',
                            }}
                          >
                            {cand.file.name}
                          </div>
                          {cand.file.parentDir && (
                            <div
                              style={{
                                fontSize: 10.5,
                                color: 'var(--sh-muted-fg)',
                                overflow: 'hidden',
                                textOverflow: 'ellipsis',
                                whiteSpace: 'nowrap',
                              }}
                            >
                              {cand.file.parentDir}
                            </div>
                          )}
                        </div>
                      </>
                    )}
                  </button>
                </React.Fragment>
              );
            })}
          </div>
        )}

        {/* 浮动 `/` 快捷命令菜单 */}
        {!mentionTrigger && activeSlashItems.length > 0 && (
          <div className="sh-autocomplete-popover" role="listbox" aria-label="快捷指令">
            <div style={{ padding: '3px 8px 5px', fontSize: 11, color: 'var(--sh-muted-fg)', fontWeight: 500 }}>
              快捷指令
            </div>
            {activeSlashItems.map((cmd, idx) => (
              <button
                key={cmd.id}
                type="button"
                className="sh-menu-item"
                data-highlighted={String(idx === highlightIdx)}
                onMouseDown={(e) => {
                  e.preventDefault();
                  applySlashSelection(cmd);
                }}
              >
                <span className="sh-badge">{cmd.command}</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 500 }}>{cmd.label}</div>
                  <div style={{ fontSize: 11, color: 'var(--sh-muted-fg)' }}>{cmd.description}</div>
                </div>
              </button>
            ))}
          </div>
        )}

        {/* DSH 同款草稿附件与高亮引用胶囊条（悬浮成员看详情，单击任意文件/图片走 DSH 原生右侧栏预览） */}
        {hasDraftPills && (
          <div className="sh-composer-pills-bar">
            {activeMentionedMembers.map((m) => (
              <MemberHoverCardWrap key={m.id} member={m}>
                <span className="sh-draft-member-chip">
                  <MemberAvatar avatar={m.avatar} bodyKind={m.body.kind} alt={m.name} size={14} />
                  <span>@{m.name}</span>
                  <button
                    type="button"
                    className="sh-draft-chip-remove"
                    onClick={() => removeMentionToken(m)}
                    aria-label={`移除 @${m.name}`}
                  >
                    <X size={10} />
                  </button>
                </span>
              </MemberHoverCardWrap>
            ))}

            {activeReferencedFiles.map((fp) => {
              const short = fp.split('/').at(-1) ?? fp;
              return (
                <span key={fp} className="sh-draft-file-chip-wrap">
                  <FileReferenceHighlightChip
                    label={short}
                    fullPath={fp}
                    onOpen={onOpenFile ? () => onOpenFile(fp) : undefined}
                  />
                  <button
                    type="button"
                    className="sh-draft-chip-remove"
                    onClick={() => removeFileToken(fp)}
                    aria-label={`移除 ${short}`}
                  >
                    <X size={10} />
                  </button>
                </span>
              );
            })}

            {attachments.map((att) => (
              <div key={att.id} className="sh-draft-att-card">
                <button
                  type="button"
                  className="sh-draft-att-main"
                  title={onOpenFile ? `点击在 DSH 右侧栏预览 ${att.name}` : att.name}
                  onClick={() => onOpenFile?.(att.filePath)}
                >
                  {att.kind === 'image' ? (
                    <img src={att.previewUrl} alt={att.name} className="sh-draft-att-thumb" />
                  ) : (
                    <span className="sh-draft-att-icon">
                      <FileText size={14} />
                    </span>
                  )}
                  <span className="sh-draft-att-info">
                    <span className="sh-draft-att-name">{att.name}</span>
                    <span className="sh-draft-att-size">{formatShortSize(att.sizeBytes)}</span>
                  </span>
                </button>
                <button
                  type="button"
                  className="sh-draft-att-del"
                  title="移除附件"
                  onClick={() =>
                    setAttachments((prev) => prev.filter((item) => item.id !== att.id))
                  }
                >
                  <X size={11} />
                </button>
              </div>
            ))}

            {uploadingCount > 0 && (
              <span className="sh-badge" style={{ gap: 5, height: 24 }}>
                <Loader2 size={11} className="sh-spin" />
                <span>上传附件中 ({uploadingCount})…</span>
              </span>
            )}
          </div>
        )}

        {uploadError && (
          <div style={{ padding: '4px 12px 0', fontSize: 11.5, color: 'var(--sh-destructive)' }}>
            {uploadError}
          </div>
        )}

        {/* 行内高亮镜像层 + 原生 Textarea（既支持 @名称 / @文件 行内高亮，又保证中文输入法 100% 丝滑） */}
        <div className="sh-composer-editor-stack">
          <div ref={mirrorRef} className="sh-composer-mirror" aria-hidden="true">
            {renderHighlightedMirrorNodes(text, members)}
          </div>
          <textarea
            ref={textareaRef}
            className="sh-composer-textarea"
            rows={2}
            disabled={disabled}
            placeholder={placeholder}
            value={text}
            onScroll={(e) => {
              if (mirrorRef.current) {
                mirrorRef.current.scrollTop = e.currentTarget.scrollTop;
              }
            }}
            onPaste={(e) => {
              const items = Array.from(e.clipboardData?.items ?? []);
              const pastedFiles = items
                .filter((item) => item.kind === 'file')
                .flatMap((item) => {
                  const f = item.getAsFile();
                  return f ? [f] : [];
                });
              if (pastedFiles.length > 0) {
                e.preventDefault();
                void handleFilesSelected(pastedFiles);
              }
            }}
            onChange={(e) => {
              setText(e.target.value);
              setCaretPos(e.target.selectionStart ?? e.target.value.length);
              setDismissedToken(null);
            }}
            onSelect={(e) => {
              const el = e.currentTarget;
              setCaretPos(el.selectionStart ?? 0);
            }}
            onKeyDown={handleKeyDown}
          />
        </div>

        <div className="sh-composer-foot">
          <div style={{ display: 'flex', alignItems: 'center', gap: 2, minWidth: 0 }}>
            <button
              type="button"
              className="sh-btn sh-btn-ghost sh-btn-sm"
              onClick={() => fileInputRef.current?.click()}
              title="上传图片或任意文件附件（也支持直接粘贴截图或拖入文件）"
              disabled={disabled}
              style={{ padding: '0 7px' }}
            >
              <Paperclip size={13} />
              <span className="sh-hide-xs">附件</span>
            </button>
            <button
              type="button"
              className="sh-btn sh-btn-ghost sh-btn-sm"
              onClick={() => insertAtTrigger('@')}
              title="输入 @ 点名家庭成员或引用工作区文件"
              style={{ padding: '0 7px' }}
            >
              <AtSign size={13} />
              <span className="sh-hide-xs">点名 / 文件</span>
            </button>
            <button
              type="button"
              className="sh-btn sh-btn-ghost sh-btn-sm"
              onClick={() => insertAtTrigger('/')}
              title="输入 / 唤起快捷指令"
              style={{ padding: '0 7px' }}
            >
              <Slash size={13} />
              <span className="sh-hide-xs">指令</span>
            </button>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
            {isBusy && onStop && (
              <button
                type="button"
                className="sh-btn sh-btn-destructive sh-btn-sm"
                onClick={onStop}
                title="中断当前运行"
              >
                <Square size={11} />
                <span>停止</span>
              </button>
            )}

            <button
              type="button"
              aria-label="发送消息"
              className="sh-btn sh-btn-primary sh-btn-icon"
              style={{ width: 28, height: 28 }}
              disabled={(!text.trim() && attachments.length === 0) || disabled || uploadingCount > 0}
              onClick={triggerSend}
            >
              {attachments.some((a) => a.kind === 'image') && !text.trim() ? (
                <ImageIcon size={14} />
              ) : (
                <ArrowUp size={15} />
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
