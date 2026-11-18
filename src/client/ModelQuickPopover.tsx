import { Check, ChevronDown, Cpu, RefreshCw, Search, Zap } from 'lucide-react';
import React, { useEffect, useMemo, useRef, useState } from 'react';

import type { BodyKind, BodyModelCatalog, FamilyMember } from '../core/types.ts';
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

export function formatShortModelBadge(model?: string, effort?: string): string {
  const shortModel = model
    ? model.includes('/')
      ? model.slice(model.indexOf('/') + 1)
      : model
    : 'CLI 默认';
  const trimmedModel = shortModel.length > 20 ? `${shortModel.slice(0, 19)}…` : shortModel;
  if (!effort) return trimmedModel;
  const effortTag =
    effort === 'low' || effort === 'none' || effort === 'minimal'
      ? '极速'
      : effort === 'medium'
        ? '均衡'
        : effort === 'high'
          ? '深度'
          : effort;
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

  const applyPatch = async (nextModel: string | undefined, nextEffort: string | undefined) => {
    setSaving(true);
    try {
      await familyClientApi.updateMember(member.id, {
        body: {
          ...member.body,
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
    <div ref={wrapRef} style={{ position: 'relative' }}>
      <button
        type="button"
        className="sh-btn sh-btn-outline sh-btn-sm"
        title="点击秒切该成员的 CLI 模型与思考快慢（支持会话内热切换）"
        onClick={() => setOpen((v) => !v)}
        style={{ height: 26, padding: '0 8px', fontSize: 11.5, gap: 5 }}
      >
        <Cpu size={12} />
        <span>{badgeText}</span>
        <ChevronDown size={11} style={{ opacity: 0.65 }} />
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="切换成员模型与思考快慢"
          style={{
            position: 'absolute',
            right: 0,
            top: 'calc(100% + 6px)',
            width: 326,
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
        title="在群里直接给任意成员切换更快的模型或思考档位"
        onClick={() => setOpen((v) => !v)}
        style={{ height: 28, gap: 5 }}
      >
        <Zap size={12} />
        <span>模型与快慢</span>
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
