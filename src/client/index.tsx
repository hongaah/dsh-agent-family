import React, { useEffect, useMemo, useState } from 'react';

import type { FamilyFocusTarget } from '../core/types.ts';
import { ApprovalBanner } from './ApprovalBanner.tsx';
import {
  deriveSessionFamilyActivity,
  familyLiveStore,
  getPendingMainSyncForSession,
  useFamilyGlobalState,
  useFamilyLiveState,
} from './api.ts';
import { FamilyToolCard } from './FamilyToolCard.tsx';
import {
  type FamilyNavigationOrder,
  FamilyWorkbench,
  type SessionSummaryOption,
} from './FamilyWorkbench.tsx';
import {
  FileReferenceHighlightChip,
  MemberMentionPill,
} from './MemberHoverChip.tsx';
import { ensureFamilyStyles } from './styles.ts';

export const name = 'dsh-agent-family';
export const PANEL_ID = 'dsh-agent-family';
export const RIGHT_TAB_ID = 'dsh-agent-family/tab';
export const RIGHT_TAB_KIND = 'agent-family';
export const LOCALE_NS = 'dshAgentFamily';

export const inject = ['slots', 'locale', 'sessions'];

interface SidebarRightTabInfo {
  readonly tab: {
    readonly id: string;
    readonly visible?: boolean;
    readonly navigation?: {
      readonly params?: Record<string, unknown>;
      readonly revision?: number;
    };
  };
  readonly panel: {
    readonly id: string;
    readonly isFloating?: boolean;
  };
}

interface SidebarRightService {
  readonly mounted?: {
    getSnapshot(): string | undefined;
    subscribe(fn: () => void): () => void;
  };
  openResource?(address: string): void;
  openTab(
    kind: string,
    options?: {
      readonly destination?: 'sidebar' | 'float';
      readonly params?: Record<string, unknown>;
    }
  ): void;
}

interface DshConversationInputActions {
  setDraft?(text: string): void;
  persistDraft?(): void;
}

interface BetterSidebarOptionalService {
  openTab?(spec: {
    readonly type: string;
    readonly title: string;
    readonly path: string;
    readonly id: string;
    readonly line?: number;
  }): void;
}

interface SidebarRightTabsRegistry {
  register(definition: {
    readonly id: string;
    readonly kind: string;
    readonly title: () => string;
    readonly keepMounted?: boolean;
    readonly guide?: ReadonlyArray<{
      readonly id: string;
      readonly order: number;
      readonly title: () => string;
      readonly description: () => string;
      readonly icon: unknown;
    }>;
  }): () => void;
}

interface DshInputTriggersService {
  registerSource(source: {
    readonly trigger: string;
    readonly name: string;
    readonly showGroupTitle?: boolean;
    candidates(
      session: { readonly sessionId: string },
      req: {
        readonly query: string;
        readonly quoted?: boolean;
        readonly drilled?: boolean;
        readonly signal: AbortSignal;
      }
    ): Promise<
      ReadonlyArray<{
        readonly name: string;
        readonly label?: string;
        readonly description?: string;
        readonly icon?: string;
        readonly section?: string;
        readonly value: string;
      }>
    >;
    onPick(event: {
      readonly candidate: { readonly value?: string };
      readonly action: string;
    }):
      | {
          readonly insert: {
            readonly source: string;
            readonly ref: string;
            readonly label: string;
            readonly appearance: 'session' | 'file' | 'folder';
            readonly clipboardText: string;
          };
        }
      | undefined;
    openReference?(
      session: { readonly sessionId: string },
      ref: { readonly ref: string; readonly appearance?: string }
    ): boolean;
    readonly codec: {
      clipboardText(ref: string): string;
      serialize(ref: string): Promise<string>;
    };
  }): () => void;
}

interface DshUiConversationService {
  readonly userText?: {
    register(rule: {
      readonly id: string;
      readonly order: number;
      match(
        text: string,
        from: number
      ):
        | {
            readonly id: string;
            readonly start: number;
            readonly end: number;
            readonly data: Record<string, unknown>;
          }
        | undefined;
    }): () => void;
  };
}

interface ClientRuntimeContext {
  readonly locale: {
    register(ns: string, dicts: Record<string, Record<string, string>>): () => void;
    bind(ns: string): (key: string) => string;
  };
  readonly slots: {
    inject(
      slotName: string,
      callback: () => (() => void) | Generator<() => void, void, unknown>
    ): () => void;
    register(options: Record<string, unknown>, component: unknown): () => void;
  };
  readonly sessions?: {
    readonly list?: {
      getSnapshot(): {
        readonly byId: Record<
          string,
          { readonly id: string; readonly cwd?: string; readonly displayTitle?: string }
        >;
      };
      subscribe(fn: () => void): () => void;
    };
  };
  readonly layout?: {
    selectPanel(id: string | null): void;
    readonly panelInfo?: {
      getSnapshot(): { readonly activePanelId: string | null };
    };
  };
  readonly sidebarRight?: SidebarRightService;
  readonly sidebarRightTabs?: SidebarRightTabsRegistry;
  readonly inputTriggers?: DshInputTriggersService;
  readonly uiConversation?: DshUiConversationService;
  get?(serviceName: string): unknown;
  inject(deps: readonly string[], callback: (scoped: ClientRuntimeContext) => void | (() => void)): () => void;
  effect(fn: () => (() => void) | Generator<() => void, void, unknown>, label?: string): () => void;
}

const zhDict: Record<string, string> = {
  panel: '智能体家庭',
  settingsNav: '智能体家庭',
};

const enDict: Record<string, string> = {
  panel: 'Agent Family',
  settingsNav: 'Agent Family',
};

class FamilyNavigationBridge {
  private lastExternalSessionId: string | undefined;
  private latestOrder: FamilyNavigationOrder | null = null;
  private seq = 0;
  private readonly listeners = new Set<() => void>();

  public setExternalSession(sessionId: string | undefined): void {
    if (sessionId && !sessionId.startsWith('family-')) {
      this.lastExternalSessionId = sessionId;
    }
  }

  public getExternalSession(): string | undefined {
    return this.lastExternalSessionId;
  }

  public getOrder(): FamilyNavigationOrder | null {
    return this.latestOrder;
  }

  public dispatch(scopeId: string, target: FamilyFocusTarget): FamilyNavigationOrder {
    if (scopeId && !scopeId.startsWith('family-')) {
      this.lastExternalSessionId = scopeId;
    }
    this.seq += 1;
    const order: FamilyNavigationOrder = {
      scopeId,
      target,
      seq: this.seq,
    };
    this.latestOrder = order;
    for (const l of this.listeners) {
      l();
    }
    return order;
  }

  public subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }
}

const navBridge = new FamilyNavigationBridge();

function encodeResourceSegment(seg: string): string {
  return encodeURIComponent(seg).replace(/%3A/giu, ':');
}

function buildDshSessionFileAddress(
  sessionId: string,
  cwd: string | undefined,
  rawPath: string
): string {
  const normalized = rawPath.replace(/\\/gu, '/').replace(/^(?:\.\/)+/u, '');
  const isAbs =
    normalized.startsWith('/') || /^[A-Za-z]:\//u.test(normalized) || normalized.startsWith('//');
  const root = cwd ? cwd.replace(/\\/gu, '/').replace(/\/+$/u, '') : '';
  let relOrAbs = normalized;
  if (isAbs && root && normalized.startsWith(`${root}/`)) {
    relOrAbs = normalized.slice(root.length + 1);
  }
  const encodedPath = relOrAbs.split('/').map(encodeResourceSegment).join('/');
  return `dsh-resource://file/session/${encodeResourceSegment(sessionId)}/${encodedPath}`;
}

function resolveWorkspaceAbsolutePath(cwd: string | undefined, filePath: string): string {
  const clean = filePath.replace(/\\/gu, '/');
  if (clean.startsWith('/') || /^[A-Za-z]:\//u.test(clean)) {
    return clean;
  }
  if (!cwd) return clean;
  return `${cwd.replace(/\\/gu, '/').replace(/\/+$/u, '')}/${clean.replace(/^(?:\.\/)+/u, '')}`;
}

function focusMainConversationEditorDom(sessionId: string): void {
  if (typeof document === 'undefined') return;
  const escaped =
    typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
      ? CSS.escape(sessionId)
      : sessionId.replace(/"/gu, '\\"');
  const scopeRoot =
    document.querySelector(`[data-conversation-session="${escaped}"]`) ?? document;
  const editable = scopeRoot.querySelector<HTMLElement>(
    '[contenteditable="true"], textarea'
  );
  if (!editable) return;
  editable.focus();
  if (editable.getAttribute('contenteditable') === 'true' && typeof window !== 'undefined') {
    try {
      const sel = window.getSelection();
      if (sel) {
        const range = document.createRange();
        range.selectNodeContents(editable);
        range.collapse(false);
        sel.removeAllRanges();
        sel.addRange(range);
      }
    } catch {
      // ignore selection error
    }
  }
}

class MainConversationComposerBridge {
  private readonly actionsBySession = new Map<string, DshConversationInputActions>();
  private readonly pendingDraftBySession = new Map<string, string>();

  public bind(sessionId: string, actions?: DshConversationInputActions): () => void {
    if (!sessionId || !actions) return () => undefined;
    this.actionsBySession.set(sessionId, actions);
    const queued = this.pendingDraftBySession.get(sessionId);
    if (queued !== undefined) {
      this.pendingDraftBySession.delete(sessionId);
      this.applyDraftNow(sessionId, actions, queued);
    }
    return () => {
      if (this.actionsBySession.get(sessionId) === actions) {
        this.actionsBySession.delete(sessionId);
      }
    };
  }

  public prefillAndFocus(sessionId: string, text: string): void {
    const actions = this.actionsBySession.get(sessionId);
    if (actions?.setDraft) {
      this.applyDraftNow(sessionId, actions, text);
      return;
    }
    this.pendingDraftBySession.set(sessionId, text);
    void navigator.clipboard?.writeText(text).catch(() => undefined);
  }

  private applyDraftNow(
    sessionId: string,
    actions: DshConversationInputActions,
    text: string
  ): void {
    try {
      actions.setDraft?.(text);
      actions.persistDraft?.();
      if (typeof requestAnimationFrame === 'function') {
        requestAnimationFrame(() => focusMainConversationEditorDom(sessionId));
      } else {
        focusMainConversationEditorDom(sessionId);
      }
    } catch {
      void navigator.clipboard?.writeText(text).catch(() => undefined);
    }
  }
}

const mainComposerBridge = new MainConversationComposerBridge();

function FamilySidebarIcon({ size = 16 }: { readonly size?: number }): React.ReactElement {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="6.5" r="2.6" stroke="currentColor" strokeWidth="1.8" />
      <circle cx="5.5" cy="11" r="2.1" stroke="currentColor" strokeWidth="1.7" />
      <circle cx="18.5" cy="11" r="2.1" stroke="currentColor" strokeWidth="1.7" />
      <path
        d="M7.8 18.5c0-2.3 1.9-4.1 4.2-4.1s4.2 1.8 4.2 4.1"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
      <path
        d="M2.5 19c0-1.8 1.3-3.2 3-3.2.8 0 1.5.3 2 .8"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
      <path
        d="M21.5 19c0-1.8-1.3-3.2-3-3.2-.8 0-1.5.3-2 .8"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </svg>
  );
}

function readSessionsList(ctx: ClientRuntimeContext): SessionSummaryOption[] {
  const byId = ctx.sessions?.list?.getSnapshot()?.byId ?? {};
  return Object.values(byId)
    .filter((item) => !item.id.startsWith('family-'))
    .map((item) => ({
      id: item.id,
      title: item.displayTitle || item.id,
      cwd: item.cwd,
    }));
}

function parseNavParamsToTarget(params?: Record<string, unknown>): FamilyFocusTarget {
  if (params?.kind === 'member' && typeof params.memberId === 'string' && params.memberId) {
    return { kind: 'member', memberId: params.memberId };
  }
  const groupId =
    typeof params?.groupId === 'string' && params.groupId ? params.groupId : 'family-main';
  return { kind: 'group', groupId };
}

function ComposerFamilyQuickBar({
  sessionId,
  inputActions,
  onOpenForSession,
  onOpenReceiptFile,
}: {
  readonly sessionId: string;
  readonly inputActions?: DshConversationInputActions;
  readonly onOpenForSession: (sessionId: string, target: FamilyFocusTarget) => void;
  readonly onOpenReceiptFile: (sessionId: string, receiptPath: string) => void;
}): React.ReactElement {
  const { state } = useFamilyLiveState(sessionId);

  useEffect(() => {
    navBridge.setExternalSession(sessionId);
  }, [sessionId]);

  useEffect(() => {
    return mainComposerBridge.bind(sessionId, inputActions);
  }, [sessionId, inputActions]);

  const enabledCount = state.members.filter((m) => m.enabled).length;
  const scopedApprovals = useMemo(
    () => state.pendingApprovals.filter((a) => a.scopeId === sessionId),
    [state.pendingApprovals, sessionId]
  );

  const activity = useMemo(
    () => deriveSessionFamilyActivity(state, sessionId),
    [state, sessionId]
  );
  const pendingSync = useMemo(
    () => getPendingMainSyncForSession(state, sessionId),
    [state, sessionId]
  );
  const pendingFileCount = pendingSync?.changedFiles.length ?? 0;
  const pendingNoteCount = pendingSync?.noteCount ?? 0;
  const latestReceiptPath = pendingSync?.latestReceiptPath;
  const isSessionActive = activity.kind === 'active' || activity.kind === 'approval';

  const chipTitle =
    pendingFileCount > 0
      ? `家庭成员已修改 ${pendingFileCount} 个文件 — 下次发消息将静默同步纪要文件索引并开启防覆盖重读守卫（不污染提问气泡）`
      : '在当前会话旁打开智能体家庭群聊（也可在输入框敲 @成员名称 或 /family 直接指派）';

  const receiptChipLabel =
    pendingFileCount > 0
      ? `协作纪要 · 改${pendingFileCount}文件`
      : pendingNoteCount > 0
        ? `协作纪要 · ${pendingNoteCount}条`
        : '最新协作纪要.md';

  return (
    <div style={{ display: 'inline-flex', flexDirection: 'column', gap: 4 }}>
      {scopedApprovals.length > 0 && <ApprovalBanner approvals={scopedApprovals} compact />}
      <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
        <button
          type="button"
          onClick={() => onOpenForSession(sessionId, { kind: 'group', groupId: 'family-main' })}
          className="dshfam-chip"
          title={chipTitle}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            padding: '3px 10px',
            fontSize: 12,
            ...(scopedApprovals.length > 0
              ? { borderColor: '#d97706', color: '#d97706', fontWeight: 600 }
              : isSessionActive
                ? { borderColor: 'rgba(16, 185, 129, 0.5)', fontWeight: 600 }
                : pendingFileCount > 0
                  ? { borderColor: 'rgba(59, 130, 246, 0.45)' }
                  : {}),
          }}
        >
          {activity.kind === 'active' ? <span className="dshfam-live-green-dot" /> : <span>🏠</span>}
          <span>
            {activity.kind === 'active' && activity.shortLabel
              ? `家庭 · ${activity.shortLabel}`
              : `家庭 (${enabledCount})`}
          </span>
          {activity.totalUnread > 0 && (
            <span className="sh-unread-badge">{activity.totalUnread}</span>
          )}
          {scopedApprovals.length > 0 && <span>· 🙋 {scopedApprovals.length} 待批示</span>}
        </button>

        {latestReceiptPath && (
          <FileReferenceHighlightChip
            label={receiptChipLabel}
            fullPath={`点击在 DSH 右侧栏预览家庭协作纪要：${latestReceiptPath}`}
            onOpen={() => onOpenReceiptFile(sessionId, latestReceiptPath)}
          />
        )}
      </div>
    </div>
  );
}

/**
 * 左侧对话列表每一行的行首状态点（挂载到 DSH 原生 `sidebar.session.row.leading`）。
 * 当该会话下的家庭成员正在发言/执行、等待批示或有未读消息时，在侧边栏对话标题前同步亮起状态标识。
 */
function SessionRowFamilyLeadingMark({
  sessionId,
}: {
  readonly sessionId?: string;
}): React.ReactElement | null {
  const state = useFamilyGlobalState();
  const activity = useMemo(
    () => (sessionId ? deriveSessionFamilyActivity(state, sessionId) : null),
    [state, sessionId]
  );

  if (!activity || activity.kind === 'idle') {
    return null;
  }

  const dotColor = activity.kind === 'approval' ? '#f59e0b' : '#10b981';
  const isPulsing = activity.kind === 'active' || activity.kind === 'approval';

  return (
    <span
      role="img"
      aria-label={activity.detailLabel}
      title={activity.detailLabel}
      onClick={(e) => e.stopPropagation()}
      style={{
        width: 14,
        height: 14,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0,
      }}
    >
      <span
        style={{
          width: 7,
          height: 7,
          borderRadius: 999,
          background: dotColor,
          boxShadow: isPulsing
            ? `0 0 0 3px ${activity.kind === 'approval' ? 'rgba(245, 158, 11, 0.24)' : 'rgba(16, 185, 129, 0.22)'}`
            : 'none',
          animation: isPulsing ? 'sh-pulse 1.4s ease-in-out infinite' : 'none',
        }}
      />
    </span>
  );
}

/**
 * 左侧对话列表每一行的行尾轻量标签（挂载到 DSH 原生 `sidebar.session.row.trailing`）。
 * 展示如「小前端发言中」「待批示」或未读计数徽章。
 */
function SessionRowFamilyTrailingBadge({
  sessionId,
}: {
  readonly sessionId?: string;
}): React.ReactElement | null {
  const state = useFamilyGlobalState();
  const activity = useMemo(
    () => (sessionId ? deriveSessionFamilyActivity(state, sessionId) : null),
    [state, sessionId]
  );

  if (!activity || activity.kind === 'idle') {
    return null;
  }

  if (activity.kind === 'unread') {
    return (
      <span
        className="sh-unread-badge"
        title={activity.detailLabel}
        style={{ height: 16, minWidth: 16, fontSize: 10 }}
      >
        {activity.totalUnread}
      </span>
    );
  }

  const isApproval = activity.kind === 'approval';
  return (
    <span
      title={activity.detailLabel}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        height: 17,
        padding: '0 6px',
        borderRadius: 999,
        fontSize: 10.5,
        fontWeight: 600,
        lineHeight: '17px',
        whiteSpace: 'nowrap',
        maxWidth: 88,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        color: isApproval ? '#f59e0b' : '#10b981',
        background: isApproval ? 'rgba(245, 158, 11, 0.14)' : 'rgba(16, 185, 129, 0.14)',
      }}
    >
      {activity.shortLabel}
    </span>
  );
}

/**
 * 左侧对话列表悬停卡片详情行（挂载到 DSH 原生 `sidebar.session.row.hover`）。
 */
function SessionRowFamilyHoverStatus({
  sessionId,
}: {
  readonly sessionId?: string;
}): React.ReactElement | null {
  const state = useFamilyGlobalState();
  const activity = useMemo(
    () => (sessionId ? deriveSessionFamilyActivity(state, sessionId) : null),
    [state, sessionId]
  );

  if (!activity || activity.kind === 'idle') {
    return null;
  }

  const dotColor = activity.kind === 'approval' ? '#f59e0b' : '#10b981';
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 7,
        fontSize: 12,
        lineHeight: '18px',
        color: 'var(--dsw-alias-hovercard-label-secondary, #a1a1aa)',
      }}
    >
      <span
        style={{
          width: 7,
          height: 7,
          borderRadius: 999,
          background: dotColor,
          flexShrink: 0,
        }}
      />
      <span>🏠 {activity.detailLabel}</span>
    </div>
  );
}

function FamilySettingsSummary({
  onOpenPanel,
}: {
  readonly onOpenPanel: () => void;
}): React.ReactElement {
  const { state } = useFamilyLiveState('default');
  return (
    <div className="dshfam-toolcard" style={{ padding: 16 }}>
      <div style={{ fontSize: 14, fontWeight: 700 }}>智能体家庭 (dsh-agent-family)</div>
      <div style={{ fontSize: 12.5, opacity: 0.78, lineHeight: 1.55 }}>
        当前已登记 {state.members.length} 位家庭成员。在任意对话中输入 <code>/family</code> 或{' '}
        <code>/成员ID</code> 即可主动指派，点击输入框旁「家庭」按钮可在对话右侧并排开启群聊。
      </div>
      <div>
        <button type="button" className="sh-btn sh-btn-primary" onClick={onOpenPanel}>
          打开「智能体家庭」工作台管理成员与群聊
        </button>
      </div>
    </div>
  );
}

export function apply(ctx: ClientRuntimeContext): void {
  ctx.effect(() => ensureFamilyStyles(), 'dsh-agent-family: styles');
  ctx.effect(
    () => ctx.locale.register(LOCALE_NS, { zh: zhDict, en: enDict }),
    'dsh-agent-family: locale'
  );
  const t = ctx.locale.bind(LOCALE_NS);

  let layoutRef: ClientRuntimeContext['layout'];
  let sidebarRightRef: SidebarRightService | undefined;

  ctx.inject(['layout'], (scoped) => {
    layoutRef = scoped.layout;
    scoped.effect(
      () => () => {
        if (layoutRef?.panelInfo?.getSnapshot().activePanelId === PANEL_ID) {
          layoutRef.selectPanel(null);
        }
        layoutRef = undefined;
      },
      'dsh-agent-family: layout-cleanup'
    );
  });

  const openFullscreenFamily = (scopeId?: string, target?: FamilyFocusTarget) => {
    const resolvedScope = scopeId ?? navBridge.getExternalSession() ?? readSessionsList(ctx)[0]?.id ?? 'default';
    navBridge.dispatch(resolvedScope, target ?? { kind: 'group', groupId: 'family-main' });
    layoutRef?.selectPanel(PANEL_ID);
  };

  const openFamilyForConversation = (
    sessionId: string,
    target: FamilyFocusTarget = { kind: 'group', groupId: 'family-main' }
  ) => {
    navBridge.dispatch(sessionId, target);
    if (sidebarRightRef) {
      try {
        sidebarRightRef.openTab(RIGHT_TAB_KIND, {
          destination: 'sidebar',
          params:
            target.kind === 'member'
              ? { kind: 'member', memberId: target.memberId }
              : { kind: 'group', groupId: target.groupId },
        });
        return;
      } catch {
        // 若当前布局不支持右侧栏打开则平滑回退到全屏工作台并自动同步 sessionId
      }
    }
    layoutRef?.selectPanel(PANEL_ID);
  };

  const backToConversation = () => {
    layoutRef?.selectPanel(null);
  };

  const openWorkspaceFileInHost = (
    scopeId: string,
    cwd: string | undefined,
    filePath: string,
    line?: number
  ) => {
    const effectiveScopeId =
      scopeId !== 'default'
        ? scopeId
        : (navBridge.getExternalSession() ?? readSessionsList(ctx)[0]?.id ?? 'default');
    const sessionCwd =
      cwd ?? ctx.sessions?.list?.getSnapshot()?.byId?.[effectiveScopeId]?.cwd;
    const absPath = resolveWorkspaceAbsolutePath(sessionCwd, filePath);

    // 若当前处于全屏家庭面板，先切回对话视图以便右侧原生文件预览栏立即可见
    if (
      effectiveScopeId !== 'default' &&
      layoutRef?.panelInfo?.getSnapshot().activePanelId === PANEL_ID
    ) {
      layoutRef.selectPanel(null);
    }

    // 1. 仅当明确指定行号且安装了 betterSidebar 源码编辑器时，支持精准跳到指定行
    if (line !== undefined && typeof ctx.get === 'function') {
      try {
        const bs = ctx.get('betterSidebar') as BetterSidebarOptionalService | undefined;
        if (bs && typeof bs.openTab === 'function') {
          const slashIdx = absPath.lastIndexOf('/');
          const title = slashIdx === -1 ? absPath : absPath.slice(slashIdx + 1);
          bs.openTab({
            type: 'editor',
            title,
            path: absPath,
            id: `editor:${absPath}`,
            line,
          });
          return;
        }
      } catch {
        // fallback to native openResource
      }
    }

    // 2. 统一优先复用 DSH 宿主原生的文件预览机制 (`ctx.sidebarRight.openResource`)：
    // 原生支持 Markdown、代码、PNG/JPG/WebP/GIF 图片、PDF、HTML、Excel/Word/PPT 预览，无需重复造轮子
    if (
      sidebarRightRef &&
      typeof sidebarRightRef.openResource === 'function' &&
      effectiveScopeId !== 'default'
    ) {
      try {
        const uri = buildDshSessionFileAddress(effectiveScopeId, sessionCwd, filePath);
        sidebarRightRef.openResource(uri);
        return;
      } catch {
        // fallback below
      }
    }

    if (typeof ctx.get === 'function') {
      try {
        const bs = ctx.get('betterSidebar') as BetterSidebarOptionalService | undefined;
        if (bs && typeof bs.openTab === 'function') {
          const slashIdx = absPath.lastIndexOf('/');
          const title = slashIdx === -1 ? absPath : absPath.slice(slashIdx + 1);
          bs.openTab({
            type: 'editor',
            title,
            path: absPath,
            id: `editor:${absPath}`,
            ...(line !== undefined ? { line } : {}),
          });
        }
      } catch {
        // ignore in standalone preview
      }
    }
  };

  const handoffToMainConversation = (scopeId: string, prefillText: string) => {
    if (layoutRef?.panelInfo?.getSnapshot().activePanelId === PANEL_ID) {
      layoutRef.selectPanel(null);
    }
    mainComposerBridge.prefillAndFocus(scopeId, prefillText);
  };

  // 监听宿主 `/` 斜杠命令触发的 focus_requested 事件，自动滑开当前对话右侧的家庭分栏
  ctx.effect(
    () =>
      familyLiveStore.subscribeFocus((scopeId, target) => {
        navBridge.dispatch(scopeId, target);
        const onScreenSession = sidebarRightRef?.mounted?.getSnapshot();
        if (sidebarRightRef && (!onScreenSession || onScreenSession === scopeId)) {
          try {
            sidebarRightRef.openTab(RIGHT_TAB_KIND, {
              destination: 'sidebar',
              params:
                target.kind === 'member'
                  ? { kind: 'member', memberId: target.memberId }
                  : { kind: 'group', groupId: target.groupId },
            });
          } catch {
            // ignore if session not currently on screen
          }
        }
      }),
    'dsh-agent-family: slash-focus-listener'
  );

  // 全屏工作台组件：自动同步外部最近活跃会话与目标群聊
  function ConnectedFullscreenWorkbench(): React.ReactElement {
    const [sessions, setSessions] = useState<SessionSummaryOption[]>(() => readSessionsList(ctx));
    const [navOrder, setNavOrder] = useState<FamilyNavigationOrder | null>(() => {
      const existing = navBridge.getOrder();
      if (existing) return existing;
      const ext = navBridge.getExternalSession();
      return ext
        ? { scopeId: ext, target: { kind: 'group', groupId: 'family-main' }, seq: 1 }
        : null;
    });

    useEffect(() => {
      const listSource = ctx.sessions?.list;
      if (!listSource) return;
      const sync = () => setSessions(readSessionsList(ctx));
      sync();
      return listSource.subscribe(sync);
    }, []);

    useEffect(() => {
      return navBridge.subscribe(() => {
        setNavOrder(navBridge.getOrder());
      });
    }, []);

    return (
      <FamilyWorkbench
        mode="fullscreen"
        sessions={sessions}
        navigationOrder={navOrder}
        onBackToConversation={backToConversation}
        onOpenWorkspaceFile={openWorkspaceFileInHost}
        onHandoffToMainSession={handoffToMainConversation}
      />
    );
  }

  // 右侧同屏分栏 Tab 正文组件：天然一对一锁定宿主会话 sessionId
  function ConnectedSplitTabBody(props: {
    readonly sessionId: string;
    readonly useTabInfo: () => SidebarRightTabInfo;
  }): React.ReactElement {
    const { tab } = props.useTabInfo();
    const [sessions, setSessions] = useState<SessionSummaryOption[]>(() => readSessionsList(ctx));
    const [navOrder, setNavOrder] = useState<FamilyNavigationOrder | null>(() => {
      const existing = navBridge.getOrder();
      if (existing?.scopeId === props.sessionId) return existing;
      return {
        scopeId: props.sessionId,
        target: parseNavParamsToTarget(tab.navigation?.params),
        seq: tab.navigation?.revision ?? 1,
      };
    });

    useEffect(() => {
      navBridge.setExternalSession(props.sessionId);
    }, [props.sessionId]);

    useEffect(() => {
      if (!tab.navigation?.revision) return;
      setNavOrder({
        scopeId: props.sessionId,
        target: parseNavParamsToTarget(tab.navigation.params),
        seq: 10000 + tab.navigation.revision,
      });
    }, [props.sessionId, tab.navigation?.revision, tab.navigation?.params]);

    useEffect(() => {
      return navBridge.subscribe(() => {
        const latest = navBridge.getOrder();
        if (latest?.scopeId === props.sessionId) {
          setNavOrder(latest);
        }
      });
    }, [props.sessionId]);

    useEffect(() => {
      const listSource = ctx.sessions?.list;
      if (!listSource) return;
      const sync = () => setSessions(readSessionsList(ctx));
      sync();
      return listSource.subscribe(sync);
    }, []);

    return (
      <FamilyWorkbench
        mode="split"
        lockedScopeId={props.sessionId}
        isVisible={tab.visible !== false}
        sessions={sessions}
        navigationOrder={navOrder}
        onBackToConversation={backToConversation}
        onExpandFullscreen={(scopeId, currentTarget) => openFullscreenFamily(scopeId, currentTarget)}
        onOpenWorkspaceFile={openWorkspaceFileInHost}
        onHandoffToMainSession={handoffToMainConversation}
      />
    );
  }

  // 0. 注册 DSH 原生右侧同屏停靠栏 Tab (`@deepseek-ai/dsh-client-ui-sidebar-right`)
  ctx.inject(['sidebarRightTabs', 'sidebarRight'], (scoped) => {
    sidebarRightRef = scoped.sidebarRight;
    const mountedSource = scoped.sidebarRight?.mounted;
    if (mountedSource) {
      scoped.effect(() => {
        const syncMounted = () => {
          const current = mountedSource.getSnapshot();
          if (current) navBridge.setExternalSession(current);
        };
        syncMounted();
        return mountedSource.subscribe(syncMounted);
      }, 'dsh-agent-family: track-mounted-session');
    }

    scoped.effect(
      () =>
        scoped.sidebarRightTabs!.register({
          id: RIGHT_TAB_ID,
          kind: RIGHT_TAB_KIND,
          title: () => t('panel'),
          keepMounted: true,
          guide: [
            {
              id: 'agent-family',
              order: 35,
              title: () => t('panel'),
              description: () => '在当前对话右侧同屏开启家庭群聊与成员协作',
              icon: FamilySidebarIcon,
            },
          ],
        }),
      'dsh-agent-family: right-tab-type'
    );

    scoped.effect(
      () =>
        scoped.slots.inject('sidebar.right.pane.tab', () =>
          scoped.slots.register(
            {
              name: 'sidebar.right.pane.tab',
              key: RIGHT_TAB_ID,
              locale: LOCALE_NS,
            },
            ConnectedSplitTabBody
          )
        ),
      'dsh-agent-family: right-tab-body'
    );

    scoped.effect(
      () => () => {
        sidebarRightRef = undefined;
      },
      'dsh-agent-family: right-sidebar-cleanup'
    );
  });

  // 1. 左侧栏一级常驻入口 + 全屏主工作区面板
  ctx.slots.inject('main', () =>
    ctx.slots.register(
      {
        name: 'main',
        key: PANEL_ID,
        locale: LOCALE_NS,
      },
      ConnectedFullscreenWorkbench
    )
  );

  ctx.slots.inject('sidebar.panellist', () =>
    ctx.slots.register(
      {
        name: 'sidebar.panellist',
        id: PANEL_ID,
        order: 6,
        label: () => t('panel'),
        locale: LOCALE_NS,
      },
      (owner: { readonly size?: number } = {}) => <FamilySidebarIcon size={owner.size ?? 16} />
    )
  );

  // 2. 主聊天输入框旁家庭状态胶囊 + 左侧会话列表行级实时状态标识（leading 呼吸绿点 + trailing 状态胶囊 + hover 详情）
  ctx.slots.inject('sidebar.session.row.leading', () =>
    ctx.slots.register(
      {
        name: 'sidebar.session.row.leading',
        id: 'dsh-agent-family-row-leading',
        order: 5,
        locale: LOCALE_NS,
      },
      SessionRowFamilyLeadingMark
    )
  );

  ctx.slots.inject('sidebar.session.row.trailing', () =>
    ctx.slots.register(
      {
        name: 'sidebar.session.row.trailing',
        id: 'dsh-agent-family-row-trailing',
        order: 5,
        locale: LOCALE_NS,
      },
      SessionRowFamilyTrailingBadge
    )
  );

  ctx.slots.inject('sidebar.session.row.hover', () =>
    ctx.slots.register(
      {
        name: 'sidebar.session.row.hover',
        id: 'dsh-agent-family-row-hover',
        order: 5,
        locale: LOCALE_NS,
      },
      SessionRowFamilyHoverStatus
    )
  );

  ctx.slots.inject('conversation.input.left', () =>
    ctx.slots.register(
      {
        name: 'conversation.input.left',
        id: 'dsh-agent-family-composer-bar',
        order: 25,
        locale: LOCALE_NS,
      },
      (props: {
        readonly sessionId?: string;
        readonly inputActions?: DshConversationInputActions;
      }) => {
        if (!props.sessionId) return null;
        return (
          <ComposerFamilyQuickBar
            sessionId={props.sessionId}
            inputActions={props.inputActions}
            onOpenForSession={openFamilyForConversation}
            onOpenReceiptFile={(sid, receiptPath) =>
              openWorkspaceFileInHost(sid, undefined, receiptPath)
            }
          />
        );
      }
    )
  );

  // 2.5 注册外部 DSH 主对话输入框 `@` 家庭成员补全与已发送消息 `@名称` 高亮悬浮名片
  ctx.inject(['inputTriggers', 'uiConversation'], (scoped) => {
    const triggers = scoped.inputTriggers;
    const uiConv = scoped.uiConversation;

    function DshSentMemberMentionNode(props: {
      readonly sessionId?: string;
      readonly node: { readonly data?: Record<string, unknown> };
    }): React.ReactElement {
      const globalState = useFamilyGlobalState();
      const memberId = String(props.node.data?.memberId ?? '');
      const found = globalState.members.find((m) => m.id === memberId);
      return (
        <MemberMentionPill
          member={found}
          fallbackId={memberId}
          onClick={() => {
            if (props.sessionId && memberId) {
              openFamilyForConversation(props.sessionId, {
                kind: 'member',
                memberId,
              });
            }
          }}
        />
      );
    }

    if (uiConv?.userText) {
      scoped.effect(
        () =>
          uiConv.userText!.register({
            id: 'dsh-family-member',
            order: 15,
            match(text: string, from: number) {
              const members = familyLiveStore.getState().members;
              if (members.length === 0) return undefined;
              let best:
                | {
                    readonly id: string;
                    readonly start: number;
                    readonly end: number;
                    readonly data: Record<string, unknown>;
                  }
                | undefined;

              for (const m of members) {
                for (const token of [`@${m.id}`, `@${m.name}`]) {
                  let searchPos = from;
                  while (searchPos < text.length) {
                    const idx = text.indexOf(token, searchPos);
                    if (idx === -1) break;
                    const beforeChar = idx > 0 ? text[idx - 1] ?? '' : '';
                    const afterChar = text[idx + token.length] ?? '';
                    const validBefore = idx === 0 || /[\s,;:!?，。；：！？(（]/u.test(beforeChar);
                    const validAfter =
                      token === `@${m.name}` ||
                      !afterChar ||
                      !/[a-z0-9-]/iu.test(afterChar);
                    if (validBefore && validAfter) {
                      if (
                        !best ||
                        idx < best.start ||
                        (idx === best.start && token.length > best.end - best.start)
                      ) {
                        best = {
                          id: 'dsh-family-member',
                          start: idx,
                          end: idx + token.length,
                          data: { memberId: m.id, memberName: m.name },
                        };
                      }
                      break;
                    }
                    searchPos = idx + 1;
                  }
                }
              }
              return best;
            },
          }),
        'dsh-agent-family: usertext-member-rule'
      );

      scoped.effect(
        () =>
          scoped.slots.inject('conversation.user.text.node', () =>
            scoped.slots.register(
              {
                name: 'conversation.user.text.node',
                key: 'dsh-family-member',
                priority: 100,
                locale: LOCALE_NS,
              },
              DshSentMemberMentionNode
            )
          ),
        'dsh-agent-family: usertext-member-node'
      );
    }

    if (triggers) {
      scoped.effect(
        () =>
          triggers.registerSource({
            trigger: '@',
            name: 'dsh-agent-family',
            showGroupTitle: false,
            async candidates(_session, { query, quoted }) {
              if (quoted) return [];
              await familyLiveStore.ensureBootstrapped();
              const enabled = familyLiveStore.getState().members.filter((m) => m.enabled);
              const q = query.trim().toLowerCase();
              return enabled
                .filter(
                  (m) =>
                    !q ||
                    m.name.toLowerCase().includes(q) ||
                    m.id.toLowerCase().includes(q) ||
                    m.specialty.toLowerCase().includes(q)
                )
                .map((m) => ({
                  name: m.name,
                  label: m.name,
                  description: `@${m.id} · ${m.body.kind} · ${m.specialty.slice(0, 26)}`,
                  icon: 'session',
                  section: '智能体家庭成员',
                  value: JSON.stringify({ id: m.id, name: m.name }),
                }));
            },
            onPick({ candidate }) {
              if (!candidate.value) return undefined;
              try {
                const parsed = JSON.parse(candidate.value) as { id?: string; name?: string };
                if (!parsed.id || !parsed.name) return undefined;
                return {
                  insert: {
                    source: 'dsh-agent-family',
                    ref: `@${parsed.id}`,
                    label: parsed.name,
                    appearance: 'session',
                    clipboardText: `@${parsed.id}`,
                  },
                };
              } catch {
                return undefined;
              }
            },
            openReference(session, { ref }) {
              const memberId = ref.replace(/^@/u, '').trim();
              if (!memberId) return false;
              openFamilyForConversation(session.sessionId, {
                kind: 'member',
                memberId,
              });
              return true;
            },
            codec: {
              clipboardText: (ref) => ref,
              serialize: (ref) => Promise.resolve(ref),
            },
          }),
        'dsh-agent-family: main-composer-at-trigger'
      );
    }
  });

  // 3. 对话流内嵌家庭任务与群聊结果卡片
  const familyToolNames = ['family_assign', 'family_group_discuss'] as const;
  ctx.slots.inject('tool.call.toolview', function* () {
    for (const toolKey of familyToolNames) {
      yield ctx.slots.register(
        {
          name: 'tool.call.toolview',
          key: toolKey,
          locale: LOCALE_NS,
        },
        (props: {
          readonly sessionId: string;
          readonly toolName: string;
          readonly block: Record<string, unknown>;
        }) => (
          <FamilyToolCard
            sessionId={props.sessionId}
            toolName={props.toolName}
            block={props.block}
            onOpenWorkbench={() =>
              openFamilyForConversation(props.sessionId, {
                kind: 'group',
                groupId: 'family-main',
              })
            }
          />
        )
      );
    }
  });

  // 4. 插件设置页与系统设置页入口
  ctx.slots.inject('plugins.bundle.config', () =>
    ctx.slots.register(
      {
        name: 'plugins.bundle.config',
        key: name,
        locale: LOCALE_NS,
      },
      (owner: { readonly view?: string } = {}) =>
        owner.view === 'summary' ? null : (
          <FamilySettingsSummary onOpenPanel={() => openFullscreenFamily()} />
        )
    )
  );

  ctx.slots.inject('settings.section.icon', () =>
    ctx.slots.register(
      {
        name: 'settings.section.icon',
        id: PANEL_ID,
      },
      (owner: { readonly size?: number } = {}) => <FamilySidebarIcon size={owner.size ?? 16} />
    )
  );

  ctx.slots.inject('settings.section', () =>
    ctx.slots.register(
      {
        name: 'settings.section',
        id: PANEL_ID,
        order: 86,
        label: () => t('settingsNav'),
        locale: LOCALE_NS,
      },
      () => <FamilySettingsSummary onOpenPanel={() => openFullscreenFamily()} />
    )
  );
}
