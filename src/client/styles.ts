const STYLE_ELEMENT_ID = 'dsh-agent-family-styles';

/**
 * 纯正 shadcn/ui (Zinc 语义色板) 设计系统：
 * 自动兼容亮色模式、暗色模式 (`prefers-color-scheme: dark` / `.dark` / `[data-theme="dark"]`) 与 DSH 宿主变量。
 */
const FAMILY_CSS = `
.dshfam-root, .dshfam-portal {
  --sh-bg: #ffffff;
  --sh-fg: #09090b;
  --sh-card: #ffffff;
  --sh-popover: #ffffff;
  --sh-sidebar: #fafafa;
  --sh-muted: #f4f4f5;
  --sh-muted-fg: #71717a;
  --sh-accent: #f4f4f5;
  --sh-accent-fg: #18181b;
  --sh-primary: #18181b;
  --sh-primary-fg: #fafafa;
  --sh-primary-hover: #27272a;
  --sh-border: #e4e4e7;
  --sh-input: #e4e4e7;
  --sh-ring: rgba(24, 24, 27, 0.18);
  --sh-destructive: #dc2626;
  --sh-destructive-soft: rgba(220, 38, 38, 0.1);
  --sh-emerald: #10b981;
  --sh-emerald-soft: rgba(16, 185, 129, 0.14);
  --sh-amber: #f59e0b;
  --sh-amber-soft: rgba(245, 158, 11, 0.13);
  --sh-code-bg: #18181b;
  --sh-code-fg: #f4f4f5;
  --sh-shadow-sm: 0 1px 2px 0 rgba(0, 0, 0, 0.04);
  --sh-shadow-lg: 0 16px 40px -8px rgba(0, 0, 0, 0.18), 0 4px 12px -2px rgba(0, 0, 0, 0.08);
  --sh-radius: 8px;
  --sh-radius-md: 6px;
  --sh-radius-lg: 12px;
  --sh-font-sans: 'Inter', -apple-system, BlinkMacSystemFont, 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', sans-serif;
  --sh-font-mono: 'JetBrains Mono', 'SF Mono', ui-monospace, Menlo, Consolas, monospace;
}

@media (prefers-color-scheme: dark) {
  .dshfam-root:not([data-force-theme="light"]),
  .dshfam-portal:not([data-force-theme="light"]) {
    --sh-bg: #09090b;
    --sh-fg: #fafafa;
    --sh-card: #111114;
    --sh-popover: #141418;
    --sh-sidebar: #0c0c0f;
    --sh-muted: #18181b;
    --sh-muted-fg: #a1a1aa;
    --sh-accent: #1f1f24;
    --sh-accent-fg: #fafafa;
    --sh-primary: #fafafa;
    --sh-primary-fg: #09090b;
    --sh-primary-hover: #e4e4e7;
    --sh-border: rgba(255, 255, 255, 0.09);
    --sh-input: rgba(255, 255, 255, 0.12);
    --sh-ring: rgba(212, 212, 216, 0.25);
    --sh-destructive: #f87171;
    --sh-destructive-soft: rgba(248, 113, 113, 0.14);
    --sh-code-bg: #141418;
    --sh-code-fg: #f4f4f5;
    --sh-shadow-lg: 0 20px 48px -10px rgba(0, 0, 0, 0.65), 0 0 0 1px rgba(255, 255, 255, 0.07);
  }
}

[data-theme="light"] .dshfam-root,
html.light .dshfam-root,
.dshfam-root[data-force-theme="light"] {
  --sh-bg: #ffffff;
  --sh-fg: #09090b;
  --sh-card: #ffffff;
  --sh-popover: #ffffff;
  --sh-sidebar: #fafafa;
  --sh-muted: #f4f4f5;
  --sh-muted-fg: #71717a;
  --sh-accent: #f4f4f5;
  --sh-accent-fg: #18181b;
  --sh-primary: #18181b;
  --sh-primary-fg: #fafafa;
  --sh-primary-hover: #27272a;
  --sh-border: #e4e4e7;
  --sh-input: #e4e4e7;
  --sh-ring: rgba(24, 24, 27, 0.18);
  --sh-destructive: #dc2626;
  --sh-destructive-soft: rgba(220, 38, 38, 0.1);
  --sh-code-bg: #18181b;
  --sh-code-fg: #f4f4f5;
  --sh-shadow-lg: 0 16px 40px -8px rgba(0, 0, 0, 0.18), 0 4px 12px -2px rgba(0, 0, 0, 0.08);
}

.dark .dshfam-root,
[data-theme="dark"] .dshfam-root,
.dshfam-root[data-force-theme="dark"] {
  --sh-bg: #09090b;
  --sh-fg: #fafafa;
  --sh-card: #111114;
  --sh-popover: #141418;
  --sh-sidebar: #0c0c0f;
  --sh-muted: #18181b;
  --sh-muted-fg: #a1a1aa;
  --sh-accent: #1f1f24;
  --sh-accent-fg: #fafafa;
  --sh-primary: #fafafa;
  --sh-primary-fg: #09090b;
  --sh-primary-hover: #e4e4e7;
  --sh-border: rgba(255, 255, 255, 0.09);
  --sh-input: rgba(255, 255, 255, 0.12);
  --sh-ring: rgba(212, 212, 216, 0.25);
  --sh-destructive: #f87171;
  --sh-destructive-soft: rgba(248, 113, 113, 0.14);
  --sh-code-bg: #141418;
  --sh-code-fg: #f4f4f5;
  --sh-shadow-lg: 0 20px 48px -10px rgba(0, 0, 0, 0.65), 0 0 0 1px rgba(255, 255, 255, 0.07);
}

.dshfam-root {
  display: flex;
  flex-direction: column;
  height: 100%;
  width: 100%;
  overflow: hidden;
  background: var(--dsw-alias-bg-layer-1, var(--sh-bg));
  color: var(--dsw-alias-label-primary, var(--sh-fg));
  font-family: var(--sh-font-sans);
  font-size: 13px;
  line-height: 1.5;
  box-sizing: border-box;
  position: relative;
  container-type: inline-size;
  -webkit-font-smoothing: antialiased;
}

.dshfam-root *, .dshfam-root *::before, .dshfam-root *::after {
  box-sizing: border-box;
}

/* Header Toolbar (shadcn responsive header) */
.dshfam-header {
  min-height: 46px;
  padding: 6px 14px;
  border-bottom: 1px solid var(--sh-border);
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 8px;
  flex-shrink: 0;
  background: var(--sh-bg);
}

.dshfam-header-left {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  flex: 1 1 auto;
}

.dshfam-header-right {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  min-width: 0;
}

/* shadcn Buttons */
.sh-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  height: 32px;
  padding: 0 12px;
  border-radius: var(--sh-radius-md);
  font-family: inherit;
  font-size: 12.5px;
  font-weight: 500;
  white-space: nowrap;
  flex-shrink: 0;
  cursor: pointer;
  border: 1px solid transparent;
  transition: background-color 0.14s ease, border-color 0.14s ease, color 0.14s ease, opacity 0.14s ease;
}

.sh-btn:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px var(--sh-ring);
}

.sh-btn:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.sh-btn-primary {
  background: var(--sh-primary);
  color: var(--sh-primary-fg);
  box-shadow: var(--sh-shadow-sm);
}

.sh-btn-primary:hover:not(:disabled) {
  background: var(--sh-primary-hover);
}

.sh-btn-outline {
  background: transparent;
  border-color: var(--sh-border);
  color: inherit;
  box-shadow: var(--sh-shadow-sm);
}

.sh-btn-outline:hover:not(:disabled) {
  background: var(--sh-accent);
  color: var(--sh-accent-fg);
}

.sh-btn-secondary {
  background: var(--sh-muted);
  color: inherit;
}

.sh-btn-secondary:hover:not(:disabled) {
  background: var(--sh-accent);
}

.sh-btn-ghost {
  background: transparent;
  color: var(--sh-muted-fg);
}

.sh-btn-ghost:hover:not(:disabled) {
  background: var(--sh-accent);
  color: var(--sh-fg);
}

.sh-btn-destructive {
  background: var(--sh-destructive-soft);
  border-color: rgba(239, 68, 68, 0.28);
  color: var(--sh-destructive);
}

.sh-btn-destructive:hover:not(:disabled) {
  background: rgba(239, 68, 68, 0.2);
}

.sh-btn-icon {
  width: 30px;
  height: 30px;
  padding: 0;
}

.sh-btn-sm {
  height: 26px;
  padding: 0 9px;
  font-size: 11.5px;
}

/* Compatibility aliases for existing external slots */
.dshfam-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  height: 30px;
  padding: 0 11px;
  border-radius: var(--sh-radius-md);
  border: 1px solid var(--sh-border);
  background: transparent;
  color: inherit;
  font-size: 12px;
  font-weight: 500;
  white-space: nowrap;
  flex-shrink: 0;
  cursor: pointer;
  transition: background 0.14s ease;
}

.dshfam-btn:hover:not(:disabled) {
  background: var(--sh-accent);
}

.dshfam-btn-primary {
  background: var(--sh-primary);
  border-color: var(--sh-primary);
  color: var(--sh-primary-fg);
}

.dshfam-btn-primary:hover:not(:disabled) {
  background: var(--sh-primary-hover);
}

.dshfam-btn-danger {
  background: var(--sh-destructive-soft);
  border-color: rgba(239, 68, 68, 0.3);
  color: var(--sh-destructive);
}

/* shadcn Badges & Kbd */
.sh-badge, .dshfam-mono-tag {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 20px;
  padding: 0 6px;
  border-radius: 5px;
  border: 1px solid var(--sh-border);
  background: var(--sh-muted);
  color: var(--sh-muted-fg);
  font-family: var(--sh-font-mono);
  font-size: 10.5px;
  font-weight: 500;
  line-height: 1;
  white-space: nowrap;
}

.sh-kbd {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  height: 19px;
  padding: 0 5px;
  border-radius: 4px;
  border: 1px solid var(--sh-border);
  background: var(--sh-muted);
  color: var(--sh-muted-fg);
  font-family: var(--sh-font-mono);
  font-size: 10px;
  font-weight: 500;
}

/* Inputs & Selects */
.sh-input, .sh-select, .sh-textarea {
  width: 100%;
  border-radius: var(--sh-radius-md);
  border: 1px solid var(--sh-input);
  background: transparent;
  color: inherit;
  font-family: inherit;
  font-size: 13px;
  transition: border-color 0.14s ease, box-shadow 0.14s ease;
}

.sh-input, .sh-select {
  height: 34px;
  padding: 0 10px;
}

.sh-textarea {
  padding: 8px 10px;
  line-height: 1.55;
  resize: vertical;
}

.sh-input:focus, .sh-select:focus, .sh-textarea:focus {
  outline: none;
  border-color: var(--sh-muted-fg);
  box-shadow: 0 0 0 2px var(--sh-ring);
}

.sh-label {
  display: block;
  font-size: 12px;
  font-weight: 500;
  margin-bottom: 5px;
  color: inherit;
}

/* 3-Pane Studio Layout */
.dshfam-workspace {
  display: flex;
  flex: 1;
  min-height: 0;
  overflow: hidden;
  position: relative;
}

.dshfam-sidebar {
  width: 248px;
  flex-shrink: 0;
  border-right: 1px solid var(--sh-border);
  background: var(--sh-sidebar);
  display: flex;
  flex-direction: column;
  min-height: 0;
}

@container (max-width: 780px) {
  .dshfam-sidebar {
    width: 196px;
  }
  .sh-cmd-search-text {
    display: none;
  }
}

@container (max-width: 600px) {
  .dshfam-sidebar {
    display: none;
  }
}

.dshfam-mobile-switch-bar {
  display: none;
}

@container (max-width: 600px) {
  .dshfam-mobile-switch-bar {
    display: flex;
  }
}

.dshfam-sidebar-scroll {
  flex: 1;
  overflow-y: auto;
  padding: 12px 10px;
  display: flex;
  flex-direction: column;
  gap: 18px;
}

.dshfam-sidebar-footer {
  padding: 10px 12px;
  border-top: 1px solid var(--sh-border);
  display: flex;
  flex-direction: column;
  gap: 7px;
  background: var(--sh-bg);
}

.sh-section-label {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 8px;
  font-size: 11px;
  font-weight: 600;
  color: var(--sh-muted-fg);
  letter-spacing: 0.02em;
}

.sh-nav-row {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 7px 8px;
  border-radius: 7px;
  border: 1px solid transparent;
  background: transparent;
  color: inherit;
  text-align: left;
  cursor: pointer;
  position: relative;
  transition: background 0.12s ease;
}

.sh-nav-row:hover {
  background: var(--sh-accent);
}

.sh-nav-row[data-active="true"] {
  background: var(--sh-accent);
  border-color: var(--sh-border);
  font-weight: 500;
}

.sh-nav-row .sh-row-action {
  opacity: 0;
  transition: opacity 0.12s ease;
}

.sh-nav-row:hover .sh-row-action {
  opacity: 1;
}

.dshfam-avatar {
  border-radius: 8px;
  background: var(--sh-muted);
  border: 1px solid var(--sh-border);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  overflow: hidden;
}

/* Status Dots */
.dshfam-dot {
  width: 7px;
  height: 7px;
  border-radius: 999px;
  flex-shrink: 0;
}

.dshfam-dot[data-state="sleeping"], .dshfam-dot[data-state="idle"] {
  background: rgba(161, 161, 170, 0.45);
}

.dshfam-dot[data-state="working"], .dshfam-dot[data-state="in_call"] {
  background: var(--sh-emerald);
  box-shadow: 0 0 0 3px var(--sh-emerald-soft);
  animation: sh-pulse 1.8s ease-in-out infinite;
}

.dshfam-dot[data-state="awaiting_approval"] {
  background: var(--sh-amber);
  box-shadow: 0 0 0 3px var(--sh-amber-soft);
  animation: sh-pulse 1.4s ease-in-out infinite;
}

.dshfam-dot[data-state="error"] {
  background: var(--sh-destructive);
}

/* Main Stage */
.dshfam-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  background: var(--sh-bg);
  position: relative;
  container-type: inline-size;
}

.dshfam-stage-bar {
  min-height: 48px;
  padding: 6px 14px;
  border-bottom: 1px solid var(--sh-border);
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 8px;
  flex-shrink: 0;
}

.dshfam-stage-identity {
  display: flex;
  align-items: center;
  gap: 9px;
  min-width: 120px;
  flex: 1 1 140px;
  overflow: hidden;
}

.dshfam-stage-controls {
  display: flex;
  align-items: center;
  gap: 5px;
  flex-shrink: 0;
  min-width: 0;
}

@container (max-width: 440px) {
  .dshfam-stage-bar {
    padding: 6px 10px;
  }
  .sh-model-pill-btn {
    max-width: 118px !important;
  }
  .sh-hide-xs {
    display: none;
  }
  .dshfam-stream {
    padding: 12px 12px;
  }
  .dshfam-composer-shell {
    padding: 8px 10px 12px;
  }
}

.dshfam-stream {
  flex: 1;
  overflow-y: auto;
  padding: 20px 22px;
  display: flex;
  flex-direction: column;
  gap: 16px;
}

/* Message Row (Modern Linear/Cursor AI Thread Style) */
.sh-msg-row {
  display: flex;
  gap: 11px;
  align-items: flex-start;
  max-width: 840px;
  width: 100%;
  margin: 0 auto;
  position: relative;
  animation: sh-fade-up 0.16s ease-out;
}

.sh-msg-row[data-mine="true"] {
  flex-direction: row-reverse;
}

.sh-msg-card {
  flex: 1;
  min-width: 0;
  padding: 11px 14px;
  border-radius: 10px;
  border: 1px solid var(--sh-border);
  background: var(--sh-card);
  position: relative;
}

.sh-msg-row[data-mine="true"] .sh-msg-card {
  flex: 0 1 auto;
  max-width: 78%;
  background: var(--sh-muted);
  border-color: var(--sh-border);
}

.sh-msg-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 6px;
}

.sh-msg-actions {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  opacity: 0;
  transition: opacity 0.12s ease;
}

.sh-msg-card:hover .sh-msg-actions {
  opacity: 1;
}

/* Rich Markdown Content */
.sh-prose {
  font-size: 13px;
  line-height: 1.64;
  word-break: break-word;
  overflow-wrap: anywhere;
}

.sh-host-markdown {
  font-size: var(--dsh-content-font-size, 13.5px);
  line-height: calc(21px + var(--dsh-content-font-delta, 0px));
  font-family: var(--dsw-font-family, var(--sh-font-sans));
  color: var(--dsw-alias-label-primary, inherit);
}

.sh-host-markdown a[href*="__family_member__/"],
.sh-host-markdown button[title*="查看家庭成员"] {
  display: inline-flex;
  align-items: center;
  padding: 0 6px;
  border-radius: 5px;
  background: rgba(59, 130, 246, 0.14);
  border: 1px solid rgba(59, 130, 246, 0.32);
  font-family: var(--sh-font-sans);
  font-size: 12.2px;
  font-weight: 600;
  text-decoration: none;
  color: #60a5fa;
  cursor: pointer;
}

.sh-prose p {
  margin: 0 0 8px;
}

.sh-prose p:last-child {
  margin-bottom: 0;
}

.sh-prose ul, .sh-prose ol {
  margin: 4px 0 8px;
  padding-left: 20px;
}

.sh-prose li {
  margin: 2.5px 0;
}

.sh-md-h {
  margin: 12px 0 6px;
  font-weight: 650;
  line-height: 1.35;
  letter-spacing: -0.01em;
}

.sh-md-h:first-child {
  margin-top: 0;
}

.sh-md-h1 { font-size: 17px; padding-bottom: 4px; border-bottom: 1px solid var(--sh-border); }
.sh-md-h2 { font-size: 15px; padding-bottom: 3px; border-bottom: 1px solid var(--sh-border); }
.sh-md-h3 { font-size: 13.8px; }
.sh-md-h4, .sh-md-h5, .sh-md-h6 { font-size: 13px; }

.sh-md-hr {
  border: none;
  border-top: 1px solid var(--sh-border);
  margin: 10px 0;
}

.sh-md-blockquote {
  margin: 6px 0 8px;
  padding: 4px 11px;
  border-left: 3px solid var(--sh-border);
  color: var(--sh-muted-fg);
  background: rgba(128, 128, 128, 0.05);
  border-radius: 0 6px 6px 0;
}

.sh-md-table-wrap {
  margin: 8px 0;
  overflow-x: auto;
  border-radius: 8px;
  border: 1px solid var(--sh-border);
}

.sh-md-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12.2px;
}

.sh-md-table th,
.sh-md-table td {
  padding: 6px 10px;
  border-bottom: 1px solid var(--sh-border);
  text-align: left;
}

.sh-md-table th {
  background: var(--sh-muted);
  font-weight: 600;
}

.sh-md-table tr:last-child td {
  border-bottom: none;
}

.sh-md-link,
.sh-md-link-btn {
  color: #3b82f6;
  text-decoration: underline;
  text-underline-offset: 2px;
  background: transparent;
  border: none;
  padding: 0;
  font: inherit;
  cursor: pointer;
}

.sh-inline-file-link {
  cursor: pointer;
  color: inherit;
  transition: border-color 0.12s ease, background 0.12s ease;
}

.sh-inline-file-link:hover {
  border-color: #3b82f6;
  color: #3b82f6;
}

/* Deliverable File Changes Card */
.sh-deliverable-card {
  margin-top: 10px;
  border-radius: 8px;
  border: 1px solid var(--sh-border);
  background: var(--sh-muted);
  overflow: hidden;
}

.sh-deliverable-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 6px 10px;
  cursor: pointer;
  user-select: none;
}

.sh-deliverable-head:hover {
  background: var(--sh-accent);
}

.sh-deliverable-list {
  border-top: 1px solid var(--sh-border);
  padding: 4px;
  display: flex;
  flex-direction: column;
  gap: 2px;
  background: var(--sh-card);
}

.sh-deliverable-row {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 4px 7px;
  border-radius: 5px;
  font-size: 11.8px;
}

.sh-deliverable-row[data-clickable="true"] {
  cursor: pointer;
}

.sh-deliverable-row[data-clickable="true"]:hover {
  background: var(--sh-accent);
}

.sh-deliverable-kind {
  width: 17px;
  height: 17px;
  border-radius: 4px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-family: var(--sh-font-mono);
  font-size: 10px;
  font-weight: 700;
  flex-shrink: 0;
}

.sh-deliverable-path {
  flex: 1;
  min-width: 0;
  font-family: var(--sh-font-mono);
  font-size: 11.5px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.sh-deliverable-stats {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-family: var(--sh-font-mono);
  font-size: 11px;
  flex-shrink: 0;
}

.sh-deliverable-open-icon {
  opacity: 0.45;
  transition: opacity 0.12s ease;
}

.sh-deliverable-row:hover .sh-deliverable-open-icon {
  opacity: 1;
}

.sh-inline-code {
  font-family: var(--sh-font-mono);
  font-size: 11.5px;
  padding: 1.5px 5px;
  border-radius: 4px;
  background: var(--sh-muted);
  border: 1px solid var(--sh-border);
}

.sh-mention-pill {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 1px 6px;
  border-radius: 5px;
  background: rgba(59, 130, 246, 0.14);
  border: 1px solid rgba(59, 130, 246, 0.32);
  font-family: var(--sh-font-sans);
  font-size: 12px;
  font-weight: 600;
  line-height: 1.4;
  cursor: pointer;
  color: #60a5fa;
  vertical-align: baseline;
  transition: background 0.12s ease, border-color 0.12s ease;
}

.sh-mention-pill:hover {
  background: rgba(59, 130, 246, 0.22);
  border-color: rgba(59, 130, 246, 0.52);
}

.sh-file-ref-pill {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 1px 6px;
  border-radius: 5px;
  background: var(--sh-muted);
  border: 1px solid var(--sh-border);
  font-family: var(--sh-font-sans);
  font-size: 11.8px;
  font-weight: 500;
  line-height: 1.45;
  cursor: pointer;
  color: inherit;
  vertical-align: baseline;
}

.sh-file-ref-pill:hover {
  border-color: #3b82f6;
  color: #3b82f6;
}

/* Member HoverCard */
.sh-member-hover-anchor {
  position: relative;
  display: inline-flex;
  align-items: center;
  vertical-align: baseline;
}

.sh-member-hovercard {
  position: absolute;
  left: 0;
  bottom: calc(100% + 7px);
  width: 248px;
  padding: 10px 12px;
  border-radius: 10px;
  border: 1px solid var(--sh-border);
  background: var(--sh-popover);
  color: var(--sh-popover-fg);
  box-shadow: var(--sh-shadow-lg);
  z-index: 80;
  text-align: left;
  font-weight: 400;
  animation: sh-fade-up 0.12s ease-out;
}

.sh-member-hovercard[data-align="right"] {
  left: auto;
  right: 0;
}

/* Stage header hoverable member name */
.sh-stage-member-name-trigger {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 1px 6px;
  margin-left: -6px;
  border-radius: 6px;
  font-weight: 650;
  font-size: 13.5px;
  cursor: default;
  transition: background 0.12s ease;
}

.sh-stage-member-name-trigger:hover {
  background: var(--sh-accent);
}

.sh-codeblock {
  margin: 8px 0;
  border-radius: 8px;
  border: 1px solid var(--sh-border);
  background: var(--sh-code-bg);
  color: var(--sh-code-fg);
  overflow: hidden;
}

.sh-codeblock-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 5px 10px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
  font-family: var(--sh-font-mono);
  font-size: 11px;
  color: #a1a1aa;
}

.sh-codeblock pre {
  margin: 0;
  padding: 10px 12px;
  overflow-x: auto;
  font-family: var(--sh-font-mono);
  font-size: 12px;
  line-height: 1.5;
}

/* Composer Container */
.dshfam-composer-shell {
  padding: 10px 22px 16px;
  background: var(--sh-bg);
}

.sh-composer-box {
  max-width: 840px;
  margin: 0 auto;
  border-radius: 11px;
  border: 1px solid var(--sh-border);
  background: var(--sh-card);
  box-shadow: var(--sh-shadow-sm);
  position: relative;
  transition: border-color 0.14s ease, box-shadow 0.14s ease;
}

.sh-composer-box:focus-within {
  border-color: var(--sh-muted-fg);
  box-shadow: 0 0 0 2px var(--sh-ring);
}

.sh-composer-box[data-drag="true"] {
  border-color: #3b82f6;
  box-shadow: 0 0 0 2px rgba(59, 130, 246, 0.35);
}

/* Composer Draft Pills & Attachment Strip */
.sh-composer-pills-bar {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  padding: 8px 11px 2px;
}

.sh-draft-member-chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 24px;
  padding: 0 6px 0 7px;
  border-radius: 6px;
  background: rgba(59, 130, 246, 0.14);
  border: 1px solid rgba(59, 130, 246, 0.32);
  color: #60a5fa;
  font-size: 11.8px;
  font-weight: 600;
}

.sh-draft-file-chip-wrap {
  display: inline-flex;
  align-items: center;
  gap: 2px;
}

.sh-draft-chip-remove {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 15px;
  height: 15px;
  border-radius: 4px;
  border: none;
  background: transparent;
  color: inherit;
  opacity: 0.68;
  cursor: pointer;
  padding: 0;
}

.sh-draft-chip-remove:hover {
  opacity: 1;
  background: rgba(128, 128, 128, 0.18);
}

.sh-draft-att-card {
  display: inline-flex;
  align-items: center;
  height: 44px;
  max-width: 210px;
  border-radius: 9px;
  border: 1px solid var(--sh-border);
  background: var(--sh-muted);
  overflow: hidden;
  position: relative;
}

.sh-draft-att-main {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  height: 100%;
  padding: 4px 24px 4px 6px;
  border: none;
  background: transparent;
  color: inherit;
  cursor: pointer;
  min-width: 0;
}

.sh-draft-att-main:hover {
  background: var(--sh-accent);
}

.sh-draft-att-thumb {
  width: 34px;
  height: 34px;
  border-radius: 6px;
  object-fit: cover;
  flex-shrink: 0;
}

.sh-draft-att-icon {
  width: 32px;
  height: 32px;
  border-radius: 6px;
  background: rgba(59, 130, 246, 0.14);
  color: #3b82f6;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.sh-draft-att-info {
  display: flex;
  flex-direction: column;
  min-width: 0;
  text-align: left;
}

.sh-draft-att-name {
  font-size: 11.5px;
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.sh-draft-att-size {
  font-size: 10px;
  color: var(--sh-muted-fg);
}

.sh-draft-att-del {
  position: absolute;
  top: 4px;
  right: 4px;
  width: 17px;
  height: 17px;
  border-radius: 999px;
  border: none;
  background: rgba(0, 0, 0, 0.45);
  color: #fff;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  padding: 0;
  opacity: 0.72;
}

.sh-draft-att-del:hover {
  opacity: 1;
}

/* Sent Message Attachments */
.sh-msg-attachments {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 8px;
}

.sh-att-img-single {
  padding: 0;
  border: 1px solid var(--sh-border);
  border-radius: 9px;
  overflow: hidden;
  background: transparent;
  cursor: pointer;
  max-width: 220px;
  max-height: 220px;
  display: inline-flex;
}

.sh-att-img-single img {
  max-width: 220px;
  max-height: 220px;
  object-fit: cover;
  display: block;
}

.sh-att-img-thumb {
  width: 64px;
  height: 64px;
  padding: 0;
  border: 1px solid var(--sh-border);
  border-radius: 9px;
  overflow: hidden;
  background: transparent;
  cursor: pointer;
}

.sh-att-img-thumb img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}

.sh-att-file-card {
  display: inline-flex;
  align-items: center;
  gap: 9px;
  height: 52px;
  width: min(224px, 100%);
  padding: 0 11px;
  border-radius: 10px;
  border: 1px solid var(--sh-border);
  background: var(--sh-muted);
  color: inherit;
  cursor: pointer;
  transition: border-color 0.12s ease, background 0.12s ease;
}

.sh-att-file-card:hover {
  border-color: #3b82f6;
  background: var(--sh-accent);
}

.sh-att-file-icon {
  width: 32px;
  height: 32px;
  border-radius: 7px;
  background: rgba(59, 130, 246, 0.15);
  color: #3b82f6;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.sh-att-file-name {
  display: block;
  font-size: 12px;
  font-weight: 550;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.sh-att-file-meta {
  display: block;
  font-size: 10.5px;
  color: var(--sh-muted-fg);
}

/* Inline Highlight Mirror Stack */
.sh-composer-editor-stack {
  position: relative;
  width: 100%;
}

.sh-composer-mirror {
  position: absolute;
  inset: 0;
  padding: 10px 13px 6px;
  font-family: inherit;
  font-size: 13px;
  line-height: 1.55;
  white-space: pre-wrap;
  word-wrap: break-word;
  overflow: hidden;
  pointer-events: none;
  color: transparent;
}

.sh-composer-inline-mark {
  background: rgba(59, 130, 246, 0.22);
  color: transparent;
  border-radius: 4px;
  padding: 1px 0;
}

.sh-composer-textarea {
  position: relative;
  z-index: 1;
  width: 100%;
  min-height: 54px;
  max-height: 180px;
  padding: 10px 13px 6px;
  border: none;
  background: transparent;
  color: inherit;
  font-family: inherit;
  font-size: 13px;
  line-height: 1.55;
  resize: none;
}

@keyframes sh-spin-anim {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

.sh-spin {
  animation: sh-spin-anim 0.9s linear infinite;
}

.sh-composer-textarea:focus {
  outline: none;
}

.sh-composer-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 6px 10px 8px;
}

/* Floating Autocomplete Popover (@mention / slash) */
.sh-autocomplete-popover {
  position: absolute;
  left: 8px;
  bottom: calc(100% + 8px);
  width: min(320px, calc(100% - 16px));
  max-height: 250px;
  overflow-y: auto;
  padding: 5px;
  border-radius: 10px;
  border: 1px solid var(--sh-border);
  background: var(--sh-popover);
  box-shadow: var(--sh-shadow-lg);
  z-index: 40;
  animation: sh-fade-up 0.12s ease-out;
}

.sh-menu-item {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 7px 9px;
  border-radius: 6px;
  border: none;
  background: transparent;
  color: inherit;
  font-family: inherit;
  font-size: 12.5px;
  text-align: left;
  cursor: pointer;
}

.sh-menu-item[data-highlighted="true"], .sh-menu-item:hover {
  background: var(--sh-accent);
}

/* Right Inspector */
.dshfam-inspector {
  width: 284px;
  flex-shrink: 0;
  border-left: 1px solid var(--sh-border);
  background: var(--sh-sidebar);
  display: flex;
  flex-direction: column;
  min-height: 0;
}

@container (max-width: 980px) {
  .dshfam-inspector {
    position: absolute;
    top: 0;
    right: 0;
    bottom: 0;
    width: min(284px, 88%);
    z-index: 35;
    box-shadow: var(--sh-shadow-lg);
  }
}

/* Segmented Tabs (shadcn TabsList) */
.sh-tabs-list {
  display: grid;
  grid-template-columns: 1fr 1fr;
  padding: 3px;
  border-radius: 8px;
  background: var(--sh-muted);
  border: 1px solid var(--sh-border);
}

.sh-tabs-trigger {
  height: 26px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--sh-muted-fg);
  font-family: inherit;
  font-size: 11.5px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.14s ease;
}

.sh-tabs-trigger[data-active="true"] {
  background: var(--sh-card);
  color: var(--sh-fg);
  box-shadow: var(--sh-shadow-sm);
}

/* Overlay Sheet & CommandDialog */
.sh-backdrop,
.sh-sheet-backdrop {
  position: absolute;
  inset: 0;
  background: rgba(0, 0, 0, 0.48);
  backdrop-filter: blur(2px);
  z-index: 60;
  display: flex;
  justify-content: flex-end;
  animation: sh-fade-in 0.15s ease-out;
}

.sh-sheet {
  width: min(520px, 92vw);
  height: 100%;
  background: var(--sh-bg);
  border-left: 1px solid var(--sh-border);
  box-shadow: var(--sh-shadow-lg);
  display: flex;
  flex-direction: column;
  animation: sh-slide-left 0.18s cubic-bezier(0.16, 1, 0.3, 1);
}

.sh-sheet-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 15px 18px;
  border-bottom: 1px solid var(--sh-border);
}

.sh-sheet-body {
  flex: 1;
  overflow-y: auto;
  padding: 18px 20px;
}

.sh-sheet-footer {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  padding: 12px 18px;
  border-top: 1px solid var(--sh-border);
  background: var(--sh-sidebar);
}

.sh-field {
  display: flex;
  flex-direction: column;
  gap: 5px;
}

.sh-hint {
  font-size: 11px;
  color: var(--sh-muted-fg);
  line-height: 1.45;
}

.sh-dialog-backdrop {
  position: absolute;
  inset: 0;
  background: rgba(0, 0, 0, 0.48);
  backdrop-filter: blur(2px);
  z-index: 70;
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding-top: 11vh;
  animation: sh-fade-in 0.12s ease-out;
}

.sh-command-dialog {
  width: min(500px, 92vw);
  border-radius: 12px;
  border: 1px solid var(--sh-border);
  background: var(--sh-popover);
  box-shadow: var(--sh-shadow-lg);
  overflow: hidden;
  animation: sh-fade-up 0.14s cubic-bezier(0.16, 1, 0.3, 1);
}

.dshfam-icon-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(100px, 1fr));
  gap: 6px;
}

.dshfam-icon-option {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  padding: 6px 8px;
  border-radius: 7px;
  border: 1px solid var(--sh-border);
  background: transparent;
  color: inherit;
  font-size: 11.5px;
  cursor: pointer;
  transition: background 0.12s ease, border-color 0.12s ease;
}

.dshfam-icon-option:hover {
  background: var(--sh-accent);
}

.dshfam-icon-option[data-selected="true"] {
  border-color: var(--sh-fg);
  background: var(--sh-accent);
  font-weight: 600;
}

.dshfam-chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  border: 1px solid var(--sh-border);
  background: var(--sh-card);
  color: inherit;
  border-radius: 999px;
  padding: 3px 9px;
  font-size: 11.5px;
  cursor: pointer;
  transition: background 0.12s ease, border-color 0.12s ease;
}

.dshfam-chip:hover {
  background: var(--sh-accent);
}

.dshfam-approval-banner {
  margin: 8px 16px 0;
  padding: 11px 14px;
  border-radius: 10px;
  border: 1px solid rgba(245, 158, 11, 0.42);
  background: var(--sh-amber-soft);
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.dshfam-toolcard {
  border: 1px solid var(--sh-border, rgba(128, 128, 128, 0.2));
  border-radius: 10px;
  padding: 11px 13px;
  margin: 6px 0;
  background: var(--sh-card, rgba(128, 128, 128, 0.04));
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.sh-unread-badge {
  min-width: 18px;
  height: 18px;
  padding: 0 5px;
  border-radius: 999px;
  background: var(--sh-emerald, #10b981);
  color: #ffffff;
  font-size: 10.5px;
  font-weight: 700;
  line-height: 18px;
  text-align: center;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.dshfam-live-green-dot {
  width: 7px;
  height: 7px;
  border-radius: 999px;
  background: #10b981;
  box-shadow: 0 0 0 3px rgba(16, 185, 129, 0.22);
  display: inline-block;
  flex-shrink: 0;
  animation: sh-pulse 1.4s ease-in-out infinite;
}

.dshfam-split-bar {
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 7px 10px;
  border-bottom: 1px solid var(--sh-border);
  background: var(--sh-sidebar);
  overflow-x: auto;
  flex-shrink: 0;
}

.dshfam-split-pill {
  height: 27px;
  padding: 0 9px;
  border-radius: 7px;
  border: 1px solid var(--sh-border);
  background: transparent;
  color: var(--sh-muted-fg);
  font-size: 12px;
  font-weight: 500;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  cursor: pointer;
  white-space: nowrap;
  flex-shrink: 0;
  transition: background 0.12s ease, color 0.12s ease, border-color 0.12s ease;
}

.dshfam-split-pill:hover {
  background: var(--sh-accent);
  color: var(--sh-fg);
}

.dshfam-split-pill[data-active="true"] {
  background: var(--sh-card);
  color: var(--sh-fg);
  border-color: var(--sh-fg);
  font-weight: 600;
  box-shadow: var(--sh-shadow-sm);
}

@keyframes sh-fade-in {
  from { opacity: 0; }
  to { opacity: 1; }
}

@keyframes sh-fade-up {
  from { opacity: 0; transform: translateY(4px); }
  to { opacity: 1; transform: translateY(0); }
}

@keyframes sh-slide-left {
  from { transform: translateX(24px); opacity: 0.7; }
  to { transform: translateX(0); opacity: 1; }
}

@keyframes sh-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.45; }
}

@media (prefers-reduced-motion: reduce) {
  .sh-msg-row, .sh-sheet, .sh-command-dialog, .sh-autocomplete-popover, .dshfam-dot {
    animation: none !important;
  }
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
    document.head.appendChild(el);
  }
  el.textContent = FAMILY_CSS;
  return () => undefined;
}
