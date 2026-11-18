import React, { useEffect, useMemo, useState } from 'react';

import type { FamilyFocusTarget } from '../core/types.ts';
import { ApprovalBanner } from './ApprovalBanner.tsx';
import { familyLiveStore, useFamilyLiveState } from './api.ts';
import { FamilyToolCard } from './FamilyToolCard.tsx';
import {
  type FamilyNavigationOrder,
  FamilyWorkbench,
  type SessionSummaryOption,
} from './FamilyWorkbench.tsx';
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
  openTab(
    kind: string,
    options?: {
      readonly destination?: 'sidebar' | 'float';
      readonly params?: Record<string, unknown>;
    }
  ): void;
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
  onOpenForSession,
}: {
  readonly sessionId: string;
  readonly onOpenForSession: (sessionId: string, target: FamilyFocusTarget) => void;
}): React.ReactElement {
  const { state } = useFamilyLiveState(sessionId);

  useEffect(() => {
    navBridge.setExternalSession(sessionId);
  }, [sessionId]);

  const enabledCount = state.members.filter((m) => m.enabled).length;
  const scopedApprovals = useMemo(
    () => state.pendingApprovals.filter((a) => a.scopeId === sessionId),
    [state.pendingApprovals, sessionId]
  );

  const { isSessionActive, activeLabel, totalUnread } = useMemo(() => {
    const rooms = state.rooms.filter((r) => r.scopeId === sessionId);
    const snaps = state.snapshots.filter((s) => s.scopeId === sessionId);

    const runningRoom = rooms.find((r) => r.running);
    const activeSnap = snaps.find(
      (s) => s.state === 'working' || s.state === 'in_call' || s.state === 'awaiting_approval'
    );
    const activeMemberName = activeSnap
      ? state.members.find((m) => m.id === activeSnap.memberId)?.name ?? activeSnap.memberId
      : '';

    const unreadRooms = rooms.reduce((sum, r) => sum + (r.unreadCount ?? 0), 0);
    const unreadMembers = snaps.reduce((sum, s) => sum + (s.unreadCount ?? 0), 0);

    return {
      isSessionActive: Boolean(runningRoom || activeSnap),
      activeLabel: runningRoom
        ? runningRoom.activeSpeakerId
          ? `${state.members.find((m) => m.id === runningRoom.activeSpeakerId)?.name ?? runningRoom.activeSpeakerId}发言中`
          : '群聊进行中'
        : activeMemberName
          ? `${activeMemberName}执行中`
          : '',
      totalUnread: unreadRooms + unreadMembers,
    };
  }, [state.rooms, state.snapshots, state.members, sessionId]);

  return (
    <div style={{ display: 'inline-flex', flexDirection: 'column', gap: 4 }}>
      {scopedApprovals.length > 0 && <ApprovalBanner approvals={scopedApprovals} compact />}
      <button
        type="button"
        onClick={() => onOpenForSession(sessionId, { kind: 'group', groupId: 'family-main' })}
        className="dshfam-chip"
        title="在当前会话旁打开智能体家庭群聊（也可在输入框敲 /family 或 /成员ID 直接指派）"
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
              : {}),
        }}
      >
        {isSessionActive ? <span className="dshfam-live-green-dot" /> : <span>🏠</span>}
        <span>
          {isSessionActive && activeLabel ? `家庭 · ${activeLabel}` : `家庭 (${enabledCount})`}
        </span>
        {totalUnread > 0 && <span className="sh-unread-badge">{totalUnread}</span>}
        {scopedApprovals.length > 0 && <span>· 🙋 {scopedApprovals.length} 待批示</span>}
      </button>
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

  // 2. 主聊天输入框旁家庭状态胶囊（活跃呼吸绿点 + 未读数角标 + 点击同屏展开当前会话群聊）
  ctx.slots.inject('conversation.input.left', () =>
    ctx.slots.register(
      {
        name: 'conversation.input.left',
        id: 'dsh-agent-family-composer-bar',
        order: 25,
        locale: LOCALE_NS,
      },
      (props: { readonly sessionId?: string }) => {
        if (!props.sessionId) return null;
        return (
          <ComposerFamilyQuickBar
            sessionId={props.sessionId}
            onOpenForSession={openFamilyForConversation}
          />
        );
      }
    )
  );

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
