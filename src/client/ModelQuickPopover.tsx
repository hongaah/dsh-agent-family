import {
  Check,
  ChevronDown,
  Cpu,
  RefreshCw,
  Search,
  Shield,
  ShieldAlert,
  ShieldCheck,
  Zap,
} from 'lucide-react';
import React, { useEffect, useMemo, useRef, useState } from 'react';

import { PERMISSION_MODE_METAS } from '../core/permission-policy.ts';
import type {
  BodyKind,
  BodyModelCatalog,
  FamilyMember,
  PermissionMode,
} from '../core/types.ts';
import { familyClientApi } from './api.ts';
import { MemberAvatar } from './MemberAvatar.tsx';

export const EFFORT_PRESETS: ReadonlyArray<{
  readonly value: string;
  readonly shortLabel: string;
  readonly title: string;
}> = [
  { value: '', shortLabel: '默认', title: '跟随该 CLI 自身默认思考强度' },
  { value: 'low', shortLabel: '⚡ 极速', title: 'low：极速秒回，适合闲聊唠嗑与轻量修改' },
  { value: 'medium', shortLabel: '⚖️ 均衡', title: 'medium：速度与推理质量均衡' },
  { value: 'high', shortLabel: '🧠 深度', title: 'high：深度思考，适合复杂逻辑与代码审查' },
  { value: 'xhigh', shortLabel: '🔥 满血', title: 'xhigh：超深推理，耗时较长，适合疑难攻坚' },
];

const catalogMemoryCache = new Map<BodyKind, BodyModelCatalog>();

export function formatShortModelBadge(
  modelOrBody?: string | { readonly model?: string; readonly reasoningEffort?: string },
  effort?: string
): string {
  const model =
    typeof modelOrBody === 'object' && modelOrBody !== null
      ? modelOrBody.model
      : modelOrBody;
  const resolvedEffort =
    typeof modelOrBody === 'object' && modelOrBody !== null
      ? modelOrBody.reasoningEffort
      : effort;

  const shortModel = model
    ? model.includes('/')
      ? model.slice(model.indexOf('/') + 1)
      : model
    : 'CLI 默认';
  const trimmedModel = shortModel.length > 20 ? `${shortModel.slice(0, 19)}…` : shortModel;
  if (!resolvedEffort) return trimmedModel;
  const effortTag =
    resolvedEffort === 'low' || resolvedEffort === 'none' || resolvedEffort === 'minimal'
      ? '极速'
      : resolvedEffort === 'medium'
        ? '均衡'
        : resolvedEffort === 'high'
          ? '深度'
          : resolvedEffort;
  return `${trimmedModel} · ${effortTag}`;
}

export function useBodyModelCatalog(kind: BodyKind, active: boolean): {
  readonly catalog: BodyModelCatalog | null;
  readonly loading: boolean;
  readonly reload: () => Promise<void>;
} {
  const [catalog, setCatalog] = useState<BodyModelCatalog | null>(
    () => catalogMemoryCache.get(kind) ?? null
  );
  const [loading, setLoading] = useState<boolean>(false);

  useEffect(() => {
    const cached = catalogMemoryCache.get(kind);
    if (cached) {
      setCatalog(cached);
      return;
    }
    setCatalog(null);
    if (!active) return;

    let cancelled = false;
    setLoading(true);
    void familyClientApi
      .listBodyModels(kind, false)
      .then((res) => {
        catalogMemoryCache.set(kind, res.catalog);
        if (!cancelled) setCatalog(res.catalog);
      })
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [kind, active]);

  const reload = async () => {
    setLoading(true);
    try {
      const res = await familyClientApi.listBodyModels(kind, true);
      catalogMemoryCache.set(kind, res.catalog);
      setCatalog(res.catalog);
    } finally {
      setLoading(false);
    }
  };

  return { catalog, loading, reload };
}

interface MemberModelConfigBodyProps {
  readonly member: FamilyMember;
  readonly active: boolean;
  readonly onUpdated: () => void;
}

function MemberModelConfigBody({
  member,
  active,
  onUpdated,
}: MemberModelConfigBodyProps): React.ReactElement {
  const { catalog, loading, reload } = useBodyModelCatalog(member.body.kind, active);
  const [query, setQuery] = useState<string>('');
  const [saving, setSaving] = useState<boolean>(false);

  const currentModel = member.body.model ?? '';
  const currentEffort = member.body.reasoningEffort ?? '';
  const currentPerm: PermissionMode = member.body.permissionMode ?? 'ask';

  const availableEfforts = useMemo(() => {
    if (catalog && !catalog.supportsEffort) return [];
    const matchedModel = catalog?.models.find((m) => m.id === currentModel);
    const allowed = matchedModel?.supportedEfforts ?? catalog?.defaultEfforts ?? ['low', 'medium', 'high', 'xhigh'];
    return EFFORT_PRESETS.filter((p) => p.value === '' || allowed.includes(p.value));
  }, [catalog, currentModel]);

  const filteredModels = useMemo(() => {
    const list = catalog?.models ?? [];
    const q = query.trim().toLowerCase();
    if (!q) return list;
    return list.filter(
      (m) => m.id.toLowerCase().includes(q) || m.label.toLowerCase().includes(q)
    );
  }, [catalog, query]);

  const exactMatchExists = useMemo(() => {
    const q = query.trim();
    if (!q) return true;
    return (catalog?.models ?? []).some((m) => m.id === q);
  }, [catalog, query]);

  const applyPatch = async (
    nextModel: string | undefined,
    nextEffort: string | undefined,
    nextPermission: PermissionMode = currentPerm
  ) => {
    setSaving(true);
    try {
      await familyClientApi.updateMember(member.id, {
        body: {
          ...member.body,
          permissionMode: nextPermission,
          model: nextModel?.trim() || undefined,
          reasoningEffort: nextEffort?.trim() || undefined,
        },
      });
      onUpdated();
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {/* 权限自主模式（每次询问 / 自动模式 / 完全访问） */}
      <div>
        <div
          style={{
            fontSize: 11,
            fontWeight: 600,
            color: 'var(--sh-muted-fg)',
            marginBottom: 5,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}
        >
          <span>执行权限模式</span>
          {saving && <span style={{ fontSize: 10.5 }}>同步中…</span>}
        </div>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(3, 1fr)',
            gap: 4,
            padding: 3,
            borderRadius: 7,
            background: 'var(--sh-muted)',
          }}
        >
          {PERMISSION_MODE_METAS.map((pm) => {
            const selected = currentPerm === pm.value;
            return (
              <button
                key={pm.value}
                type="button"
                title={pm.description}
                disabled={saving}
                onClick={() => void applyPatch(currentModel, currentEffort, pm.value)}
                style={{
                  height: 26,
                  border: 'none',
                  borderRadius: 5,
                  fontSize: 11,
                  fontWeight: selected ? 600 : 500,
                  cursor: 'pointer',
                  background: selected ? 'var(--sh-card)' : 'transparent',
                  color: selected ? 'var(--sh-fg)' : 'var(--sh-muted-fg)',
                  boxShadow: selected ? 'var(--sh-shadow-sm)' : 'none',
                  whiteSpace: 'nowrap',
                }}
              >
                {pm.shortLabel}
              </button>
            );
          })}
        </div>
      </div>

      {/* 思考快慢档位一键切换 */}
      {availableEfforts.length > 1 && (
        <div>
          <div
            style={{
              fontSize: 11,
              fontWeight: 600,
              color: 'var(--sh-muted-fg)',
              marginBottom: 5,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
            }}
          >
            <span>思考快慢（Reasoning Effort）</span>
            {saving && <span style={{ fontSize: 10.5 }}>切换中…</span>}
          </div>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: `repeat(${availableEfforts.length}, 1fr)`,
              gap: 4,
              padding: 3,
              borderRadius: 7,
              background: 'var(--sh-muted)',
            }}
          >
            {availableEfforts.map((preset) => {
              const selected = currentEffort === preset.value;
              return (
                <button
                  key={preset.value || 'default'}
                  type="button"
                  title={preset.title}
                  disabled={saving}
                  onClick={() => void applyPatch(currentModel, preset.value)}
                  style={{
                    height: 25,
                    border: 'none',
                    borderRadius: 5,
                    fontSize: 11,
                    fontWeight: selected ? 600 : 500,
                    cursor: 'pointer',
                    background: selected ? 'var(--sh-card)' : 'transparent',
                    color: selected ? 'var(--sh-fg)' : 'var(--sh-muted-fg)',
                    boxShadow: selected ? 'var(--sh-shadow-sm)' : 'none',
                    whiteSpace: 'nowrap',
                    padding: '0 4px',
                  }}
                >
                  {preset.shortLabel}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* 模型搜索与刷新 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
        <div style={{ position: 'relative', flex: 1 }}>
          <Search
            size={12}
            style={{
              position: 'absolute',
              left: 8,
              top: '50%',
              transform: 'translateY(-50%)',
              color: 'var(--sh-muted-fg)',
            }}
          />
          <input
            className="sh-input"
            style={{ height: 28, paddingLeft: 26, fontSize: 12 }}
            placeholder="搜索模型，或输入自定义模型 ID…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && query.trim()) {
                e.preventDefault();
                void applyPatch(query.trim(), currentEffort);
                setQuery('');
              }
            }}
          />
        </div>
        <button
          type="button"
          className="sh-btn sh-btn-outline sh-btn-icon"
          style={{ width: 28, height: 28 }}
          disabled={loading}
          title="重新扫描本机 CLI 可用模型"
          onClick={() => void reload()}
        >
          <RefreshCw size={12} />
        </button>
      </div>

      {/* 可选模型列表 */}
      <div
        style={{
          maxHeight: 220,
          overflowY: 'auto',
          display: 'flex',
          flexDirection: 'column',
          gap: 2,
          margin: '0 -2px',
          padding: '0 2px',
        }}
      >
        <button
          type="button"
          className="sh-menu-item"
          data-highlighted={String(!currentModel)}
          onClick={() => void applyPatch('', currentEffort)}
          style={{ justifyContent: 'space-between', padding: '6px 8px' }}
        >
          <div style={{ minWidth: 0, textAlign: 'left' }}>
            <div style={{ fontSize: 12, fontWeight: !currentModel ? 600 : 500 }}>
              跟随 {member.body.kind} 默认模型
            </div>
            {catalog?.currentDefault && (
              <div
                style={{
                  fontSize: 10.5,
                  color: 'var(--sh-muted-fg)',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                当前默认: {catalog.currentDefault}
              </div>
            )}
          </div>
          {!currentModel && <Check size={13} style={{ flexShrink: 0 }} />}
        </button>

        {!exactMatchExists && query.trim() && (
          <button
            type="button"
            className="sh-menu-item"
            onClick={() => {
              const next = query.trim();
              setQuery('');
              void applyPatch(next, currentEffort);
            }}
            style={{ justifyContent: 'space-between', padding: '6px 8px' }}
          >
            <span style={{ fontSize: 12 }}>
              使用自定义模型 <code>{query.trim()}</code>
            </span>
            <Zap size={12} />
          </button>
        )}

        {loading && filteredModels.length === 0 ? (
          <div style={{ padding: '14px 8px', textAlign: 'center', fontSize: 11.5, color: 'var(--sh-muted-fg)' }}>
            正在读取 {member.body.kind} 模型列表…
          </div>
        ) : (
          filteredModels.map((item) => {
            const isSelected = currentModel === item.id;
            return (
              <button
                key={item.id}
                type="button"
                className="sh-menu-item"
                data-highlighted={String(isSelected)}
                onClick={() => void applyPatch(item.id, currentEffort)}
                style={{ justifyContent: 'space-between', padding: '6px 8px', gap: 6 }}
              >
                <div style={{ minWidth: 0, flex: 1, textAlign: 'left' }}>
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 5,
                      fontSize: 12,
                      fontWeight: isSelected ? 600 : 500,
                    }}
                  >
                    <span
                      style={{
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {item.id}
                    </span>
                    {item.isFast && (
                      <span
                        className="sh-badge"
                        style={{
                          height: 16,
                          padding: '0 5px',
                          fontSize: 10,
                          color: '#10b981',
                          borderColor: 'rgba(16, 185, 129, 0.35)',
                        }}
                      >
                        快
                      </span>
                    )}
                  </div>
                  {item.label && item.label !== item.id && (
                    <div
                      style={{
                        fontSize: 10.5,
                        color: 'var(--sh-muted-fg)',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {item.label}
                    </div>
                  )}
                </div>
                {isSelected && <Check size={13} style={{ flexShrink: 0 }} />}
              </button>
            );
          })
        )}
      </div>
    </div>
  );
}

export function MemberModelQuickPopover({
  member,
  onUpdated,
}: {
  readonly member: FamilyMember;
  readonly onUpdated: () => void;
}): React.ReactElement {
  const [open, setOpen] = useState<boolean>(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (ev: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(ev.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const badgeText = formatShortModelBadge(member.body.model, member.body.reasoningEffort);

  return (
    <div ref={wrapRef} style={{ position: 'relative', minWidth: 0 }}>
      <button
        type="button"
        className="sh-btn sh-btn-outline sh-btn-sm sh-model-pill-btn"
        title={`点击切换模型与思考快慢（当前：${badgeText}）`}
        onClick={() => setOpen((v) => !v)}
        style={{ height: 26, padding: '0 8px', fontSize: 11.5, gap: 5, maxWidth: 172 }}
      >
        <Cpu size={12} style={{ flexShrink: 0 }} />
        <span
          style={{
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            minWidth: 0,
          }}
        >
          {badgeText}
        </span>
        <ChevronDown size={11} style={{ opacity: 0.65, flexShrink: 0 }} />
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="切换成员模型与思考快慢"
          style={{
            position: 'absolute',
            right: 0,
            top: 'calc(100% + 6px)',
            width: 'min(326px, calc(100vw - 24px))',
            padding: 11,
            borderRadius: 10,
            border: '1px solid var(--sh-border)',
            background: 'var(--sh-popover)',
            color: 'var(--sh-popover-fg)',
            boxShadow: 'var(--sh-shadow-lg)',
            zIndex: 50,
          }}
        >
          <MemberModelConfigBody member={member} active={open} onUpdated={onUpdated} />
        </div>
      )}
    </div>
  );
}

export function GroupMembersModelPopover({
  members,
  onUpdated,
}: {
  readonly members: readonly FamilyMember[];
  readonly onUpdated: () => void;
}): React.ReactElement | null {
  const [open, setOpen] = useState<boolean>(false);
  const [selectedId, setSelectedId] = useState<string>(() => members[0]?.id ?? '');
  const wrapRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!members.some((m) => m.id === selectedId) && members[0]) {
      setSelectedId(members[0].id);
    }
  }, [members, selectedId]);

  useEffect(() => {
    if (!open) return;
    const onDown = (ev: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(ev.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  if (members.length === 0) return null;
  const currentMember = members.find((m) => m.id === selectedId) ?? members[0]!;

  return (
    <div ref={wrapRef} style={{ position: 'relative' }}>
      <button
        type="button"
        className="sh-btn sh-btn-outline sh-btn-sm"
        title="在群里直接给任意成员切换权限模式（询问/自动/完全访问）、模型与思考快慢"
        onClick={() => setOpen((v) => !v)}
        style={{ height: 28, gap: 5 }}
      >
        <Zap size={12} />
        <span>模型与权限</span>
        <ChevronDown size={11} style={{ opacity: 0.65 }} />
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="群成员模型与快慢配置"
          style={{
            position: 'absolute',
            right: 0,
            top: 'calc(100% + 6px)',
            width: 344,
            padding: 11,
            borderRadius: 10,
            border: '1px solid var(--sh-border)',
            background: 'var(--sh-popover)',
            color: 'var(--sh-popover-fg)',
            boxShadow: 'var(--sh-shadow-lg)',
            zIndex: 50,
            display: 'flex',
            flexDirection: 'column',
            gap: 10,
          }}
        >
          <div style={{ display: 'flex', gap: 5, overflowX: 'auto', paddingBottom: 2 }}>
            {members.map((m) => {
              const active = m.id === currentMember.id;
              return (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => setSelectedId(m.id)}
                  style={{
                    padding: '4px 8px',
                    borderRadius: 7,
                    border: `1px solid ${active ? 'var(--sh-fg)' : 'var(--sh-border)'}`,
                    background: active ? 'var(--sh-accent)' : 'transparent',
                    color: 'inherit',
                    cursor: 'pointer',
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 6,
                    fontSize: 11.5,
                    fontWeight: active ? 600 : 500,
                    flexShrink: 0,
                  }}
                >
                  <MemberAvatar avatar={m.avatar} bodyKind={m.body.kind} alt={m.name} size={16} />
                  <span>{m.name}</span>
                </button>
              );
            })}
          </div>

          <MemberModelConfigBody member={currentMember} active={open} onUpdated={onUpdated} />
        </div>
      )}
    </div>
  );
}

export function PermissionModeIcon({
  mode,
  size = 12,
}: {
  readonly mode: PermissionMode | undefined;
  readonly size?: number;
}): React.ReactElement {
  if (mode === 'full_access') {
    return <ShieldAlert size={size} style={{ color: '#f59e0b' }} />;
  }
  if (mode === 'auto') {
    return <ShieldCheck size={size} style={{ color: '#10b981' }} />;
  }
  return <Shield size={size} />;
}

export function MemberPermissionQuickPopover({
  member,
  onUpdated,
}: {
  readonly member: FamilyMember;
  readonly onUpdated: () => void;
}): React.ReactElement {
  const [open, setOpen] = useState<boolean>(false);
  const [saving, setSaving] = useState<boolean>(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const currentMode: PermissionMode = member.body.permissionMode ?? 'ask';

  useEffect(() => {
    if (!open) return;
    const onDown = (ev: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(ev.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const currentMeta =
    PERMISSION_MODE_METAS.find((m) => m.value === currentMode) ?? PERMISSION_MODE_METAS[0]!;

  const selectMode = async (next: PermissionMode) => {
    setSaving(true);
    try {
      await familyClientApi.updateMember(member.id, {
        body: {
          ...member.body,
          permissionMode: next,
        },
      });
      setOpen(false);
      onUpdated();
    } finally {
      setSaving(false);
    }
  };

  return (
    <div ref={wrapRef} style={{ position: 'relative' }}>
      <button
        type="button"
        className="sh-btn sh-btn-outline sh-btn-sm"
        title={`当前权限模式：${currentMeta.label} — ${currentMeta.description}`}
        onClick={() => setOpen((v) => !v)}
        style={{ height: 26, padding: '0 8px', fontSize: 11.5, gap: 5 }}
      >
        <PermissionModeIcon mode={currentMode} size={12} />
        <span>{currentMeta.shortLabel}</span>
        <ChevronDown size={11} style={{ opacity: 0.65 }} />
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="切换成员权限模式"
          style={{
            position: 'absolute',
            right: 0,
            top: 'calc(100% + 6px)',
            width: 296,
            padding: 6,
            borderRadius: 10,
            border: '1px solid var(--sh-border)',
            background: 'var(--sh-popover)',
            color: 'var(--sh-popover-fg)',
            boxShadow: 'var(--sh-shadow-lg)',
            zIndex: 50,
            display: 'flex',
            flexDirection: 'column',
            gap: 2,
          }}
        >
          {PERMISSION_MODE_METAS.map((pm) => {
            const active = pm.value === currentMode;
            return (
              <button
                key={pm.value}
                type="button"
                disabled={saving}
                className="sh-menu-item"
                data-highlighted={String(active)}
                onClick={() => void selectMode(pm.value)}
                style={{
                  alignItems: 'flex-start',
                  padding: '8px 9px',
                  gap: 8,
                }}
              >
                <div style={{ marginTop: 2 }}>
                  <PermissionModeIcon mode={pm.value} size={14} />
                </div>
                <div style={{ flex: 1, minWidth: 0, textAlign: 'left' }}>
                  <div style={{ fontSize: 12.5, fontWeight: active ? 600 : 500 }}>{pm.label}</div>
                  <div
                    style={{
                      fontSize: 11,
                      color: 'var(--sh-muted-fg)',
                      lineHeight: 1.45,
                      marginTop: 2,
                    }}
                  >
                    {pm.description}
                  </div>
                </div>
                {active && <Check size={13} style={{ marginTop: 2, flexShrink: 0 }} />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
