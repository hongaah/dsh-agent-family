import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type {
  DshHostContext,
  DshHostEventMap,
  DshPreStepDecision,
  DshPreStepPayload,
  DshRawToolDefinition,
  DshWebRoute,
} from '../src/host/dsh-types.ts';
import { createFamilyHostPlugin } from '../src/host/index.ts';
import {
  AsyncEventQueue,
  type AwakenMemberContext,
  type BodyDriver,
  type LiveMemberSession,
} from '../src/drivers/driver.ts';
import type { MemberStreamEvent } from '../src/core/types.ts';

function createTestDriver(): BodyDriver {
  return {
    kind: 'claude',
    awaken: async (ctx: AwakenMemberContext): Promise<LiveMemberSession> => ({
      bodyKind: 'claude',
      isAlive: () => true,
      sendTurn: (prompt: string): AsyncIterable<MemberStreamEvent> => {
        const q = new AsyncEventQueue<MemberStreamEvent>();
        const reply = `[${ctx.member.name}完成]: ${prompt.slice(0, 60)}`;
        q.push({ kind: 'text_delta', delta: reply });
        q.push({ kind: 'turn_done', finalText: reply });
        q.close();
        return q;
      },
      replyApproval: async () => undefined,
      dispose: async () => undefined,
    }),
  };
}

describe('Cordis Host Plugin (Tools, SystemPrompt, @Mention Pre-Step, Web API & Teardown)', () => {
  let tempDir: string;
  let disposers: Array<() => void>;
  let registeredTools: Map<string, DshRawToolDefinition>;
  let promptSections: Map<string, () => string>;
  let preStepListeners: Array<
    (payload: DshPreStepPayload, next: () => Promise<DshPreStepDecision>) => Promise<DshPreStepDecision>
  >;
  let routes: DshWebRoute[];
  let httpServer: Server | null = null;
  let rejectAuth = false;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'dsh-agent-family-host-'));
    disposers = [];
    registeredTools = new Map();
    promptSections = new Map();
    preStepListeners = [];
    routes = [];
    rejectAuth = false;
  });

  afterEach(async () => {
    for (const dispose of disposers.reverse()) {
      dispose();
    }
    if (httpServer) {
      await new Promise<void>((r) => httpServer!.close(() => r()));
      httpServer = null;
    }
    rmSync(tempDir, { recursive: true, force: true });
  });

  function buildMockHostContext(): DshHostContext {
    const ctx: DshHostContext = {
      sessions: {
        get: (id: string) => ({ id, header: { cwd: tempDir } }),
      },
      tools: {
        register: (tool) => {
          registeredTools.set(tool.name, tool);
          return () => {
            registeredTools.delete(tool.name);
          };
        },
      },
      webServer: {
        register: (route) => {
          routes.push(route);
          return () => {
            routes = routes.filter((r) => r !== route);
          };
        },
      },
      systemPrompt: {
        section: (spec) => {
          promptSections.set(spec.name, spec.text);
          return () => {
            promptSections.delete(spec.name);
          };
        },
      },
      get: (serviceName: string) => {
        if (serviceName === 'connection') {
          return {
            requestRejection: () => (rejectAuth ? (401 as const) : undefined),
          };
        }
        return undefined;
      },
      effect: (fn) => {
        const cleanup = fn();
        if (typeof cleanup === 'function') {
          disposers.push(cleanup);
          return cleanup;
        }
        return () => undefined;
      },
      inject: (_deps, cb) => {
        const cleanup = cb(ctx);
        if (typeof cleanup === 'function') {
          disposers.push(cleanup);
          return cleanup;
        }
        return () => undefined;
      },
      on: <K extends keyof DshHostEventMap>(event: K, listener: DshHostEventMap[K]) => {
        if (event === 'agent/pre-step') {
          preStepListeners.push(listener as DshHostEventMap['agent/pre-step']);
        }
        return () => undefined;
      },
    };
    return ctx;
  }

  it('registers Lead tools, dynamic roster system prompt, @member pre-step routing, and HTTP API routes', async () => {
    const ctx = buildMockHostContext();
    const plugin = createFamilyHostPlugin({
      storageDir: tempDir,
      customDrivers: [createTestDriver()],
    });
    plugin.apply(ctx);

    expect(registeredTools.has('family_assign')).toBe(true);
    expect(registeredTools.has('family_group_discuss')).toBe(true);
    expect(registeredTools.has('family_status')).toBe(true);
    expect(registeredTools.has('family_interrupt')).toBe(true);

    // 启动真实 HTTP server 验证挂载的 Web API 路由
    httpServer = createServer((req, res) => {
      const matched = routes.find((r) =>
        r.kind === 'exact' ? req.url === r.path : (req.url ?? '').startsWith(r.path)
      );
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

    // 1. 创建两位成员
    const createRes1 = await fetch(`${base}/dsh-agent-family/api/members`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: 'fe-sis',
        name: '前端妹妹',
        avatar: '🎨',
        specialty: '前端页面实现',
        body: { kind: 'claude' },
        soulPrompt: '前端专家',
      }),
    });
    expect(createRes1.status).toBe(200);

    const createRes2 = await fetch(`${base}/dsh-agent-family/api/members`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: 'arch-bro',
        name: '架构师大哥',
        avatar: '🏛️',
        specialty: '系统架构把关',
        body: { kind: 'claude' },
        soulPrompt: '架构专家',
      }),
    });
    expect(createRes2.status).toBe(200);

    // 2. 验证系统提示词动态反映在岗成员名册
    const rosterPrompt = promptSections.get('dsh-agent-family:roster')?.() ?? '';
    expect(rosterPrompt).toContain('@fe-sis');
    expect(rosterPrompt).toContain('架构师大哥');

    // 3. 验证 @fe-sis 预步骤自动附加直派路由提示
    const preStep = preStepListeners[0]!;
    const decision = await preStep(
      {
        agent: { session: { id: 'chat-sess-1', header: { cwd: tempDir } } },
        step: 0,
        signal: new AbortController().signal,
        messages: [
          {
            role: 'user',
            content: [{ type: 'text', text: '@fe-sis 帮我把登录按钮样式美化一下' }],
          },
        ],
      },
      async () => ({
        kind: 'enter',
        messages: [
          {
            role: 'user',
            content: [{ type: 'text', text: '@fe-sis 帮我把登录按钮样式美化一下' }],
          },
        ],
      })
    );
    expect(decision.kind).toBe('enter');
    if (decision.kind === 'enter') {
      const rewrittenText = decision.messages[0]?.content[0]?.text ?? '';
      expect(rewrittenText).toContain('family_assign');
      expect(rewrittenText).toContain('fe-sis');
    }

    // 4. 验证主对话并发调用 family_assign 与 family_group_discuss 工具
    const assignTool = registeredTools.get('family_assign')!;
    const assignValue = await assignTool.execute(
      {
        tasks: [
          { memberId: 'fe-sis', goal: '实现按钮动画' },
          { memberId: 'arch-bro', goal: '审查状态设计' },
        ],
      },
      {
        callId: 'c1',
        name: 'family_assign',
        arguments: {},
        signal: new AbortController().signal,
        agent: { session: { id: 'chat-sess-1', header: { cwd: tempDir } } },
      }
    );
    const renderedAssign = assignTool.output.render({}, assignValue);
    expect(renderedAssign[0]?.text).toContain('前端妹妹完成');
    expect(renderedAssign[0]?.text).toContain('架构师大哥完成');

    const groupTool = registeredTools.get('family_group_discuss')!;
    const groupValue = await groupTool.execute(
      {
        message: '大家对齐一下新弹窗的关闭逻辑',
      },
      {
        callId: 'c2',
        name: 'family_group_discuss',
        arguments: {},
        signal: new AbortController().signal,
        agent: { session: { id: 'chat-sess-1', header: { cwd: tempDir } } },
      }
    );
    const renderedGroup = groupTool.output.render({}, groupValue);
    expect(renderedGroup[0]?.text).toContain('家庭总群');

    // 5. 验证宿主鉴权拦截
    rejectAuth = true;
    const rejectedRes = await fetch(`${base}/dsh-agent-family/api/bootstrap`);
    expect(rejectedRes.status).toBe(401);
  });
});
