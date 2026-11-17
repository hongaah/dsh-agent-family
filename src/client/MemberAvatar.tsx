import anthropicSvg from '@lobehub/icons-static-svg/icons/anthropic.svg';
import claudeColorSvg from '@lobehub/icons-static-svg/icons/claude-color.svg';
import claudeCodeColorSvg from '@lobehub/icons-static-svg/icons/claudecode-color.svg';
import codexColorSvg from '@lobehub/icons-static-svg/icons/codex-color.svg';
import cursorSvg from '@lobehub/icons-static-svg/icons/cursor.svg';
import deepseekColorSvg from '@lobehub/icons-static-svg/icons/deepseek-color.svg';
import doubaoColorSvg from '@lobehub/icons-static-svg/icons/doubao-color.svg';
import geminiColorSvg from '@lobehub/icons-static-svg/icons/gemini-color.svg';
import copilotSvg from '@lobehub/icons-static-svg/icons/githubcopilot.svg';
import grokSvg from '@lobehub/icons-static-svg/icons/grok.svg';
import kimiColorSvg from '@lobehub/icons-static-svg/icons/kimi-color.svg';
import minimaxColorSvg from '@lobehub/icons-static-svg/icons/minimax-color.svg';
import ollamaSvg from '@lobehub/icons-static-svg/icons/ollama.svg';
import openaiSvg from '@lobehub/icons-static-svg/icons/openai.svg';
import opencodeSvg from '@lobehub/icons-static-svg/icons/opencode.svg';
import openrouterColorSvg from '@lobehub/icons-static-svg/icons/openrouter-color.svg';
import qwenColorSvg from '@lobehub/icons-static-svg/icons/qwen-color.svg';
import zhipuColorSvg from '@lobehub/icons-static-svg/icons/zhipu-color.svg';
import React, { useId, useMemo, useState } from 'react';

import { defaultLobeAvatarForBody } from '../core/avatar-spec.ts';
import type { BodyKind } from '../core/types.ts';

export interface LobeVendorIconEntry {
  readonly key: `lobe:${string}`;
  readonly label: string;
  readonly svg: string;
}

export const LOBE_VENDOR_ICONS: readonly LobeVendorIconEntry[] = [
  { key: 'lobe:deepseek', label: 'DeepSeek', svg: deepseekColorSvg },
  { key: 'lobe:claudecode', label: 'Claude Code', svg: claudeCodeColorSvg },
  { key: 'lobe:claude', label: 'Claude', svg: claudeColorSvg },
  { key: 'lobe:codex', label: 'Codex', svg: codexColorSvg },
  { key: 'lobe:openai', label: 'OpenAI', svg: openaiSvg },
  { key: 'lobe:opencode', label: 'OpenCode', svg: opencodeSvg },
  { key: 'lobe:anthropic', label: 'Anthropic', svg: anthropicSvg },
  { key: 'lobe:gemini', label: 'Gemini', svg: geminiColorSvg },
  { key: 'lobe:qwen', label: 'Qwen 通义', svg: qwenColorSvg },
  { key: 'lobe:kimi', label: 'Kimi', svg: kimiColorSvg },
  { key: 'lobe:minimax', label: 'MiniMax', svg: minimaxColorSvg },
  { key: 'lobe:zhipu', label: '智谱 GLM', svg: zhipuColorSvg },
  { key: 'lobe:doubao', label: '豆包', svg: doubaoColorSvg },
  { key: 'lobe:grok', label: 'Grok', svg: grokSvg },
  { key: 'lobe:cursor', label: 'Cursor', svg: cursorSvg },
  { key: 'lobe:copilot', label: 'Copilot', svg: copilotSvg },
  { key: 'lobe:ollama', label: 'Ollama', svg: ollamaSvg },
  { key: 'lobe:openrouter', label: 'OpenRouter', svg: openrouterColorSvg },
];

const LOBE_SVG_MAP = new Map<string, string>(
  LOBE_VENDOR_ICONS.map((entry) => [entry.key, entry.svg])
);

function scopeSvgIdsAndSize(rawSvg: string, scopePrefix: string, pxSize: number): string {
  const sized = rawSvg
    .replace(/\bheight="1em"/gu, `height="${pxSize}"`)
    .replace(/\bwidth="1em"/gu, `width="${pxSize}"`);
  return sized
    .replace(/\bid="([^"]+)"/gu, (_m, idVal: string) => `id="${scopePrefix}-${idVal}"`)
    .replace(/url\(#([^)]+)\)/gu, (_m, idVal: string) => `url(#${scopePrefix}-${idVal})`);
}

export function isPhotoAvatarUrl(avatar: string | undefined): boolean {
  if (!avatar) return false;
  const trimmed = avatar.trim();
  return (
    trimmed.startsWith('/dsh-agent-family/api/avatars/') ||
    trimmed.startsWith('data:image/') ||
    trimmed.startsWith('http://') ||
    trimmed.startsWith('https://')
  );
}

export interface MemberAvatarProps {
  readonly avatar?: string;
  readonly bodyKind?: BodyKind;
  readonly alt?: string;
  readonly size?: number;
  readonly className?: string;
}

/**
 * 统一头像渲染器：
 * 1. `lobe:*` 渲染官方 `@lobehub/icons` 矢量厂商图标（自动隔离渐变 defs ID，暗色/亮色自适应）；
 * 2. `/dsh-agent-family/api/avatars/*` 或 `data:image/*` 渲染用户上传的照片；
 * 3. 兼容特殊身份（如人类 `human`、群聊 `group`）与历史 Emoji。
 */
export function MemberAvatar({
  avatar,
  bodyKind,
  alt = '',
  size = 30,
  className = 'dshfam-avatar',
}: MemberAvatarProps): React.ReactElement {
  const rawUid = useId();
  const safeUid = useMemo(() => rawUid.replace(/[^a-zA-Z0-9_-]/gu, 'u'), [rawUid]);
  const [photoFailed, setPhotoFailed] = useState<boolean>(false);

  const effectiveAvatar =
    !photoFailed && avatar && avatar.trim()
      ? avatar.trim()
      : bodyKind
        ? defaultLobeAvatarForBody(bodyKind)
        : 'lobe:deepseek';

  const iconInnerPx = Math.max(14, Math.round(size * 0.64));

  if (!photoFailed && isPhotoAvatarUrl(effectiveAvatar)) {
    return (
      <span
        className={className}
        style={{
          width: size,
          height: size,
          padding: 0,
          overflow: 'hidden',
        }}
      >
        <img
          src={effectiveAvatar}
          alt={alt}
          onError={() => setPhotoFailed(true)}
          style={{
            width: '100%',
            height: '100%',
            objectFit: 'cover',
            display: 'block',
          }}
        />
      </span>
    );
  }

  const lobeSvg = LOBE_SVG_MAP.get(effectiveAvatar);
  if (lobeSvg) {
    const html = scopeSvgIdsAndSize(lobeSvg, safeUid, iconInnerPx);
    return (
      <span
        className={className}
        style={{ width: size, height: size }}
        aria-label={alt || effectiveAvatar}
        dangerouslySetInnerHTML={{ __html: html }}
      />
    );
  }

  return (
    <span
      className={className}
      style={{
        width: size,
        height: size,
        fontSize: Math.max(12, Math.round(size * 0.5)),
      }}
    >
      {effectiveAvatar}
    </span>
  );
}

/**
 * 在浏览器端将用户选择的本地照片居中裁剪缩放为清晰的 256×256 方形头像（GIF 与 SVG 保留原格式）。
 */
export async function prepareUploadedPhotoDataUrl(file: File): Promise<string> {
  if (!file.type.startsWith('image/')) {
    throw new Error('请选择 PNG、JPG、WebP、GIF 或 SVG 图片文件。');
  }

  const rawDataUrl = await new Promise<string>((resolveRead, rejectRead) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') {
        resolveRead(reader.result);
      } else {
        rejectRead(new Error('读取图片文件失败。'));
      }
    };
    reader.onerror = () => rejectRead(new Error('读取图片文件失败。'));
    reader.readAsDataURL(file);
  });

  if (file.type === 'image/gif' || file.type === 'image/svg+xml') {
    return rawDataUrl;
  }

  return new Promise<string>((resolveCrop, rejectCrop) => {
    const img = new Image();
    img.onload = () => {
      const targetSize = 256;
      const canvas = document.createElement('canvas');
      canvas.width = targetSize;
      canvas.height = targetSize;
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        resolveCrop(rawDataUrl);
        return;
      }
      const side = Math.min(img.naturalWidth || img.width, img.naturalHeight || img.height);
      const sx = Math.max(0, ((img.naturalWidth || img.width) - side) / 2);
      const sy = Math.max(0, ((img.naturalHeight || img.height) - side) / 2);
      ctx.drawImage(img, sx, sy, side, side, 0, 0, targetSize, targetSize);
      const webp = canvas.toDataURL('image/webp', 0.88);
      if (webp.startsWith('data:image/webp')) {
        resolveCrop(webp);
      } else {
        resolveCrop(canvas.toDataURL('image/png'));
      }
    };
    img.onerror = () => rejectCrop(new Error('解析所选图片失败，请换一张照片试试。'));
    img.src = rawDataUrl;
  });
}
