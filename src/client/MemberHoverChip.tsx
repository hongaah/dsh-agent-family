import { FileText, Image as ImageIcon } from 'lucide-react';
import React, { useRef, useState } from 'react';

import { PERMISSION_MODE_METAS } from '../core/permission-policy.ts';
import type { FamilyMember, FamilyMessageAttachment } from '../core/types.ts';
import { MemberAvatar } from './MemberAvatar.tsx';
import { formatShortModelBadge } from './ModelQuickPopover.tsx';

declare const require: ((id: string) => unknown) | undefined;

interface HostReferenceChipProps {
  readonly appearance: 'file' | 'folder' | 'session';
  readonly label: string;
  readonly title?: string;
  readonly onActivate?: () => void;
}

let cachedReferenceChip: React.ComponentType<HostReferenceChipProps> | null | undefined;

function getHostReferenceChip(): React.ComponentType<HostReferenceChipProps> | null {
  if (cachedReferenceChip !== undefined) return cachedReferenceChip;
  try {
    if (typeof require === 'function') {
      const mod = require('@deepseek-ai/dsh-client-ui-primitives') as
        | Record<string, unknown>
        | undefined;
      if (mod && typeof mod.ReferenceChip === 'function') {
        cachedReferenceChip = mod.ReferenceChip as React.ComponentType<HostReferenceChipProps>;
        return cachedReferenceChip;
      }
    }
  } catch {
    // standalone fallback
  }
  cachedReferenceChip = null;
  return null;
}

export function FileReferenceHighlightChip({
  label,
  fullPath,
  kind = 'file',
  onOpen,
}: {
  readonly label: string;
  readonly fullPath: string;
  readonly kind?: 'file' | 'folder';
  readonly onOpen?: () => void;
}): React.ReactElement {
  const HostChip = getHostReferenceChip();
  if (HostChip) {
    return (
      <span style={{ display: 'inline-flex', verticalAlign: 'baseline' }}>
        <HostChip
          appearance={kind === 'folder' ? 'folder' : 'file'}
          label={label}
          title={fullPath}
          {...(onOpen ? { onActivate: onOpen } : {})}
        />
      </span>
    );
  }

  return (
    <button
      type="button"
      className="sh-file-ref-pill"
      onClick={onOpen}
      title={fullPath}
    >
      <FileText size={11} style={{ flexShrink: 0 }} />
      <span>{label}</span>
    </button>
  );
}

export function MemberHoverCardWrap({
  member,
  statusText,
  align = 'left',
  children,
}: {
  readonly member: FamilyMember;
  readonly statusText?: string;
  readonly align?: 'left' | 'right';
  readonly children: React.ReactNode;
}): React.ReactElement {
  const [hovered, setHovered] = useState<boolean>(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const show = () => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setHovered(true), 120);
  };

  const hide = () => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setHovered(false), 90);
  };

  const permLabel =
    PERMISSION_MODE_METAS.find((p) => p.value === (member.body.permissionMode ?? 'ask'))
      ?.shortLabel ?? '每次询问';
  const modelLabel = formatShortModelBadge(member.body);

  return (
    <span
      className="sh-member-hover-anchor"
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocus={show}
      onBlur={hide}
    >
      {children}
      {hovered && (
        <span
          role="tooltip"
          className="sh-member-hovercard"
          data-align={align}
          onMouseEnter={show}
          onMouseLeave={hide}
        >
          <span style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
            <MemberAvatar
              avatar={member.avatar}
              bodyKind={member.body.kind}
              alt={member.name}
              size={32}
            />
            <span style={{ minWidth: 0, flex: 1 }}>
              <span style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                <strong style={{ fontSize: 13, fontWeight: 650 }}>{member.name}</strong>
                <span className="sh-badge" style={{ fontSize: 10.5 }}>
                  @{member.id}
                </span>
              </span>
              <span
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 5,
                  marginTop: 3,
                  flexWrap: 'wrap',
                }}
              >
                <span className="sh-badge">{member.body.kind}</span>
                <span className="sh-badge">{permLabel}</span>
                {modelLabel !== 'CLI 默认' && <span className="sh-badge">{modelLabel}</span>}
              </span>
            </span>
          </span>
          <span
            style={{
              display: 'block',
              marginTop: 7,
              fontSize: 11.5,
              lineHeight: 1.48,
              color: 'var(--sh-muted-fg)',
              whiteSpace: 'normal',
            }}
          >
            {member.specialty}
          </span>
          {statusText && (
            <span
              style={{
                display: 'block',
                marginTop: 5,
                paddingTop: 5,
                borderTop: '1px solid var(--sh-border)',
                fontSize: 11,
                color: '#10b981',
              }}
            >
              状态：{statusText}
            </span>
          )}
        </span>
      )}
    </span>
  );
}

export function MemberMentionPill({
  member,
  fallbackId,
  onClick,
}: {
  readonly member?: FamilyMember;
  readonly fallbackId: string;
  readonly onClick?: () => void;
}): React.ReactElement {
  if (!member) {
    return (
      <button
        type="button"
        className="sh-mention-pill"
        onClick={onClick}
      >
        @{fallbackId}
      </button>
    );
  }

  return (
    <MemberHoverCardWrap member={member}>
      <button
        type="button"
        className="sh-mention-pill sh-mention-name-pill"
        onClick={onClick}
      >
        <MemberAvatar
          avatar={member.avatar}
          bodyKind={member.body.kind}
          alt={member.name}
          size={13}
        />
        <span>@{member.name}</span>
      </button>
    </MemberHoverCardWrap>
  );
}

function formatBytesSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function extensionBadgeOf(name: string): string {
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || dot === name.length - 1) return 'FILE';
  return name.slice(dot + 1, dot + 7).toUpperCase();
}

/**
 * 消息气泡中的附件高亮列表（单击图片或文件统一调用 DSH 原生右侧栏文件预览 openResource，不重复造预览轮子）。
 */
export function MessageAttachmentsStrip({
  attachments,
  onOpenFile,
}: {
  readonly attachments?: readonly FamilyMessageAttachment[];
  readonly onOpenFile?: (filePath: string) => void;
}): React.ReactElement | null {
  if (!attachments || attachments.length === 0) return null;

  const singleImageOnly = attachments.length === 1 && attachments[0]?.kind === 'image';

  return (
    <div className="sh-msg-attachments">
      {attachments.map((att) => {
        const canPreview = Boolean(onOpenFile && att.filePath);
        if (att.kind === 'image' && att.previewUrl) {
          return (
            <button
              key={att.id}
              type="button"
              className={singleImageOnly ? 'sh-att-img-single' : 'sh-att-img-thumb'}
              title={canPreview ? `点击在 DSH 右侧栏预览 ${att.name}` : att.name}
              onClick={() => {
                if (canPreview) onOpenFile?.(att.filePath);
              }}
            >
              <img src={att.previewUrl} alt={att.name} loading="lazy" />
            </button>
          );
        }

        return (
          <button
            key={att.id}
            type="button"
            className="sh-att-file-card"
            title={canPreview ? `点击在 DSH 右侧栏预览 ${att.name}` : att.name}
            onClick={() => {
              if (canPreview) onOpenFile?.(att.filePath);
            }}
          >
            <span className="sh-att-file-icon">
              {att.kind === 'image' ? <ImageIcon size={15} /> : <FileText size={15} />}
            </span>
            <span style={{ minWidth: 0, flex: 1, textAlign: 'left' }}>
              <span className="sh-att-file-name">{att.name}</span>
              <span className="sh-att-file-meta">
                {extensionBadgeOf(att.name)} · {formatBytesSize(att.sizeBytes)}
              </span>
            </span>
          </button>
        );
      })}
    </div>
  );
}
