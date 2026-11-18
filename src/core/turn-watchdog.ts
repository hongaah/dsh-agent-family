export type TurnWatchdogScene = 'group' | 'phone_call' | 'direct';

export interface TurnWatchdogTimeouts {
  /** 群聊单人发言最大静默时长（默认 90s） */
  readonly groupIdleMs: number;
  /** 家庭电话被叫方最大静默时长（默认 120s） */
  readonly phoneCallIdleMs: number;
  /** 私聊独立执行任务最大静默时长（默认 180s） */
  readonly directIdleMs: number;
}

export const DEFAULT_WATCHDOG_TIMEOUTS: TurnWatchdogTimeouts = {
  groupIdleMs: 90_000,
  phoneCallIdleMs: 120_000,
  directIdleMs: 180_000,
};

export class MemberTurnStallError extends Error {
  public readonly memberId: string;
  public readonly memberName: string;
  public readonly idleTimeoutMs: number;
  public readonly scene: TurnWatchdogScene;

  public constructor(params: {
    readonly memberId: string;
    readonly memberName: string;
    readonly idleTimeoutMs: number;
    readonly scene: TurnWatchdogScene;
  }) {
    const sec = Math.max(1, Math.round(params.idleTimeoutMs / 1000));
    super(
      `家庭成员「${params.memberName} (@${params.memberId})」连续 ${sec} 秒无任何流式输出或工具状态响应，已触发心跳超时保护。`
    );
    this.name = 'MemberTurnStallError';
    this.memberId = params.memberId;
    this.memberName = params.memberName;
    this.idleTimeoutMs = params.idleTimeoutMs;
    this.scene = params.scene;
  }
}

/**
 * 单轮执行流式活动心跳看门狗：
 * - 每次收到 `text_delta` 或 `status` 工具心跳时调用 `touch()` 刷新计时器；
 * - 当进入人类审批 (`approval_requested`) 或等待下游 `phone_call` 子通话期间，支持按 token `pause(reasonKey)` 挂起计时，绝不误杀正常等待；
 * - 所有挂起原因解除 (`resume(reasonKey)`) 后自动重新起算空闲窗口；
 * - 一旦真正假死超时，构造 `MemberTurnStallError` 并触发 `onStall` 回调主动中断本轮并回收僵尸身体。
 */
export class TurnActivityWatchdog {
  private readonly idleTimeoutMs: number;
  private readonly memberId: string;
  private readonly memberName: string;
  private readonly scene: TurnWatchdogScene;
  private readonly onStall: (error: MemberTurnStallError) => void;
  private readonly pauseTokens = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private stalledError: MemberTurnStallError | null = null;

  public constructor(options: {
    readonly memberId: string;
    readonly memberName: string;
    readonly scene: TurnWatchdogScene;
    readonly idleTimeoutMs: number;
    readonly onStall: (error: MemberTurnStallError) => void;
  }) {
    this.memberId = options.memberId;
    this.memberName = options.memberName;
    this.scene = options.scene;
    this.idleTimeoutMs = Math.max(20, options.idleTimeoutMs);
    this.onStall = options.onStall;
    this.armTimer();
  }

  public touch(): void {
    if (this.stopped) return;
    if (this.pauseTokens.size > 0) return;
    this.armTimer();
  }

  public pause(token: string): void {
    if (this.stopped) return;
    this.pauseTokens.add(token);
    this.clearTimer();
  }

  public resume(token: string): void {
    if (this.stopped) return;
    this.pauseTokens.delete(token);
    if (this.pauseTokens.size === 0) {
      this.armTimer();
    }
  }

  public isPaused(): boolean {
    return this.pauseTokens.size > 0;
  }

  public getStallError(): MemberTurnStallError | null {
    return this.stalledError;
  }

  public stop(): void {
    this.stopped = true;
    this.pauseTokens.clear();
    this.clearTimer();
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private armTimer(): void {
    this.clearTimer();
    if (this.stopped || this.pauseTokens.size > 0) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.stopped || this.pauseTokens.size > 0) return;
      this.stopped = true;
      const err = new MemberTurnStallError({
        memberId: this.memberId,
        memberName: this.memberName,
        idleTimeoutMs: this.idleTimeoutMs,
        scene: this.scene,
      });
      this.stalledError = err;
      this.onStall(err);
    }, this.idleTimeoutMs);
    this.timer.unref?.();
  }
}
