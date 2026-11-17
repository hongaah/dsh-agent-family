import React, { useEffect, useMemo, useState } from 'react';

import { BODY_KINDS, type BodyKind, type FamilyMember, type StarterMemberTemplate } from '../core/types.ts';
import { ApprovalBanner } from './ApprovalBanner.tsx';
import { familyClientApi, useFamilyLiveState } from './api.ts';

export interface SessionSummaryOption {
  readonly id: string;
  readonly title: string;
  readonly cwd?: string;
}

export interface FamilyWorkbenchProps {
  readonly sessions: readonly SessionSummaryOption[];
  readonly onBackToConversation: () => void;
}

type WorkbenchTab = 'lounge' | 'studio';
type LoungeTarget =
  | { readonly kind: 'group'; readonly groupId: string }
  | { readonly kind: 'member'; readonly memberId: string };

const AVATAR_PRESETS = ['🏛️', '🎨', '⚙️', '🛡️', '🧠', '🚀', '🔍', '🦊', '🦉', '⚡'] as const;

const STATE_LABELS: Readonly<Record<string, string>> = {
  sleeping: '休眠待唤醒',
  idle: '空闲待命',
  working: '独立推进中',
  in_call: '📞 通话协商中',
  awaiting_approval: '🙋 举手待批示',
  error: '连接异常',
};

export function FamilyWorkbench({
  sessions,
  onBackToConversation,
}: FamilyWorkbenchProps): React.ReactElement {
  const [selectedScopeId, setSelectedScopeId] = useState<string>(() => sessions[0]?.id ?? 'default');
  const { state, refresh } = useFamilyLiveState(selectedScopeId);

  const [activeTab, setActiveTab] = useState<WorkbenchTab>('lounge');
  const [target, setTarget] = useState<LoungeTarget>({ kind: 'group', groupId: 'family-main' });
  const [composerText, setComposerText] = useState<string>('');
  const [sendFresh, setSendFresh] = useState<boolean>(false);
  const [sending, setSending] = useState<boolean>(false);
  const [errorBanner, setErrorBanner] = useState<string | null>(null);

  // 新建专题群弹窗状态
  const [creatingGroup, setCreatingGroup] = useState<boolean>(false);
  const [newGroupTitle, setNewGroupTitle] = useState<string>('');
  const [newGroupMembers, setNewGroupMembers] = useState<string[]>([]);

  // 成员与灵魂工坊编辑表单状态
  const [editingMemberId, setEditingMemberId] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState<boolean>(false);
  const [formId, setFormId] = useState<string>('');
  const [formName, setFormName] = useState<string>('');
  const [formAvatar, setFormAvatar] = useState<string>('🏛️');
  const [formSpecialty, setFormSpecialty] = useState<string>('');
  const [formBodyKind, setFormBodyKind] = useState<BodyKind>('claude');
  const [formCommand, setFormCommand] = useState<string>('');
  const [formExtraArgs, setFormExtraArgs] = useState<string>('');
  const [formSoulPrompt, setFormSoulPrompt] = useState<string>('');
  const [probing, setProbing] = useState<boolean>(false);

  useEffect(() => {
    if (selectedScopeId === 'default' && sessions.length > 0 && sessions[0]?.id) {
      setSelectedScopeId(sessions[0].id);
    }
  }, [sessions, selectedScopeId]);

  const currentSessionMeta = useMemo(
    () => sessions.find((s) => s.id === selectedScopeId),
    [sessions, selectedScopeId]
  );

  const enabledMembers = useMemo(
    () => state.members.filter((m) => m.enabled),
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

  const activeGroupRoom = useMemo(() => {
    if (target.kind !== 'group') return undefined;
    return (
      state.rooms.find((r) => r.scopeId === selectedScopeId && r.id === target.groupId) ?? {
        id: 'family-main',
        title: '🏠 家庭总群',
        scopeId: selectedScopeId,
        memberIds: 'all_enabled' as const,
        messages: [],
        readCursors: {},
        activeSpeakerId: null,
        running: false,
      }
    );
  }, [state.rooms, selectedScopeId, target]);

  const activeMember = useMemo(() => {
    if (target.kind !== 'member') return undefined;
    return state.members.find((m) => m.id === target.memberId);
  }, [state.members, target]);

  const activeMemberSnapshot = useMemo(() => {
    if (!activeMember) return undefined;
    return snapshotByMember.get(activeMember.id);
  }, [activeMember, snapshotByMember]);

  const firstAvailableBody = useMemo<BodyKind>(() => {
    const ready = state.bodies.find((b) => b.available);
    return ready?.kind ?? 'claude';
  }, [state.bodies]);

  const openCreateForm = (tpl?: StarterMemberTemplate) => {
    setEditingMemberId(null);
    setFormId(tpl?.id ?? '');
    setFormName(tpl?.name ?? '');
    setFormAvatar(tpl?.avatar ?? '🏛️');
    setFormSpecialty(tpl?.specialty ?? '');
    setFormBodyKind(tpl?.recommendedBody ?? firstAvailableBody);
    setFormCommand('');
    setFormExtraArgs('');
    setFormSoulPrompt(tpl?.soulPrompt ?? '');
    setFormOpen(true);
    setActiveTab('studio');
  };

  const openEditForm = (member: FamilyMember) => {
    setEditingMemberId(member.id);
    setFormId(member.id);
    setFormName(member.name);
    setFormAvatar(member.avatar);
    setFormSpecialty(member.specialty);
    setFormBodyKind(member.body.kind);
    setFormCommand(member.body.command ?? '');
    setFormExtraArgs((member.body.extraArgs ?? []).join(' '));
    setFormSoulPrompt(member.soulPrompt);
    setFormOpen(true);
    setActiveTab('studio');
  };

  const handleSaveMember = async (ev: React.FormEvent) => {
    ev.preventDefault();
    setErrorBanner(null);
    const parsedArgs = formExtraArgs
      .split(/\s+/u)
      .map((s) => s.trim())
      .filter(Boolean);
    const bodySpec = {
      kind: formBodyKind,
      ...(formCommand.trim() ? { command: formCommand.trim() } : {}),
      ...(parsedArgs.length > 0 ? { extraArgs: parsedArgs } : {}),
    };

    try {
      if (editingMemberId) {
        await familyClientApi.updateMember(editingMemberId, {
          name: formName,
          avatar: formAvatar,
          specialty: formSpecialty,
          body: bodySpec,
          soulPrompt: formSoulPrompt,
        });
      } else {
        await familyClientApi.createMember({
          id: formId,
          name: formName,
          avatar: formAvatar,
          specialty: formSpecialty,
          body: bodySpec,
          soulPrompt: formSoulPrompt,
        });
      }
      setFormOpen(false);
      await refresh();
    } catch (err) {
      setErrorBanner(err instanceof Error ? err.message : String(err));
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

  const handleReprobe = async () => {
    setProbing(true);
    try {
      await familyClientApi.probeBodies();
      await refresh();
    } finally {
      setProbing(false);
    }
  };

  const handleSendInLounge = async () => {
    const text = composerText.trim();
    if (!text || sending) return;
    setErrorBanner(null);
    setComposerText('');
    setSending(true);
    try {
      if (target.kind === 'group') {
        await familyClientApi.postGroupMessage({
          scopeId: selectedScopeId,
          groupId: target.groupId,
          content: text,
          cwd: currentSessionMeta?.cwd,
        });
      } else {
        await familyClientApi.sendDirectChat({
          scopeId: selectedScopeId,
          memberId: target.memberId,
          message: text,
          cwd: currentSessionMeta?.cwd,
          fresh: sendFresh,
        });
        setSendFresh(false);
      }
    } catch (err) {
      setErrorBanner(err instanceof Error ? err.message : String(err));
    } finally {
      setSending(false);
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

  const workingCount = state.snapshots.filter(
    (s) =>
      s.scopeId === selectedScopeId &&
      (s.state === 'working' || s.state === 'in_call' || s.state === 'awaiting_approval')
  ).length;

  return (
    <div className="dshfam-root">
      {/* 顶部栏 */}
      <div className="dshfam-topbar">
        <div className="dshfam-brand">
          <div className="dshfam-brand-badge">🏠</div>
          <div>
            <div className="dshfam-brand-title">智能体家庭 · Agents Family</div>
            <div className="dshfam-brand-sub">
              CLI 是身体，提示词是灵魂，随身手机与家庭群聊让成员像真人一样独立或协作完活
            </div>
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          {sessions.length > 0 && (
            <select
              aria-label="关联工作区会话"
              className="dshfam-select"
              style={{ width: 210 }}
              value={selectedScopeId}
              onChange={(e) => setSelectedScopeId(e.target.value)}
            >
              {sessions.map((s) => (
                <option key={s.id} value={s.id}>
                  工作区：{s.title}
                </option>
              ))}
            </select>
          )}

          <div className="dshfam-tabs" role="tablist">
            <button
              type="button"
              role="tab"
              className="dshfam-tab"
              data-active={String(activeTab === 'lounge')}
              onClick={() => setActiveTab('lounge')}
            >
              🏠 家庭客厅 {workingCount > 0 ? `(${workingCount} 忙碌)` : ''}
            </button>
            <button
              type="button"
              role="tab"
              className="dshfam-tab"
              data-active={String(activeTab === 'studio')}
              onClick={() => setActiveTab('studio')}
            >
              ✨ 成员与灵魂工坊 ({state.members.length})
            </button>
          </div>

          <button type="button" className="dshfam-btn" onClick={onBackToConversation}>
            返回主对话
          </button>
        </div>
      </div>

      {/* 全局举手待批示通知条 */}
      <ApprovalBanner approvals={state.pendingApprovals} />

      {errorBanner && (
        <div
          style={{
            margin: '8px 16px 0',
            padding: '8px 12px',
            borderRadius: 8,
            background: 'rgba(239, 68, 68, 0.14)',
            border: '1px solid rgba(239, 68, 68, 0.38)',
            color: '#ef4444',
            fontSize: 12.5,
            display: 'flex',
            justifyContent: 'space-between',
          }}
        >
          <span>{errorBanner}</span>
          <button
            type="button"
            onClick={() => setErrorBanner(null)}
            style={{ background: 'none', border: 'none', color: 'inherit', cursor: 'pointer' }}
          >
            ✕
          </button>
        </div>
      )}

      {activeTab === 'lounge' ? (
        <div className="dshfam-lounge">
          {/* 左栏：群聊空间 + 家庭成员名册 */}
          <aside className="dshfam-nav-rail">
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <div className="dshfam-section-head">
                <span>群聊空间</span>
                <button
                  type="button"
                  className="dshfam-chip"
                  onClick={() => setCreatingGroup((v) => !v)}
                >
                  + 拉群
                </button>
              </div>

              {creatingGroup && (
                <div
                  style={{
                    padding: 10,
                    borderRadius: 9,
                    border: '1px solid var(--fam-border-strong)',
                    background: 'var(--fam-surface)',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 7,
                  }}
                >
                  <input
                    className="dshfam-input"
                    placeholder="群名称（如：登录改版专项群）"
                    value={newGroupTitle}
                    onChange={(e) => setNewGroupTitle(e.target.value)}
                  />
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                    {enabledMembers.map((m) => {
                      const checked = newGroupMembers.includes(m.id);
                      return (
                        <button
                          key={m.id}
                          type="button"
                          className="dshfam-chip"
                          style={
                            checked
                              ? { borderColor: 'var(--fam-accent)', color: 'var(--fam-accent)' }
                              : undefined
                          }
                          onClick={() =>
                            setNewGroupMembers((prev) =>
                              prev.includes(m.id) ? prev.filter((x) => x !== m.id) : [...prev, m.id]
                            )
                          }
                        >
                          {m.avatar} {m.name}
                        </button>
                      );
                    })}
                  </div>
                  <button
                    type="button"
                    className="dshfam-btn dshfam-btn-primary"
                    onClick={() => void handleCreateTopicGroup()}
                  >
                    创建群聊
                  </button>
                </div>
              )}

              {(state.rooms.filter((r) => r.scopeId === selectedScopeId).length > 0
                ? state.rooms.filter((r) => r.scopeId === selectedScopeId)
                : [
                    {
                      id: 'family-main',
                      title: '🏠 家庭总群',
                      scopeId: selectedScopeId,
                      memberIds: 'all_enabled' as const,
                      messages: [],
                      readCursors: {},
                      activeSpeakerId: null,
                      running: false,
                    },
                  ]
              ).map((room) => (
                <button
                  key={room.id}
                  type="button"
                  className="dshfam-nav-item"
                  data-selected={String(target.kind === 'group' && target.groupId === room.id)}
                  onClick={() => setTarget({ kind: 'group', groupId: room.id })}
                >
                  <span className="dshfam-avatar">👥</span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {room.title}
                    </div>
                    <div style={{ fontSize: 11, opacity: 0.62 }}>
                      {room.running ? '💬 正在热烈讨论中…' : `${room.messages.length} 条发言`}
                    </div>
                  </div>
                </button>
              ))}
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <div className="dshfam-section-head">
                <span>家庭成员（一对一）</span>
                <button
                  type="button"
                  className="dshfam-chip"
                  onClick={() => openCreateForm()}
                >
                  + 新成员
                </button>
              </div>

              {enabledMembers.length === 0 ? (
                <div
                  style={{
                    padding: 12,
                    borderRadius: 10,
                    border: '1px dashed var(--fam-border-strong)',
                    fontSize: 12,
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 8,
                  }}
                >
                  <div>家里还没有在岗成员。你可以白纸创建，或一键召入预设家庭成员：</div>
                  <button
                    type="button"
                    className="dshfam-btn dshfam-btn-primary"
                    onClick={() => void handleSeedFamily()}
                  >
                    ✨ 一键召入预设四口之家
                  </button>
                </div>
              ) : (
                enabledMembers.map((member) => {
                  const snap = snapshotByMember.get(member.id);
                  const st = snap?.state ?? 'sleeping';
                  return (
                    <button
                      key={member.id}
                      type="button"
                      className="dshfam-nav-item"
                      data-selected={String(
                        target.kind === 'member' && target.memberId === member.id
                      )}
                      onClick={() => setTarget({ kind: 'member', memberId: member.id })}
                    >
                      <span className="dshfam-avatar">{member.avatar}</span>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                          <span style={{ fontSize: 13, fontWeight: 600 }}>{member.name}</span>
                          <span className="dshfam-mono-tag">{member.body.kind}</span>
                        </div>
                        <div
                          style={{
                            fontSize: 11,
                            opacity: 0.65,
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                          }}
                        >
                          {snap?.statusText || STATE_LABELS[st] || member.specialty}
                        </div>
                      </div>
                      <span className="dshfam-dot" data-state={st} />
                    </button>
                  );
                })
              )}
            </div>
          </aside>

          {/* 中栏：群聊室 或 成员一对一书房 */}
          <section className="dshfam-stage">
            {target.kind === 'group' && activeGroupRoom ? (
              <>
                <div className="dshfam-stage-head">
                  <div>
                    <div style={{ fontSize: 14.5, fontWeight: 700 }}>{activeGroupRoom.title}</div>
                    <div style={{ fontSize: 11.5, opacity: 0.68 }}>
                      {activeGroupRoom.activeSpeakerId
                        ? `🎙️ @${activeGroupRoom.activeSpeakerId} 正在思考发言…`
                        : activeGroupRoom.lastPassMemberName
                          ? `🤫 ${activeGroupRoom.lastPassMemberName} 已阅（静默旁听）`
                          : '群内成员各自独立记忆，按未读消息增量接话、互相 @ 协作或提出异议'}
                    </div>
                  </div>
                  {activeGroupRoom.running && (
                    <button
                      type="button"
                      className="dshfam-btn dshfam-btn-danger"
                      onClick={() =>
                        void familyClientApi.interrupt({
                          scopeId: selectedScopeId,
                          groupId: activeGroupRoom.id,
                        })
                      }
                    >
                      ⏸ 暂停讨论
                    </button>
                  )}
                </div>

                <div className="dshfam-feed">
                  {activeGroupRoom.messages.length === 0 ? (
                    <div style={{ opacity: 0.6, fontSize: 13, margin: 'auto', textAlign: 'center', maxWidth: 420 }}>
                      在群里抛出一项任务或方案议题吧！你可以直接广播让全员评估分工，也可以点下方 `@成员` 指定谁先开口。
                    </div>
                  ) : (
                    activeGroupRoom.messages.map((msg) => {
                      const isHuman = msg.senderId === 'human';
                      const senderMember = state.members.find((m) => m.id === msg.senderId);
                      return (
                        <div key={msg.id} className="dshfam-bubble" data-mine={String(isHuman)}>
                          <div className="dshfam-bubble-meta">
                            <span>
                              {msg.senderAvatar} {msg.senderName}
                            </span>
                            {!isHuman && <span className="dshfam-mono-tag">@{msg.senderId}</span>}
                            {senderMember && (
                              <span className="dshfam-mono-tag">{senderMember.body.kind}</span>
                            )}
                          </div>
                          <div>{msg.content}</div>
                        </div>
                      );
                    })
                  )}
                </div>

                <div className="dshfam-composer">
                  {enabledMembers.length > 0 && (
                    <div className="dshfam-mention-bar">
                      <span style={{ fontSize: 11, opacity: 0.6 }}>点名接话：</span>
                      {enabledMembers.map((m) => (
                        <button
                          key={m.id}
                          type="button"
                          className="dshfam-chip"
                          onClick={() =>
                            setComposerText((prev) => `${prev}${prev.endsWith(' ') || !prev ? '' : ' '}@${m.id} `)
                          }
                        >
                          {m.avatar} @{m.id}
                        </button>
                      ))}
                    </div>
                  )}
                  <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
                    <textarea
                      className="dshfam-textarea"
                      placeholder="在群里布置协作目标、方案讨论或随时插话拍板（Cmd/Ctrl + Enter 发送）…"
                      value={composerText}
                      onChange={(e) => setComposerText(e.target.value)}
                      onKeyDown={(e) => {
                        if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                          e.preventDefault();
                          void handleSendInLounge();
                        }
                      }}
                    />
                    <button
                      type="button"
                      className="dshfam-btn dshfam-btn-primary"
                      disabled={!composerText.trim() || enabledMembers.length === 0}
                      onClick={() => void handleSendInLounge()}
                      style={{ height: 40, padding: '0 16px' }}
                    >
                      发送群消息
                    </button>
                  </div>
                </div>
              </>
            ) : activeMember ? (
              <>
                <div className="dshfam-stage-head">
                  <div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span style={{ fontSize: 16 }}>{activeMember.avatar}</span>
                      <span style={{ fontSize: 14.5, fontWeight: 700 }}>{activeMember.name}</span>
                      <span className="dshfam-mono-tag">@{activeMember.id}</span>
                      <span className="dshfam-mono-tag">身体: {activeMember.body.kind}</span>
                    </div>
                    <div style={{ fontSize: 11.5, opacity: 0.68, marginTop: 2 }}>
                      {activeMemberSnapshot?.statusText || activeMember.specialty}
                    </div>
                  </div>

                  <div style={{ display: 'flex', gap: 6 }}>
                    <button
                      type="button"
                      className="dshfam-btn"
                      onClick={() => openEditForm(activeMember)}
                    >
                      编辑灵魂
                    </button>
                    <button
                      type="button"
                      className="dshfam-btn"
                      onClick={() =>
                        void familyClientApi.resetSession(selectedScopeId, activeMember.id)
                      }
                    >
                      🔄 重置身体
                    </button>
                    {(activeMemberSnapshot?.state === 'working' ||
                      activeMemberSnapshot?.state === 'in_call') && (
                      <button
                        type="button"
                        className="dshfam-btn dshfam-btn-danger"
                        onClick={() =>
                          void familyClientApi.interrupt({
                            scopeId: selectedScopeId,
                            memberId: activeMember.id,
                          })
                        }
                      >
                        ⏹ 中断
                      </button>
                    )}
                  </div>
                </div>

                <div className="dshfam-feed">
                  {(activeMemberSnapshot?.entries ?? []).length === 0 ? (
                    <div style={{ opacity: 0.62, fontSize: 13, margin: 'auto', textAlign: 'center', maxWidth: 420 }}>
                      直接给 {activeMember.avatar} {activeMember.name} 交代工作吧！TA 会使用本机 `{activeMember.body.kind}` 身体独立完成，需要其他家人配合时也会自己掏随身手机联系对方。
                    </div>
                  ) : (
                    (activeMemberSnapshot?.entries ?? []).map((entry) => {
                      const isHuman = entry.role === 'human';
                      return (
                        <div key={entry.id} className="dshfam-bubble" data-mine={String(isHuman)}>
                          <div className="dshfam-bubble-meta">
                            <span>{entry.authorName}</span>
                            {entry.statusSummary && (
                              <span className="dshfam-mono-tag">{entry.statusSummary}</span>
                            )}
                            {entry.streaming && <span style={{ color: 'var(--fam-accent)' }}>● 输出中</span>}
                          </div>
                          <div>{entry.content || (entry.streaming ? '思考中…' : '')}</div>
                        </div>
                      );
                    })
                  )}
                </div>

                <div className="dshfam-composer">
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: 11.5 }}>
                    <label style={{ display: 'inline-flex', alignItems: 'center', gap: 5, cursor: 'pointer', opacity: 0.8 }}>
                      <input
                        type="checkbox"
                        checked={sendFresh}
                        onChange={(e) => setSendFresh(e.target.checked)}
                      />
                      本条任务开启全新身体上下文（不延续此前对话）
                    </label>
                  </div>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
                    <textarea
                      className="dshfam-textarea"
                      placeholder={`交代给 ${activeMember.name} (@${activeMember.id}) 的工作（Cmd/Ctrl + Enter 发送）…`}
                      value={composerText}
                      onChange={(e) => setComposerText(e.target.value)}
                      onKeyDown={(e) => {
                        if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                          e.preventDefault();
                          void handleSendInLounge();
                        }
                      }}
                    />
                    <button
                      type="button"
                      className="dshfam-btn dshfam-btn-primary"
                      disabled={!composerText.trim() || sending}
                      onClick={() => void handleSendInLounge()}
                      style={{ height: 40, padding: '0 16px' }}
                    >
                      派发任务
                    </button>
                  </div>
                </div>
              </>
            ) : (
              <div style={{ margin: 'auto', opacity: 0.6, fontSize: 13 }}>
                请在左侧选择「家庭总群」或任意家庭成员开始协作
              </div>
            )}
          </section>

          {/* 右栏：随身家庭手机通话动态墙 */}
          <aside className="dshfam-phone-rail">
            <div className="dshfam-section-head">
              <span>📞 家庭手机通话实况</span>
              <span>{state.callRecords.length}</span>
            </div>

            {state.callRecords.length === 0 ? (
              <div style={{ fontSize: 12, opacity: 0.58, lineHeight: 1.5, padding: '8px 4px' }}>
                当家庭成员在干活途中主动拨打 `phone_call` 请教、协作或拒绝不合理要求时，通话记录会实时出现在这里。
              </div>
            ) : (
              [...state.callRecords].reverse().map((call) => (
                <div key={call.id} className="dshfam-call-card">
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontWeight: 700 }}>
                    <span>
                      {call.fromMemberName} ➔ {call.toMemberName}
                    </span>
                    <span className="dshfam-mono-tag">{call.status}</span>
                  </div>
                  <div style={{ opacity: 0.78 }}>诉求：{call.message.slice(0, 110)}</div>
                  {call.reply && (
                    <div
                      style={{
                        paddingTop: 5,
                        borderTop: '1px dashed var(--fam-border)',
                        opacity: 0.92,
                      }}
                    >
                      回应：{call.reply.slice(0, 140)}
                      {call.reply.length > 140 ? '…' : ''}
                    </div>
                  )}
                </div>
              ))
            )}
          </aside>
        </div>
      ) : (
        /* 页签 2：成员与灵魂工坊 */
        <div className="dshfam-studio">
          {/* 本机四大 CLI 身体体检舱 */}
          <div>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
              <div>
                <div style={{ fontSize: 14, fontWeight: 700 }}>本机 CLI「身体」体检舱</div>
                <div style={{ fontSize: 12, opacity: 0.68 }}>
                  一具身体可孕育任意多个不同灵魂的家庭成员；记忆与操作权限均遵循各 CLI 自身意志
                </div>
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <button type="button" className="dshfam-btn" disabled={probing} onClick={() => void handleReprobe()}>
                  {probing ? '体检中…' : '🔄 重新检测本机 CLI'}
                </button>
                <button type="button" className="dshfam-btn" onClick={() => void handleSeedFamily()}>
                  ✨ 补齐预设家庭成员
                </button>
                <button type="button" className="dshfam-btn dshfam-btn-primary" onClick={() => openCreateForm()}>
                  + 创造新家庭成员
                </button>
              </div>
            </div>

            <div className="dshfam-body-grid">
              {state.bodies.map((body) => (
                <div key={body.kind} className="dshfam-body-card">
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                    <span style={{ fontWeight: 700, fontSize: 13 }}>{body.label}</span>
                    <span
                      className="dshfam-dot"
                      data-state={body.available ? 'working' : 'sleeping'}
                      title={body.available ? '可用' : '未就绪'}
                    />
                  </div>
                  <div className="dshfam-mono-tag" style={{ alignSelf: 'flex-start' }}>
                    {body.kind} · {body.available ? '已就绪' : '未检测到'}
                  </div>
                  <div style={{ fontSize: 11, opacity: 0.65, wordBreak: 'break-all' }}>
                    {body.note || body.executablePath || ''}
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* 新建 / 编辑成员灵魂表单 */}
          {formOpen && (
            <form
              onSubmit={(e) => void handleSaveMember(e)}
              style={{
                padding: 16,
                borderRadius: 12,
                border: '1px solid var(--fam-accent)',
                background: 'var(--fam-surface)',
                display: 'flex',
                flexDirection: 'column',
                gap: 12,
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <div style={{ fontSize: 14, fontWeight: 700 }}>
                  {editingMemberId ? `编辑成员灵魂 (@${editingMemberId})` : '赋予新成员「身体 + 灵魂」'}
                </div>
                {!editingMemberId && state.templates.length > 0 && (
                  <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
                    <span style={{ fontSize: 11.5, opacity: 0.65 }}>套用灵感模板：</span>
                    {state.templates.map((tpl) => (
                      <button
                        key={tpl.id}
                        type="button"
                        className="dshfam-chip"
                        onClick={() => openCreateForm(tpl)}
                      >
                        {tpl.avatar} {tpl.name}
                      </button>
                    ))}
                  </div>
                )}
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10 }}>
                <div>
                  <label style={{ fontSize: 11.5, fontWeight: 600 }}>唯一代号 ID（英文小写/连字符）</label>
                  <input
                    className="dshfam-input"
                    disabled={Boolean(editingMemberId)}
                    placeholder="如 fe-sis、sec-guard"
                    value={formId}
                    onChange={(e) => setFormId(e.target.value)}
                    required
                  />
                </div>
                <div>
                  <label style={{ fontSize: 11.5, fontWeight: 600 }}>家庭称呼</label>
                  <input
                    className="dshfam-input"
                    placeholder="如 前端妹妹"
                    value={formName}
                    onChange={(e) => setFormName(e.target.value)}
                    required
                  />
                </div>
                <div>
                  <label style={{ fontSize: 11.5, fontWeight: 600 }}>选择身体（CLI）</label>
                  <select
                    className="dshfam-select"
                    value={formBodyKind}
                    onChange={(e) => setFormBodyKind(e.target.value as BodyKind)}
                  >
                    {BODY_KINDS.map((k) => (
                      <option key={k} value={k}>
                        {k}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '240px 1fr', gap: 10 }}>
                <div>
                  <label style={{ fontSize: 11.5, fontWeight: 600 }}>头像标识</label>
                  <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginTop: 4 }}>
                    {AVATAR_PRESETS.map((emoji) => (
                      <button
                        key={emoji}
                        type="button"
                        className="dshfam-chip"
                        style={
                          formAvatar === emoji
                            ? { borderColor: 'var(--fam-accent)', background: 'var(--fam-accent-soft)' }
                            : undefined
                        }
                        onClick={() => setFormAvatar(emoji)}
                      >
                        {emoji}
                      </button>
                    ))}
                  </div>
                </div>
                <div>
                  <label style={{ fontSize: 11.5, fontWeight: 600 }}>
                    一句话专长职责（展示在家庭名册与手机通讯录中，供同伴选人协作）
                  </label>
                  <input
                    className="dshfam-input"
                    placeholder="如：负责 Vue3 组件设计、响应式交互与前端类型把关"
                    value={formSpecialty}
                    onChange={(e) => setFormSpecialty(e.target.value)}
                    required
                  />
                </div>
              </div>

              <div>
                <label style={{ fontSize: 11.5, fontWeight: 600 }}>
                  灵魂提示词（Soul Prompt：决定 TA 的性格、专业原则、何时主动找人商量、何时拒绝越界要求）
                </label>
                <textarea
                  className="dshfam-textarea"
                  style={{ minHeight: 120 }}
                  placeholder="描述这位家庭成员的人格、工作习惯与底线原则…"
                  value={formSoulPrompt}
                  onChange={(e) => setFormSoulPrompt(e.target.value)}
                  required
                />
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                <div>
                  <label style={{ fontSize: 11, opacity: 0.72 }}>
                    自定义 CLI 命令路径（可选，留空自动探测本机安装）
                  </label>
                  <input
                    className="dshfam-input"
                    placeholder="留空默认自动查找"
                    value={formCommand}
                    onChange={(e) => setFormCommand(e.target.value)}
                  />
                </div>
                <div>
                  <label style={{ fontSize: 11, opacity: 0.72 }}>
                    原生附加启动参数（可选，空格分隔，留空继承 CLI 自身默认配置）
                  </label>
                  <input
                    className="dshfam-input"
                    placeholder="如 --model sonnet（可留空）"
                    value={formExtraArgs}
                    onChange={(e) => setFormExtraArgs(e.target.value)}
                  />
                </div>
              </div>

              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
                <button type="button" className="dshfam-btn" onClick={() => setFormOpen(false)}>
                  取消
                </button>
                <button type="submit" className="dshfam-btn dshfam-btn-primary">
                  保存家庭成员
                </button>
              </div>
            </form>
          )}

          {/* 在册家庭成员网格 */}
          <div className="dshfam-member-grid">
            {state.members.map((member) => (
              <div
                key={member.id}
                className="dshfam-member-card"
                style={!member.enabled ? { opacity: 0.58 } : undefined}
              >
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
                    <span className="dshfam-avatar">{member.avatar}</span>
                    <div>
                      <div style={{ fontWeight: 700, fontSize: 14 }}>{member.name}</div>
                      <div style={{ display: 'flex', gap: 5, marginTop: 2 }}>
                        <span className="dshfam-mono-tag">@{member.id}</span>
                        <span className="dshfam-mono-tag">身体: {member.body.kind}</span>
                      </div>
                    </div>
                  </div>

                  <button
                    type="button"
                    className="dshfam-chip"
                    onClick={() =>
                      void familyClientApi
                        .updateMember(member.id, { enabled: !member.enabled })
                        .then(() => refresh())
                    }
                  >
                    {member.enabled ? '🟢 在岗' : '⏸ 休假'}
                  </button>
                </div>

                <div style={{ fontSize: 12.5, fontWeight: 600 }}>{member.specialty}</div>
                <div
                  style={{
                    fontSize: 12,
                    opacity: 0.75,
                    whiteSpace: 'pre-wrap',
                    maxHeight: 88,
                    overflow: 'hidden',
                  }}
                >
                  {member.soulPrompt}
                </div>

                <div style={{ display: 'flex', gap: 6, marginTop: 'auto', paddingTop: 6 }}>
                  <button
                    type="button"
                    className="dshfam-btn dshfam-btn-primary"
                    onClick={() => {
                      setTarget({ kind: 'member', memberId: member.id });
                      setActiveTab('lounge');
                    }}
                  >
                    去客厅派活
                  </button>
                  <button type="button" className="dshfam-btn" onClick={() => openEditForm(member)}>
                    编辑
                  </button>
                  <button
                    type="button"
                    className="dshfam-btn dshfam-btn-danger"
                    onClick={() =>
                      void familyClientApi.deleteMember(member.id).then(() => refresh())
                    }
                  >
                    移除
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
