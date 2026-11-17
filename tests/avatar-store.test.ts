import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  AvatarStore,
  defaultLobeAvatarForBody,
  formatAvatarPrefixForPrompt,
} from '../src/core/avatar-utils.ts';
import { MemberRegistry } from '../src/core/member-registry.ts';
import { composeAwakeningSoul } from '../src/core/soul-composer.ts';
import type { DshHostContext, DshWebRoute } from '../src/host/dsh-types.ts';
import { createFamilyHostPlugin } from '../src/host/index.ts';

// 1x1 透明 PNG
const TINY_PNG_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

describe('Lobe Vendor Icons & Custom Photo Avatar Upload', () => {
  let tempDir: string;
  let httpServer: Server | null = null;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'dsh-family-avatars-'));
  });

  afterEach(async () => {
    if (httpServer) {
      await new Promise<void>((r) => httpServer!.close(() => r()));
      httpServer = null;
    }
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('maps each CLI body kind to its official lobe-icons vendor identifier by default', () => {
    expect(defaultLobeAvatarForBody('claude')).toBe('lobe:claudecode');
    expect(defaultLobeAvatarForBody('codex')).toBe('lobe:codex');
    expect(defaultLobeAvatarForBody('opencode')).toBe('lobe:opencode');
    expect(defaultLobeAvatarForBody('dsh')).toBe('lobe:deepseek');

    const registry = new MemberRegistry(tempDir);
    const created = registry.create({
      id: 'auto-icon',
      name: '默认图标成员',
      specialty: '自动匹配厂商图标',
      body: { kind: 'codex' },
      soulPrompt: '实干派',
    });
    expect(created.avatar).toBe('lobe:codex');
  });

  it('never leaks lobe:* identifiers, avatar URLs, or base64 data URLs into LLM prompts', () => {
    expect(formatAvatarPrefixForPrompt('lobe:deepseek')).toBe('');
    expect(formatAvatarPrefixForPrompt('/dsh-agent-family/api/avatars/abc.png')).toBe('');
    expect(formatAvatarPrefixForPrompt(TINY_PNG_DATA_URL)).toBe('');
    expect(formatAvatarPrefixForPrompt('🐳')).toBe('🐳 ');

    const registry = new MemberRegistry(tempDir);
    const member = registry.create({
      id: 'photo-agent',
      name: '自拍达人',
      avatar: '/dsh-agent-family/api/avatars/custom-123.png',
      specialty: '测试头像隔离',
      body: { kind: 'claude' },
      soulPrompt: '专注代码',
    });
    const composed = composeAwakeningSoul(member, [member]);
    expect(composed).not.toContain('/dsh-agent-family/api/avatars/');
    expect(composed).toContain('自拍达人');
  });

  it('stores valid uploaded photos, blocks script-injected SVGs and path traversal, and serves via Host HTTP API', async () => {
    const store = new AvatarStore(tempDir);
    const saved = store.saveDataUrl(TINY_PNG_DATA_URL);
    expect(saved.url).toMatch(/^\/dsh-agent-family\/api\/avatars\/[a-z0-9-]+\.png$/);

    const readBack = store.readAvatarFile(saved.filename);
    expect(readBack?.mimeType).toBe('image/png');
    expect(readBack?.buffer.byteLength).toBeGreaterThan(10);

    // 拦截路径穿越
    expect(store.readAvatarFile('../members.json')).toBeUndefined();
    expect(store.readAvatarFile('..\\members.json')).toBeUndefined();

    // 拦截非图片与带脚本 SVG
    expect(() => store.saveDataUrl('data:text/html;base64,PGh0bWw+')).toThrow(/格式|图片/i);
    const evilSvg = `data:image/svg+xml;base64,${Buffer.from('<svg><script>alert(1)</script></svg>').toString('base64')}`;
    expect(() => store.saveDataUrl(evilSvg)).toThrow(/script|安全/i);

    // 验证 Host HTTP 上传与读取闭环
    let routes: DshWebRoute[] = [];
    const ctx: DshHostContext = {
      sessions: { get: () => undefined },
      tools: { register: () => () => undefined },
      webServer: {
        register: (route) => {
          routes.push(route);
          return () => {
            routes = routes.filter((r) => r !== route);
          };
        },
      },
      get: () => undefined,
      effect: (fn) => {
        const c = fn();
        return typeof c === 'function' ? c : () => undefined;
      },
      inject: (_d, cb) => {
        const c = cb(ctx);
        return typeof c === 'function' ? c : () => undefined;
      },
      on: () => () => undefined,
    };

    createFamilyHostPlugin({ storageDir: tempDir }).apply(ctx);

    httpServer = createServer((req, res) => {
      const matched = routes.find((r) => (req.url ?? '').startsWith(r.path));
      if (!matched) {
        res.writeHead(404);
        res.end();
        return;
      }
      void matched.handler(req, res);
    });
    await new Promise<void>((r) => httpServer!.listen(0, '127.0.0.1', () => r()));
    const port = (httpServer.address() as AddressInfo).port;
    const base = `http://127.0.0.1:${port}`;

    const uploadRes = await fetch(`${base}/dsh-agent-family/api/avatars`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dataUrl: TINY_PNG_DATA_URL }),
    });
    expect(uploadRes.status).toBe(200);
    const uploaded = (await uploadRes.json()) as { url: string };
    expect(uploaded.url).toContain('/dsh-agent-family/api/avatars/');

    const getRes = await fetch(`${base}${uploaded.url}`);
    expect(getRes.status).toBe(200);
    expect(getRes.headers.get('content-type')).toBe('image/png');
    const bytes = await getRes.arrayBuffer();
    expect(bytes.byteLength).toBeGreaterThan(10);
  });
});
