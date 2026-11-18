import { resolveBodyExecutable } from '../core/cli-locator.ts';
import type { ApprovalOption, MemberStreamEvent } from '../core/types.ts';
import {
  AsyncEventQueue,
  type AwakenMemberContext,
  type BodyDriver,
  type LiveMemberSession,
} from './driver.ts';
import { JsonRpcStdioPeer, type JsonRpcId } from './json-rpc-peer.ts';

export class OpenCodeDriver implements BodyDriver {
  public readonly kind = 'opencode' as const;

  public async awaken(context: AwakenMemberContext): Promise<LiveMemberSession> {
    const executable = await resolveBodyExecutable(context.member.body);
    if (!executable) {
      throw new Error(
        `未在本机找到 OpenCode CLI 可执行文件 (${context.member.body.command ?? 'opencode'})，请检查是否已安装。`
      );
    }

    let activeQueue: AsyncEventQueue<MemberStreamEvent> | null = null;
    let accumulatedText = '';
    let soulDelivered = false;
    const pendingPermissions = new Map<string, JsonRpcId>();

    const args: string[] = ['acp', ...(context.member.body.extraArgs ?? [])];

    const peer = new JsonRpcStdioPeer({
      executable,
      args,
      cwd: context.cwd,
      includeJsonRpcHeader: true,
      onNotification: ({ method, params }) => {
        if (!activeQueue || method !== 'session/update') return;
        const update =
          params.update && typeof params.update === 'object'
            ? (params.update as Record<string, unknown>)
            : {};
        const kind = typeof update.sessionUpdate === 'string' ? update.sessionUpdate : '';

        if (kind === 'agent_message_chunk' && update.content && typeof update.content === 'object') {
          const content = update.content as Record<string, unknown>;
          if (content.type === 'text' && typeof content.text === 'string' && content.text) {
            accumulatedText += content.text;
            activeQueue.push({ kind: 'text_delta', delta: content.text });
          }
          return;
        }

        if (kind === 'tool_call' && typeof update.title === 'string') {
          activeQueue.push({ kind: 'status', summary: update.title });
        }
      },
      onServerRequest: ({ id, method, params }) => {
        if (method === 'session/request_permission') {
          const toolCall =
            params.toolCall && typeof params.toolCall === 'object'
              ? (params.toolCall as Record<string, unknown>)
              : {};
          const title =
            typeof toolCall.title === 'string' && toolCall.title
              ? toolCall.title
              : 'OpenCode 请求操作确认';

          const rawOptions = Array.isArray(params.options) ? params.options : [];
          const options: ApprovalOption[] = [];
          for (const rawOpt of rawOptions) {
            if (!rawOpt || typeof rawOpt !== 'object') continue;
            const optObj = rawOpt as Record<string, unknown>;
            if (typeof optObj.optionId !== 'string') continue;
            const rawKind = typeof optObj.kind === 'string' ? optObj.kind : '';
            options.push({
              optionId: optObj.optionId,
              label: typeof optObj.name === 'string' ? optObj.name : optObj.optionId,
              kind: rawKind.includes('always')
                ? 'allow_always'
                : rawKind.includes('allow')
                  ? 'allow'
                  : 'deny',
            });
          }

          // 成员调用自身挂载的「家庭手机」工具默认直接放行，避免阻塞跨成员协作
          const serializedToolCall = JSON.stringify(toolCall);
          if (
            serializedToolCall.includes('family_phone') ||
            serializedToolCall.includes('phone_contacts') ||
            serializedToolCall.includes('phone_call') ||
            serializedToolCall.includes('phone_group_discuss')
          ) {
            const allowOpt =
              options.find((o) => o.kind === 'allow_always') ??
              options.find((o) => o.kind === 'allow');
            peer.respond(id, {
              outcome: {
                outcome: 'selected',
                optionId: allowOpt?.optionId ?? 'allow',
              },
            });
            return;
          }

          const requestKey = String(id);
          pendingPermissions.set(requestKey, id);
          activeQueue?.push({
            kind: 'approval_requested',
            requestId: requestKey,
            title,
            detail: JSON.stringify(toolCall, null, 2).slice(0, 800),
            options:
              options.length > 0
                ? options
                : [
                    { optionId: 'allow', label: '允许', kind: 'allow' },
                    { optionId: 'reject', label: '拒绝', kind: 'deny' },
                  ],
          });
          return;
        }

        peer.respond(id, {});
      },
      onExit: (err) => {
        pendingPermissions.clear();
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
          protocolVersion: 1,
          clientCapabilities: {},
        },
        context.signal
      );

      const sessionRes = await peer.request(
        'session/new',
        {
          cwd: context.cwd,
          mcpServers: [
            {
              type: 'http',
              name: 'family_phone',
              url: context.phoneMcp.httpUrl,
              headers: [
                {
                  name: 'Authorization',
                  value: `Bearer ${context.phoneMcp.bearerToken}`,
                },
              ],
            },
          ],
        },
        context.signal
      );

      const sessionId = typeof sessionRes.sessionId === 'string' ? sessionRes.sessionId : '';
      if (!sessionId) {
        throw new Error('OpenCode ACP 未返回有效的 sessionId。');
      }

      let activeModel = context.member.body.model?.trim() ?? '';
      if (activeModel) {
        await peer
          .request(
            'session/set_config_option',
            { sessionId, configId: 'model', value: activeModel },
            context.signal
          )
          .catch(() => undefined);
      }

      return {
        bodyKind: 'opencode',
        isAlive: () => peer.isAlive(),
        reconfigure: async (nextBody): Promise<boolean> => {
          const nextModel = nextBody.model?.trim() ?? '';
          if (activeModel && !nextModel) {
            return false;
          }
          if (nextModel && nextModel !== activeModel) {
            if (!peer.isAlive()) return false;
            try {
              await peer.request('session/set_config_option', {
                sessionId,
                configId: 'model',
                value: nextModel,
              });
              activeModel = nextModel;
              return true;
            } catch {
              return false;
            }
          }
          return true;
        },
        sendTurn: (prompt: string, signal: AbortSignal): AsyncIterable<MemberStreamEvent> => {
          if (!peer.isAlive()) {
            throw new Error('OpenCode 身体进程已离线。');
          }
          const queue = new AsyncEventQueue<MemberStreamEvent>();
          activeQueue = queue;
          accumulatedText = '';

          const effectiveText = !soulDelivered
            ? `<member_soul>\n${context.composedSoul}\n</member_soul>\n\n${prompt}`
            : prompt;
          soulDelivered = true;

          const onAbort = () => {
            if (activeQueue === queue) {
              activeQueue = null;
              peer.notify('session/cancel', { sessionId });
              queue.fail(new Error('当前 OpenCode 轮次已被中断。'));
            }
          };
          signal.addEventListener('abort', onAbort, { once: true });

          void peer
            .request(
              'session/prompt',
              {
                sessionId,
                prompt: [{ type: 'text', text: effectiveText }],
              },
              signal
            )
            .then(() => {
              if (activeQueue === queue) {
                activeQueue = null;
                queue.push({ kind: 'turn_done', finalText: accumulatedText });
                queue.close();
              }
            })
            .catch((err: unknown) => {
              if (activeQueue === queue) {
                activeQueue = null;
                queue.fail(err instanceof Error ? err : new Error(String(err)));
              }
            });

          return queue;
        },
        replyApproval: async (requestId: string, optionId: string): Promise<void> => {
          const rpcId = pendingPermissions.get(requestId);
          if (rpcId === undefined) return;
          pendingPermissions.delete(requestId);
          peer.respond(rpcId, {
            outcome: {
              outcome: 'selected',
              optionId,
            },
          });
        },
        dispose: async () => {
          pendingPermissions.clear();
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
