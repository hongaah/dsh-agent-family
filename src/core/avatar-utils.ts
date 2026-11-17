import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export {
  defaultLobeAvatarForBody,
  formatAvatarPrefixForPrompt,
  isGraphicalAvatar,
} from './avatar-spec.ts';

export const MAX_AVATAR_BYTES = 2 * 1024 * 1024;

const MIME_TO_EXT: Readonly<Record<string, string>> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/svg+xml': 'svg',
};

const EXT_TO_MIME: Readonly<Record<string, string>> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  svg: 'image/svg+xml',
};

const SAFE_AVATAR_FILENAME = /^[a-z0-9-]+\.(png|jpg|webp|gif|svg)$/u;
const DATA_URL_PATTERN =
  /^data:(image\/(?:png|jpeg|webp|gif|svg\+xml));base64,([A-Za-z0-9+/=\s]+)$/u;

function assertSafeSvgContent(buffer: Buffer): void {
  const text = buffer.toString('utf8');
  if (/<script\b|javascript:|on[a-z]+\s*=|<foreignObject\b/iu.test(text)) {
    throw new Error('SVG 头像包含不安全的脚本或事件属性，已拒绝保存。');
  }
}

export class AvatarStore {
  private readonly avatarsDir: string;

  public constructor(storageDir: string) {
    this.avatarsDir = join(storageDir, 'avatars');
  }

  public saveDataUrl(dataUrl: string): {
    readonly filename: string;
    readonly url: string;
    readonly mimeType: string;
  } {
    const match = DATA_URL_PATTERN.exec(dataUrl.trim());
    if (!match) {
      throw new Error('仅支持上传 PNG、JPG、WebP、GIF 或 SVG 格式的图片。');
    }
    const mimeType = match[1]!;
    const base64Body = match[2]!.replace(/\s+/gu, '');
    const ext = MIME_TO_EXT[mimeType];
    if (!ext) {
      throw new Error(`不支持的图片格式: ${mimeType}`);
    }

    const buffer = Buffer.from(base64Body, 'base64');
    if (buffer.byteLength === 0) {
      throw new Error('上传的图片内容为空。');
    }
    if (buffer.byteLength > MAX_AVATAR_BYTES) {
      throw new Error('头像图片体积不能超过 2MB，请压缩后重试。');
    }
    if (mimeType === 'image/svg+xml') {
      assertSafeSvgContent(buffer);
    }

    mkdirSync(this.avatarsDir, { recursive: true });
    const filename = `${randomUUID()}.${ext}`;
    const fullPath = join(this.avatarsDir, filename);
    writeFileSync(fullPath, buffer);

    return {
      filename,
      url: `/dsh-agent-family/api/avatars/${filename}`,
      mimeType,
    };
  }

  public readAvatarFile(
    filename: string
  ): { readonly buffer: Buffer; readonly mimeType: string } | undefined {
    const normalized = filename.trim();
    if (!SAFE_AVATAR_FILENAME.test(normalized)) {
      return undefined;
    }
    const fullPath = join(this.avatarsDir, normalized);
    if (!existsSync(fullPath)) {
      return undefined;
    }
    const ext = normalized.split('.').pop() ?? '';
    const mimeType = EXT_TO_MIME[ext];
    if (!mimeType) return undefined;
    return {
      buffer: readFileSync(fullPath),
      mimeType,
    };
  }
}
