import type {
  BodyKind,
  FamilyMember,
  MemberStreamEvent,
  PhoneMcpLaunchSpec,
} from '../core/types.ts';

export interface AwakenMemberContext {
  readonly scopeId: string;
  readonly member: FamilyMember;
  readonly composedSoul: string;
  readonly cwd: string;
  readonly phoneMcp: PhoneMcpLaunchSpec;
  readonly signal: AbortSignal;
}

export interface LiveMemberSession {
  readonly bodyKind: BodyKind;
  isAlive(): boolean;
  sendTurn(prompt: string, signal: AbortSignal): AsyncIterable<MemberStreamEvent>;
  replyApproval(requestId: string, optionId: string): Promise<void>;
  dispose(): Promise<void>;
}

export interface BodyDriver {
  readonly kind: BodyKind;
  awaken(context: AwakenMemberContext): Promise<LiveMemberSession>;
}

/**
 * 严格类型化的异步事件推流队列，用于将子进程回调流转换为 AsyncIterable。
 */
export class AsyncEventQueue<T> implements AsyncIterable<T> {
  private readonly buffer: T[] = [];
  private readonly waiters: Array<{
    resolve: (result: IteratorResult<T>) => void;
    reject: (error: Error) => void;
  }> = [];
  private closed = false;
  private failure: Error | null = null;

  public push(item: T): void {
    if (this.closed || this.failure) return;
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter.resolve({ value: item, done: false });
      return;
    }
    this.buffer.push(item);
  }

  public close(): void {
    if (this.closed || this.failure) return;
    this.closed = true;
    while (this.waiters.length > 0) {
      const waiter = this.waiters.shift()!;
      waiter.resolve({ value: undefined, done: true });
    }
  }

  public fail(error: Error): void {
    if (this.closed || this.failure) return;
    this.failure = error;
    while (this.waiters.length > 0) {
      const waiter = this.waiters.shift()!;
      waiter.reject(error);
    }
  }

  public [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> => {
        if (this.buffer.length > 0) {
          const nextItem = this.buffer.shift()!;
          return Promise.resolve({ value: nextItem, done: false });
        }
        if (this.failure) {
          return Promise.reject(this.failure);
        }
        if (this.closed) {
          return Promise.resolve({ value: undefined, done: true });
        }
        return new Promise<IteratorResult<T>>((resolve, reject) => {
          this.waiters.push({ resolve, reject });
        });
      },
    };
  }
}
