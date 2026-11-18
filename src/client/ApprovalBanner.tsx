import { Send, Zap } from 'lucide-react';
import React, { useState } from 'react';

import type { PendingApproval } from '../core/types.ts';
import { familyClientApi, familyLiveStore } from './api.ts';
import { MemberAvatar } from './MemberAvatar.tsx';

export interface ApprovalBannerProps {
  readonly approvals: readonly PendingApproval[];
  readonly compact?: boolean;
}

/**
 * 「成员举手请求批示 / 向你提问 (AskUser)」横幅：
 * - 支持一键允许/拒绝；
 * - 对常规命令提供「允许并设为自动模式」快捷升级；
 * - 对 AskUser 提问支持快捷选项点击 + 自由文本输入回答。
 */
export function ApprovalBanner({
  approvals,
  compact = false,
}: ApprovalBannerProps): React.ReactElement | null {
  const [submittingId, setSubmittingId] = useState<string | null>(null);
  const [customInputs, setCustomInputs] = useState<Record<string, string>>({});

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

  const handleAllowAndSwitchAuto = async (item: PendingApproval, allowOptionId: string) => {
    setSubmittingId(item.approvalId);
    try {
      const currentMember = familyLiveStore
        .getState()
        .members.find((m) => m.id === item.memberId);
      if (currentMember) {
        await familyClientApi.updateMember(currentMember.id, {
          body: {
            ...currentMember.body,
            permissionMode: 'auto',
          },
        });
      }
      const res = await familyClientApi.replyApproval(item.approvalId, allowOptionId);
      familyLiveStore.patchState((prev) => ({
        ...prev,
        pendingApprovals: res.pendingApprovals,
      }));
      await familyLiveStore.refresh();
    } finally {
      setSubmittingId(null);
    }
  };

  return (
    <div
      className="dshfam-approval-banner"
      style={compact ? { margin: '4px 0', padding: '8px 11px' } : undefined}
    >
      {approvals.map((item) => {
        const isBusy = submittingId === item.approvalId;
        const isDanger = item.title.includes('高危');
        const firstAllowOpt = item.options.find((o) => o.kind !== 'deny');
        const memberRecord = familyLiveStore
          .getState()
          .members.find((m) => m.id === item.memberId);
        const canOfferUpgradeToAuto =
          !compact &&
          !item.allowCustomInput &&
          !isDanger &&
          firstAllowOpt !== undefined &&
          (memberRecord?.body.permissionMode ?? 'ask') === 'ask';

        const customText = customInputs[item.approvalId] ?? '';

        return (
          <div
            key={item.approvalId}
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 7,
            }}
          >
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                fontSize: 12.5,
                fontWeight: 600,
              }}
            >
              <MemberAvatar
                avatar={item.memberAvatar}
                bodyKind={item.bodyKind}
                alt={item.memberName}
                size={22}
              />
              <span>
                <strong>{item.memberName}</strong>{' '}
                <span className="sh-badge" style={{ margin: '0 3px' }}>
                  {item.bodyKind}
                </span>{' '}
                {item.allowCustomInput ? item.title : `请求你的批示：${item.title}`}
              </span>
            </div>

            {!compact && item.detail && (
              <pre
                style={{
                  margin: 0,
                  padding: '7px 10px',
                  borderRadius: 6,
                  background: 'rgba(0,0,0,0.22)',
                  fontSize: 11.5,
                  maxHeight: 110,
                  overflow: 'auto',
                  fontFamily: 'var(--sh-font-mono)',
                  whiteSpace: 'pre-wrap',
                }}
              >
                {item.detail}
              </pre>
            )}

            <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6 }}>
              {item.options.map((opt) => {
                const isDeny = opt.kind === 'deny';
                return (
                  <button
                    key={opt.optionId}
                    type="button"
                    disabled={isBusy}
                    onClick={() => void handleChoose(item.approvalId, opt.optionId)}
                    className={`sh-btn sh-btn-sm ${isDeny ? 'sh-btn-destructive' : 'sh-btn-primary'}`}
                  >
                    {opt.label}
                  </button>
                );
              })}

              {canOfferUpgradeToAuto && firstAllowOpt && (
                <button
                  type="button"
                  disabled={isBusy}
                  onClick={() => void handleAllowAndSwitchAuto(item, firstAllowOpt.optionId)}
                  className="sh-btn sh-btn-outline sh-btn-sm"
                  title="允许本次操作，并将该成员切换为「自动模式」（今后常规操作自动放行，仅高危操作和提问才询问）"
                >
                  <Zap size={12} />
                  <span>允许并设为自动模式</span>
                </button>
              )}
            </div>

            {item.allowCustomInput && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <input
                  className="sh-input"
                  style={{ height: 29, fontSize: 12, flex: 1 }}
                  placeholder="也可直接输入你的自定义回答并按回车…"
                  value={customText}
                  disabled={isBusy}
                  onChange={(e) =>
                    setCustomInputs((prev) => ({
                      ...prev,
                      [item.approvalId]: e.target.value,
                    }))
                  }
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && customText.trim()) {
                      e.preventDefault();
                      void handleChoose(item.approvalId, `answer:${customText.trim()}`);
                    }
                  }}
                />
                <button
                  type="button"
                  className="sh-btn sh-btn-secondary sh-btn-sm"
                  disabled={isBusy || !customText.trim()}
                  onClick={() => void handleChoose(item.approvalId, `answer:${customText.trim()}`)}
                >
                  <Send size={12} />
                  <span>发送回答</span>
                </button>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
