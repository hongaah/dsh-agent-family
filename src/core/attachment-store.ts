import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';

import type { FamilyMessageAttachment, WorkspaceFileCandidate } from './types.ts';

const execFileAsync = promisify(execFile);

const MAX_ATTACHMENT_BYTES = 32 * 1024 * 1024;
const IMAGE_MIME_SET = new Set([
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/webp',
  'image/gif',
  'image/svg+xml',
]);

const EXT_TO_MIME: Readonly<Record<string, string>> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.ts': 'text/plain; charset=utf-8',
  '.tsx': 'text/plain; charset=utf-8',
  '.js': 'text/plain; charset=utf-8',
  '.jsx': 'text/plain; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
};

const IGNORED_SEARCH_DIRS = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  '.next',
  '.nuxt',
  '.turbo',
  'coverage',
  'target',
  '__pycache__',
  '.venv',
]);

function sanitizeAttachmentFileName(rawName: string, fallbackExt: string = '.bin'): string {
  const base = basename(rawName.replace(/\\/gu, '/')).trim();
  const cleaned = base
    .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/gu, '_')
    .replace(/^\.+/u, '');
  if (!cleaned) {
    return `attachment${fallbackExt}`;
  }
  return cleaned.slice(0, 120);
}

function parseBase64OrDataUrl(raw: string): { mimeFromHeader?: string; buffer: Buffer } {
  const trimmed = raw.trim();
  const dataUrlMatch = /^data:([^;,]+)?;base64,([\s\S]+)$/iu.exec(trimmed);
  if (dataUrlMatch) {
    return {
      mimeFromHeader: dataUrlMatch[1]?.trim().toLowerCase(),
      buffer: Buffer.from(dataUrlMatch[2] ?? '', 'base64'),
    };
  }
  return {
    buffer: Buffer.from(trimmed, 'base64'),
  };
}

const MIME_TO_EXT: Readonly<Record<string, string>> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'image/svg+xml': '.svg',
  'application/pdf': '.pdf',
};

export class FamilyAttachmentStore {
  private readonly attachmentsDir: string;
  private readonly apiPrefix: string;

  public constructor(storageDir: string, apiPrefix: string = '/dsh-agent-family/api') {
    this.attachmentsDir = join(storageDir, 'attachments');
    this.apiPrefix = apiPrefix;
  }

  public saveRawBuffer(input: {
    readonly name: string;
    readonly mimeType?: string;
    readonly buffer: Buffer | Uint8Array;
  }): FamilyMessageAttachment {
    const buf = Buffer.isBuffer(input.buffer) ? input.buffer : Buffer.from(input.buffer);
    if (buf.byteLength === 0) {
      throw new Error('附件内容不能为空。');
    }
    if (buf.byteLength > MAX_ATTACHMENT_BYTES) {
      throw new Error('单个附件大小上限为 32 MB。');
    }

    const id = randomUUID().replace(/-/gu, '').slice(0, 16);
    const ext = extname(input.name).toLowerCase();
    const inferredMime =
      (input.mimeType?.trim().toLowerCase() || EXT_TO_MIME[ext]) ??
      'application/octet-stream';
    const isImage = IMAGE_MIME_SET.has(inferredMime);
    const fallbackExt = MIME_TO_EXT[inferredMime] ?? (isImage ? '.png' : ext || '.bin');

    let safeName = sanitizeAttachmentFileName(input.name, fallbackExt);
    if (!extname(safeName) && fallbackExt) {
      safeName = `${safeName}${fallbackExt}`;
    }

    const itemDir = join(this.attachmentsDir, id);
    mkdirSync(itemDir, { recursive: true });
    const filePath = join(itemDir, safeName);
    writeFileSync(filePath, buf);

    const meta: FamilyMessageAttachment = {
      id,
      kind: isImage ? 'image' : 'file',
      name: safeName,
      mimeType: inferredMime,
      sizeBytes: buf.byteLength,
      filePath,
      previewUrl: `${this.apiPrefix}/attachments/${id}`,
    };
    writeFileSync(join(itemDir, '.meta.json'), `${JSON.stringify(meta, null, 2)}\n`, 'utf8');
    return meta;
  }

  public saveUploadedFile(input: {
    readonly name: string;
    readonly mimeType?: string;
    readonly dataBase64: string;
  }): FamilyMessageAttachment {
    const { mimeFromHeader, buffer } = parseBase64OrDataUrl(input.dataBase64);
    return this.saveRawBuffer({
      name: input.name,
      mimeType: input.mimeType?.trim().toLowerCase() || mimeFromHeader,
      buffer,
    });
  }

  /**
   * 将本机磁盘上的已有文件（如 DSH 主会话附件对象、工作区文件、或某位 Agent 生成的截图/文档路径）
   * 导入注册为家庭标准附件：既生成前端可直接展示的 `previewUrl` 高亮卡片/缩略图，又补齐标准扩展名供各 CLI 原生多模态识别。
   */
  public importFromLocalPath(params: {
    readonly filePath: string;
    readonly baseCwd?: string;
    readonly displayName?: string;
    readonly mimeType?: string;
  }): FamilyMessageAttachment | null {
    const cleanedRaw = params.filePath.trim().replace(/^@"?|"?$/gu, '');
    if (!cleanedRaw) return null;
    const absSource = params.baseCwd ? resolve(params.baseCwd, cleanedRaw) : resolve(cleanedRaw);
    if (!existsSync(absSource)) return null;

    let st;
    try {
      st = statSync(absSource);
    } catch {
      return null;
    }
    if (!st.isFile()) return null;

    const rawName = params.displayName?.trim() || basename(absSource);
    const ext = (extname(rawName) || extname(absSource)).toLowerCase();
    const inferredMime =
      (params.mimeType?.trim().toLowerCase() || EXT_TO_MIME[ext]) ??
      'application/octet-stream';
    const isImage = IMAGE_MIME_SET.has(inferredMime);
    const desiredExt = MIME_TO_EXT[inferredMime] ?? (isImage ? '.png' : ext || '');

    let safeName = sanitizeAttachmentFileName(rawName, desiredExt || '.bin');
    if (!extname(safeName) && desiredExt) {
      safeName = `${safeName}${desiredExt}`;
    }

    const id = randomUUID().replace(/-/gu, '').slice(0, 16);
    const itemDir = join(this.attachmentsDir, id);
    mkdirSync(itemDir, { recursive: true });

    // 若源文件缺少扩展名（如 DSH 底层 sha256 裸对象）或体积适中（<= 16MB），拷贝一份带标准扩展名的快照以便 Codex localImage 与 DSH 预览器准确识别类型
    let finalFilePath = absSource;
    if (!extname(absSource) || st.size <= 16 * 1024 * 1024) {
      const copiedPath = join(itemDir, safeName);
      try {
        copyFileSync(absSource, copiedPath);
        finalFilePath = copiedPath;
      } catch {
        finalFilePath = absSource;
      }
    }

    const meta: FamilyMessageAttachment = {
      id,
      kind: isImage ? 'image' : 'file',
      name: safeName,
      mimeType: inferredMime,
      sizeBytes: st.size,
      filePath: finalFilePath,
      previewUrl: `${this.apiPrefix}/attachments/${id}`,
    };
    writeFileSync(join(itemDir, '.meta.json'), `${JSON.stringify(meta, null, 2)}\n`, 'utf8');
    return meta;
  }

  public getAttachmentMeta(id: string): FamilyMessageAttachment | null {
    const cleanId = id.replace(/[^a-zA-Z0-9_-]/gu, '');
    if (!cleanId) return null;
    const metaPath = join(this.attachmentsDir, cleanId, '.meta.json');
    if (!existsSync(metaPath)) return null;
    try {
      const parsed = JSON.parse(readFileSync(metaPath, 'utf8')) as FamilyMessageAttachment;
      if (!parsed.filePath || !existsSync(parsed.filePath)) return null;
      return parsed;
    } catch {
      return null;
    }
  }

  public readAttachmentBytes(id: string): {
    readonly meta: FamilyMessageAttachment;
    readonly buffer: Buffer;
  } | null {
    const meta = this.getAttachmentMeta(id);
    if (!meta) return null;
    try {
      const buffer = readFileSync(meta.filePath);
      return { meta, buffer };
    } catch {
      return null;
    }
  }
}

function toWorkspaceCandidate(relPosix: string): WorkspaceFileCandidate {
  const base = basename(relPosix);
  const dir = dirname(relPosix);
  return {
    path: relPosix,
    name: base,
    parentDir: dir === '.' ? '' : dir,
  };
}

/**
 * 极速检索当前会话工作目录下的文件列表（供输入框 `@` 联合检索家庭成员与工作区文件）。
 */
export async function searchWorkspaceFiles(
  rawCwd: string,
  query: string,
  limit: number = 25
): Promise<WorkspaceFileCandidate[]> {
  const cwd = resolve(rawCwd);
  if (!existsSync(cwd)) return [];

  let allRelPaths: string[] = [];
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['ls-files', '-co', '--exclude-standard', '-z'],
      { cwd, timeout: 1500, maxBuffer: 8 * 1024 * 1024 }
    );
    allRelPaths = stdout
      .split('\0')
      .map((s) => s.trim())
      .filter((s) => Boolean(s) && !s.startsWith('..'));
  } catch {
    // 非 Git 目录走轻量广度遍历
    const queue: Array<{ dir: string; depth: number }> = [{ dir: cwd, depth: 0 }];
    while (queue.length > 0 && allRelPaths.length < 2500) {
      const cur = queue.shift()!;
      let entries;
      try {
        entries = await readdir(cur.dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const d of entries) {
        if (d.name === '.DS_Store' || IGNORED_SEARCH_DIRS.has(d.name)) continue;
        const abs = join(cur.dir, d.name);
        if (d.isDirectory()) {
          if (cur.depth < 4) queue.push({ dir: abs, depth: cur.depth + 1 });
        } else if (d.isFile()) {
          allRelPaths.push(relative(cwd, abs).split(sep).join('/'));
          if (allRelPaths.length >= 2500) break;
        }
      }
    }
  }

  const q = query.trim().toLowerCase();
  const clamped = Math.max(1, Math.min(60, limit));

  if (!q) {
    return allRelPaths.slice(0, clamped).map(toWorkspaceCandidate);
  }

  const scored: Array<{ score: number; path: string }> = [];
  for (const relPath of allRelPaths) {
    const lowerPath = relPath.toLowerCase();
    const lowerBase = basename(lowerPath);
    if (lowerBase === q) {
      scored.push({ score: 0, path: relPath });
    } else if (lowerBase.startsWith(q)) {
      scored.push({ score: 1, path: relPath });
    } else if (lowerBase.includes(q)) {
      scored.push({ score: 2, path: relPath });
    } else if (lowerPath.includes(q)) {
      scored.push({ score: 3, path: relPath });
    }
  }

  scored.sort((a, b) => (a.score !== b.score ? a.score - b.score : a.path.length - b.path.length));
  return scored.slice(0, clamped).map((s) => toWorkspaceCandidate(s.path));
}

export function formatAttachmentsForAgentPrompt(
  attachments?: readonly FamilyMessageAttachment[]
): string {
  if (!attachments || attachments.length === 0) return '';
  const lines = attachments.map((att) =>
    att.kind === 'image'
      ? `- 🖼️ [图片附件: ${att.name}] 本地路径: \`${att.filePath}\` (${Math.max(1, Math.round(att.sizeBytes / 1024))} KB)`
      : `- 📎 [文件附件: ${att.name}] 本地只读路径: \`${att.filePath}\` (${Math.max(1, Math.round(att.sizeBytes / 1024))} KB，请直接读取该路径查看完整内容)`
  );
  return ['【用户随本条消息附带的附件】', ...lines].join('\n');
}
