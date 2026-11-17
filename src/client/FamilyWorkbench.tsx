import {
  ArrowDown,
  ArrowLeft,
  Check,
  Copy,
  CornerUpRight,
  Eraser,
  Hash,
  PanelRight,
  Pencil,
  PhoneCall,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  Sparkles,
  Square,
  Trash2,
  UserPlus,
  Users,
} from 'lucide-react';
import React, { useEffect, useMemo, useRef, useState } from 'react';

import { defaultLobeAvatarForBody } from '../core/avatar-spec.ts';
import type { FamilyMember } from '../core/types.ts';
import { ApprovalBanner } from './ApprovalBanner.tsx';
import { familyClientApi, useFamilyLiveState } from './api.ts';
import { CommandPalette } from './CommandPalette.tsx';
import { MemberAvatar } from './MemberAvatar.tsx';
import { MemberSheet } from './MemberSheet.tsx';
import { RichMessageContent } from './RichMessageContent.tsx';
import { SmartComposer } from './SmartComposer.tsx';

export interface SessionSummaryOption {
  readonly id: string;
  readonly title: string;
  readonly cwd?: string;
}

export interface FamilyWorkbenchProps {
  readonly sessions: readonly SessionSummaryOption[];
  readonly onBackToConversation: () => void;
}

type LoungeTarget =
  | { readonly kind: 'group'; readonly groupId: string }
  | { readonly kind: 'member'; readonly memberId: string };

type InspectorTab = 'calls' | 'context';

const STATE_LABELS: Readonly<Record<string, string>> = {
  sleeping: '待唤醒',
  idle: '空闲',
  working: '执行中',
  in_call: '通话中',
  awaiting_approval: '待批示',
  error: '异常',
};

function CopyMessageButton({ text }: { readonly text: string }): React.ReactElement {
  const [copied, setCopied] = useState<boolean>(false);
  return (
    <button
      type="button"
      className="sh-btn sh-btn-ghost sh-btn-icon"
      style={{ width: 24, height: 24 }}
      title="复制内容"
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        });
      }}
    >
      {copied ? <Check size={12} /> : <Copy size={12} />}
    </button>
  );
}

function HandoffPopoverButton({
  sourceAuthor,
  content,
  candidates,
  onHandoff,
}: {
  readonly sourceAuthor: string;
  readonly content: string;
  readonly candidates: readonly FamilyMember[];
  readonly onHandoff: (targetMemberId: string, framedPrompt: string) => void;
}): React.ReactElement | null {
  const [open, setOpen] = useState<boolean>(false);
  if (candidates.length === 0) return null;

  return (
    <div style={{ position: 'relative' }}>
      <button
        type="button"
        className="sh-btn sh-btn-ghost sh-btn-icon"
        style={{ width: 24, height: 24 }}
        title="转交其他家庭成员评审或接力"
        onClick={() => setOpen((v) => !v)}
      >
        <CornerUpRight size={12} />
      </button>
      {open && (
        <div
          style={{
            position: 'absolute',
            right: 0,
            top: 'calc(100% + 4px)',
            width: 190,
            padding: 4,
            borderRadius: 8,
            border: '1px solid var(--sh-border)',
            background: 'var(--sh-popover)',
            boxShadow: 'var(--sh-shadow-lg)',
            zIndex: 35,
          }}
        >
          <div style={{ padding: '4px 8px', fontSize: 10.5, color: 'var(--sh-muted-fg)', fontWeight: 600 }}>
            转交给谁评审 / 接力？
          </div>
          {candidates.map((m) => (
            <button
              key={m.id}
              type="button"
              className="sh-menu-item"
              style={{ padding: '5px 8px', fontSize: 12 }}
              onClick={() => {
                setOpen(false);
                const snippet = content.length > 1200 ? `${content.slice(0, 1200)}…` : content;
                onHandoff(
                  m.id,
                  `以下是「${sourceAuthor}」刚才产出的结论/方案，请站在你的专业角度进行评审、补充或直接接力落地：\n\n---\n${snippet}\n---`
                );
              }}
            >
              <MemberAvatar avatar={m.avatar} bodyKind={m.body.kind} alt={m.name} size={18} />
              <span>{m.name}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function FamilyWorkbench({
  sessions,
  onBackToConversation,
}: FamilyWorkbenchProps): React.ReactElement {
  const [selectedScopeId, setSelectedScopeId] = useState<string>(() => sessions[0]?.id ?? 'default');
  const { state, refresh } = useFamilyLiveState(selectedScopeId);

  const [target, setTarget] = useState<LoungeTarget>({ kind: 'group', groupId: 'family-main' });
  const [sendFresh, setSendFresh] = useState<boolean>(false);
  const [errorBanner, setErrorBanner] = useState<string | null>(null);
  const [inspectorOpen, setInspectorOpen] = useState<boolean>(() =>
    typeof window !== 'undefined' ? window.innerWidth >= 1120 : true
  );
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>('calls');

  // Slide-over Sheet 与 Cmd+K 指挥面板状态
  const [sheetOpen, setSheetOpen] = useState<boolean>(false);
  const [editingMember, setEditingMember] = useState<FamilyMember | null>(null);
  const [paletteOpen, setPaletteOpen] = useState<boolean>(false);

  // 新建专题群浮层状态
  const [creatingGroup, setCreatingGroup] = useState<boolean>(false);
  const [newGroupTitle, setNewGroupTitle] = useState<string>('');
  const [newGroupMembers, setNewGroupMembers] = useState<string[]>([]);
  const [probing, setProbing] = useState<boolean>(false);
  const [composerInsert, setComposerInsert] = useState<{ seq: number; text: string } | null>(null);

  // 智能贴底滚动状态
  const streamRef = useRef<HTMLDivElement | null>(null);
  const stickToBottomRef = useRef<boolean>(true);
  const [showJumpBottom, setShowJumpBottom] = useState<boolean>(false);

  useEffect(() => {
    if (selectedScopeId === 'default' && sessions.length > 0 && sessions[0]?.id) {
      setSelectedScopeId(sessions[0].id);
    }
  }, [sessions, selectedScopeId]);

  // 全局 Cmd/Ctrl + K 快捷键唤起指挥面板
  useEffect(() => {
    const onGlobalKey = (ev: KeyboardEvent) => {
      if ((ev.metaKey || ev.ctrlKey) && ev.key.toLowerCase() === 'k') {
        ev.preventDefault();
        setPaletteOpen((v) => !v);
      }
    };
    window.addEventListener('keydown', onGlobalKey);
    return () => window.removeEventListener('keydown', onGlobalKey);
  }, []);

  const currentSessionMeta = useMemo(
    () => sessions.find((s) => s.id === selectedScopeId),
    [sessions, selectedScopeId]
  );

  const enabledMembers = useMemo(
    () => state.members.filter((m) => m.enabled),
    [state.members]
  );

  const validMemberIdSet = useMemo(
    () => new Set(state.members.map((m) => m.id)),
    [state.members]
  );

  const snapshotByMember = useMemo(() => {
    const map = new Map<string, (typeof state.snapshots)[number]>();
    for (const snap of state.snapshots) {
      if (snap.scopeId === selectedScopeId) {
        map.set(snap.memberId, snap);
      }
    }
    return map;
  }, [state.snapshots, selectedScopeId]);

  const scopedRooms = useMemo(() => {
    const found = state.rooms.filter((r) => r.scopeId === selectedScopeId);
    if (found.length > 0) return found;
    return [
      {
        id: 'family-main',
        title: '家庭总群',
        scopeId: selectedScopeId,
        memberIds: 'all_enabled' as const,
        messages: [],
        readCursors: {},
        activeSpeakerId: null,
        streamingDraft: null,
        running: false,
      },
    ];
  }, [state.rooms, selectedScopeId]);

  const activeGroupRoom = useMemo(() => {
    if (target.kind !== 'group') return undefined;
    return scopedRooms.find((r) => r.id === target.groupId) ?? scopedRooms[0];
  }, [scopedRooms, target]);

  const activeMember = useMemo(() => {
    if (target.kind !== 'member') return undefined;
    return state.members.find((m) => m.id === target.memberId);
  }, [state.members, target]);

  const activeMemberSnapshot = useMemo(() => {
    if (!activeMember) return undefined;
    return snapshotByMember.get(activeMember.id);
  }, [activeMember, snapshotByMember]);

  // 监听消息变化自动平滑贴底（仅当用户未手动上翻历史时）
  const streamSignature =
    target.kind === 'group'
      ? `${activeGroupRoom?.messages.length ?? 0}:${activeGroupRoom?.streamingDraft?.content.length ?? 0}`
      : `${activeMemberSnapshot?.entries.length ?? 0}:${activeMemberSnapshot?.entries.at(-1)?.content.length ?? 0}`;

  useEffect(() => {
    const el = streamRef.current;
    if (!el) return;
    if (stickToBottomRef.current) {
      el.scrollTop = el.scrollHeight;
    } else {
      setShowJumpBottom(true);
    }
  }, [streamSignature, target]);

  const scrollToBottom = () => {
    const el = streamRef.current;
    if (!el) return;
    stickToBottomRef.current = true;
    setShowJumpBottom(false);
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  };

  const openCreateSheet = () => {
    setEditingMember(null);
    setSheetOpen(true);
  };

  const openEditSheet = (member: FamilyMember) => {
    setEditingMember(member);
    setSheetOpen(true);
  };

  const dispatchMessageNonBlocking = (messageText: string, overrideTarget?: LoungeTarget) => {
    const effectiveTarget = overrideTarget ?? target;
    setErrorBanner(null);
    stickToBottomRef.current = true;
    setShowJumpBottom(false);

    if (effectiveTarget.kind === 'group') {
      void familyClientApi
        .postGroupMessage({
          scopeId: selectedScopeId,
          groupId: effectiveTarget.groupId,
          content: messageText,
          cwd: currentSessionMeta?.cwd,
        })
        .catch((err: unknown) => {
          setErrorBanner(err instanceof Error ? err.message : String(err));
        });
      return;
    }

    const useFresh = sendFresh;
    setSendFresh(false);
    void familyClientApi
      .sendDirectChat({
        scopeId: selectedScopeId,
        memberId: effectiveTarget.memberId,
        message: messageText,
        cwd: currentSessionMeta?.cwd,
        fresh: useFresh,
      })
      .catch((err: unknown) => {
        setErrorBanner(err instanceof Error ? err.message : String(err));
      });
  };

  const handleHandoffToMember = (targetMemberId: string, framedPrompt: string) => {
    const nextTarget: LoungeTarget = { kind: 'member', memberId: targetMemberId };
    setTarget(nextTarget);
    dispatchMessageNonBlocking(framedPrompt, nextTarget);
  };

  const handleClearCurrentHistory = async () => {
    setErrorBanner(null);
    try {
      if (target.kind === 'group' && activeGroupRoom) {
        await familyClientApi.clearHistory({
          scopeId: selectedScopeId,
          groupId: activeGroupRoom.id,
        });
      } else if (target.kind === 'member' && activeMember) {
        await familyClientApi.clearHistory({
          scopeId: selectedScopeId,
          memberId: activeMember.id,
        });
      }
      await refresh();
    } catch (err) {
      setErrorBanner(err instanceof Error ? err.message : String(err));
    }
  };

  const handleReprobeBodies = async () => {
    setProbing(true);
    try {
      await familyClientApi.probeBodies();
      await refresh();
    } finally {
      setProbing(false);
    }
  };

  const handleSeedFamily = async () => {
    setErrorBanner(null);
    try {
      await familyClientApi.seedTemplates();
      await refresh();
    } catch (err) {
      setErrorBanner(err instanceof Error ? err.message : String(err));
    }
  };

  const handleCreateTopicGroup = async () => {
    if (!newGroupTitle.trim()) return;
    setErrorBanner(null);
    try {
      const res = await familyClientApi.createGroup({
        scopeId: selectedScopeId,
        title: newGroupTitle.trim(),
        memberIds: newGroupMembers,
      });
      setCreatingGroup(false);
      setNewGroupTitle('');
      setNewGroupMembers([]);
      await refresh();
      setTarget({ kind: 'group', groupId: res.room.id });
    } catch (err) {
      setErrorBanner(err instanceof Error ? err.message : String(err));
    }
  };

  const isCurrentStageBusy =
    target.kind === 'group'
      ? Boolean(activeGroupRoom?.running)
      : activeMemberSnapshot?.state === 'working' ||
        activeMemberSnapshot?.state === 'in_call' ||
        activeMemberSnapshot?.state === 'awaiting_approval';

  const groupParticipantMembers = useMemo(() => {
    if (!activeGroupRoom) return enabledMembers;
    if (activeGroupRoom.memberIds === 'all_enabled') return enabledMembers;
    const set = new Set(activeGroupRoom.memberIds);
    return enabledMembers.filter((m) => set.has(m.id));
  }, [activeGroupRoom, enabledMembers]);

  return (
    <div className="dshfam-root">
      {/* 顶栏 Toolbar (shadcn minimal header) */}
      <header className="dshfam-header">
        <div className="dshfam-header-left">
          <MemberAvatar avatar="lobe:deepseek" size={28} />
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
            <span style={{ fontWeight: 600, fontSize: 14, whiteSpace: 'nowrap' }}>智能体家庭</span>
            <span style={{ color: 'var(--sh-muted-fg)' }}>/</span>
            {sessions.length > 0 ? (
              <select
                aria-label="关联工作区会话"
                className="sh-select"
                style={{ height: 28, width: 196, fontSize: 12 }}
                value={selectedScopeId}
                onChange={(e) => setSelectedScopeId(e.target.value)}
              >
                {sessions.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.title}
                  </option>
                ))}
              </select>
            ) : (
              <span style={{ fontSize: 12, color: 'var(--sh-muted-fg)' }}>默认工作区</span>
            )}
          </div>
        </div>

        <div className="dshfam-header-right">
          <button
            type="button"
            className="sh-btn sh-btn-outline"
            style={{ height: 30, padding: '0 10px', color: 'var(--sh-muted-fg)', gap: 10 }}
            onClick={() => setPaletteOpen(true)}
          >
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 12 }}>
              <Search size={13} />
              <span>跳转或执行命令…</span>
            </span>
            <span className="sh-kbd">⌘K</span>
          </button>

          <button
            type="button"
            className="sh-btn sh-btn-primary"
            style={{ height: 30 }}
            onClick={openCreateSheet}
          >
            <UserPlus size={14} />
            <span>新成员</span>
          </button>

          <button
            type="button"
            className={`sh-btn sh-btn-icon ${inspectorOpen ? 'sh-btn-secondary' : 'sh-btn-ghost'}`}
            title="展开/收起右侧协作检查器"
            aria-label="切换右侧栏"
            onClick={() => setInspectorOpen((v) => !v)}
          >
            <PanelRight size={15} />
          </button>

          <button
            type="button"
            className="sh-btn sh-btn-ghost"
            style={{ height: 30 }}
            onClick={onBackToConversation}
          >
            <ArrowLeft size={14} />
            <span>返回对话</span>
          </button>
        </div>
      </header>

      {/* 原生权限举手待批示横幅 */}
      <ApprovalBanner approvals={state.pendingApprovals} />

      {errorBanner && (
        <div
          style={{
            margin: '8px 16px 0',
            padding: '8px 12px',
            borderRadius: 8,
            background: 'var(--sh-destructive-soft)',
            color: 'var(--sh-destructive)',
            fontSize: 12.5,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}
        >
          <span>{errorBanner}</span>
          <button
            type="button"
            className="sh-btn sh-btn-ghost sh-btn-icon"
            style={{ width: 22, height: 22 }}
            onClick={() => setErrorBanner(null)}
          >
            ✕
          </button>
        </div>
      )}

      {/* 三栏主工作区 */}
      <div className="dshfam-workspace">
        {/* 左栏：群聊频道 + 家庭成员 + CLI 身体底座 */}
        <aside className="dshfam-sidebar">
          <div className="dshfam-sidebar-scroll">
            {/* 群聊分组 */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <div className="sh-section-label">
                <span>群聊空间</span>
                <button
                  type="button"
                  className="sh-btn sh-btn-ghost sh-btn-icon"
                  style={{ width: 22, height: 22 }}
                  title="新建专题讨论群"
                  onClick={() => setCreatingGroup((v) => !v)}
                >
                  <Plus size={13} />
                </button>
              </div>

              {creatingGroup && (
                <div
                  style={{
                    margin: '4px 4px 6px',
                    padding: 10,
                    borderRadius: 8,
                    border: '1px solid var(--sh-border)',
                    background: 'var(--sh-card)',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 8,
                  }}
                >
                  <input
                    className="sh-input"
                    style={{ height: 30, fontSize: 12 }}
                    placeholder="群聊名称（如：接口联调群）"
                    value={newGroupTitle}
                    onChange={(e) => setNewGroupTitle(e.target.value)}
                  />
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                    {enabledMembers.map((m) => {
                      const selected = newGroupMembers.includes(m.id);
                      return (
                        <button
                          key={m.id}
                          type="button"
                          className="dshfam-chip"
                          style={
                            selected
                              ? { borderColor: 'var(--sh-fg)', background: 'var(--sh-accent)' }
                              : undefined
                          }
                          onClick={() =>
                            setNewGroupMembers((prev) =>
                              prev.includes(m.id) ? prev.filter((x) => x !== m.id) : [...prev, m.id]
                            )
                          }
                        >
                          <MemberAvatar avatar={m.avatar} bodyKind={m.body.kind} size={14} />
                          <span>{m.name}</span>
                        </button>
                      );
                    })}
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 6 }}>
                    <button
                      type="button"
                      className="sh-btn sh-btn-ghost sh-btn-sm"
                      onClick={() => setCreatingGroup(false)}
                    >
                      取消
                    </button>
                    <button
                      type="button"
                      className="sh-btn sh-btn-primary sh-btn-sm"
                      disabled={!newGroupTitle.trim()}
                      onClick={() => void handleCreateTopicGroup()}
                    >
                      创建
                    </button>
                  </div>
                </div>
              )}

              {scopedRooms.map((room) => {
                const isSelected = target.kind === 'group' && target.groupId === room.id;
                return (
                  <div
                    key={room.id}
                    className="sh-nav-row"
                    data-active={String(isSelected)}
                    role="button"
                    tabIndex={0}
                    onClick={() => setTarget({ kind: 'group', groupId: room.id })}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') setTarget({ kind: 'group', groupId: room.id });
                    }}
                  >
                    <span className="dshfam-avatar" style={{ width: 26, height: 26 }}>
                      {room.id === 'family-main' ? <Users size={13} /> : <Hash size={13} />}
                    </span>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div
                        style={{
                          fontSize: 12.5,
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {room.title.replace(/^🏠\s*/u, '')}
                      </div>
                    </div>
                    {room.running ? (
                      <span className="dshfam-dot" data-state="working" title="讨论中" />
                    ) : room.id !== 'family-main' ? (
                      <button
                        type="button"
                        className="sh-btn sh-btn-ghost sh-btn-icon sh-row-action"
                        style={{ width: 20, height: 20 }}
                        title="移除专题群"
                        onClick={(e) => {
                          e.stopPropagation();
                          void familyClientApi.deleteGroup(selectedScopeId, room.id).then(() => {
                            if (isSelected) setTarget({ kind: 'group', groupId: 'family-main' });
                            return refresh();
                          });
                        }}
                      >
                        <Trash2 size={11} />
                      </button>
                    ) : (
                      <span style={{ fontSize: 11, color: 'var(--sh-muted-fg)' }}>
                        {room.messages.length || ''}
                      </span>
                    )}
                  </div>
                );
              })}
            </div>

            {/* 家庭成员分组 */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <div className="sh-section-label">
                <span>家庭成员 ({state.members.length})</span>
                <button
                  type="button"
                  className="sh-btn sh-btn-ghost sh-btn-icon"
                  style={{ width: 22, height: 22 }}
                  title="创造新家庭成员"
                  onClick={openCreateSheet}
                >
                  <Plus size={13} />
                </button>
              </div>

              {state.members.length === 0 ? (
                <div
                  style={{
                    margin: '4px 4px 0',
                    padding: 12,
                    borderRadius: 9,
                    border: '1px dashed var(--sh-border)',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 8,
                    fontSize: 12,
                    color: 'var(--sh-muted-fg)',
                  }}
                >
                  <div>尚未登记成员，可一键导入预设家庭或自由创建：</div>
                  <button
                    type="button"
                    className="sh-btn sh-btn-outline sh-btn-sm"
                    onClick={() => void handleSeedFamily()}
                  >
                    <Sparkles size={12} />
                    <span>导入预设四口之家</span>
                  </button>
                </div>
              ) : (
                state.members.map((member) => {
                  const snap = snapshotByMember.get(member.id);
                  const st = !member.enabled ? 'sleeping' : (snap?.state ?? 'sleeping');
                  const isSelected = target.kind === 'member' && target.memberId === member.id;
                  return (
                    <div
                      key={member.id}
                      className="sh-nav-row"
                      data-active={String(isSelected)}
                      style={!member.enabled ? { opacity: 0.52 } : undefined}
                      role="button"
                      tabIndex={0}
                      onClick={() => setTarget({ kind: 'member', memberId: member.id })}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') setTarget({ kind: 'member', memberId: member.id });
                      }}
                    >
                      <MemberAvatar
                        avatar={member.avatar}
                        bodyKind={member.body.kind}
                        alt={member.name}
                        size={28}
                      />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                          <span
                            style={{
                              fontSize: 12.5,
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                              whiteSpace: 'nowrap',
                            }}
                          >
                            {member.name}
                          </span>
                          <span className="sh-badge" style={{ height: 17, fontSize: 10 }}>
                            {member.body.kind}
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
                          {!member.enabled
                            ? '休假停用中'
                            : snap?.statusText || STATE_LABELS[st] || `@${member.id}`}
                        </div>
                      </div>

                      <button
                        type="button"
                        className="sh-btn sh-btn-ghost sh-btn-icon sh-row-action"
                        style={{ width: 22, height: 22 }}
                        title="编辑成员灵魂与头像"
                        onClick={(e) => {
                          e.stopPropagation();
                          openEditSheet(member);
                        }}
                      >
                        <Pencil size={11} />
                      </button>
                      <span className="dshfam-dot" data-state={st} />
                    </div>
                  );
                })
              )}
            </div>
          </div>

          {/* 左下角：本机四大 CLI 身体状态底座 */}
          <div className="dshfam-sidebar-footer">
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--sh-muted-fg)' }}>
                本机 CLI 身体状态
              </span>
              <button
                type="button"
                className="sh-btn sh-btn-ghost sh-btn-icon"
                style={{ width: 20, height: 20 }}
                disabled={probing}
                title="重新检测本机 CLI"
                onClick={() => void handleReprobeBodies()}
              >
                <RefreshCw size={11} />
              </button>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 5 }}>
              {state.bodies.map((b) => (
                <div
                  key={b.kind}
                  title={`${b.label}: ${b.note || (b.available ? '可用' : '未安装')}`}
                  style={{
                    padding: '4px 5px',
                    borderRadius: 6,
                    border: '1px solid var(--sh-border)',
                    background: 'var(--sh-card)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: 4,
                  }}
                >
                  <MemberAvatar avatar={defaultLobeAvatarForBody(b.kind)} bodyKind={b.kind} size={16} />
                  <span
                    className="dshfam-dot"
                    style={{ width: 6, height: 6 }}
                    data-state={b.available ? 'working' : 'sleeping'}
                  />
                </div>
              ))}
            </div>
          </div>
        </aside>

        {/* 中栏：对话主舞台 */}
        <main className="dshfam-main">
          {target.kind === 'group' && activeGroupRoom ? (
            <>
              <div className="dshfam-stage-bar">
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
                  <span className="dshfam-avatar" style={{ width: 30, height: 30 }}>
                    <Users size={15} />
                  </span>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span style={{ fontWeight: 600, fontSize: 14 }}>
                        {activeGroupRoom.title.replace(/^🏠\s*/u, '')}
                      </span>
                      <span className="sh-badge">{groupParticipantMembers.length} 位在岗成员</span>
                    </div>
                    <div style={{ fontSize: 11.5, color: 'var(--sh-muted-fg)' }}>
                      {activeGroupRoom.activeSpeakerId
                        ? `@${activeGroupRoom.activeSpeakerId} 正在拿着话筒发言…`
                        : activeGroupRoom.lastPassMemberName
                          ? `${activeGroupRoom.lastPassMemberName} 已阅（无额外补充）`
                          : '支持 @成员 点名接龙、实时流式发言与跨成员方案争辩'}
                    </div>
                  </div>
                </div>

                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  {activeGroupRoom.messages.length > 0 && (
                    <button
                      type="button"
                      className="sh-btn sh-btn-ghost sh-btn-sm"
                      title="清空本群界面展示记录"
                      onClick={() => void handleClearCurrentHistory()}
                    >
                      <Eraser size={13} />
                      <span>清空记录</span>
                    </button>
                  )}
                  {activeGroupRoom.running && (
                    <button
                      type="button"
                      className="sh-btn sh-btn-destructive sh-btn-sm"
                      onClick={() =>
                        void familyClientApi.interrupt({
                          scopeId: selectedScopeId,
                          groupId: activeGroupRoom.id,
                        })
                      }
                    >
                      <Square size={11} />
                      <span>暂停讨论</span>
                    </button>
                  )}
                </div>
              </div>

              <div
                ref={streamRef}
                className="dshfam-stream"
                onScroll={(e) => {
                  const el = e.currentTarget;
                  const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 64;
                  stickToBottomRef.current = nearBottom;
                  if (nearBottom) setShowJumpBottom(false);
                }}
              >
                {activeGroupRoom.messages.length === 0 && !activeGroupRoom.streamingDraft ? (
                  <div
                    style={{
                      margin: 'auto',
                      maxWidth: 480,
                      textAlign: 'center',
                      display: 'flex',
                      flexDirection: 'column',
                      alignItems: 'center',
                      gap: 14,
                    }}
                  >
                    <div style={{ display: 'flex', gap: 6 }}>
                      {groupParticipantMembers.slice(0, 5).map((m) => (
                        <MemberAvatar
                          key={m.id}
                          avatar={m.avatar}
                          bodyKind={m.body.kind}
                          alt={m.name}
                          size={34}
                        />
                      ))}
                    </div>
                    <div>
                      <div style={{ fontSize: 15, fontWeight: 600 }}>
                        在「{activeGroupRoom.title.replace(/^🏠\s*/u, '')}」召集大家一起干活
                      </div>
                      <div style={{ fontSize: 12.5, color: 'var(--sh-muted-fg)', marginTop: 4 }}>
                        每位成员拥有独立 CLI 身体与灵魂，会按未读增量阅读前面伙伴的发言、互相 @ 接龙商量或直言拒绝不合理方案。
                      </div>
                    </div>
                    {groupParticipantMembers.length > 0 && (
                      <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'center', gap: 8 }}>
                        {[
                          '大家简短报个到，说说各自擅长什么、什么事可以找你配合',
                          '结合当前工作区代码，大家讨论一下最值得优化的一个模块并分工',
                        ].map((promptIdea) => (
                          <button
                            key={promptIdea}
                            type="button"
                            className="sh-btn sh-btn-outline sh-btn-sm"
                            onClick={() => dispatchMessageNonBlocking(promptIdea)}
                          >
                            {promptIdea}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                ) : (
                  <>
                    {activeGroupRoom.messages.map((msg) => {
                      const isHuman = msg.senderId === 'human';
                      const senderMember = state.members.find((m) => m.id === msg.senderId);
                      return (
                        <div key={msg.id} className="sh-msg-row" data-mine={String(isHuman)}>
                          {!isHuman && (
                            <MemberAvatar
                              avatar={senderMember?.avatar ?? msg.senderAvatar}
                              bodyKind={senderMember?.body.kind}
                              alt={msg.senderName}
                              size={30}
                            />
                          )}
                          <div className="sh-msg-card">
                            <div className="sh-msg-head">
                              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                                <span style={{ fontWeight: 600, fontSize: 12.5 }}>{msg.senderName}</span>
                                {!isHuman && <span className="sh-badge">@{msg.senderId}</span>}
                                {senderMember && (
                                  <span className="sh-badge">{senderMember.body.kind}</span>
                                )}
                              </div>
                              <div className="sh-msg-actions">
                                <CopyMessageButton text={msg.content} />
                                {!isHuman && (
                                  <HandoffPopoverButton
                                    sourceAuthor={msg.senderName}
                                    content={msg.content}
                                    candidates={enabledMembers.filter((m) => m.id !== msg.senderId)}
                                    onHandoff={handleHandoffToMember}
                                  />
                                )}
                              </div>
                            </div>
                            <RichMessageContent
                              content={msg.content}
                              validMemberIds={validMemberIdSet}
                              onSelectMember={(mId) => setTarget({ kind: 'member', memberId: mId })}
                            />
                          </div>
                        </div>
                      );
                    })}

                    {/* 群聊内实时打字流式气泡 */}
                    {activeGroupRoom.streamingDraft && (
                      <div className="sh-msg-row" data-mine="false">
                        <MemberAvatar
                          avatar={activeGroupRoom.streamingDraft.senderAvatar}
                          bodyKind={
                            state.members.find(
                              (m) => m.id === activeGroupRoom.streamingDraft?.senderId
                            )?.body.kind
                          }
                          alt={activeGroupRoom.streamingDraft.senderName}
                          size={30}
                        />
                        <div className="sh-msg-card">
                          <div className="sh-msg-head">
                            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                              <span style={{ fontWeight: 600, fontSize: 12.5 }}>
                                {activeGroupRoom.streamingDraft.senderName}
                              </span>
                              <span className="sh-badge">
                                @{activeGroupRoom.streamingDraft.senderId}
                              </span>
                              {activeGroupRoom.streamingDraft.statusSummary && (
                                <span className="sh-badge">
                                  {activeGroupRoom.streamingDraft.statusSummary}
                                </span>
                              )}
                            </div>
                          </div>
                          {activeGroupRoom.streamingDraft.content ? (
                            <RichMessageContent
                              content={activeGroupRoom.streamingDraft.content}
                              validMemberIds={validMemberIdSet}
                            />
                          ) : (
                            <div style={{ color: 'var(--sh-muted-fg)', fontSize: 12.5 }}>
                              正在组织发言…
                            </div>
                          )}
                        </div>
                      </div>
                    )}
                  </>
                )}
              </div>

              {showJumpBottom && (
                <button
                  type="button"
                  className="sh-btn sh-btn-secondary sh-btn-sm"
                  onClick={scrollToBottom}
                  style={{
                    position: 'absolute',
                    bottom: 108,
                    left: '50%',
                    transform: 'translateX(-50%)',
                    boxShadow: 'var(--sh-shadow-lg)',
                    borderRadius: 999,
                  }}
                >
                  <ArrowDown size={12} />
                  <span>回到底部看新动态</span>
                </button>
              )}

              <SmartComposer
                mode="group"
                placeholder="输入 @ 点名成员发言，或直接布置协作议题…"
                members={groupParticipantMembers}
                isBusy={activeGroupRoom.running}
                sendFresh={false}
                onToggleFresh={() => undefined}
                onSubmit={(msg) => dispatchMessageNonBlocking(msg)}
                onStop={() =>
                  void familyClientApi.interrupt({
                    scopeId: selectedScopeId,
                    groupId: activeGroupRoom.id,
                  })
                }
                onSlashCommand={(cmd) => {
                  if (cmd === 'clear') void handleClearCurrentHistory();
                }}
                disabled={groupParticipantMembers.length === 0}
                externalInsertText={composerInsert}
              />
            </>
          ) : activeMember ? (
            <>
              <div className="dshfam-stage-bar">
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
                  <MemberAvatar
                    avatar={activeMember.avatar}
                    bodyKind={activeMember.body.kind}
                    alt={activeMember.name}
                    size={32}
                  />
                  <div style={{ minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                      <span style={{ fontWeight: 600, fontSize: 14 }}>{activeMember.name}</span>
                      <span className="sh-badge">@{activeMember.id}</span>
                      <span className="sh-badge">{activeMember.body.kind}</span>
                      {(activeMemberSnapshot?.queueLength ?? 0) > 0 && (
                        <span className="sh-badge">
                          排队 {activeMemberSnapshot?.queueLength}
                        </span>
                      )}
                    </div>
                    <div
                      style={{
                        fontSize: 11.5,
                        color: 'var(--sh-muted-fg)',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {activeMemberSnapshot?.statusText || activeMember.specialty}
                    </div>
                  </div>
                </div>

                <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
                  <button
                    type="button"
                    className="sh-btn sh-btn-ghost sh-btn-sm"
                    onClick={() => openEditSheet(activeMember)}
                  >
                    <Pencil size={12} />
                    <span>编辑</span>
                  </button>
                  <button
                    type="button"
                    className="sh-btn sh-btn-ghost sh-btn-sm"
                    title="休眠当前身体，下次派活开启全新上下文"
                    onClick={() =>
                      void familyClientApi.resetSession(selectedScopeId, activeMember.id)
                    }
                  >
                    <RotateCcw size={12} />
                    <span>重置身体</span>
                  </button>
                  {(activeMemberSnapshot?.entries.length ?? 0) > 0 && (
                    <button
                      type="button"
                      className="sh-btn sh-btn-ghost sh-btn-sm"
                      onClick={() => void handleClearCurrentHistory()}
                    >
                      <Eraser size={12} />
                      <span>清屏</span>
                    </button>
                  )}
                </div>
              </div>

              <div
                ref={streamRef}
                className="dshfam-stream"
                onScroll={(e) => {
                  const el = e.currentTarget;
                  const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 64;
                  stickToBottomRef.current = nearBottom;
                  if (nearBottom) setShowJumpBottom(false);
                }}
              >
                {(activeMemberSnapshot?.entries ?? []).length === 0 ? (
                  <div
                    style={{
                      margin: 'auto',
                      maxWidth: 460,
                      textAlign: 'center',
                      display: 'flex',
                      flexDirection: 'column',
                      alignItems: 'center',
                      gap: 12,
                    }}
                  >
                    <MemberAvatar
                      avatar={activeMember.avatar}
                      bodyKind={activeMember.body.kind}
                      alt={activeMember.name}
                      size={48}
                    />
                    <div>
                      <div style={{ fontSize: 15, fontWeight: 600 }}>
                        {activeMember.name} · 独立工作书房
                      </div>
                      <div style={{ fontSize: 12.5, color: 'var(--sh-muted-fg)', marginTop: 4 }}>
                        {activeMember.specialty}。直接交代任务即可，遇到需要其他成员配合时 TA 会主动掏出随身手机联系家里人。
                      </div>
                    </div>
                    <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'center', gap: 8 }}>
                      {[
                        '先看看当前工作区目录结构，告诉我你准备怎么开展工作',
                        '用你的随身手机看看家里还有哪些伙伴在线',
                      ].map((idea) => (
                        <button
                          key={idea}
                          type="button"
                          className="sh-btn sh-btn-outline sh-btn-sm"
                          onClick={() => dispatchMessageNonBlocking(idea)}
                        >
                          {idea}
                        </button>
                      ))}
                    </div>
                  </div>
                ) : (
                  (activeMemberSnapshot?.entries ?? []).map((entry) => {
                    const isHuman = entry.role === 'human';
                    return (
                      <div key={entry.id} className="sh-msg-row" data-mine={String(isHuman)}>
                        {!isHuman && (
                          <MemberAvatar
                            avatar={entry.role === 'member' ? activeMember.avatar : 'lobe:deepseek'}
                            bodyKind={activeMember.body.kind}
                            alt={entry.authorName}
                            size={30}
                          />
                        )}
                        <div className="sh-msg-card">
                          <div className="sh-msg-head">
                            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                              <span style={{ fontWeight: 600, fontSize: 12.5 }}>{entry.authorName}</span>
                              {entry.statusSummary && (
                                <span className="sh-badge">{entry.statusSummary}</span>
                              )}
                              {entry.streaming && (
                                <span className="sh-badge" style={{ color: 'var(--sh-emerald)' }}>
                                  输出中
                                </span>
                              )}
                            </div>
                            {!entry.streaming && entry.content && (
                              <div className="sh-msg-actions">
                                <CopyMessageButton text={entry.content} />
                                {entry.role === 'member' && (
                                  <HandoffPopoverButton
                                    sourceAuthor={activeMember.name}
                                    content={entry.content}
                                    candidates={enabledMembers.filter(
                                      (m) => m.id !== activeMember.id
                                    )}
                                    onHandoff={handleHandoffToMember}
                                  />
                                )}
                              </div>
                            )}
                          </div>
                          {entry.content ? (
                            <RichMessageContent
                              content={entry.content}
                              validMemberIds={validMemberIdSet}
                              onSelectMember={(mId) => setTarget({ kind: 'member', memberId: mId })}
                            />
                          ) : (
                            <div style={{ color: 'var(--sh-muted-fg)', fontSize: 12.5 }}>
                              {entry.statusSummary || '正在思考与推进…'}
                            </div>
                          )}
                        </div>
                      </div>
                    );
                  })
                )}
              </div>

              {showJumpBottom && (
                <button
                  type="button"
                  className="sh-btn sh-btn-secondary sh-btn-sm"
                  onClick={scrollToBottom}
                  style={{
                    position: 'absolute',
                    bottom: 108,
                    left: '50%',
                    transform: 'translateX(-50%)',
                    boxShadow: 'var(--sh-shadow-lg)',
                    borderRadius: 999,
                  }}
                >
                  <ArrowDown size={12} />
                  <span>回到底部</span>
                </button>
              )}

              <SmartComposer
                mode="member"
                placeholder={
                  !activeMember.enabled
                    ? `${activeMember.name} 当前休假停用中，可在右侧开启在岗`
                    : `交代给 ${activeMember.name} (@${activeMember.id}) 的工作…`
                }
                members={enabledMembers}
                isBusy={Boolean(isCurrentStageBusy)}
                sendFresh={sendFresh}
                onToggleFresh={setSendFresh}
                onSubmit={(msg) => dispatchMessageNonBlocking(msg)}
                onStop={() =>
                  void familyClientApi.interrupt({
                    scopeId: selectedScopeId,
                    memberId: activeMember.id,
                  })
                }
                onSlashCommand={(cmd) => {
                  if (cmd === 'clear') void handleClearCurrentHistory();
                  if (cmd === 'reset') {
                    void familyClientApi.resetSession(selectedScopeId, activeMember.id);
                  }
                }}
                disabled={!activeMember.enabled}
                externalInsertText={composerInsert}
              />
            </>
          ) : (
            <div style={{ margin: 'auto', color: 'var(--sh-muted-fg)' }}>
              请在左侧选择群聊或家庭成员
            </div>
          )}
        </main>

        {/* 右栏可折叠协作检查器 (Inspector) */}
        {inspectorOpen && (
          <aside className="dshfam-inspector">
            <div style={{ padding: '10px 12px', borderBottom: '1px solid var(--sh-border)' }}>
              <div className="sh-tabs-list">
                <button
                  type="button"
                  className="sh-tabs-trigger"
                  data-active={String(inspectorTab === 'calls')}
                  onClick={() => setInspectorTab('calls')}
                >
                  手机通话 ({state.callRecords.length})
                </button>
                <button
                  type="button"
                  className="sh-tabs-trigger"
                  data-active={String(inspectorTab === 'context')}
                  onClick={() => setInspectorTab('context')}
                >
                  {target.kind === 'member' ? '灵魂与档案' : '群内成员'}
                </button>
              </div>
            </div>

            <div style={{ flex: 1, overflowY: 'auto', padding: 12, display: 'flex', flexDirection: 'column', gap: 10 }}>
              {inspectorTab === 'calls' ? (
                state.callRecords.length === 0 ? (
                  <div
                    style={{
                      padding: '24px 10px',
                      textAlign: 'center',
                      color: 'var(--sh-muted-fg)',
                      fontSize: 12,
                      lineHeight: 1.6,
                    }}
                  >
                    <PhoneCall size={20} style={{ opacity: 0.45, marginBottom: 6 }} />
                    <div>暂无跨成员通话</div>
                    <div style={{ fontSize: 11, marginTop: 4 }}>
                      当成员在执行任务途中主动拨打 `phone_call` 商量方案、协作或拒绝越界要求时，通话纪要会实时呈现在此。
                    </div>
                  </div>
                ) : (
                  [...state.callRecords].reverse().map((call) => (
                    <div
                      key={call.id}
                      style={{
                        padding: '10px 11px',
                        borderRadius: 8,
                        border: '1px solid var(--sh-border)',
                        background: 'var(--sh-card)',
                        fontSize: 12,
                        display: 'flex',
                        flexDirection: 'column',
                        gap: 6,
                      }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6 }}>
                        <span style={{ fontWeight: 600 }}>
                          {call.fromMemberName} ➔ {call.toMemberName}
                        </span>
                        <span className="sh-badge">{call.status}</span>
                      </div>
                      <div style={{ color: 'var(--sh-muted-fg)', fontSize: 11.5 }}>
                        {call.message.slice(0, 120)}
                      </div>
                      {call.reply && (
                        <div
                          style={{
                            paddingTop: 6,
                            borderTop: '1px dashed var(--sh-border)',
                            fontSize: 11.5,
                          }}
                        >
                          {call.reply.slice(0, 160)}
                          {call.reply.length > 160 ? '…' : ''}
                        </div>
                      )}
                    </div>
                  ))
                )
              ) : target.kind === 'member' && activeMember ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                  <div
                    style={{
                      padding: 12,
                      borderRadius: 9,
                      border: '1px solid var(--sh-border)',
                      background: 'var(--sh-card)',
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 10,
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                      <MemberAvatar
                        avatar={activeMember.avatar}
                        bodyKind={activeMember.body.kind}
                        alt={activeMember.name}
                        size={40}
                      />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontWeight: 600, fontSize: 13.5 }}>{activeMember.name}</div>
                        <div style={{ display: 'flex', gap: 5, marginTop: 3 }}>
                          <span className="sh-badge">@{activeMember.id}</span>
                          <span className="sh-badge">{activeMember.body.kind}</span>
                        </div>
                      </div>
                    </div>

                    <div style={{ fontSize: 12, color: 'var(--sh-muted-fg)' }}>
                      {activeMember.specialty}
                    </div>

                    <div style={{ display: 'flex', gap: 6 }}>
                      <button
                        type="button"
                        className="sh-btn sh-btn-outline sh-btn-sm"
                        style={{ flex: 1 }}
                        onClick={() => openEditSheet(activeMember)}
                      >
                        <Pencil size={12} />
                        <span>编辑灵魂</span>
                      </button>
                      <button
                        type="button"
                        className="sh-btn sh-btn-outline sh-btn-sm"
                        onClick={() =>
                          void familyClientApi
                            .updateMember(activeMember.id, { enabled: !activeMember.enabled })
                            .then(() => refresh())
                        }
                      >
                        {activeMember.enabled ? '设为休假' : '恢复在岗'}
                      </button>
                    </div>
                  </div>

                  <div>
                    <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--sh-muted-fg)', marginBottom: 6 }}>
                      灵魂准则（Soul Prompt）
                    </div>
                    <div
                      style={{
                        padding: 11,
                        borderRadius: 8,
                        border: '1px solid var(--sh-border)',
                        background: 'var(--sh-card)',
                        fontSize: 12,
                        lineHeight: 1.58,
                        whiteSpace: 'pre-wrap',
                      }}
                    >
                      {activeMember.soulPrompt}
                    </div>
                  </div>

                  <button
                    type="button"
                    className="sh-btn sh-btn-destructive sh-btn-sm"
                    style={{ alignSelf: 'flex-start' }}
                    onClick={() =>
                      void familyClientApi.deleteMember(activeMember.id).then(() => {
                        setTarget({ kind: 'group', groupId: 'family-main' });
                        return refresh();
                      })
                    }
                  >
                    <Trash2 size={12} />
                    <span>从家庭户口本移除</span>
                  </button>
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--sh-muted-fg)', padding: '0 2px' }}>
                    本群在岗成员（点击可 @ 点名）
                  </div>
                  {groupParticipantMembers.map((m) => (
                    <div
                      key={m.id}
                      style={{
                        padding: '8px 10px',
                        borderRadius: 8,
                        border: '1px solid var(--sh-border)',
                        background: 'var(--sh-card)',
                        display: 'flex',
                        alignItems: 'center',
                        gap: 9,
                      }}
                    >
                      <MemberAvatar avatar={m.avatar} bodyKind={m.body.kind} alt={m.name} size={28} />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontWeight: 600, fontSize: 12.5 }}>{m.name}</div>
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
                      <button
                        type="button"
                        className="sh-btn sh-btn-outline sh-btn-sm"
                        onClick={() =>
                          setComposerInsert((prev) => ({
                            seq: (prev?.seq ?? 0) + 1,
                            text: `@${m.id} `,
                          }))
                        }
                      >
                        @TA
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </aside>
        )}
      </div>

      {/* 右侧滑出式 Sheet：成员创建、Lobe 图标选择与自定义照片裁剪上传 */}
      <MemberSheet
        open={sheetOpen}
        editingMember={editingMember}
        templates={state.templates}
        bodies={state.bodies}
        onClose={() => setSheetOpen(false)}
        onSaved={(saved) => {
          void refresh();
          setTarget({ kind: 'member', memberId: saved.id });
        }}
      />

      {/* Cmd/Ctrl + K 快捷指挥面板 */}
      <CommandPalette
        open={paletteOpen}
        rooms={scopedRooms}
        members={state.members}
        onClose={() => setPaletteOpen(false)}
        onSelectGroup={(gId) => setTarget({ kind: 'group', groupId: gId })}
        onSelectMember={(mId) => setTarget({ kind: 'member', memberId: mId })}
        onCreateMember={openCreateSheet}
        onCreateGroup={() => setCreatingGroup(true)}
        onReprobeBodies={() => void handleReprobeBodies()}
        onSeedFamily={() => void handleSeedFamily()}
        onBackToMainChat={onBackToConversation}
      />
    </div>
  );
}
