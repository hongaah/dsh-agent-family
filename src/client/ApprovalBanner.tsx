import React, { useState } from 'react';

import type { PendingApproval } from '../core/types.ts';
import { familyClientApi, familyLiveStore } from './api.ts';
import { MemberAvatar } from './MemberAvatar.tsx';

export interface ApprovalBannerProps {
  readonly approvals: readonly PendingApproval[];
  readonly compact?: boolean;
}

/**
 * 「成员举手请求批示」原样确认横幅：
 * 完全透传各 CLI 自己给出的审批标题、详情与选项按钮，不做任何外层语义篡改。
 */
export function ApprovalBanner({
  approvals,
  compact = false,
}: ApprovalBannerProps): React.ReactElement | null {
  const [submittingId, setSubmittingId] = useState<string | null>(null);

  if (approvals.length === 0) return null;

  const handleChoose = async (approvalId: string, optionId: string) => {
    setSubmittingId(approvalId);
    try {
      const res = await familyClientApi.replyApproval(approvalId, optionId);
      familyLiveStore.patchState((prev) => ({
        ...prev,
        pendingApprovals: res.pendingApprovals,
      }));
    } finally {
      setSubmittingId(null);
    }
  };

  return (
    <div
      className="dshfam-approval-banner"
      style={compact ? { margin: '4px 0', padding: '8px 11px' } : undefined}
    >
      {approvals.map((item) => (
        <div
          key={item.approvalId}
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 6,
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              fontSize: 12.5,
              fontWeight: 700,
            }}
          >
            <MemberAvatar
              avatar={item.memberAvatar}
              bodyKind={item.bodyKind}
              alt={item.memberName}
              size={22}
            />
            <span>
              {item.memberName} <span className="dshfam-mono-tag">{item.bodyKind}</span> 请求你的批示：
              {item.title}
            </span>
          </div>

          {!compact && item.detail && (
            <pre
              style={{
                margin: 0,
                padding: '6px 8px',
                borderRadius: 6,
                background: 'rgba(0,0,0,0.12)',
                fontSize: 11,
                maxHeight: 110,
                overflow: 'auto',
                fontFamily: 'var(--fam-font-mono)',
              }}
            >
              {item.detail}
            </pre>
          )}

          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {item.options.map((opt) => {
              const isDeny = opt.kind === 'deny';
              return (
                <button
                  key={opt.optionId}
                  type="button"
                  disabled={submittingId === item.approvalId}
                  onClick={() => void handleChoose(item.approvalId, opt.optionId)}
                  className={`dshfam-btn ${isDeny ? 'dshfam-btn-danger' : 'dshfam-btn-primary'}`}
                  style={{ padding: '4px 10px', fontSize: 12 }}
                >
                  {opt.label}
                </button>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
