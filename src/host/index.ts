import { resolve } from 'node:path';

import { probeAllBodies } from '../core/cli-locator.ts';
import { FamilyHub } from '../core/family-hub.ts';
import { extractMemberMentions, GroupChatEngine, MAIN_GROUP_ID } from '../core/group-chat.ts';
import {
  defaultFamilyStorageDir,
  MemberRegistry,
  STARTER_MEMBER_TEMPLATES,
} from '../core/member-registry.ts';
import type {
  BodySpec,
  CreateMemberInput,
  FamilyRealtimeEvent,
  PhoneCallIntent,
  UpdateMemberInput,
} from '../core/types.ts';
import { ClaudeDriver } from '../drivers/claude-driver.ts';
import { CodexDriver } from '../drivers/codex-driver.ts';
import type { BodyDriver } from '../drivers/driver.ts';
import { DshNativeDriver, type DshHostBridge } from '../drivers/dsh-native-driver.ts';
import { OpenCodeDriver } from '../drivers/opencode-driver.ts';
import { FamilyPhoneBus } from '../phone/phone-bus.ts';
import type {
  DshAgentLike,
  DshAgentsRegistry,
  DshConnectionService,
  DshHostContext,
  DshHttpRequest,
  DshHttpResponse,
  DshPreStepDecision,
  DshPreStepMessage,
  DshPreStepPayload,
  DshSubagentEndInfo,
  DshSubagentResult,
  DshSubagentRuntime,
  DshWorkingDirectoryService,
} from './dsh-types.ts';

export const name = 'dsh-agent-family';
export const inject = ['tools', 'sessions'];
export const API_PREFIX = '/dsh-agent-family/api';

export interface FamilyHostPluginOptions {
  readonly storageDir?: string;
  readonly customDrivers?: readonly BodyDriver[];
}

async function resolveSessionCwd(
  ctx: DshHostContext,
  sessionId?: string,
  explicitCwd?: string
): Promise<string> {
  if (explicitCwd && explicitCwd.trim()) {
    return resolve(explicitCwd.trim());
  }
  if (sessionId) {
    const session = ctx.sessions.get(sessionId);
    if (session) {
      const wd = ctx.get('workingDirectory') as DshWorkingDirectoryService | undefined;
      const liveCwd = wd?.get(session) ?? session.header.cwd;
      if (liveCwd && liveCwd.trim()) {
        return resolve(liveCwd);
      }
    }
  }
  const wd = ctx.get('workingDirectory') as DshWorkingDirectoryService | undefined;
  if (wd?.defaultDirectory) {
    return resolve(wd.defaultDirectory);
  }
  return process.cwd();
}

async function readRequestJson(req: DshHttpRequest): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const part of req) {
    chunks.push(typeof part === 'string' ? Buffer.from(part) : Buffer.from(part));
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) return {};
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {};
  }
  return parsed as Record<string, unknown>;
}

function writeJson(res: DshHttpResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(text);
}

function extractTextFromDshResult(result: DshSubagentResult): string {
  const texts = result.output
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text ?? '')
    .join('\n')
    .trim();
  if (texts) return texts;
  if (result.diagnostic) return `[DSH 诊断]: ${result.diagnostic}`;
  return '';
}

function appendHintToLastUserMessage(
  messages: readonly DshPreStepMessage[],
  note: string
): DshPreStepMessage[] {
  const copy = messages.map((m) => ({
    ...m,
    content: m.content.map((c) => ({ ...c })),
  }));
  for (let i = copy.length - 1; i >= 0; i -= 1) {
    const msg = copy[i]!;
    if (!msg.role || msg.role === 'user') {
      const textIdx = msg.content.findLastIndex((part) => part.type === 'text');
      if (textIdx >= 0) {
        const prev = msg.content[textIdx]!;
        msg.content[textIdx] = {
          ...prev,
          text: `${prev.text ?? ''}${note}`,
        };
      } else {
        msg.content.push({ type: 'text', text: note });
      }
      break;
    }
  }
  return copy;
}

function parseBodySpecFromPayload(raw: unknown): BodySpec | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const obj = raw as Record<string, unknown>;
  const kind = obj.kind;
  if (kind !== 'claude' && kind !== 'codex' && kind !== 'opencode' && kind !== 'dsh') {
    return undefined;
  }
  const command = typeof obj.command === 'string' ? obj.command : undefined;
  const extraArgs = Array.isArray(obj.extraArgs)
    ? obj.extraArgs.filter((item): item is string => typeof item === 'string')
    : undefined;
  return {
    kind,
    ...(command !== undefined ? { command } : {}),
    ...(extraArgs !== undefined ? { extraArgs } : {}),
  };
}

export function createFamilyHostPlugin(options: FamilyHostPluginOptions = {}) {
  return {
    name,
    inject,
    apply(ctx: DshHostContext): void {
      const registry = new MemberRegistry(options.storageDir ?? defaultFamilyStorageDir());
      const observedAgents = new Map<string, DshAgentLike>();
      const dshChildSessions = new Map<string, { scopeId: string; memberId: string }>();
      const activeDshChildren = new Map<string, string>();
      const subagentEndWaiters = new Map<
        string,
        { resolve: (text: string) => void; reject: (err: Error) => void }
      >();

      const findLiveParentAgent = (scopeId: string): DshAgentLike | undefined => {
        const cached = observedAgents.get(scopeId);
        if (cached) return cached;
        const agentsSvc = ctx.get('agents') as DshAgentsRegistry | undefined;
        const lookedUp = agentsSvc?.get?.(scopeId);
        if (lookedUp) return lookedUp;
        for (const candidate of observedAgents.values()) {
          return candidate;
        }
        return undefined;
      };

      const dshBridge: DshHostBridge = {
        isAvailable: () => Boolean(ctx.get('subagents')),
        runTurn: async ({ scopeId, member, composedSoul, cwd, prompt, isFirstTurn, signal }) => {
          const subagents = ctx.get('subagents') as DshSubagentRuntime | undefined;
          const parent = findLiveParentAgent(scopeId);
          if (!subagents || !parent) {
            throw new Error(
              '当前暂无活跃的 DSH 父级会话句柄以唤醒进程内子代理；请先在主对话发起任意轮次，或为该成员绑定本地 claude/codex/opencode 身体。'
            );
          }

          const key = `${scopeId}::${member.id}`;
          const existingChildId = !isFirstTurn ? activeDshChildren.get(key) : undefined;

          if (existingChildId && subagents.sendMessage) {
            const waitEnd = new Promise<string>((resolveEnd, rejectEnd) => {
              subagentEndWaiters.set(existingChildId, { resolve: resolveEnd, reject: rejectEnd });
              signal.addEventListener(
                'abort',
                () => {
                  subagentEndWaiters.delete(existingChildId);
                  rejectEnd(new Error('DSH 子成员轮次已被中断。'));
                },
                { once: true }
              );
            });
            await subagents.sendMessage(
              parent,
              existingChildId,
              [{ type: 'text', text: prompt }],
              { signal }
            );
            return waitEnd;
          }

          const framedPrompt = `${composedSoul}\n\n---\n\n${prompt}`;
          const activation = await subagents.startActivation({
            provider: 'spawn',
            label: `${member.avatar} ${member.name}`,
            name: member.id,
            cwd,
            prompt: [{ type: 'text', text: framedPrompt }],
            parent,
            signal,
            delivery: 'caller',
          });
          activeDshChildren.set(key, activation.childId);
          dshChildSessions.set(activation.childId, { scopeId, memberId: member.id });
          const res = await activation.result;
          if (res.stopReason === 'error' || res.stopReason === 'aborted') {
            throw new Error(res.diagnostic || `DSH 子成员执行终止 (${res.stopReason})`);
          }
          return extractTextFromDshResult(res);
        },
        disposeMember: async (scopeId, memberId) => {
          const key = `${scopeId}::${memberId}`;
          const childId = activeDshChildren.get(key);
          if (childId) {
            activeDshChildren.delete(key);
            dshChildSessions.delete(childId);
          }
        },
      };

      const defaultDrivers: readonly BodyDriver[] = [
        new ClaudeDriver(),
        new CodexDriver(),
        new OpenCodeDriver(),
        new DshNativeDriver(dshBridge),
      ];

      const hub = new FamilyHub({
        registry,
        drivers: options.customDrivers ?? defaultDrivers,
      });
      const groupEngine = new GroupChatEngine(hub, registry);
      hub.attachGroupEngine(groupEngine);

      const phoneBus = new FamilyPhoneBus(hub);
      void phoneBus.start().catch((err: unknown) => {
        ctx.logger?.error('[dsh-agent-family] 启动本地家庭手机总线失败:', err);
      });
      hub.attachPhoneBus(phoneBus);

      // 监听 DSH 原生子代理完成事件以结算多轮 sendMessage
      ctx.effect(
        () =>
          ctx.on('subagent/end', (info: DshSubagentEndInfo) => {
            const waiter = subagentEndWaiters.get(info.id);
            if (!waiter) return;
            subagentEndWaiters.delete(info.id);
            if (info.result.stopReason === 'error' || info.result.stopReason === 'aborted') {
              waiter.reject(
                new Error(info.result.diagnostic || `DSH 成员结束 (${info.result.stopReason})`)
              );
            } else {
              waiter.resolve(extractTextFromDshResult(info.result));
            }
          }),
        'dsh-agent-family: subagent-end-observer'
      );

      // 插件卸载或宿主退出时全量优雅释放所有 CLI 身体进程与手机总线
      const sseClients = new Set<DshHttpResponse>();
      ctx.effect(() => {
        const unsubHub = hub.subscribe((ev: FamilyRealtimeEvent) => {
          const frame = `data: ${JSON.stringify(ev)}\n\n`;
          for (const client of sseClients) {
            if (client.writableEnded) {
              sseClients.delete(client);
              continue;
            }
            client.write(frame);
          }
        });

        const heartbeat = setInterval(() => {
          for (const client of sseClients) {
            if (client.writableEnded) {
              sseClients.delete(client);
              continue;
            }
            client.write(': heartbeat\n\n');
          }
        }, 15_000);

        return () => {
          clearInterval(heartbeat);
          unsubHub();
          for (const client of sseClients) {
            client.end();
          }
          sseClients.clear();
          void hub.dispose();
          void phoneBus.stop();
        };
      }, 'dsh-agent-family: lifecycle-cleanup');

      // 1. 注册主对话动态家庭名册系统提示词
      ctx.inject(['systemPrompt'], (scoped) => {
        if (!scoped.systemPrompt) return;
        return scoped.effect(
          () =>
            scoped.systemPrompt!.section({
              name: 'dsh-agent-family:roster',
              text: () => {
                const enabled = registry.listEnabled();
                if (enabled.length === 0) {
                  return [
                    '## 智能体家庭 (dsh-agent-family)',
                    '- 当前家庭户口本尚未创建或启用任何成员。用户可在左侧栏「智能体家庭」面板创建绑定本机 CLI（claude/codex/opencode/dsh）并赋予灵魂的家庭成员。',
                  ].join('\n');
                }
                const rosterLines = enabled.map(
                  (m) =>
                    `- ${m.avatar} **${m.name}** (\`@${m.id}\`, 身体: \`${m.body.kind}\`)：${m.specialty}`
                );
                return [
                  '## 智能体家庭 (Agents Family)',
                  '你家里有以下具备独立灵魂、独立身体与随身「家庭手机」的家庭成员：',
                  ...rosterLines,
                  '',
                  '协作指引：',
                  '- 当任务适合交给某位或多位家庭成员独立或并行推进（或用户通过 `@成员ID` 点名）时，调用 `family_assign` 指派目标；成员在执行途中会自主使用随身手机与其他成员沟通或拒绝不合理要求。',
                  '- 当遇到需要多位成员当面碰撞、互相评议或达成跨模块共识的复杂议题时，调用 `family_group_discuss` 在家庭群聊中发起多轮讨论。',
                ].join('\n');
              },
            }),
          'dsh-agent-family: system-prompt'
        );
      });

      // 2. 注册面向主对话 Lead（以及 DSH 原生子成员）的工具集
      registerFamilyTools(ctx, hub, groupEngine, registry, observedAgents, dshChildSessions);

      // 3. 拦截 agent/pre-step：缓存活跃父 Agent，并识别用户输入中的 @成员ID 点名
      ctx.effect(
        () =>
          ctx.on(
            'agent/pre-step',
            async (
              payload: DshPreStepPayload,
              next: () => Promise<DshPreStepDecision>
            ): Promise<DshPreStepDecision> => {
              if (payload.agent?.session?.id) {
                observedAgents.set(payload.agent.session.id, payload.agent);
              }
              const decision = await next();
              if (decision.kind === 'reject' || payload.signal.aborted) {
                return decision;
              }

              const enabledIds = new Set(registry.listEnabled().map((m) => m.id));
              if (enabledIds.size === 0) return decision;

              const mentioned: string[] = [];
              for (const msg of decision.messages) {
                if (msg.role && msg.role !== 'user') continue;
                for (const block of msg.content) {
                  if (block.type === 'text' && typeof block.text === 'string') {
                    for (const id of extractMemberMentions(block.text, enabledIds)) {
                      if (!mentioned.includes(id)) mentioned.push(id);
                    }
                  }
                }
              }

              if (mentioned.length === 0) {
                return decision;
              }

              const memberDescriptions = mentioned
                .map((id) => {
                  const m = registry.get(id);
                  return m ? `${m.name} (@${m.id})` : `@${id}`;
                })
                .join('、');

              const routingHint =
                mentioned.length === 1
                  ? `\n\n<family_direct_mention>\n用户明确点名了家庭成员 ${memberDescriptions}。请立即调用 \`family_assign\` 将用户的完整诉求交由 \`${mentioned[0]}\` 处理，不要越俎代庖替其回答。\n</family_direct_mention>`
                  : `\n\n<family_direct_mention>\n用户同时点名了多位家庭成员：${memberDescriptions}。如属并行独立任务请调用 \`family_assign\` 并发指派；如属方案会商请调用 \`family_group_discuss\` 拉起群聊讨论。\n</family_direct_mention>`;

              return {
                ...decision,
                messages: appendHintToLastUserMessage(decision.messages, routingHint),
              };
            }
          ),
        'dsh-agent-family: pre-step-mentions'
      );

      // 4. 注册 Web / Desktop 工作台 HTTP 路由与 SSE 实时通道
      ctx.inject(['webServer'], (scoped) => {
        if (!scoped.webServer) return;
        return scoped.effect(
          () =>
            scoped.webServer!.register({
              kind: 'prefix',
              path: API_PREFIX,
              handler: async (req, res) => {
                const connection = scoped.get('connection') as DshConnectionService | undefined;
                const rejection = connection?.requestRejection?.(req);
                if (rejection) {
                  writeJson(res, rejection, { error: 'Rejected by host connection policy' });
                  return;
                }

                await handleWebApiRequest({
                  ctx: scoped,
                  req,
                  res,
                  registry,
                  hub,
                  groupEngine,
                  sseClients,
                });
              },
            }),
          'dsh-agent-family: web-routes'
        );
      });
    },
  };
}

function registerFamilyTools(
  ctx: DshHostContext,
  hub: FamilyHub,
  groupEngine: GroupChatEngine,
  registry: MemberRegistry,
  observedAgents: Map<string, DshAgentLike>,
  dshChildSessions: Map<string, { scopeId: string; memberId: string }>
): void {
  // 工具 1: family_assign（单人或多人并发指派工作）
  ctx.effect(
    () =>
      ctx.tools.register({
        name: 'family_assign',
        description:
          '向一位或多位家庭成员分配任务（多位成员将并发独立推进，期间他们可自主通过随身家庭手机联系其他成员协作或拒绝不合理要求）。',
        parameters: {
          type: 'object',
          properties: {
            tasks: {
              type: 'array',
              minItems: 1,
              items: {
                type: 'object',
                properties: {
                  memberId: {
                    type: 'string',
                    description: '目标家庭成员唯一 ID（如 arch-bro、fe-sis，不带 @）',
                  },
                  goal: {
                    type: 'string',
                    description: '完整、自包含的任务说明与上下文背景',
                  },
                  cwd: {
                    type: 'string',
                    description: '可选工作目录覆盖；省略则继承当前会话工作目录',
                  },
                  fresh: {
                    type: 'boolean',
                    description: '可选：是否重置该成员唤醒全新身体上下文（默认 false，延续该成员当前记忆）',
                  },
                },
                required: ['memberId', 'goal'],
                additionalProperties: false,
              },
            },
          },
          required: ['tasks'],
          additionalProperties: false,
        },
        output: {
          schema: { type: 'object' },
          presentationMeta: (_args, value) => value,
          render: (_args, value) => {
            const payload =
              value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
            const results = Array.isArray(payload.results) ? payload.results : [];
            const formatted = results
              .map((item) => {
                const r = item as Record<string, unknown>;
                const header = `### ${String(r.avatar ?? '🤖')} ${String(r.memberName ?? r.memberId)} (@${String(r.memberId)} · ${String(r.bodyKind ?? '')})`;
                if (r.error) {
                  return `${header}\n❌ 执行失败：${String(r.error)}`;
                }
                const calls = Array.isArray(r.phoneCalls) ? r.phoneCalls : [];
                const callSummary =
                  calls.length > 0
                    ? `\n\n> 📞 期间拨打了 ${calls.length} 通家庭电话：${calls
                        .map((c) => {
                          const rec = c as Record<string, unknown>;
                          return `${String(rec.fromMemberName)} → ${String(rec.toMemberName)} (${String(rec.status)})`;
                        })
                        .join('；')}`
                    : '';
                return `${header}\n${String(r.finalText ?? '')}${callSummary}`;
              })
              .join('\n\n---\n\n');
            return [{ type: 'text', text: formatted || '未执行任何成员任务。' }];
          },
        },
        execute: async (args, exec) => {
          if (exec.agent?.session?.id) {
            observedAgents.set(exec.agent.session.id, exec.agent);
          }
          const scopeId = exec.agent?.session?.id ?? 'default';
          const defaultCwd = await resolveSessionCwd(ctx, scopeId);
          const rawTasks = Array.isArray(args.tasks) ? args.tasks : [];

          const settled = await Promise.all(
            rawTasks.map(async (rawItem) => {
              const item =
                rawItem && typeof rawItem === 'object'
                  ? (rawItem as Record<string, unknown>)
                  : {};
              const memberId = String(item.memberId ?? '').replace(/^@/u, '').trim();
              const goal = String(item.goal ?? '').trim();
              const taskCwd =
                typeof item.cwd === 'string' && item.cwd.trim()
                  ? resolve(defaultCwd, item.cwd.trim())
                  : defaultCwd;
              const fresh = item.fresh === true;
              const memberMeta = registry.get(memberId);

              try {
                const res = await hub.sendMemberMessage({
                  scopeId,
                  memberId,
                  senderRole: 'lead',
                  senderName: '主对话统筹',
                  message: goal,
                  cwd: taskCwd,
                  fresh,
                  signal: exec.signal,
                });
                return {
                  memberId: res.member.id,
                  memberName: res.member.name,
                  avatar: res.member.avatar,
                  bodyKind: res.member.body.kind,
                  goal,
                  finalText: res.finalText,
                  phoneCalls: res.phoneCallsDuringTurn,
                };
              } catch (err) {
                return {
                  memberId,
                  memberName: memberMeta?.name ?? memberId,
                  avatar: memberMeta?.avatar ?? '🤖',
                  bodyKind: memberMeta?.body.kind ?? 'unknown',
                  goal,
                  error: err instanceof Error ? err.message : String(err),
                };
              }
            })
          );

          return {
            kind: 'family_assign',
            scopeId,
            results: settled,
          };
        },
      }),
    'dsh-agent-family: tool-assign'
  );

  // 工具 2: family_group_discuss（发起多轮家庭群聊讨论）
  ctx.effect(
    () =>
      ctx.tools.register({
        name: 'family_group_discuss',
        description:
          '在家庭群聊（默认家庭总群 family-main，或指定 participants 拉起专题群）发起多轮协作讨论。成员能彼此看到对方发言、互相 @ 追问或拒绝不合理提议。',
        parameters: {
          type: 'object',
          properties: {
            groupId: {
              type: 'string',
              description: '可选群 ID，默认 family-main',
            },
            title: {
              type: 'string',
              description: '新建专题群时的群名称（可选）',
            },
            participants: {
              type: 'array',
              items: { type: 'string' },
              description: '可选参与讨论的成员 ID 列表；省略则使用家庭总群全员',
            },
            message: {
              type: 'string',
              description: '抛入群聊的讨论议题与背景（支持 @成员ID 点名谁先发言）',
            },
          },
          required: ['message'],
          additionalProperties: false,
        },
        output: {
          schema: { type: 'object' },
          presentationMeta: (_args, value) => value,
          render: (_args, value) => {
            const v = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
            const title = String(v.title ?? '家庭群聊');
            const messages = Array.isArray(v.newMessages) ? v.newMessages : [];
            const lines = messages.map((raw) => {
              const m = raw as Record<string, unknown>;
              return `- **${String(m.senderAvatar ?? '')} ${String(m.senderName)} (@${String(m.senderId)})**：${String(m.content)}`;
            });
            return [
              {
                type: 'text',
                text:
                  lines.length > 0
                    ? `### 👥 ${title} 讨论纪要\n\n${lines.join('\n\n')}`
                    : `### 👥 ${title}\n群成员已阅，暂无补充异议。`,
              },
            ];
          },
        },
        execute: async (args, exec) => {
          if (exec.agent?.session?.id) {
            observedAgents.set(exec.agent.session.id, exec.agent);
          }
          const scopeId = exec.agent?.session?.id ?? 'default';
          const cwd = await resolveSessionCwd(ctx, scopeId);
          const message = String(args.message ?? '').trim();
          const participants = Array.isArray(args.participants)
            ? args.participants
                .filter((p): p is string => typeof p === 'string')
                .map((p) => p.replace(/^@/u, '').trim())
            : undefined;

          let targetGroupId =
            typeof args.groupId === 'string' && args.groupId.trim() ? args.groupId.trim() : '';
          if (!targetGroupId) {
            if (participants && participants.length > 0) {
              const created = groupEngine.createRoom({
                scopeId,
                title:
                  typeof args.title === 'string' && args.title.trim()
                    ? args.title.trim()
                    : '专题方案会商群',
                memberIds: participants,
              });
              targetGroupId = created.id;
            } else {
              targetGroupId = MAIN_GROUP_ID;
            }
          }

          const existing =
            groupEngine.getRoom(scopeId, targetGroupId) ?? groupEngine.getOrCreateMainRoom(scopeId);
          const startIdx = existing.messages.length;

          const updated = await groupEngine.postMessage({
            scopeId,
            groupId: existing.id,
            senderId: 'lead',
            senderName: '主对话召集',
            senderAvatar: '📢',
            content: message,
            cwd,
          });

          return {
            kind: 'family_group_discuss',
            scopeId,
            groupId: updated.id,
            title: updated.title,
            newMessages: updated.messages.slice(startIdx + 1),
          };
        },
      }),
    'dsh-agent-family: tool-group-discuss'
  );

  // 工具 3: family_status（查询家庭成员与审批状态）
  ctx.effect(
    () =>
      ctx.tools.register({
        name: 'family_status',
        description: '查看智能体家庭在册成员、本机 CLI 身体体检状态、当前忙碌情况与待处理的人类审批。',
        parameters: {
          type: 'object',
          properties: {},
          additionalProperties: false,
        },
        output: {
          schema: { type: 'object' },
          render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
        },
        execute: async (_args, exec) => {
          const scopeId = exec.agent?.session?.id ?? 'default';
          const bodies = await probeAllBodies({ hasDshHostRuntime: Boolean(ctx.get('subagents')) });
          return {
            members: registry.list(),
            bodies,
            snapshots: hub.listSnapshots(scopeId),
            pendingApprovals: hub.listPendingApprovals(scopeId),
          };
        },
      }),
    'dsh-agent-family: tool-status'
  );

  // 工具 4: family_interrupt（中断指定成员或暂停群聊接龙）
  ctx.effect(
    () =>
      ctx.tools.register({
        name: 'family_interrupt',
        description: '中断某位家庭成员正在执行的轮次，或暂停某个家庭群聊的连续讨论。',
        parameters: {
          type: 'object',
          properties: {
            memberId: { type: 'string', description: '要中断的成员 ID（可选）' },
            groupId: { type: 'string', description: '要暂停的群聊 ID（可选）' },
          },
          additionalProperties: false,
        },
        output: {
          schema: { type: 'object' },
          render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
        },
        execute: async (args, exec) => {
          const scopeId = exec.agent?.session?.id ?? 'default';
          const interruptedMember =
            typeof args.memberId === 'string' && args.memberId.trim()
              ? hub.interruptMember(scopeId, args.memberId.replace(/^@/u, '').trim())
              : false;
          const interruptedGroup =
            typeof args.groupId === 'string' && args.groupId.trim()
              ? groupEngine.interruptRoom(scopeId, args.groupId.trim())
              : false;
          return { interruptedMember, interruptedGroup };
        },
      }),
    'dsh-agent-family: tool-interrupt'
  );

  // 为 DSH 自身进程内子代理动态暴露随身手机工具（仅对登记在 dshChildSessions 中的子代理工作）
  for (const schema of FamilyPhoneBus.getToolSchemas()) {
    ctx.effect(
      () =>
        ctx.tools.register(
          {
            name: schema.name,
            description: schema.description,
            parameters: schema.inputSchema as unknown as Record<string, unknown>,
            output: {
              schema: { type: 'string' },
              render: (_a, val) => [{ type: 'text', text: String(val ?? '') }],
            },
            execute: async (args, exec) => {
              const childSessionId = exec.agent?.session?.id ?? '';
              const owner = dshChildSessions.get(childSessionId);
              if (!owner) {
                return '此随身手机工具仅供已唤醒的家庭成员内部调用；主对话请使用 family_assign 或 family_group_discuss。';
              }
              if (schema.name === 'phone_contacts') {
                return hub.handlePhoneContacts(owner.scopeId, owner.memberId);
              }
              if (schema.name === 'phone_call') {
                const rawIntent = typeof args.intent === 'string' ? args.intent : 'discuss';
                const intent: PhoneCallIntent =
                  rawIntent === 'request_help' || rawIntent === 'sync' ? rawIntent : 'discuss';
                return hub.handlePhoneCall({
                  scopeId: owner.scopeId,
                  callerId: owner.memberId,
                  toMemberId: String(args.to ?? ''),
                  intent,
                  message: String(args.message ?? ''),
                  signal: exec.signal,
                });
              }
              return hub.handlePhoneGroupDiscuss({
                scopeId: owner.scopeId,
                callerId: owner.memberId,
                groupId: typeof args.groupId === 'string' ? args.groupId : undefined,
                title: typeof args.title === 'string' ? args.title : undefined,
                participants: Array.isArray(args.participants)
                  ? args.participants.filter((p): p is string => typeof p === 'string')
                  : undefined,
                message: String(args.message ?? ''),
              });
            },
          },
          {
            when: () => dshChildSessions.size > 0,
          }
        ),
      `dsh-agent-family: dsh-child-${schema.name}`
    );
  }
}

async function handleWebApiRequest(params: {
  readonly ctx: DshHostContext;
  readonly req: DshHttpRequest;
  readonly res: DshHttpResponse;
  readonly registry: MemberRegistry;
  readonly hub: FamilyHub;
  readonly groupEngine: GroupChatEngine;
  readonly sseClients: Set<DshHttpResponse>;
}): Promise<void> {
  const { ctx, req, res, registry, hub, groupEngine, sseClients } = params;
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  const subPath = url.pathname.slice(API_PREFIX.length) || '/';
  const method = (req.method ?? 'GET').toUpperCase();

  try {
    if (method === 'GET' && subPath === '/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
      });
      res.flushHeaders?.();
      res.write(': connected\n\n');
      sseClients.add(res);
      req.on?.('close', () => {
        sseClients.delete(res);
      });
      return;
    }

    if (method === 'GET' && subPath === '/bootstrap') {
      const scopeId = url.searchParams.get('scopeId') || 'default';
      const bodies = await probeAllBodies({ hasDshHostRuntime: Boolean(ctx.get('subagents')) });
      writeJson(res, 200, {
        members: registry.list(),
        templates: STARTER_MEMBER_TEMPLATES,
        bodies,
        snapshots: hub.listSnapshots(scopeId),
        rooms: groupEngine.listRooms(scopeId),
        callRecords: hub.listPhoneCallRecords(scopeId),
        pendingApprovals: hub.listPendingApprovals(),
      });
      return;
    }

    if (method === 'POST' && subPath === '/probe') {
      const bodies = await probeAllBodies({ hasDshHostRuntime: Boolean(ctx.get('subagents')) });
      writeJson(res, 200, { bodies });
      return;
    }

    if (method === 'POST' && subPath === '/members/seed') {
      const body = await readRequestJson(req);
      const preferred =
        body.preferredBody === 'claude' ||
        body.preferredBody === 'codex' ||
        body.preferredBody === 'opencode' ||
        body.preferredBody === 'dsh'
          ? body.preferredBody
          : undefined;
      const created = registry.seedStarterTemplates(preferred);
      writeJson(res, 200, { created, members: registry.list() });
      return;
    }

    if (method === 'POST' && subPath === '/members') {
      const body = await readRequestJson(req);
      const parsedBody = parseBodySpecFromPayload(body.body);
      if (!parsedBody) {
        writeJson(res, 400, { error: '请提供合法的身体配置 (claude / codex / opencode / dsh)。' });
        return;
      }
      const input: CreateMemberInput = {
        id: String(body.id ?? ''),
        name: String(body.name ?? ''),
        avatar: typeof body.avatar === 'string' ? body.avatar : undefined,
        specialty: String(body.specialty ?? ''),
        body: parsedBody,
        soulPrompt: String(body.soulPrompt ?? ''),
        enabled: typeof body.enabled === 'boolean' ? body.enabled : true,
      };
      const created = registry.create(input);
      writeJson(res, 200, { member: created, members: registry.list() });
      return;
    }

    if (subPath.startsWith('/members/')) {
      const memberId = decodeURIComponent(subPath.slice('/members/'.length));
      if (method === 'PUT') {
        const body = await readRequestJson(req);
        const parsedBody = body.body !== undefined ? parseBodySpecFromPayload(body.body) : undefined;
        const patch: UpdateMemberInput = {
          ...(typeof body.name === 'string' ? { name: body.name } : {}),
          ...(typeof body.avatar === 'string' ? { avatar: body.avatar } : {}),
          ...(typeof body.specialty === 'string' ? { specialty: body.specialty } : {}),
          ...(parsedBody ? { body: parsedBody } : {}),
          ...(typeof body.soulPrompt === 'string' ? { soulPrompt: body.soulPrompt } : {}),
          ...(typeof body.enabled === 'boolean' ? { enabled: body.enabled } : {}),
        };
        const updated = registry.update(memberId, patch);
        writeJson(res, 200, { member: updated, members: registry.list() });
        return;
      }
      if (method === 'DELETE') {
        const removed = registry.remove(memberId);
        writeJson(res, 200, { removed, members: registry.list() });
        return;
      }
    }

    if (method === 'POST' && subPath === '/chat') {
      const body = await readRequestJson(req);
      const scopeId = typeof body.scopeId === 'string' && body.scopeId.trim() ? body.scopeId : 'default';
      const memberId = String(body.memberId ?? '').trim();
      const message = String(body.message ?? '').trim();
      if (!memberId || !message) {
        writeJson(res, 400, { error: 'memberId 与 message 不能为空。' });
        return;
      }
      const cwd = await resolveSessionCwd(
        ctx,
        scopeId,
        typeof body.cwd === 'string' ? body.cwd : undefined
      );
      const outcome = await hub.sendMemberMessage({
        scopeId,
        memberId,
        senderRole: 'human',
        senderName: '你',
        message,
        cwd,
        fresh: body.fresh === true,
      });
      writeJson(res, 200, {
        finalText: outcome.finalText,
        snapshot: hub.getMemberSnapshot(scopeId, memberId),
      });
      return;
    }

    if (method === 'POST' && subPath === '/interrupt') {
      const body = await readRequestJson(req);
      const scopeId = typeof body.scopeId === 'string' && body.scopeId.trim() ? body.scopeId : 'default';
      const memberInterrupted =
        typeof body.memberId === 'string' && body.memberId.trim()
          ? hub.interruptMember(scopeId, body.memberId.trim())
          : false;
      const groupInterrupted =
        typeof body.groupId === 'string' && body.groupId.trim()
          ? groupEngine.interruptRoom(scopeId, body.groupId.trim())
          : false;
      writeJson(res, 200, { memberInterrupted, groupInterrupted });
      return;
    }

    if (method === 'POST' && subPath === '/reset-session') {
      const body = await readRequestJson(req);
      const scopeId = typeof body.scopeId === 'string' && body.scopeId.trim() ? body.scopeId : 'default';
      const memberId = String(body.memberId ?? '').trim();
      await hub.resetMemberSession(scopeId, memberId);
      writeJson(res, 200, { ok: true, snapshot: hub.getMemberSnapshot(scopeId, memberId) });
      return;
    }

    if (method === 'POST' && subPath === '/groups') {
      const body = await readRequestJson(req);
      const scopeId = typeof body.scopeId === 'string' && body.scopeId.trim() ? body.scopeId : 'default';
      const title = String(body.title ?? '').trim() || '专题讨论群';
      const memberIds = Array.isArray(body.memberIds)
        ? body.memberIds.filter((item): item is string => typeof item === 'string')
        : 'all_enabled';
      const room = groupEngine.createRoom({
        scopeId,
        title,
        memberIds: Array.isArray(memberIds) && memberIds.length > 0 ? memberIds : 'all_enabled',
      });
      writeJson(res, 200, { room, rooms: groupEngine.listRooms(scopeId) });
      return;
    }

    if (method === 'POST' && subPath === '/groups/messages') {
      const body = await readRequestJson(req);
      const scopeId = typeof body.scopeId === 'string' && body.scopeId.trim() ? body.scopeId : 'default';
      const groupId =
        typeof body.groupId === 'string' && body.groupId.trim() ? body.groupId.trim() : MAIN_GROUP_ID;
      const content = String(body.content ?? '').trim();
      if (!content) {
        writeJson(res, 400, { error: '群聊发言内容不能为空。' });
        return;
      }
      const cwd = await resolveSessionCwd(
        ctx,
        scopeId,
        typeof body.cwd === 'string' ? body.cwd : undefined
      );
      const room = await groupEngine.postMessage({
        scopeId,
        groupId,
        senderId: 'human',
        senderName: '你',
        senderAvatar: '🧑‍💻',
        content,
        cwd,
      });
      writeJson(res, 200, { room });
      return;
    }

    if (method === 'POST' && subPath === '/approvals/reply') {
      const body = await readRequestJson(req);
      const approvalId = String(body.approvalId ?? '').trim();
      const optionId = String(body.optionId ?? '').trim();
      if (!approvalId || !optionId) {
        writeJson(res, 400, { error: 'approvalId 与 optionId 不能为空。' });
        return;
      }
      const applied = await hub.replyApproval(approvalId, optionId);
      writeJson(res, 200, { applied, pendingApprovals: hub.listPendingApprovals() });
      return;
    }

    writeJson(res, 404, { error: `Unknown route: ${method} ${subPath}` });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    writeJson(res, 400, { error: message });
  }
}

const defaultPlugin = createFamilyHostPlugin();

export function apply(ctx: DshHostContext): void {
  defaultPlugin.apply(ctx);
}
