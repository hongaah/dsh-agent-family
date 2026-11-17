import { ArrowUp, AtSign, RotateCcw, Slash, Square } from 'lucide-react';
import React, { useEffect, useMemo, useRef, useState } from 'react';

import type { FamilyMember } from '../core/types.ts';
import { MemberAvatar } from './MemberAvatar.tsx';

export interface SmartComposerProps {
  readonly mode: 'group' | 'member';
  readonly placeholder: string;
  readonly members: readonly FamilyMember[];
  readonly isBusy: boolean;
  readonly sendFresh: boolean;
  readonly onToggleFresh: (next: boolean) => void;
  readonly onSubmit: (message: string) => void;
  readonly onStop?: () => void;
  readonly onSlashCommand: (cmd: 'clear' | 'reset') => void;
  readonly disabled?: boolean;
  readonly externalInsertText?: { readonly seq: number; readonly text: string } | null;
}

interface SlashCommandItem {
  readonly id: 'all' | 'clear' | 'reset';
  readonly command: string;
  readonly label: string;
  readonly description: string;
}

export function SmartComposer({
  mode,
  placeholder,
  members,
  isBusy,
  sendFresh,
  onToggleFresh,
  onSubmit,
  onStop,
  onSlashCommand,
  disabled = false,
  externalInsertText,
}: SmartComposerProps): React.ReactElement {
  const [text, setText] = useState<string>('');
  const [caretPos, setCaretPos] = useState<number>(0);
  const [highlightIdx, setHighlightIdx] = useState<number>(0);
  const [dismissedToken, setDismissedToken] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const lastSeqRef = useRef<number>(0);

  useEffect(() => {
    if (externalInsertText && externalInsertText.seq !== lastSeqRef.current) {
      lastSeqRef.current = externalInsertText.seq;
      setText((prev) => {
        const prefix = prev && !prev.endsWith(' ') ? `${prev} ` : prev;
        return `${prefix}${externalInsertText.text}`;
      });
      requestAnimationFrame(() => {
        textareaRef.current?.focus();
      });
    }
  }, [externalInsertText]);

  // 检测光标前是否处于 @mention 触发词中
  const mentionTrigger = useMemo(() => {
    const before = text.slice(0, caretPos);
    const match = /(?:^|\s)@([a-zA-Z0-9_\u4e00-\u9fa5-]*)$/u.exec(before);
    if (!match) return null;
    const rawQuery = match[1] ?? '';
    const tokenKey = `@${rawQuery}@${caretPos}`;
    if (dismissedToken === tokenKey) return null;
    const atIndex = before.lastIndexOf('@');
    return {
      query: rawQuery.toLowerCase(),
      start: atIndex,
      end: caretPos,
      tokenKey,
    };
  }, [text, caretPos, dismissedToken]);

  const filteredMentions = useMemo(() => {
    if (!mentionTrigger) return [];
    const q = mentionTrigger.query;
    return members.filter(
      (m) =>
        !q ||
        m.id.toLowerCase().includes(q) ||
        m.name.toLowerCase().includes(q) ||
        m.specialty.toLowerCase().includes(q)
    );
  }, [members, mentionTrigger]);

  // 检测是否处于行首 `/` 快捷指令触发中
  const slashCommands = useMemo<readonly SlashCommandItem[]>(() => {
    const base: SlashCommandItem[] = [
      ...(mode === 'group'
        ? [
            {
              id: 'all' as const,
              command: '/all',
              label: '召唤全员依次表态',
              description: '在消息前插入全体在岗成员 @代号',
            },
          ]
        : [
            {
              id: 'reset' as const,
              command: '/reset',
              label: '重置唤醒新身体',
              description: '休眠当前 CLI 进程，下次发话开启全新大脑记忆',
            },
          ]),
      {
        id: 'clear',
        command: '/clear',
        label: '清空当前窗口记录',
        description: '清除界面历史气泡展示（不删除成员配置）',
      },
    ];
    return base;
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
    (mentionTrigger !== null && filteredMentions.length > 0) || activeSlashItems.length > 0;
  const menuCount =
    mentionTrigger && filteredMentions.length > 0
      ? filteredMentions.length
      : activeSlashItems.length;

  useEffect(() => {
    setHighlightIdx(0);
  }, [mentionTrigger?.query, activeSlashItems.length]);

  const applyMentionSelection = (member: FamilyMember) => {
    if (!mentionTrigger) return;
    const before = text.slice(0, mentionTrigger.start);
    const after = text.slice(mentionTrigger.end);
    const inserted = `${before}@${member.id} ${after.replace(/^\s+/u, '')}`;
    const nextPos = `${before}@${member.id} `.length;
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

  const applySlashSelection = (item: SlashCommandItem) => {
    if (item.id === 'all') {
      const allTags = members.map((m) => `@${m.id}`).join(' ');
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

  const triggerSend = () => {
    const trimmed = text.trim();
    if (!trimmed || disabled) return;
    if (trimmed === '/clear') {
      setText('');
      onSlashCommand('clear');
      return;
    }
    if (trimmed === '/reset' && mode === 'member') {
      setText('');
      onSlashCommand('reset');
      return;
    }
    setText('');
    setCaretPos(0);
    setDismissedToken(null);
    onSubmit(trimmed);
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
        if (mentionTrigger && filteredMentions.length > 0) {
          const picked = filteredMentions[highlightIdx] ?? filteredMentions[0];
          if (picked) applyMentionSelection(picked);
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

  return (
    <div className="dshfam-composer-shell">
      <div className="sh-composer-box">
        {/* 浮动 @点名 自动补全菜单 */}
        {mentionTrigger && filteredMentions.length > 0 && (
          <div className="sh-autocomplete-popover" role="listbox" aria-label="点名家庭成员">
            <div style={{ padding: '3px 8px 5px', fontSize: 11, color: 'var(--sh-muted-fg)', fontWeight: 500 }}>
              选择要 @ 点名的家庭成员（↑↓ 切换，回车确认）
            </div>
            {filteredMentions.map((m, idx) => (
              <button
                key={m.id}
                type="button"
                role="option"
                aria-selected={idx === highlightIdx}
                className="sh-menu-item"
                data-highlighted={String(idx === highlightIdx)}
                onMouseDown={(e) => {
                  e.preventDefault();
                  applyMentionSelection(m);
                }}
              >
                <MemberAvatar avatar={m.avatar} bodyKind={m.body.kind} alt={m.name} size={24} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span style={{ fontWeight: 600 }}>{m.name}</span>
                    <span className="sh-badge">@{m.id}</span>
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
                    {m.specialty}
                  </div>
                </div>
                <span className="sh-badge">{m.body.kind}</span>
              </button>
            ))}
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

        <textarea
          ref={textareaRef}
          className="sh-composer-textarea"
          rows={2}
          disabled={disabled}
          placeholder={placeholder}
          value={text}
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

        <div className="sh-composer-foot">
          <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap' }}>
            <button
              type="button"
              className="sh-btn sh-btn-ghost sh-btn-sm"
              onClick={() => insertAtTrigger('@')}
              title="输入 @ 点名家庭成员"
            >
              <AtSign size={13} />
              <span>点名</span>
            </button>
            <button
              type="button"
              className="sh-btn sh-btn-ghost sh-btn-sm"
              onClick={() => insertAtTrigger('/')}
              title="输入 / 唤起快捷指令"
            >
              <Slash size={13} />
              <span>指令</span>
            </button>

            {mode === 'member' && (
              <button
                type="button"
                className={`sh-btn sh-btn-sm ${sendFresh ? 'sh-btn-secondary' : 'sh-btn-ghost'}`}
                onClick={() => onToggleFresh(!sendFresh)}
                title="勾选后本条消息会重启该成员的 CLI 会话开启全新上下文"
              >
                <RotateCcw size={12} />
                <span>{sendFresh ? '已开启新上下文' : '延续记忆'}</span>
              </button>
            )}
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 11, color: 'var(--sh-muted-fg)' }}>
              Enter 发送 · Shift+Enter 换行
            </span>

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
              disabled={!text.trim() || disabled}
              onClick={triggerSend}
            >
              <ArrowUp size={15} />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
