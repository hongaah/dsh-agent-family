import { createInterface } from 'node:readline';

/**
 * 随身「家庭手机」Stdio MCP 轻量代理入口（供 Codex app-server 等 stdio MCP 客户端启动）。
 * 将标准输入中的 MCP JSON-RPC 行请求转发给宿主本地 `FamilyPhoneBus` HTTP 回环端点。
 */

const busUrl = process.env.DSH_FAMILY_BUS_URL?.trim() ?? '';
const busToken = process.env.DSH_FAMILY_BUS_TOKEN?.trim() ?? '';
const scopeId = process.env.DSH_FAMILY_SCOPE_ID?.trim() ?? 'default';
const callerId = process.env.DSH_FAMILY_CALLER_ID?.trim() ?? 'unknown';

const endpoint = `${busUrl}/mcp?${new URLSearchParams({ scopeId, callerId }).toString()}`;

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
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${busToken}`,
        },
        body: trimmed,
      });
      if (res.status === 202 || parsedId === null) {
        return;
      }
      const text = await res.text();
      if (text.trim()) {
        process.stdout.write(`${text.trim()}\n`);
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
