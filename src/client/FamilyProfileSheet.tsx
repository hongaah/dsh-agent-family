import { Check, Home, Sparkles, X } from 'lucide-react';
import React, { useEffect, useState } from 'react';

import { formatFamilySharedProfileSection } from '../core/family-profile-shared.ts';
import type { FamilySharedProfile } from '../core/types.ts';
import { familyClientApi } from './api.ts';

export interface FamilyProfileSheetProps {
  readonly open: boolean;
  readonly profile: FamilySharedProfile;
  readonly onClose: () => void;
  readonly onSaved: (profile: FamilySharedProfile) => void;
}

const HONORIFIC_SUGGESTIONS = ['杰哥', '哥', '老板', '老大', '主理人', '船长'] as const;

export function FamilyProfileSheet({
  open,
  profile,
  onClose,
  onSaved,
}: FamilyProfileSheetProps): React.ReactElement | null {
  const [userName, setUserName] = useState<string>(profile.userName);
  const [userHonorific, setUserHonorific] = useState<string>(profile.userHonorific);
  const [sharedPrompt, setSharedPrompt] = useState<string>(profile.sharedPrompt);
  const [saving, setSaving] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setUserName(profile.userName);
      setUserHonorific(profile.userHonorific);
      setSharedPrompt(profile.sharedPrompt);
      setError(null);
    }
  }, [open, profile]);

  useEffect(() => {
    if (!open) return;
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  const previewText = formatFamilySharedProfileSection({
    userName,
    userHonorific,
    sharedPrompt,
  });

  const handleSubmit = async (ev: React.FormEvent) => {
    ev.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const res = await familyClientApi.updateProfile({
        userName,
        userHonorific,
        sharedPrompt,
      });
      onSaved(res.profile);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="sh-sheet-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <aside className="sh-sheet" role="dialog" aria-label="家庭全局设定与称呼">
        <div className="sh-sheet-header">
          <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
            <span
              style={{
                width: 30,
                height: 30,
                borderRadius: 8,
                background: 'var(--sh-accent)',
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <Home size={15} />
            </span>
            <div>
              <div style={{ fontWeight: 600, fontSize: 14.5 }}>家庭全局设定（全员可见）</div>
              <div style={{ fontSize: 11.5, color: 'var(--sh-muted-fg)' }}>
                配置你的名字、家人对你的称呼以及全体 Agent 共同遵守的共享提示词
              </div>
            </div>
          </div>
          <button
            type="button"
            className="sh-btn sh-btn-ghost sh-btn-icon"
            onClick={onClose}
            aria-label="关闭"
          >
            <X size={15} />
          </button>
        </div>

        <form onSubmit={(e) => void handleSubmit(e)} style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
          <div className="sh-sheet-body" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            {error && (
              <div
                style={{
                  padding: '8px 12px',
                  borderRadius: 8,
                  background: 'var(--sh-destructive-soft)',
                  color: 'var(--sh-destructive)',
                  fontSize: 12,
                }}
              >
                {error}
              </div>
            )}

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <div className="sh-field">
                <label className="sh-label" htmlFor="fam-profile-username">
                  你的名字 / 昵称
                </label>
                <input
                  id="fam-profile-username"
                  className="sh-input"
                  placeholder="例如：杨杰"
                  value={userName}
                  onChange={(e) => setUserName(e.target.value)}
                />
                <span className="sh-hint">让家里每位成员都知道家主是谁</span>
              </div>

              <div className="sh-field">
                <label className="sh-label" htmlFor="fam-profile-honorific">
                  家人怎么称呼你
                </label>
                <input
                  id="fam-profile-honorific"
                  className="sh-input"
                  placeholder="例如：杰哥 / 老板 / 老大"
                  value={userHonorific}
                  onChange={(e) => setUserHonorific(e.target.value)}
                />
                <span className="sh-hint">告别生硬的“用户”，全家统一亲切称呼</span>
              </div>
            </div>

            <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 6, marginTop: -6 }}>
              <span style={{ fontSize: 11.5, color: 'var(--sh-muted-fg)' }}>快捷称呼：</span>
              {HONORIFIC_SUGGESTIONS.map((item) => {
                const active = userHonorific.trim() === item;
                return (
                  <button
                    key={item}
                    type="button"
                    className="dshfam-chip"
                    style={{
                      padding: '2px 9px',
                      fontSize: 11.5,
                      ...(active
                        ? { borderColor: 'var(--sh-fg)', background: 'var(--sh-accent)', fontWeight: 600 }
                        : {}),
                    }}
                    onClick={() => setUserHonorific(item)}
                  >
                    {item}
                  </button>
                );
              })}
            </div>

            <div className="sh-field">
              <label className="sh-label" htmlFor="fam-profile-shared-prompt">
                全员共享提示词 / 家庭公约（全部 Agent 共享记忆）
              </label>
              <textarea
                id="fam-profile-shared-prompt"
                className="sh-textarea"
                rows={7}
                placeholder={
                  '写在这里的内容会被家里每一位成员（Claude Code、Codex、OpenCode、DSH）以及主对话共同感知，例如：\n1. 日常沟通一律用精炼自然的中文；\n2. 前端默认使用 React + TypeScript 严格模式，严禁使用 any；\n3. 修改公共核心文件前先用随身手机和相关负责人对齐。'
                }
                value={sharedPrompt}
                onChange={(e) => setSharedPrompt(e.target.value)}
              />
              <span className="sh-hint">
                保存后不仅新唤醒成员自动携带，连已经在运行中的成员也会在下一轮对话立即热更新感知，无需手动重置身体。
              </span>
            </div>

            {previewText && (
              <div
                style={{
                  padding: '10px 12px',
                  borderRadius: 8,
                  border: '1px dashed var(--sh-border)',
                  background: 'var(--sh-muted)',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 6,
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11, fontWeight: 600, color: 'var(--sh-muted-fg)' }}>
                  <Sparkles size={12} />
                  <span>注入全体成员灵魂的实际效果预览</span>
                </div>
                <pre
                  style={{
                    margin: 0,
                    fontSize: 11.5,
                    lineHeight: 1.55,
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-word',
                    fontFamily: 'var(--sh-font-sans)',
                    color: 'var(--sh-fg)',
                  }}
                >
                  {previewText}
                </pre>
              </div>
            )}
          </div>

          <div className="sh-sheet-footer">
            <button type="button" className="sh-btn sh-btn-outline" onClick={onClose}>
              取消
            </button>
            <button type="submit" className="sh-btn sh-btn-primary" disabled={saving}>
              <Check size={14} />
              <span>{saving ? '保存中…' : '保存全员设定'}</span>
            </button>
          </div>
        </form>
      </aside>
    </div>
  );
}
