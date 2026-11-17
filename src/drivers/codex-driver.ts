import { resolveBodyExecutable } from '../core/cli-locator.ts';
import type { ApprovalOption, MemberStreamEvent } from '../core/types.ts';
import {
  AsyncEventQueue,
  type AwakenMemberContext,
  type BodyDriver,
  type LiveMemberSession,
} from './driver.ts';
import { JsonRpcStdioPeer, type JsonRpcId } from './json-rpc-peer.ts';

const CODEX_APPROVAL_OPTIONS: readonly ApprovalOption[] = [
  { optionId: 'accept', label: '允许本次', kind: 'allow' },
  { optionId: 'acceptForSession', label: '本会话始终允许', kind: 'allow_always' },
  { optionId: 'decline', label: '拒绝', kind: 'deny' },
  { optionId: 'cancel', label: '取消并中止', kind: 'deny' },
];

export class CodexDriver implements BodyDriver {
  public readonly kind = 'codex' as const;

  public async awaken(context: AwakenMemberContext): Promise<LiveMemberSession> {
    const executable = await resolveBodyExecutable(context.member.body);
    if (!executable) {
      throw new Error(
        `未在本机找到 Codex CLI 可执行文件 (${context.member.body.command ?? 'codex'})，请检查是否已安装。`
      );
    }

    let activeQueue: AsyncEventQueue<MemberStreamEvent> | null = null;
    let accumulatedText = '';
    const pendingServerRequests = new Map<string, JsonRpcId>();

    const args: string[] = ['app-server', '--stdio', ...(context.member.body.extraArgs ?? [])];

    const peer = new JsonRpcStdioPeer({
      executable,
      args,
      cwd: context.cwd,
      includeJsonRpcHeader: false,
      onNotification: ({ method, params }) => {
        if (!activeQueue) return;
        if (method === 'item/agentMessage/delta') {
          const delta = typeof params.delta === 'string' ? params.delta : '';
          if (delta) {
            accumulatedText += delta;
            activeQueue.push({ kind: 'text_delta', delta });
          }
          return;
        }
        if (method === 'item/started' && params.item && typeof params.item === 'object') {
          const item = params.item as Record<string, unknown>;
          if (typeof item.type === 'string' && item.type !== 'agentMessage') {
            activeQueue.push({ kind: 'status', summary: `执行 ${item.type}` });
          }
          return;
        }
        if (method === 'turn/completed') {
          const turn =
            params.turn && typeof params.turn === 'object'
              ? (params.turn as Record<string, unknown>)
              : {};
          if (turn.status === 'failed' && turn.error && typeof turn.error === 'object') {
            const errObj = turn.error as Record<string, unknown>;
            activeQueue.fail(
              new Error(typeof errObj.message === 'string' ? errObj.message : 'Codex 轮次失败')
            );
          } else {
            activeQueue.push({ kind: 'turn_done', finalText: accumulatedText });
            activeQueue.close();
          }
          activeQueue = null;
        }
      },
      onServerRequest: ({ id, method, params }) => {
        const requestKey = String(id);
        pendingServerRequests.set(requestKey, id);

        if (
          method === 'item/commandExecution/requestApproval' ||
          method === 'item/fileChange/requestApproval' ||
          method === 'execCommandApproval' ||
          method === 'applyPatchApproval'
        ) {
          const cmdLabel =
            typeof params.command === 'string'
              ? params.command
              : Array.isArray(params.command)
                ? params.command.join(' ')
                : method.includes('fileChange') || method.includes('Patch')
                  ? '修改工作区文件'
                  : method;
          activeQueue?.push({
            kind: 'approval_requested',
            requestId: requestKey,
            title: `Codex 请求确认: ${cmdLabel.slice(0, 120)}`,
            detail: JSON.stringify(params, null, 2).slice(0, 800),
            options: CODEX_APPROVAL_OPTIONS,
          });
          return;
        }

        // 其他非人工审批类内部回调默认返回空确认以防阻塞
        pendingServerRequests.delete(requestKey);
        peer.respond(id, {});
      },
      onExit: (err) => {
        pendingServerRequests.clear();
        if (activeQueue) {
          activeQueue.fail(err);
          activeQueue = null;
        }
      },
    });

    try {
      await peer.request(
        'initialize',
        {
          clientInfo: {
            name: 'dsh-agent-family',
            title: 'DSH Agent Family',
            version: '0.1.0',
          },
          capabilities: null,
        },
        context.signal
      );
      peer.notify('initialized', {});

      const threadStartRes = await peer.request(
        'thread/start',
        {
          cwd: context.cwd,
          developerInstructions: context.composedSoul,
          config: {
            mcp_servers: {
              family_phone: {
                command: context.phoneMcp.command,
                args: [...context.phoneMcp.args],
                env: { ...context.phoneMcp.env },
              },
            },
          },
        },
        context.signal
      );

      const threadObj =
        threadStartRes.thread && typeof threadStartRes.thread === 'object'
          ? (threadStartRes.thread as Record<string, unknown>)
          : {};
      const threadId = typeof threadObj.id === 'string' ? threadObj.id : '';
      if (!threadId) {
        throw new Error('Codex app-server 未返回有效的 thread.id。');
      }

      return {
        bodyKind: 'codex',
        isAlive: () => peer.isAlive(),
        sendTurn: (prompt: string, signal: AbortSignal): AsyncIterable<MemberStreamEvent> => {
          if (!peer.isAlive()) {
            throw new Error('Codex 身体进程已离线。');
          }
          const queue = new AsyncEventQueue<MemberStreamEvent>();
          activeQueue = queue;
          accumulatedText = '';

          const onAbort = () => {
            if (activeQueue === queue) {
              activeQueue = null;
              void peer.request('turn/interrupt', { threadId }).catch(() => undefined);
              queue.fail(new Error('当前 Codex 轮次已被中断。'));
            }
          };
          signal.addEventListener('abort', onAbort, { once: true });

          void peer
            .request(
              'turn/start',
              {
                threadId,
                input: [
                  {
                    type: 'text',
                    text: prompt,
                    text_elements: [],
                  },
                ],
              },
              signal
            )
            .catch((err: unknown) => {
              if (activeQueue === queue) {
                activeQueue = null;
                queue.fail(err instanceof Error ? err : new Error(String(err)));
              }
            });

          return queue;
        },
        replyApproval: async (requestId: string, optionId: string): Promise<void> => {
          const rpcId = pendingServerRequests.get(requestId);
          if (rpcId === undefined) return;
          pendingServerRequests.delete(requestId);
          const validDecision =
            optionId === 'accept' ||
            optionId === 'acceptForSession' ||
            optionId === 'decline' ||
            optionId === 'cancel'
              ? optionId
              : 'decline';
          peer.respond(rpcId, { decision: validDecision });
        },
        dispose: async () => {
          pendingServerRequests.clear();
          activeQueue = null;
          await peer.dispose();
        },
      };
    } catch (err) {
      await peer.dispose();
      throw err;
    }
  }
}
