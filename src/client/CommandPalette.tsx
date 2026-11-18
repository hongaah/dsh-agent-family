import {
  ArrowLeft,
  MessageSquarePlus,
  RefreshCw,
  Search,
  Sparkles,
  UserPlus,
  Users,
} from "lucide-react";
import React, { useEffect, useMemo, useRef, useState } from "react";

import type { FamilyGroupRoom, FamilyMember } from "../core/types.ts";
import { MemberAvatar } from "./MemberAvatar.tsx";

export interface CommandPaletteProps {
  readonly open: boolean;
  readonly rooms: readonly FamilyGroupRoom[];
  readonly members: readonly FamilyMember[];
  readonly onClose: () => void;
  readonly onSelectGroup: (groupId: string) => void;
  readonly onSelectMember: (memberId: string) => void;
  readonly onCreateMember: () => void;
  readonly onCreateGroup: () => void;
  readonly onReprobeBodies: () => void;
  readonly onSeedFamily: () => void;
  readonly onBackToMainChat: () => void;
}

interface PaletteEntry {
  readonly id: string;
  readonly group: string;
  readonly label: string;
  readonly subLabel: string;
  readonly renderIcon: () => React.ReactNode;
  readonly action: () => void;
}

export function CommandPalette({
  open,
  rooms,
  members,
  onClose,
  onSelectGroup,
  onSelectMember,
  onCreateMember,
  onCreateGroup,
  onReprobeBodies,
  onSeedFamily,
  onBackToMainChat,
}: CommandPaletteProps): React.ReactElement | null {
  const [query, setQuery] = useState<string>("");
  const [activeIdx, setActiveIdx] = useState<number>(0);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setActiveIdx(0);
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [open]);

  const entries = useMemo<readonly PaletteEntry[]>(() => {
    const list: PaletteEntry[] = [];

    for (const room of rooms) {
      list.push({
        id: `room:${room.id}`,
        group: "群聊空间",
        label: room.title.replace(/^🏠\s*/u, ""),
        subLabel: `${room.messages.length} 条消息`,
        renderIcon: () => <Users size={15} />,
        action: () => onSelectGroup(room.id),
      });
    }

    for (const member of members) {
      list.push({
        id: `member:${member.id}`,
        group: "家庭成员",
        label: `${member.name} (@${member.id})`,
        subLabel: `${member.body.kind} · ${member.specialty}`,
        renderIcon: () => (
          <MemberAvatar
            avatar={member.avatar}
            bodyKind={member.body.kind}
            alt={member.name}
            size={18}
          />
        ),
        action: () => onSelectMember(member.id),
      });
    }

    list.push(
      {
        id: "act:new-member",
        group: "快捷操作",
        label: "创造新家庭成员",
        subLabel: "绑定 CLI 身体并编写灵魂提示词 / 上传照片",
        renderIcon: () => <UserPlus size={15} />,
        action: onCreateMember,
      },
      {
        id: "act:new-group",
        group: "快捷操作",
        label: "新建专题讨论群",
        subLabel: "勾选多位成员拉起专题群聊",
        renderIcon: () => <MessageSquarePlus size={15} />,
        action: onCreateGroup,
      },
      {
        id: "act:probe",
        group: "快捷操作",
        label: "重新体检本机 CLI 身体",
        subLabel: "检测 claude / codex / opencode / dsh 可用状态",
        renderIcon: () => <RefreshCw size={15} />,
        action: onReprobeBodies,
      },
      {
        id: "act:seed",
        group: "快捷操作",
        label: "补齐预设四口之家模板",
        subLabel: "导入架构师、前端、后端与审查参考成员",
        renderIcon: () => <Sparkles size={15} />,
        action: onSeedFamily,
      },
      {
        id: "act:back",
        group: "快捷操作",
        label: "返回 DSH 主对话",
        subLabel: "退出家庭面板回到当前对话流",
        renderIcon: () => <ArrowLeft size={15} />,
        action: onBackToMainChat,
      },
    );

    const q = query.trim().toLowerCase();
    if (!q) return list;
    return list.filter(
      (item) =>
        item.label.toLowerCase().includes(q) ||
        item.subLabel.toLowerCase().includes(q) ||
        item.group.toLowerCase().includes(q),
    );
  }, [
    rooms,
    members,
    query,
    onSelectGroup,
    onSelectMember,
    onCreateMember,
    onCreateGroup,
    onReprobeBodies,
    onSeedFamily,
    onBackToMainChat,
  ]);

  useEffect(() => {
    setActiveIdx(0);
  }, [query]);

  if (!open) return null;

  const handleKeyDown = (ev: React.KeyboardEvent) => {
    if (ev.key === "Escape") {
      ev.preventDefault();
      onClose();
      return;
    }
    if (entries.length === 0) return;
    if (ev.key === "ArrowDown") {
      ev.preventDefault();
      setActiveIdx((prev) => (prev + 1) % entries.length);
    } else if (ev.key === "ArrowUp") {
      ev.preventDefault();
      setActiveIdx((prev) => (prev - 1 + entries.length) % entries.length);
    } else if (ev.key === "Enter") {
      ev.preventDefault();
      const chosen = entries[activeIdx] ?? entries[0];
      if (chosen) {
        onClose();
        chosen.action();
      }
    }
  };

  return (
    <div
      className="sh-dialog-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      onKeyDown={handleKeyDown}
    >
      <div
        className="sh-command-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="快捷指挥面板"
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 9,
            padding: "10px 14px",
            borderBottom: "1px solid var(--sh-border)",
          }}
        >
          <Search
            size={15}
            style={{ color: "var(--sh-muted-fg)", flexShrink: 0 }}
          />
          <input
            ref={inputRef}
            style={{
              flex: 1,
              border: "none",
              background: "transparent",
              color: "inherit",
              fontSize: 13.5,
              outline: "none",
            }}
            placeholder="搜索成员、切换群聊或执行家庭指令…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <span className="sh-kbd">ESC</span>
        </div>

        <div style={{ maxHeight: 330, overflowY: "auto", padding: 6 }}>
          {entries.length === 0 ? (
            <div
              style={{
                padding: "24px 12px",
                textAlign: "center",
                color: "var(--sh-muted-fg)",
                fontSize: 12.5,
              }}
            >
              未找到匹配的成员或命令
            </div>
          ) : (
            entries.map((entry, idx) => {
              const prevGroup = idx > 0 ? entries[idx - 1]?.group : null;
              return (
                <React.Fragment key={entry.id}>
                  {entry.group !== prevGroup && (
                    <div
                      style={{
                        padding: "6px 8px 3px",
                        fontSize: 10.5,
                        fontWeight: 600,
                        color: "var(--sh-muted-fg)",
                      }}
                    >
                      {entry.group}
                    </div>
                  )}
                  <button
                    type="button"
                    className="sh-menu-item"
                    data-highlighted={String(idx === activeIdx)}
                    onMouseEnter={() => setActiveIdx(idx)}
                    onClick={() => {
                      onClose();
                      entry.action();
                    }}
                  >
                    <span
                      style={{
                        width: 22,
                        display: "inline-flex",
                        alignItems: "center",
                        justifyContent: "center",
                        flexShrink: 0,
                      }}
                    >
                      {entry.renderIcon()}
                    </span>
                    <span style={{ fontWeight: 500 }}>{entry.label}</span>
                    <span
                      style={{
                        marginLeft: "auto",
                        fontSize: 11,
                        color: "var(--sh-muted-fg)",
                        maxWidth: 210,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {entry.subLabel}
                    </span>
                  </button>
                </React.Fragment>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
