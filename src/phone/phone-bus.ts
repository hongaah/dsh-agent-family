import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';

import { resolveNodeExecutable } from '../core/cli-locator.ts';
import type { FamilyHub } from '../core/family-hub.ts';
import type { PhoneCallIntent, PhoneMcpLaunchSpec } from '../core/types.ts';

const PHONE_TOOL_SCHEMAS = [
  {
    name: 'phone_contacts',
    description:
      '查看智能体家庭通讯录：列出当前家里在岗的其他成员（称呼、@代号、身体类型、专长、忙闲状态）以及可用群聊。需要找人商量或配合前可先查看。',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    annotations: {
      title: '查看智能体家庭通讯录',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: 'phone_call',
    description:
      '使用家庭手机给指定家庭成员打一对一电话（探讨方案、请求协助或同步进展）。对方会基于自身灵魂与专业立场独立回复（可能配合，也可能提出反建议或明确拒绝）。',
    inputSchema: {
      type: 'object',
      properties: {
        to: {
          type: 'string',
          description: '目标成员的唯一 ID（例如 fe-sis、be-bro，可不带 @）',
        },
        intent: {
          type: 'string',
          enum: ['discuss', 'request_help', 'sync'],
          description: '通话意图：discuss(探讨方案) / request_help(请求协助) / sync(同步知会)',
        },
        message: {
          type: 'string',
          description: '在电话里向对方清晰说明的背景、问题或协作诉求',
        },
        attachments: {
          type: 'array',
          items: { type: 'string' },
          description:
            '可选：随电话发送给对方的本地图片或文件附件路径数组（支持相对当前工作目录或绝对路径；图片会自动作为视觉多模态附件传给对方并在面板展示缩略图，文件会展示高亮附件卡并提供可读路径）',
        },
      },
      required: ['to', 'message'],
      additionalProperties: false,
    },
    annotations: {
      title: '拨打家庭成员一对一电话',
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
    },
  },
  {
    name: 'phone_group_discuss',
    description:
      '在家庭群聊（默认家庭总群 family-main，或指定 participants 拉起专题小群）发起多人当面讨论。群成员可看到彼此发言并互相 @ 接龙讨论或提出异议，讨论收敛后返回完整纪要。',
    inputSchema: {
      type: 'object',
      properties: {
        groupId: {
          type: 'string',
          description: '可选群 ID；省略且未传 participants 时默认发往家庭总群 family-main',
        },
        title: {
          type: 'string',
          description: '新建专题讨论群时的群名称（可选）',
        },
        participants: {
          type: 'array',
          items: { type: 'string' },
          description: '可选：需要拉入专题讨论小群的成员 ID 数组',
        },
        message: {
          type: 'string',
          description: '你在群里发起讨论的开场白与议题（可用 @成员ID 点名谁先发言）',
        },
        attachments: {
          type: 'array',
          items: { type: 'string' },
          description:
            '可选：随本次群消息一并发进群里的本地图片或文件附件路径数组（图片会自动以视觉多模态传给群成员并在群聊展示缩略图，普通文件展示附件卡与可读路径）',
        },
      },
      required: ['message'],
      additionalProperties: false,
    },
      annotations: {
        title: '在家庭群聊发起讨论',
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    {
      name: 'phone_read_dsh_session',
      description:
        '按需读取或按关键词检索当前关联 DSH 主工作台会话的对话记录、用户诉求与涉及文件路径（支持 query 关键词全文筛选，或 limit 读取最近最多 60 条）。',
      inputSchema: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: '可选：按关键词筛选历史对话（如包名、文件名或报错词，不区分大小写）',
          },
          limit: {
            type: 'number',
            description: '可选：读取最近多少条记录（1~60，默认 25）',
          },
        },
        additionalProperties: false,
      },
      annotations: {
        title: '查阅关联 DSH 主会话记录',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    {
      name: 'phone_workspace_board',
      description:
        '查看当前共享工作目录的实时协作黑板：了解此刻有哪些家庭成员正在同一目录并行执行什么任务、锁定占用了哪些文件（File Lease），以及最近 10 分钟刚修改过哪些文件。在多人并行修改公共文件或等待队友释放文件前可随时调用。',
      inputSchema: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
      annotations: {
        title: '查看共享工作区实时协作黑板',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
] as const;

/**
 * 兼容打包后 (`dist/index.js`) 与源码运行 (`src/phone/phone-bus.ts`) 两种目录层级，
 * 精确定位 `phone-mcp.js` Stdio 代理入口。
 */
export function resolvePhoneMcpScriptPath(baseDir: string = import.meta.dirname): string {
  const candidates = [
    resolve(baseDir, './phone-mcp.js'),
    resolve(baseDir, '../dist/phone-mcp.js'),
    resolve(baseDir, '../../dist/phone-mcp.js'),
    resolve(baseDir, './phone-mcp-stdio.ts'),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return candidates[0]!;
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) return {};
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {};
  }
  return parsed as Record<string, unknown>;
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

/**
 * 仅绑定 `127.0.0.1:0` 且强制随机密钥鉴权的本地「家庭手机」MCP 总线。
 * 同时支持：
 * 1. Streamable HTTP MCP (`/mcp?scopeId=...&callerId=...`) —— 供 Claude Code 与 OpenCode ACP 零子进程直连；
 * 2. Stdio MCP 代理 (`dist/phone-mcp.js`) —— 供 Codex app-server 等 stdio MCP 客户端接入。
 */
export class FamilyPhoneBus {
  private readonly hub: FamilyHub;
  private readonly token: string;
  private server: Server | null = null;
  private port = 0;
  private startPromise: Promise<number> | null = null;

  public constructor(hub: FamilyHub) {
    this.hub = hub;
    this.token = randomBytes(32).toString('hex');
  }

  public async start(): Promise<number> {
    if (this.server && this.port > 0) {
      return this.port;
    }
    if (this.startPromise) {
      return this.startPromise;
    }

    this.startPromise = (async () => {
      const srv = createServer((req, res) => {
        void this.handleRequest(req, res);
      });

      await new Promise<void>((resolveListen, rejectListen) => {
        srv.once('error', rejectListen);
        srv.listen(0, '127.0.0.1', () => {
          srv.removeListener('error', rejectListen);
          resolveListen();
        });
      });

      const addr = srv.address() as AddressInfo;
      this.server = srv;
      this.port = addr.port;
      return this.port;
    })().finally(() => {
      this.startPromise = null;
    });

    return this.startPromise;
  }

  public async stop(): Promise<void> {
    this.startPromise = null;
    if (!this.server) return;
    const srv = this.server;
    this.server = null;
    this.port = 0;
    await new Promise<void>((resolveClose) => {
      srv.close(() => resolveClose());
    });
  }

  public buildLaunchSpec(scopeId: string, callerId: string): PhoneMcpLaunchSpec {
    const baseUrl = `http://127.0.0.1:${this.port}`;
    const query = new URLSearchParams({ scopeId, callerId }).toString();
    const httpUrl = `${baseUrl}/mcp?${query}`;

    const scriptPath = resolvePhoneMcpScriptPath(import.meta.dirname);
    const nodeExec = resolveNodeExecutable();

    return {
      command: nodeExec.command,
      args: [scriptPath],
      env: {
        ...nodeExec.env,
        NO_PROXY: '127.0.0.1,localhost,::1',
        no_proxy: '127.0.0.1,localhost,::1',
        DSH_FAMILY_BUS_URL: baseUrl,
        DSH_FAMILY_BUS_TOKEN: this.token,
        DSH_FAMILY_SCOPE_ID: scopeId,
        DSH_FAMILY_CALLER_ID: callerId,
      },
      httpUrl,
      bearerToken: this.token,
    };
  }

  public static getToolSchemas(): typeof PHONE_TOOL_SCHEMAS {
    return PHONE_TOOL_SCHEMAS;
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const authHeader = req.headers.authorization ?? '';
    if (authHeader !== `Bearer ${this.token}`) {
      sendJson(res, 401, { error: 'Unauthorized family-phone request' });
      return;
    }

    const parsedUrl = new URL(req.url ?? '/', `http://127.0.0.1:${this.port}`);
    if (parsedUrl.pathname !== '/mcp') {
      sendJson(res, 404, { error: 'Not Found' });
      return;
    }

    if (req.method === 'DELETE') {
      res.writeHead(200);
      res.end();
      return;
    }

    if (req.method === 'GET') {
      // Streamable HTTP MCP 探测支持
      res.writeHead(405, { Allow: 'POST' });
      res.end();
      return;
    }

    if (req.method !== 'POST') {
      res.writeHead(405, { Allow: 'POST' });
      res.end();
      return;
    }

    const scopeId = parsedUrl.searchParams.get('scopeId') || 'default';
    const callerId = parsedUrl.searchParams.get('callerId') || 'unknown';

    let rpc: Record<string, unknown>;
    try {
      rpc = await readJsonBody(req);
    } catch {
      sendJson(res, 400, {
        jsonrpc: '2.0',
        id: null,
        error: { code: -32700, message: 'Parse error' },
      });
      return;
    }

    const id = typeof rpc.id === 'string' || typeof rpc.id === 'number' ? rpc.id : null;
    const method = typeof rpc.method === 'string' ? rpc.method : '';

    // JSON-RPC Notification（无需响应体）
    if (id === null && method.startsWith('notifications/')) {
      res.writeHead(202);
      res.end();
      return;
    }

    if (method === 'initialize') {
      sendJson(res, 200, {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'dsh-family-phone', version: '0.1.0' },
        },
      });
      return;
    }

    if (method === 'ping') {
      sendJson(res, 200, { jsonrpc: '2.0', id, result: {} });
      return;
    }

    if (method === 'tools/list') {
      sendJson(res, 200, {
        jsonrpc: '2.0',
        id,
        result: { tools: PHONE_TOOL_SCHEMAS },
      });
      return;
    }

    if (method === 'tools/call') {
      const params =
        rpc.params && typeof rpc.params === 'object'
          ? (rpc.params as Record<string, unknown>)
          : {};
      const toolName = typeof params.name === 'string' ? params.name : '';
      const rawArgs =
        params.arguments && typeof params.arguments === 'object' && !Array.isArray(params.arguments)
          ? (params.arguments as Record<string, unknown>)
          : {};

      const reqAbort = new AbortController();
      res.on('close', () => {
        if (!res.writableEnded) {
          reqAbort.abort();
        }
      });

      try {
        const text = await this.dispatchToolCall(
          scopeId,
          callerId,
          toolName,
          rawArgs,
          reqAbort.signal
        );
        if (!res.writableEnded) {
          sendJson(res, 200, {
            jsonrpc: '2.0',
            id,
            result: {
              content: [{ type: 'text', text }],
              isError: false,
            },
          });
        }
      } catch (err) {
        if (!res.writableEnded) {
          const msg = err instanceof Error ? err.message : String(err);
          sendJson(res, 200, {
            jsonrpc: '2.0',
            id,
            result: {
              content: [{ type: 'text', text: `家庭手机调用异常: ${msg}` }],
              isError: true,
            },
          });
        }
      }
      return;
    }

    sendJson(res, 200, {
      jsonrpc: '2.0',
      id,
      error: { code: -32601, message: `Unsupported MCP method: ${method}` },
    });
  }

  private async dispatchToolCall(
    scopeId: string,
    callerId: string,
    toolName: string,
    args: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<string> {
    if (toolName === 'phone_contacts') {
      return this.hub.handlePhoneContacts(scopeId, callerId);
    }

    if (toolName === 'phone_workspace_board') {
      return this.hub.handlePhoneWorkspaceBoard(scopeId, callerId);
    }

    if (toolName === 'phone_call') {
      const to = typeof args.to === 'string' ? args.to : '';
      const message = typeof args.message === 'string' ? args.message : '';
      const rawIntent = typeof args.intent === 'string' ? args.intent : 'discuss';
      const intent: PhoneCallIntent =
        rawIntent === 'request_help' || rawIntent === 'sync' ? rawIntent : 'discuss';
      if (!to.trim() || !message.trim()) {
        return '参数缺失：phone_call 需要提供目标成员 to 与通话内容 message。';
      }
      const attachmentPaths = Array.isArray(args.attachments)
        ? args.attachments.filter((x): x is string => typeof x === 'string')
        : undefined;
      return this.hub.handlePhoneCall({
        scopeId,
        callerId,
        toMemberId: to,
        intent,
        message,
        attachmentPaths,
        signal,
      });
    }

    if (toolName === 'phone_group_discuss') {
      const message = typeof args.message === 'string' ? args.message : '';
      const attachmentPaths = Array.isArray(args.attachments)
        ? args.attachments.filter((x): x is string => typeof x === 'string')
        : undefined;
      if (!message.trim() && (!attachmentPaths || attachmentPaths.length === 0)) {
        return '参数缺失：phone_group_discuss 需要提供开场消息 message 或附件 attachments。';
      }
      const groupId = typeof args.groupId === 'string' ? args.groupId : undefined;
      const title = typeof args.title === 'string' ? args.title : undefined;
      const participants = Array.isArray(args.participants)
        ? args.participants.filter((p): p is string => typeof p === 'string')
        : undefined;
      return this.hub.handlePhoneGroupDiscuss({
        scopeId,
        callerId,
        groupId,
        title,
        participants,
        message: message.trim() || '请大家看看我刚发在群里的附件。',
        attachmentPaths,
      });
    }

    if (toolName === 'phone_read_dsh_session') {
      const limit = typeof args.limit === 'number' && Number.isFinite(args.limit) ? args.limit : 25;
      const query = typeof args.query === 'string' ? args.query : undefined;
      return this.hub.handlePhoneReadDshSession(scopeId, limit, query);
    }

    throw new Error(`未知的家庭手机功能: ${toolName}`);
  }
}
