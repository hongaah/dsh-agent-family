import React, { useEffect, useState } from 'react';

import { ApprovalBanner } from './ApprovalBanner.tsx';
import { useFamilyLiveState } from './api.ts';
import { FamilyToolCard } from './FamilyToolCard.tsx';
import { FamilyWorkbench, type SessionSummaryOption } from './FamilyWorkbench.tsx';
import { ensureFamilyStyles } from './styles.ts';

export const name = 'dsh-agent-family';
export const PANEL_ID = 'dsh-agent-family';
export const LOCALE_NS = 'dshAgentFamily';

export const inject = ['slots', 'locale', 'sessions'];

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
  return Object.values(byId).map((item) => ({
    id: item.id,
    title: item.displayTitle || item.id,
    cwd: item.cwd,
  }));
}

function ComposerFamilyQuickBar({
  sessionId,
  onOpenPanel,
}: {
  readonly sessionId: string;
  readonly onOpenPanel: () => void;
}): React.ReactElement {
  const { state } = useFamilyLiveState(sessionId);
  const enabledCount = state.members.filter((m) => m.enabled).length;
  const approvals = state.pendingApprovals;

  return (
    <div style={{ display: 'inline-flex', flexDirection: 'column', gap: 4 }}>
      {approvals.length > 0 && <ApprovalBanner approvals={approvals} compact />}
      <button
        type="button"
        onClick={onOpenPanel}
        className="dshfam-chip"
        title="打开智能体家庭客厅与成员工坊（输入 @成员ID 可直接点名）"
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 5,
          padding: '3px 9px',
          fontSize: 12,
          ...(approvals.length > 0
            ? { borderColor: '#d97706', color: '#d97706', fontWeight: 700 }
            : {}),
        }}
      >
        <span>🏠 家庭 ({enabledCount})</span>
        {approvals.length > 0 && <span>· 🙋 {approvals.length} 待批示</span>}
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
        当前已登记 {state.members.length} 位家庭成员，本机已就绪{' '}
        {state.bodies.filter((b) => b.available).length} 具 CLI 身体。所有成员大脑记忆与操作审批均遵循对应 CLI 自身意志。
      </div>
      <div>
        <button type="button" className="dshfam-btn dshfam-btn-primary" onClick={onOpenPanel}>
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

  const openFamilyPanel = () => {
    layoutRef?.selectPanel(PANEL_ID);
  };

  const backToConversation = () => {
    layoutRef?.selectPanel(null);
  };

  function ConnectedWorkbench(): React.ReactElement {
    const [sessions, setSessions] = useState<SessionSummaryOption[]>(() => readSessionsList(ctx));

    useEffect(() => {
      const listSource = ctx.sessions?.list;
      if (!listSource) return;
      const sync = () => setSessions(readSessionsList(ctx));
      sync();
      return listSource.subscribe(sync);
    }, []);

    return <FamilyWorkbench sessions={sessions} onBackToConversation={backToConversation} />;
  }

  // 1. 左侧栏一级常驻入口 + 主工作区面板
  ctx.slots.inject('main', () =>
    ctx.slots.register(
      {
        name: 'main',
        key: PANEL_ID,
        locale: LOCALE_NS,
      },
      ConnectedWorkbench
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

  // 2. 主聊天输入框旁家庭快捷入口 + 实时「成员举手请求批示」内联提醒
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
        return <ComposerFamilyQuickBar sessionId={props.sessionId} onOpenPanel={openFamilyPanel} />;
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
            onOpenWorkbench={openFamilyPanel}
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
        owner.view === 'summary' ? null : <FamilySettingsSummary onOpenPanel={openFamilyPanel} />
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
      () => <FamilySettingsSummary onOpenPanel={openFamilyPanel} />
    )
  );
}
