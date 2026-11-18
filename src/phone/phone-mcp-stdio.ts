import { request as httpRequest } from 'node:http';
import { createInterface } from 'node:readline';

/**
 * 随身「家庭手机」Stdio MCP 轻量代理入口（供 Codex app-server 等 stdio MCP 客户端启动）。
 * 直接使用原生 `node:http` 回环 TCP 转发至 `127.0.0.1`，彻底绕过系统代理环境变量（HTTP_PROXY / ALL_PROXY）
 * 与 undici 默认超时限制，确保长耗时跨成员电话讨论稳定不断线。
 */

const busUrl = process.env.DSH_FAMILY_BUS_URL?.trim() ?? '';
const busToken = process.env.DSH_FAMILY_BUS_TOKEN?.trim() ?? '';
const scopeId = process.env.DSH_FAMILY_SCOPE_ID?.trim() ?? 'default';
const callerId = process.env.DSH_FAMILY_CALLER_ID?.trim() ?? 'unknown';

function postJsonRpcToLoopback(rawJson: string): Promise<{ status: number; text: string }> {
  return new Promise((resolvePost, rejectPost) => {
    let parsed: URL;
    try {
      parsed = new URL(`${busUrl}/mcp?${new URLSearchParams({ scopeId, callerId }).toString()}`);
    } catch (err) {
      rejectPost(err instanceof Error ? err : new Error(String(err)));
      return;
    }

    const bodyBuffer = Buffer.from(rawJson, 'utf8');
    const req = httpRequest(
      {
        hostname: parsed.hostname || '127.0.0.1',
        port: Number(parsed.port),
        path: `${parsed.pathname}${parsed.search}`,
        method: 'POST',
        agent: false,
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Content-Length': bodyBuffer.length,
          Authorization: `Bearer ${busToken}`,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer | string) => {
          chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
        });
        res.on('end', () => {
          resolvePost({
            status: res.statusCode ?? 500,
            text: Buffer.concat(chunks).toString('utf8'),
          });
        });
        res.on('error', rejectPost);
      }
    );

    req.setTimeout(600_000, () => {
      req.destroy(new Error('Family phone loopback call timed out after 600s'));
    });
    req.on('error', rejectPost);
    req.end(bodyBuffer);
  });
}

const rl = createInterface({ input: process.stdin });

rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed.startsWith('{')) return;

  void (async () => {
    let parsedId: string | number | null = null;
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      if (typeof parsed.id === 'string' || typeof parsed.id === 'number') {
        parsedId = parsed.id;
      }
      const res = await postJsonRpcToLoopback(trimmed);
      if (res.status === 202 || parsedId === null) {
        return;
      }
      if (res.text.trim()) {
        process.stdout.write(`${res.text.trim()}\n`);
      }
    } catch (err) {
      if (parsedId !== null) {
        const message = err instanceof Error ? err.message : String(err);
        process.stdout.write(
          `${JSON.stringify({
            jsonrpc: '2.0',
            id: parsedId,
            error: { code: -32603, message: `Family phone proxy failed: ${message}` },
          })}\n`
        );
      }
    }
  })();
});
