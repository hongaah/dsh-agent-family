import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
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
          if (typeof spec.order !== 'number' || !Number.isFinite(spec.order)) {
            throw new TypeError(`prompt section "${spec.name}" order must be a finite number`);
          }
          promptSections.set(spec.name, () =>
            typeof spec.text === 'function' ? spec.text() : spec.text
          );
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
      // 用户原始提问消息保持 100% 纯净，不被内部路由提示污染
      expect(decision.messages[0]?.content[0]?.text).not.toContain('<family_direct_mention>');
      const injected = decision.messages[1];
      expect(injected?.source?.kind).toBe('dsh-agent-family');
      const rewrittenText = injected?.content[0]?.text ?? '';
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

  it('drives in-process DSH body (ctx.agents.create + followup + session/event) across Turn 1, aborted Turn 2, and Turn 3 without hanging', async () => {
    const sessionEventListeners: Array<(session: { id: string }, event: { seq: number; type: string; data: Record<string, unknown> }) => void> = [];
    const streamListeners: Array<(payload: { frame: Record<string, unknown> }) => void> = [];
    let seq = 0;
    let turnNo = 0;
    const storedEvents: Array<{ seq: number; type: string; data: Record<string, unknown> }> = [];
    const scopedTools = new Map<string, DshRawToolDefinition>();
    const restrictedDeny: string[] = [];
    let shouldHangNextTurn = false;

    const fakeChildSession = {
      id: 'family-dsh-child-1',
      header: { cwd: tempDir },
      get seq() {
        return seq;
      },
      snapshotEvents: (fromSeq = 0) => storedEvents.filter((e) => e.seq >= fromSeq),
    };

    const fakeChildCtx = {
      systemPrompt: {
        section: (spec: { name: string; order?: number }) => {
          if (typeof spec.order !== 'number' || !Number.isFinite(spec.order)) {
            throw new TypeError(`prompt section "${spec.name}" order must be a finite number`);
          }
          return () => undefined;
        },
      },
      tools: {
        register: (tool: DshRawToolDefinition) => {
          scopedTools.set(tool.name, tool);
          return () => undefined;
        },
        restrict: (filter: { deny?: readonly string[] }) => {
          restrictedDeny.push(...(filter.deny ?? []));
          return () => undefined;
        },
      },
      on: (eventName: string, cb: (...args: unknown[]) => void) => {
        if (eventName === 'session/event') {
          sessionEventListeners.push(
            cb as (
              session: { id: string },
              event: { seq: number; type: string; data: Record<string, unknown> }
            ) => void
          );
        } else if (eventName === 'agent/assistant-stream') {
          streamListeners.push(cb as (payload: { frame: Record<string, unknown> }) => void);
        }
        return () => undefined;
      },
    };

    const fakeChildAgent = {
      id: 'family-dsh-child-1',
      session: fakeChildSession,
      ctx: fakeChildCtx,
      followup: (msg: { content: Array<{ text?: string }> }) => {
        turnNo += 1;
        const currentTurn = turnNo;
        const promptText = msg.content[0]?.text ?? '';
        if (shouldHangNextTurn) {
          return;
        }
        setTimeout(() => {
          for (const sl of streamListeners) {
            sl({
              frame: {
                type: 'chunk',
                chunk: { type: 'text-delta', delta: `肥鱼酱第${currentTurn}轮:` },
              },
            });
          }
          seq += 1;
          const assistantEv = {
            seq,
            type: 'assistant/message',
            data: {
              turn: currentTurn,
              step: 0,
              message: {
                content: [{ type: 'text', text: `肥鱼酱第${currentTurn}轮:${promptText}` }],
              },
            },
          };
          storedEvents.push(assistantEv);
          for (const l of sessionEventListeners) l(fakeChildSession, assistantEv);

          seq += 1;
          const endEv = {
            seq,
            type: 'turn/end',
            data: { turn: currentTurn, reason: { kind: 'completed' } },
          };
          storedEvents.push(endEv);
          for (const l of sessionEventListeners) l(fakeChildSession, endEv);
        }, 10);
      },
      cancel: () => {
        seq += 1;
        const abortEv = {
          seq,
          type: 'turn/end',
          data: { turn: turnNo, reason: { kind: 'aborted' } },
        };
        storedEvents.push(abortEv);
        for (const l of sessionEventListeners) l(fakeChildSession, abortEv);
      },
    };

    const ctx = buildMockHostContext();
    const origGet = ctx.get.bind(ctx);
    const dshCtx: DshHostContext = {
      ...ctx,
      get: (serviceName: string) => {
        if (serviceName === 'agentDefaultModel') {
          return {
            currentSelection: () => ({
              provider: 'deepseek-account',
              model: 'deepseek-flash',
            }),
          };
        }
        if (serviceName === 'agents') {
          return {
            create: async (opts: { setup?: (c: unknown, a: unknown) => void | Promise<void> }) => {
              await opts.setup?.(fakeChildCtx, fakeChildAgent);
              return {
                agent: fakeChildAgent,
                dispose: async () => undefined,
              };
            },
          };
        }
        return origGet(serviceName);
      },
    };

    const plugin = createFamilyHostPlugin({ storageDir: tempDir });
    plugin.apply(dshCtx);

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

    await fetch(`${base}/dsh-agent-family/api/members`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: 'dsh-chihuo',
        name: '肥鱼酱',
        avatar: '🏛️',
        specialty: '干大白饭',
        body: { kind: 'dsh' },
        soulPrompt: '嘴馋傲娇小鲸鱼',
      }),
    });

    // 第 1 轮：无需预先跑过主对话，直接成功回复
    const r1 = await fetch(`${base}/dsh-agent-family/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scopeId: 'any-scope', memberId: 'dsh-chihuo', message: '有人吗' }),
    });
    const j1 = (await r1.json()) as { finalText: string };
    expect(j1.finalText).toBe('肥鱼酱第1轮:有人吗');

    // 第 2 轮：模拟卡住后用户点「中断」
    shouldHangNextTurn = true;
    const pendingTurn2 = fetch(`${base}/dsh-agent-family/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scopeId: 'any-scope', memberId: 'dsh-chihuo', message: '你会什么' }),
    });
    await new Promise((r) => setTimeout(r, 25));
    await fetch(`${base}/dsh-agent-family/api/interrupt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scopeId: 'any-scope', memberId: 'dsh-chihuo' }),
    });
    const r2 = await pendingTurn2;
    expect(r2.status).toBe(400);

    // 第 3 轮：恢复正常发送「你在吗」，不卡在思考中，直接成功！
    shouldHangNextTurn = false;
    const r3 = await fetch(`${base}/dsh-agent-family/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scopeId: 'any-scope', memberId: 'dsh-chihuo', message: '你在吗' }),
    });
    const j3 = (await r3.json()) as { finalText: string };
    expect(j3.finalText).toBe('肥鱼酱第3轮:你在吗');

    // 验证 DSH 原生成员已挂载随身手机工具（含长超时）且屏蔽了主统筹专用工具
    expect(scopedTools.has('phone_contacts')).toBe(true);
    expect(scopedTools.has('phone_call')).toBe(true);
    expect(scopedTools.get('phone_call')?.timeoutMs).toBeGreaterThanOrEqual(600_000);
    expect(restrictedDeny).toContain('family_assign');
    expect(restrictedDeny).toContain('family_group_discuss');
  });

  it('registers /family + dynamic /<memberId> slash commands, bridges incremental DSH session context, and feeds receipts back into main DSH pre-step', async () => {
    const promptsReceived: string[] = [];
    const registeredCommands = new Map<
      string,
      {
        name: string;
        description: string;
        handler: (inv: {
          commandId: string;
          agent: { session: { id: string; seq: number; header: { cwd: string }; snapshotEvents: (from?: number) => unknown[] } };
          rawInput: string;
          signal: AbortSignal;
        }) => Promise<{ kind: string; text?: string }>;
      }
    >();

    const capturingDriver: BodyDriver = {
      kind: 'claude',
      awaken: async (ctx: AwakenMemberContext): Promise<LiveMemberSession> => ({
        bodyKind: 'claude',
        isAlive: () => true,
        sendTurn: (prompt: string): AsyncIterable<MemberStreamEvent> => {
          promptsReceived.push(prompt);
          const q = new AsyncEventQueue<MemberStreamEvent>();
          const reply = `[${ctx.member.name}已修复 Login.tsx 圆角]`;
          q.push({ kind: 'text_delta', delta: reply });
          q.push({ kind: 'turn_done', finalText: reply });
          q.close();
          return q;
        },
        replyApproval: async () => undefined,
        dispose: async () => undefined,
      }),
    };

    const mockSessionEvents = [
      {
        seq: 1,
        type: 'user/message',
        data: {
          message: {
            content: [{ type: 'text', text: '登录页面的提交按钮在暗色模式下看不清边框' }],
          },
        },
      },
      {
        seq: 2,
        type: 'tool/call',
        data: {
          name: 'str_replace_editor',
          arguments: { path: 'src/components/Login.tsx' },
        },
      },
      {
        seq: 3,
        type: 'assistant/message',
        data: {
          message: {
            content: [{ type: 'text', text: '我定位到是 Login.tsx 第 42 行的 border 变量缺失。' }],
          },
        },
      },
    ];

    const mockMainSession = {
      id: 'dsh-main-sess-99',
      get seq() {
        return mockSessionEvents.length;
      },
      header: { cwd: tempDir, title: '修复暗色登录页' },
      snapshotEvents: (fromSeq = 0) => mockSessionEvents.filter((e) => e.seq > fromSeq || fromSeq === 0),
    };

    const baseCtx = buildMockHostContext();
    const cmdCtx: DshHostContext = {
      ...baseCtx,
      sessions: {
        get: (id: string) => (id === 'dsh-main-sess-99' ? mockMainSession : { id, header: { cwd: tempDir } }),
      },
      commands: {
        register: (def) => {
          registeredCommands.set(def.name, def as never);
          return () => {
            registeredCommands.delete(def.name);
          };
        },
      },
    };

    const plugin = createFamilyHostPlugin({
      storageDir: tempDir,
      customDrivers: [capturingDriver],
    });
    plugin.apply(cmdCtx);

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

    // 创建成员 fe-sis 后，应自动注册动态斜杠命令 /fe-sis 以及通用 /family、/family-group
    await fetch(`${base}/dsh-agent-family/api/members`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: 'fe-sis',
        name: '小前端',
        specialty: '样式与组件修复',
        body: { kind: 'claude' },
        soulPrompt: '手速飞快',
      }),
    });

    expect(registeredCommands.has('family')).toBe(true);
    expect(registeredCommands.has('family-group')).toBe(true);
    expect(registeredCommands.has('fe-sis')).toBe(true);

    // 1. 用户在 DSH 对话中输入 `/fe-sis 帮我直接把那个按钮边框修好`
    const feCmd = registeredCommands.get('fe-sis')!;
    const cmdOut = await feCmd.handler({
      commandId: 'cmd-1',
      agent: { session: mockMainSession },
      rawInput: ' 帮我直接把那个按钮边框修好',
      signal: new AbortController().signal,
    });
    expect(cmdOut.kind).toBe('success');
    expect(cmdOut.text).toContain('小前端');

    // 验证小前端收到了精炼的 DSH 会话上下文增量简报（含用户原话、主对话结论、涉及文件 Login.tsx）
    expect(promptsReceived[0]).toContain('暗色模式下看不清边框');
    expect(promptsReceived[0]).toContain('src/components/Login.tsx');

    // 2. 第二次再次通过 /fe-sis 追问（DSH 主会话无新增事件），已同步过的旧上下文不重复冗余注入！
    await feCmd.handler({
      commandId: 'cmd-2',
      agent: { session: mockMainSession },
      rawInput: ' 顺便检查一下 hover 态',
      signal: new AbortController().signal,
    });
    expect(promptsReceived[1]).not.toContain('暗色模式下看不清边框');
    expect(promptsReceived[1]).toContain('顺便检查一下 hover 态');

    // 3. 验证双向闭环：回到主 DSH 对话发下一句话时，agent/pre-step 自动把刚才家庭成员的处理回执注入给 DSH 主模型知晓（且仅注入一次）
    const preStep = preStepListeners[0]!;
    const turnAfterSlash = await preStep(
      {
        agent: { session: mockMainSession },
        step: 0,
        signal: new AbortController().signal,
        messages: [{ role: 'user', content: [{ type: 'text', text: '现在我们继续写单元测试吧' }] }],
      },
      async () => ({
        kind: 'enter',
        messages: [{ role: 'user', content: [{ type: 'text', text: '现在我们继续写单元测试吧' }] }],
      })
    );
    expect(turnAfterSlash.kind).toBe('enter');
    if (turnAfterSlash.kind === 'enter') {
      // 1) 用户自己的提问气泡保持 100% 原样，绝不夹带大段 XML 回执文本
      expect(turnAfterSlash.messages[0]?.content[0]?.text).toBe('现在我们继续写单元测试吧');
      // 2) 独立注入 source.kind === 'dsh-agent-family' 的紧凑索引消息，且完整对话落盘在独立 .md 文件中
      const hiddenCtx = turnAfterSlash.messages[1];
      expect(hiddenCtx?.source?.kind).toBe('dsh-agent-family');
      const indexText = hiddenCtx?.content[0]?.text ?? '';
      expect(indexText).toContain('家庭协作纪要-');
      const mdPathMatch = /`([^`]+家庭协作纪要-[^`]+\.md)`/u.exec(indexText);
      expect(mdPathMatch?.[1]).toBeTruthy();
      const savedMd = readFileSync(mdPathMatch![1]!, 'utf8');
      expect(savedMd).toContain('小前端已修复 Login.tsx 圆角');
    }

    // 再下一轮不再重复注入已消费过的回执
    const secondMainTurn = await preStep(
      {
        agent: { session: mockMainSession },
        step: 0,
        signal: new AbortController().signal,
        messages: [{ role: 'user', content: [{ type: 'text', text: '好的' }] }],
      },
      async () => ({
        kind: 'enter',
        messages: [{ role: 'user', content: [{ type: 'text', text: '好的' }] }],
      })
    );
    if (secondMainTurn.kind === 'enter') {
      expect(secondMainTurn.messages[0]?.content[0]?.text ?? '').not.toContain(
        'family_collaboration_receipt'
      );
    }

    // 4. 验证 async: true 立即返回 202（彻底避免长耗时群聊触发 Electron Failed to fetch 超时）且支持 clientRequestId 幂等去重
    const asyncReqId = 'req-dedup-1001';
    const post1 = await fetch(`${base}/dsh-agent-family/api/groups/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        scopeId: 'dsh-main-sess-99',
        groupId: 'family-main',
        content: '异步非阻塞群聊测试',
        async: true,
        clientRequestId: asyncReqId,
      }),
    });
    expect(post1.status).toBe(202);

    const post2Dup = await fetch(`${base}/dsh-agent-family/api/groups/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        scopeId: 'dsh-main-sess-99',
        groupId: 'family-main',
        content: '异步非阻塞群聊测试',
        async: true,
        clientRequestId: asyncReqId,
      }),
    });
    const dupJson = (await post2Dup.json()) as { deduplicated?: boolean };
    expect(dupJson.deduplicated).toBe(true);
  });
});
