const STYLE_ELEMENT_ID = 'dsh-agent-family-styles';

const FAMILY_CSS = `
.dshfam-root {
  --fam-bg: rgba(128, 128, 128, 0.03);
  --fam-surface: rgba(128, 128, 128, 0.06);
  --fam-surface-strong: rgba(128, 128, 128, 0.11);
  --fam-border: rgba(128, 128, 128, 0.16);
  --fam-border-strong: rgba(128, 128, 128, 0.28);
  --fam-accent: #d97706;
  --fam-accent-soft: rgba(217, 119, 6, 0.14);
  --fam-emerald: #10b981;
  --fam-emerald-soft: rgba(16, 185, 129, 0.14);
  --fam-danger: #ef4444;
  --fam-danger-soft: rgba(239, 68, 68, 0.13);
  --fam-blue: #2563eb;
  --fam-blue-soft: rgba(37, 99, 235, 0.13);
  --fam-radius: 12px;
  --fam-radius-sm: 8px;
  --fam-font-sans: 'Plus Jakarta Sans', 'PingFang SC', 'Hiragino Sans GB', -apple-system, BlinkMacSystemFont, sans-serif;
  --fam-font-mono: 'JetBrains Mono', 'SF Mono', ui-monospace, Menlo, monospace;

  display: flex;
  flex-direction: column;
  height: 100%;
  width: 100%;
  overflow: hidden;
  font-family: var(--fam-font-sans);
  color: inherit;
  box-sizing: border-box;
}

.dshfam-root *, .dshfam-root *::before, .dshfam-root *::after {
  box-sizing: border-box;
}

.dshfam-topbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 12px 20px;
  border-bottom: 1px solid var(--fam-border);
  background: linear-gradient(180deg, rgba(217, 119, 6, 0.05) 0%, transparent 100%);
  flex-shrink: 0;
}

.dshfam-brand {
  display: flex;
  align-items: center;
  gap: 10px;
}

.dshfam-brand-badge {
  width: 32px;
  height: 32px;
  border-radius: 9px;
  background: var(--fam-accent-soft);
  border: 1px solid rgba(217, 119, 6, 0.32);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 16px;
}

.dshfam-brand-title {
  font-size: 15px;
  font-weight: 700;
  letter-spacing: -0.01em;
}

.dshfam-brand-sub {
  font-size: 11.5px;
  opacity: 0.65;
}

.dshfam-tabs {
  display: inline-flex;
  background: var(--fam-surface);
  border: 1px solid var(--fam-border);
  padding: 3px;
  border-radius: 10px;
  gap: 3px;
}

.dshfam-tab {
  border: none;
  background: transparent;
  color: inherit;
  padding: 6px 14px;
  border-radius: 7px;
  font-size: 12.5px;
  font-weight: 600;
  cursor: pointer;
  opacity: 0.72;
  transition: all 0.16s ease;
}

.dshfam-tab:hover {
  opacity: 1;
}

.dshfam-tab[data-active="true"] {
  background: var(--fam-accent-soft);
  color: var(--fam-accent);
  opacity: 1;
}

.dshfam-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 6px 12px;
  border-radius: var(--fam-radius-sm);
  border: 1px solid var(--fam-border);
  background: var(--fam-surface);
  color: inherit;
  font-size: 12.5px;
  font-weight: 600;
  cursor: pointer;
  transition: border-color 0.15s ease, background 0.15s ease, transform 0.1s ease;
}

.dshfam-btn:hover:not(:disabled) {
  border-color: var(--fam-border-strong);
  background: var(--fam-surface-strong);
}

.dshfam-btn:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.dshfam-btn-primary {
  background: var(--fam-accent);
  border-color: var(--fam-accent);
  color: #fff;
}

.dshfam-btn-primary:hover:not(:disabled) {
  background: #b45309;
  border-color: #b45309;
}

.dshfam-btn-danger {
  background: var(--fam-danger-soft);
  border-color: rgba(239, 68, 68, 0.35);
  color: var(--fam-danger);
}

.dshfam-lounge {
  display: grid;
  grid-template-columns: 248px minmax(0, 1fr) 276px;
  flex: 1;
  min-height: 0;
  overflow: hidden;
}

@media (max-width: 1080px) {
  .dshfam-lounge {
    grid-template-columns: 220px minmax(0, 1fr);
  }
  .dshfam-phone-rail {
    display: none;
  }
}

.dshfam-nav-rail {
  border-right: 1px solid var(--fam-border);
  display: flex;
  flex-direction: column;
  min-height: 0;
  overflow-y: auto;
  padding: 12px;
  gap: 14px;
}

.dshfam-section-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 11px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  opacity: 0.62;
  padding: 0 4px;
}

.dshfam-nav-item {
  width: 100%;
  text-align: left;
  border: 1px solid transparent;
  background: transparent;
  color: inherit;
  padding: 8px 10px;
  border-radius: 9px;
  cursor: pointer;
  display: flex;
  align-items: center;
  gap: 9px;
  transition: background 0.14s ease, border-color 0.14s ease;
}

.dshfam-nav-item:hover {
  background: var(--fam-surface);
}

.dshfam-nav-item[data-selected="true"] {
  background: var(--fam-accent-soft);
  border-color: rgba(217, 119, 6, 0.35);
}

.dshfam-avatar {
  width: 30px;
  height: 30px;
  border-radius: 8px;
  background: var(--fam-surface-strong);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 15px;
  flex-shrink: 0;
}

.dshfam-dot {
  width: 8px;
  height: 8px;
  border-radius: 999px;
  flex-shrink: 0;
}

.dshfam-dot[data-state="sleeping"], .dshfam-dot[data-state="idle"] {
  background: rgba(128, 128, 128, 0.45);
}

.dshfam-dot[data-state="working"], .dshfam-dot[data-state="in_call"] {
  background: var(--fam-emerald);
  box-shadow: 0 0 0 3px var(--fam-emerald-soft);
}

.dshfam-dot[data-state="awaiting_approval"] {
  background: var(--fam-accent);
  box-shadow: 0 0 0 3px var(--fam-accent-soft);
}

.dshfam-dot[data-state="error"] {
  background: var(--fam-danger);
}

.dshfam-stage {
  display: flex;
  flex-direction: column;
  min-height: 0;
  overflow: hidden;
}

.dshfam-stage-head {
  padding: 12px 18px;
  border-bottom: 1px solid var(--fam-border);
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-shrink: 0;
}

.dshfam-feed {
  flex: 1;
  overflow-y: auto;
  padding: 16px 18px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.dshfam-bubble {
  padding: 11px 14px;
  border-radius: 12px;
  border: 1px solid var(--fam-border);
  background: var(--fam-surface);
  max-width: 88%;
  line-height: 1.55;
  font-size: 13px;
  white-space: pre-wrap;
  word-break: break-word;
}

.dshfam-bubble[data-mine="true"] {
  align-self: flex-end;
  background: var(--fam-accent-soft);
  border-color: rgba(217, 119, 6, 0.3);
}

.dshfam-bubble-meta {
  display: flex;
  align-items: center;
  gap: 7px;
  font-size: 11.5px;
  font-weight: 600;
  margin-bottom: 5px;
  opacity: 0.82;
}

.dshfam-mono-tag {
  font-family: var(--fam-font-mono);
  font-size: 10.5px;
  padding: 1px 6px;
  border-radius: 5px;
  background: var(--fam-surface-strong);
  border: 1px solid var(--fam-border);
}

.dshfam-composer {
  padding: 12px 18px;
  border-top: 1px solid var(--fam-border);
  display: flex;
  flex-direction: column;
  gap: 8px;
  background: var(--fam-bg);
}

.dshfam-mention-bar {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 5px;
}

.dshfam-chip {
  border: 1px solid var(--fam-border);
  background: var(--fam-surface);
  color: inherit;
  border-radius: 999px;
  padding: 2px 9px;
  font-size: 11.5px;
  cursor: pointer;
}

.dshfam-chip:hover {
  border-color: var(--fam-accent);
  color: var(--fam-accent);
}

.dshfam-textarea {
  width: 100%;
  min-height: 66px;
  max-height: 180px;
  resize: vertical;
  padding: 9px 11px;
  border-radius: 9px;
  border: 1px solid var(--fam-border);
  background: transparent;
  color: inherit;
  font-family: inherit;
  font-size: 13px;
  line-height: 1.5;
}

.dshfam-textarea:focus, .dshfam-input:focus, .dshfam-select:focus {
  outline: none;
  border-color: var(--fam-accent);
}

.dshfam-input, .dshfam-select {
  width: 100%;
  padding: 7px 10px;
  border-radius: 8px;
  border: 1px solid var(--fam-border);
  background: transparent;
  color: inherit;
  font-family: inherit;
  font-size: 12.5px;
}

.dshfam-phone-rail {
  border-left: 1px solid var(--fam-border);
  display: flex;
  flex-direction: column;
  min-height: 0;
  overflow-y: auto;
  padding: 12px;
  gap: 10px;
}

.dshfam-call-card {
  padding: 10px 11px;
  border-radius: 10px;
  border: 1px solid var(--fam-border);
  background: var(--fam-surface);
  font-size: 12px;
  display: flex;
  flex-direction: column;
  gap: 5px;
}

.dshfam-studio {
  flex: 1;
  overflow-y: auto;
  padding: 18px 22px;
  display: flex;
  flex-direction: column;
  gap: 18px;
}

.dshfam-body-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(210px, 1fr));
  gap: 10px;
}

.dshfam-body-card {
  padding: 11px 13px;
  border-radius: 10px;
  border: 1px solid var(--fam-border);
  background: var(--fam-surface);
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.dshfam-member-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(290px, 1fr));
  gap: 12px;
}

.dshfam-member-card {
  padding: 14px;
  border-radius: 12px;
  border: 1px solid var(--fam-border);
  background: var(--fam-surface);
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.dshfam-approval-banner {
  margin: 8px 16px 0;
  padding: 10px 14px;
  border-radius: 10px;
  border: 1px solid rgba(217, 119, 6, 0.48);
  background: rgba(217, 119, 6, 0.12);
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.dshfam-toolcard {
  border: 1px solid rgba(128, 128, 128, 0.2);
  border-radius: 11px;
  padding: 11px 13px;
  margin: 6px 0;
  background: rgba(128, 128, 128, 0.05);
  font-family: 'Plus Jakarta Sans', 'PingFang SC', -apple-system, sans-serif;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
`;

export function ensureFamilyStyles(): () => void {
  if (typeof document === 'undefined') {
    return () => undefined;
  }
  let el = document.getElementById(STYLE_ELEMENT_ID) as HTMLStyleElement | null;
  if (!el) {
    el = document.createElement('style');
    el.id = STYLE_ELEMENT_ID;
    el.textContent = FAMILY_CSS;
    document.head.appendChild(el);
  }
  return () => {
    // 保留全局共享样式避免重渲染闪烁
  };
}
