import React from 'react';

import type { BodyKind } from '../core/types.ts';
import { MemberAvatar } from './MemberAvatar.tsx';

export interface FamilyToolCardProps {
  readonly sessionId: string;
  readonly toolName: string;
  readonly block: Record<string, unknown>;
  readonly onOpenWorkbench: () => void;
}

function asBodyKind(val: unknown): BodyKind | undefined {
  return val === 'claude' || val === 'codex' || val === 'opencode' || val === 'dsh'
    ? val
    : undefined;
}

export function FamilyToolCard({
  toolName,
  block,
  onOpenWorkbench,
}: FamilyToolCardProps): React.ReactElement {
  const settled = 'kind' in block || 'isError' in block || 'meta' in block;
  const isError = Boolean(block.isError);
  const meta = (
    block.meta && typeof block.meta === 'object' ? block.meta : null
  ) as Record<string, unknown> | null;

  if (!settled) {
    return (
      <div className="dshfam-toolcard">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
          <span style={{ fontSize: 12.5, fontWeight: 600 }}>
            智能体家庭成员正在自主推进任务 ({toolName === 'family_group_discuss' ? '群聊会商中' : '并发执行中'})…
          </span>
          <button
            type="button"
            className="dshfam-btn"
            onClick={onOpenWorkbench}
            style={{ fontSize: 11.5, padding: '3px 9px' }}
          >
            进入家庭客厅看实况
          </button>
        </div>
      </div>
    );
  }

  if (isError) {
    return (
      <div className="dshfam-toolcard" style={{ borderColor: 'rgba(239,68,68,0.4)' }}>
        <div style={{ fontSize: 12.5, color: '#ef4444', fontWeight: 600 }}>
          智能体家庭调度遇到异常 ({toolName})
        </div>
      </div>
    );
  }

  if (toolName === 'family_group_discuss' && meta) {
    const title = typeof meta.title === 'string' ? meta.title : '家庭群聊';
    const messages = Array.isArray(meta.newMessages) ? meta.newMessages : [];
    return (
      <div className="dshfam-toolcard">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span style={{ fontSize: 13, fontWeight: 700 }}>
            {title} · 讨论结果 ({messages.length} 条发言)
          </span>
          <button
            type="button"
            className="dshfam-btn"
            onClick={onOpenWorkbench}
            style={{ fontSize: 11.5, padding: '3px 9px' }}
          >
            打开群聊室
          </button>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {messages.map((raw, idx) => {
            const m = raw as Record<string, unknown>;
            return (
              <div
                key={String(m.id ?? idx)}
                style={{
                  padding: '7px 10px',
                  borderRadius: 8,
                  background: 'rgba(128,128,128,0.07)',
                  fontSize: 12.5,
                }}
              >
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                    fontWeight: 700,
                    fontSize: 11.5,
                    marginBottom: 4,
                  }}
                >
                  <MemberAvatar
                    avatar={typeof m.senderAvatar === 'string' ? m.senderAvatar : undefined}
                    alt={String(m.senderName ?? '')}
                    size={20}
                  />
                  <span>
                    {String(m.senderName ?? '')} (@{String(m.senderId ?? '')})
                  </span>
                </div>
                <div style={{ whiteSpace: 'pre-wrap' }}>{String(m.content ?? '')}</div>
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  const results = meta && Array.isArray(meta.results) ? meta.results : [];
  return (
    <div className="dshfam-toolcard">
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span style={{ fontSize: 13, fontWeight: 700 }}>
          智能体家庭任务回执（共 {results.length} 位成员交付）
        </span>
        <button
          type="button"
          className="dshfam-btn"
          onClick={onOpenWorkbench}
          style={{ fontSize: 11.5, padding: '3px 9px' }}
        >
          打开家庭客厅
        </button>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
        {results.map((raw, idx) => {
          const item = raw as Record<string, unknown>;
          const calls = Array.isArray(item.phoneCalls) ? item.phoneCalls : [];
          return (
            <div
              key={String(item.memberId ?? idx)}
              style={{
                padding: '8px 10px',
                borderRadius: 8,
                background: 'rgba(128,128,128,0.07)',
                fontSize: 12.5,
              }}
            >
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  fontWeight: 700,
                  marginBottom: 4,
                }}
              >
                <MemberAvatar
                  avatar={typeof item.avatar === 'string' ? item.avatar : undefined}
                  bodyKind={asBodyKind(item.bodyKind)}
                  alt={String(item.memberName ?? item.memberId)}
                  size={20}
                />
                <span>{String(item.memberName ?? item.memberId)}</span>
                <span className="dshfam-mono-tag">@{String(item.memberId ?? '')}</span>
                <span className="dshfam-mono-tag">{String(item.bodyKind ?? '')}</span>
                {calls.length > 0 && (
                  <span style={{ fontSize: 11, opacity: 0.75 }}>拨打了 {calls.length} 通协作电话</span>
                )}
              </div>
              {item.error ? (
                <div style={{ color: '#ef4444' }}>执行异常：{String(item.error)}</div>
              ) : (
                <div style={{ whiteSpace: 'pre-wrap' }}>
                  {String(item.finalText ?? '').slice(0, 600)}
                  {String(item.finalText ?? '').length > 600 ? '…' : ''}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
