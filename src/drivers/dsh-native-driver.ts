import type { FamilyMember, MemberStreamEvent } from '../core/types.ts';
import {
  AsyncEventQueue,
  type AwakenMemberContext,
  type BodyDriver,
  type LiveMemberSession,
} from './driver.ts';
import { OpenCodeDriver } from './opencode-driver.ts';

export interface DshHostTurnRequest {
  readonly scopeId: string;
  readonly member: FamilyMember;
  readonly composedSoul: string;
  readonly cwd: string;
  readonly prompt: string;
  readonly isFirstTurn: boolean;
  readonly signal: AbortSignal;
  readonly onDelta?: (delta: string) => void;
  readonly onStatus?: (summary: string) => void;
}

export interface DshHostBridge {
  isAvailable(): boolean;
  runTurn(request: DshHostTurnRequest): Promise<string>;
  disposeMember?(scopeId: string, memberId: string): Promise<void>;
}

/**
 * DeepSeek Harness 自身身体驱动器：
 * - 在 DSH 宿主进程内直接驱动原生 `ctx.subagents`（零外部安装依赖，共享宿主原生审批流）；
 * - 若脱离宿主且显式配置了本地 `dsh` 可执行路径，则复用标准 `dsh acp` 协议连接。
 */
export class DshNativeDriver implements BodyDriver {
  public readonly kind = 'dsh' as const;
  private readonly bridge?: DshHostBridge;

  public constructor(bridge?: DshHostBridge) {
    this.bridge = bridge;
  }

  public async awaken(context: AwakenMemberContext): Promise<LiveMemberSession> {
    if (this.bridge?.isAvailable()) {
      const bridge = this.bridge;
      let alive = true;
      let turnIndex = 0;

      return {
        bodyKind: 'dsh',
        isAlive: () => alive,
        sendTurn: (prompt: string, signal: AbortSignal): AsyncIterable<MemberStreamEvent> => {
          if (!alive) {
            throw new Error('DSH 原生成员会话已关闭。');
          }
          const queue = new AsyncEventQueue<MemberStreamEvent>();
          const isFirstTurn = turnIndex === 0;
          turnIndex += 1;

          let streamedDelta = false;
          void bridge
            .runTurn({
              scopeId: context.scopeId,
              member: context.member,
              composedSoul: context.composedSoul,
              cwd: context.cwd,
              prompt,
              isFirstTurn,
              signal,
              onDelta: (delta) => {
                if (delta) {
                  streamedDelta = true;
                  queue.push({ kind: 'text_delta', delta });
                }
              },
              onStatus: (summary) => queue.push({ kind: 'status', summary }),
            })
            .then((finalText) => {
              if (!streamedDelta && finalText) {
                queue.push({ kind: 'text_delta', delta: finalText });
              }
              queue.push({ kind: 'turn_done', finalText });
              queue.close();
            })
            .catch((err: unknown) => {
              queue.fail(err instanceof Error ? err : new Error(String(err)));
            });

          return queue;
        },
        replyApproval: async (): Promise<void> => {
          // DSH 宿主内子代理直接使用宿主原生审批界面，无需额外中转
        },
        dispose: async (): Promise<void> => {
          alive = false;
          await bridge.disposeMember?.(context.scopeId, context.member.id);
        },
      };
    }

    // 兜底：若显式指定了本地 dsh CLI，使用 dsh acp 标准通道驱动
    const acpFallback = new OpenCodeDriver();
    return acpFallback.awaken({
      ...context,
      member: {
        ...context.member,
        body: {
          kind: 'opencode',
          command: context.member.body.command ?? 'dsh',
          extraArgs: ['--profile', 'acp', ...(context.member.body.extraArgs ?? [])],
        },
      },
    });
  }
}
