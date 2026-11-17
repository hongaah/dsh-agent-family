import type { BodyKind } from './types.ts';

const DEFAULT_BODY_LOBE_ICONS: Readonly<Record<BodyKind, string>> = {
  claude: 'lobe:claudecode',
  codex: 'lobe:codex',
  opencode: 'lobe:opencode',
  dsh: 'lobe:deepseek',
};

export function defaultLobeAvatarForBody(kind: BodyKind): string {
  return DEFAULT_BODY_LOBE_ICONS[kind];
}

export function isGraphicalAvatar(avatar: string | undefined): boolean {
  if (!avatar) return false;
  const trimmed = avatar.trim();
  return (
    trimmed.startsWith('lobe:') ||
    trimmed.startsWith('/dsh-agent-family/api/avatars/') ||
    trimmed.startsWith('data:image/') ||
    trimmed.startsWith('http://') ||
    trimmed.startsWith('https://')
  );
}

/**
 * 用于构造发送给大模型的纯文本提示词前缀：
 * - 若是 `lobe:*` 厂商图标或上传的照片 URL / base64，一律返回空串，防止污染模型提示词或浪费 Token；
 * - 若是简短字符/Emoji，保留 `${trimmed} `。
 */
export function formatAvatarPrefixForPrompt(avatar: string | undefined): string {
  if (!avatar) return '';
  const trimmed = avatar.trim();
  if (!trimmed || isGraphicalAvatar(trimmed) || trimmed.length > 8) {
    return '';
  }
  return `${trimmed} `;
}
