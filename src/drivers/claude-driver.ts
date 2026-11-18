import { resolveBodyExecutable } from '../core/cli-locator.ts';
import {
  decidePermissionAction,
  extractAskUserPrompt,
} from '../core/permission-policy.ts';
import type { MemberStreamEvent, PermissionMode } from '../core/types.ts';
import {
  AsyncEventQueue,
  type AwakenMemberContext,
  type BodyDriver,
  type LiveMemberSession,
} from './driver.ts';
import { ManagedNdjsonProcess } from './json-rpc-peer.ts';

interface PendingClaudeControl {
  readonly toolInput: Record<string, unknown>;
  readonly isAskUser: boolean;
  readonly questionKey?: string;
}

export class ClaudeDriver implements BodyDriver {
  public readonly kind = 'claude' as const;

  public async awaken(context: AwakenMemberContext): Promise<LiveMemberSession> {
    const executable = await resolveBodyExecutable(context.member.body);
    if (!executable) {
      throw new Error(
        `未在本机找到 Claude Code 可执行文件 (${context.member.body.command ?? 'claude'})，请检查是否已安装。`
      );
    }

    const mcpConfigJson = JSON.stringify({
      mcpServers: {
        family_phone: {
          type: 'http',
          url: context.phoneMcp.httpUrl,
          headers: {
            Authorization: `Bearer ${context.phoneMcp.bearerToken}`,
          },
        },
      },
    });

    let activeModel = context.member.body.model?.trim() ?? '';
    let activePermissionMode: PermissionMode = context.member.body.permissionMode ?? 'ask';
    const activeEffort = context.member.body.reasoningEffort?.trim() ?? '';

    const args: string[] = [
      '-p',
      '--verbose',
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--include-partial-messages',
      '--permission-prompt-tool',
      'stdio',
      '--allowedTools',
      'mcp__family_phone__*',
      ...(activeModel ? ['--model', activeModel] : []),
      ...(activeEffort ? ['--effort', activeEffort] : []),
      '--append-system-prompt',
      context.composedSoul,
      '--mcp-config',
      mcpConfigJson,
      ...(context.member.body.extraArgs ?? []),
    ];

    let activeQueue: AsyncEventQueue<MemberStreamEvent> | null = null;
    let accumulatedText = '';
    const pendingControls = new Map<string, PendingClaudeControl>();

    const proc = new ManagedNdjsonProcess({
      executable,
      args,
      cwd: context.cwd,
      onLine: (frame) => {
        if (!activeQueue) return;
        const frameType = typeof frame.type === 'string' ? frame.type : '';

        if (frameType === 'system' && frame.subtype === 'thinking_tokens') {
          const tokens = typeof frame.estimated_tokens === 'number' ? frame.estimated_tokens : 0;
          activeQueue.push({
            kind: 'status',
            summary: tokens > 0 ? `深度思考中 (${tokens} tokens)…` : '深度思考中…',
          });
          return;
        }

        if (frameType === 'stream_event' && frame.event && typeof frame.event === 'object') {
          const ev = frame.event as Record<string, unknown>;
          if (ev.type === 'content_block_delta' && ev.delta && typeof ev.delta === 'object') {
            const delta = ev.delta as Record<string, unknown>;
            if (delta.type === 'text_delta' && typeof delta.text === 'string') {
              accumulatedText += delta.text;
              activeQueue.push({ kind: 'text_delta', delta: delta.text });
            }
          } else if (ev.type === 'content_block_start' && ev.content_block && typeof ev.content_block === 'object') {
            const block = ev.content_block as Record<string, unknown>;
            if (block.type === 'tool_use' && typeof block.name === 'string') {
              activeQueue.push({ kind: 'status', summary: `调用工具 ${block.name}` });
            }
          }
          return;
        }

        if (frameType === 'assistant' && !accumulatedText && frame.message && typeof frame.message === 'object') {
          const message = frame.message as Record<string, unknown>;
          if (Array.isArray(message.content)) {
            for (const part of message.content) {
              if (part && typeof part === 'object') {
                const p = part as Record<string, unknown>;
                if (p.type === 'text' && typeof p.text === 'string' && p.text) {
                  accumulatedText += p.text;
                  activeQueue.push({ kind: 'text_delta', delta: p.text });
                }
              }
            }
          }
          return;
        }

        if (frameType === 'control_request') {
          const requestId = typeof frame.request_id === 'string' ? frame.request_id : '';
          const req =
            frame.request && typeof frame.request === 'object'
              ? (frame.request as Record<string, unknown>)
              : {};
          if (requestId && req.subtype === 'can_use_tool') {
            const toolName = typeof req.tool_name === 'string' ? req.tool_name : '未知工具';
            const toolInput =
              req.input && typeof req.input === 'object' && !Array.isArray(req.input)
                ? (req.input as Record<string, unknown>)
                : {};
            const commandText = typeof toolInput.command === 'string' ? toolInput.command : '';

            const verdict = decidePermissionAction(activePermissionMode, {
              toolName,
              commandText,
              rawInput: toolInput,
            });

            // 在自动模式 (auto) 或完全访问 (full_access) 下，非拦截项毫秒级自动放行，零弹窗打断
            if (verdict.decision === 'auto_allow') {
              proc.writeJsonLine({
                type: 'control_response',
                response: {
                  subtype: 'success',
                  request_id: requestId,
                  response: {
                    behavior: 'allow',
                    updatedInput: toolInput,
                  },
                },
              });
              return;
            }

            if (verdict.isAskUser) {
              const askPrompt = extractAskUserPrompt(toolInput);
              pendingControls.set(requestId, {
                toolInput,
                isAskUser: true,
                questionKey: askPrompt.questionText,
              });
              activeQueue.push({
                kind: 'approval_requested',
                requestId,
                title: `💬 向你提问: ${askPrompt.questionText}`,
                detail: askPrompt.detailText,
                options: askPrompt.options,
                allowCustomInput: true,
              });
              return;
            }

            pendingControls.set(requestId, { toolInput, isAskUser: false });
            const titlePrefix = verdict.isDangerous
              ? `⚠️ 高危操作确认: ${toolName} (${verdict.reason ?? '高风险'})`
              : `请求执行 ${toolName}`;
            activeQueue.push({
              kind: 'approval_requested',
              requestId,
              title: titlePrefix,
              detail: JSON.stringify(toolInput, null, 2).slice(0, 800),
              options: [
                { optionId: 'allow', label: '允许执行', kind: 'allow' },
                { optionId: 'deny', label: '拒绝', kind: 'deny' },
              ],
            });
          }
          return;
        }

        if (frameType === 'result') {
          const resultText =
            typeof frame.result === 'string' && frame.result.length > 0
              ? frame.result
              : accumulatedText;
          if (frame.is_error === true) {
            activeQueue.fail(new Error(resultText || 'Claude Code 返回执行错误'));
          } else {
            activeQueue.push({ kind: 'turn_done', finalText: resultText });
            activeQueue.close();
          }
          activeQueue = null;
        }
      },
      onExit: ({ code, signal, stderrTail }) => {
        pendingControls.clear();
        if (activeQueue) {
          const detail = stderrTail ? `: ${stderrTail}` : '';
          activeQueue.fail(
            new Error(`Claude Code 身体进程异常退出 (exitCode=${String(code)}, signal=${String(signal)})${detail}`)
          );
          activeQueue = null;
        }
      },
    });

    return {
      bodyKind: 'claude',
      isAlive: () => proc.isAlive(),
      reconfigure: async (nextBody): Promise<boolean> => {
        activePermissionMode = nextBody.permissionMode ?? 'ask';
        const nextEffort = nextBody.reasoningEffort?.trim() ?? '';
        const nextModel = nextBody.model?.trim() ?? '';
        if (nextEffort !== activeEffort) {
          return false;
        }
        if (activeModel && !nextModel) {
          return false;
        }
        if (nextModel && nextModel !== activeModel) {
          if (!proc.isAlive()) return false;
          try {
            proc.writeJsonLine({
              type: 'control_request',
              request_id: `set-model-${Date.now()}`,
              request: {
                subtype: 'set_model',
                model: nextModel,
              },
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
        if (!proc.isAlive()) {
          throw new Error('Claude Code 身体进程已离线。');
        }
        const queue = new AsyncEventQueue<MemberStreamEvent>();
        activeQueue = queue;
        accumulatedText = '';

        const onAbort = () => {
          if (activeQueue === queue) {
            activeQueue = null;
            queue.fail(new Error('当前轮次已被中断。'));
          }
        };
        if (signal.aborted) {
          onAbort();
          return queue;
        }
        signal.addEventListener('abort', onAbort, { once: true });

        try {
          proc.writeJsonLine({
            type: 'user',
            message: {
              role: 'user',
              content: [{ type: 'text', text: prompt }],
            },
          });
        } catch (err) {
          activeQueue = null;
          queue.fail(err instanceof Error ? err : new Error(String(err)));
        }

        return queue;
      },
      replyApproval: async (requestId: string, optionId: string): Promise<void> => {
        const pending = pendingControls.get(requestId);
        pendingControls.delete(requestId);

        if (pending?.isAskUser) {
          if (optionId === 'deny') {
            proc.writeJsonLine({
              type: 'control_response',
              response: {
                subtype: 'success',
                request_id: requestId,
                response: { behavior: 'deny', message: '用户取消了本次提问。' },
              },
            });
            return;
          }
          const answerValue = optionId.startsWith('answer:')
            ? optionId.slice('answer:'.length)
            : optionId;
          const prevAnswers =
            pending.toolInput.answers && typeof pending.toolInput.answers === 'object'
              ? (pending.toolInput.answers as Record<string, unknown>)
              : {};
          proc.writeJsonLine({
            type: 'control_response',
            response: {
              subtype: 'success',
              request_id: requestId,
              response: {
                behavior: 'allow',
                updatedInput: {
                  ...pending.toolInput,
                  answers: {
                    ...prevAnswers,
                    [pending.questionKey ?? 'answer']: answerValue,
                  },
                },
              },
            },
          });
          return;
        }

        const allow = optionId === 'allow';
        proc.writeJsonLine({
          type: 'control_response',
          response: {
            subtype: 'success',
            request_id: requestId,
            response: allow
              ? { behavior: 'allow', updatedInput: pending?.toolInput ?? {} }
              : { behavior: 'deny', message: '用户拒绝了该操作请求。' },
          },
        });
      },
      dispose: async () => {
        pendingControls.clear();
        activeQueue = null;
        await proc.dispose();
      },
    };
  }
}
