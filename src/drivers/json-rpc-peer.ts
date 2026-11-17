import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';

import { buildChildProcessEnv } from '../core/cli-locator.ts';

export type JsonRpcId = string | number;

export interface JsonRpcIncomingRequest {
  readonly id: JsonRpcId;
  readonly method: string;
  readonly params: Record<string, unknown>;
}

export interface JsonRpcIncomingNotification {
  readonly method: string;
  readonly params: Record<string, unknown>;
}

export interface NdjsonProcessOptions {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly onLine: (parsed: Record<string, unknown>) => void;
  readonly onExit: (info: { code: number | null; signal: NodeJS.Signals | null; stderrTail: string }) => void;
}

/**
 * 受管 NDJSON 常驻子进程句柄：负责按行解析 JSON、捕获诊断尾部、以及分级优雅退出。
 */
export class ManagedNdjsonProcess {
  private readonly child: ChildProcessWithoutNullStreams;
  private alive = true;
  private stderrTail = '';
  private readonly exitPromise: Promise<void>;

  public constructor(options: NdjsonProcessOptions) {
    this.child = spawn(options.executable, [...options.args], {
      cwd: options.cwd,
      env: buildChildProcessEnv(options.env, options.executable),
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (chunk: string) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-4096);
    });

    const rl = createInterface({ input: this.child.stdout });
    rl.on('line', (line) => {
      const trimmed = line.trim();
      if (!trimmed.startsWith('{')) return;
      try {
        const parsed = JSON.parse(trimmed) as unknown;
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          options.onLine(parsed as Record<string, unknown>);
        }
      } catch {
        // 忽略非协议行输出
      }
    });

    this.exitPromise = new Promise<void>((resolveExit) => {
      const handleDead = (code: number | null, signal: NodeJS.Signals | null) => {
        if (!this.alive) {
          resolveExit();
          return;
        }
        this.alive = false;
        rl.close();
        options.onExit({ code, signal, stderrTail: this.stderrTail.trim() });
        resolveExit();
      };
      this.child.once('error', (err) => {
        this.stderrTail = `${this.stderrTail}\n${err.message}`.trim().slice(-4096);
        handleDead(-1, null);
      });
      this.child.once('close', (code, sig) => {
        handleDead(code, sig);
      });
    });
  }

  public isAlive(): boolean {
    return this.alive;
  }

  public getStderrTail(): string {
    return this.stderrTail.trim();
  }

  public writeJsonLine(payload: Record<string, unknown>): void {
    if (!this.alive || !this.child.stdin.writable) {
      throw new Error('成员底层 CLI 进程已离线，无法写入消息。');
    }
    this.child.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  public async dispose(): Promise<void> {
    if (!this.alive) {
      await this.exitPromise;
      return;
    }
    try {
      this.child.stdin.end();
    } catch {
      // ignore
    }

    const exitedOnEof = await Promise.race([
      this.exitPromise.then(() => true),
      new Promise<boolean>((r) => setTimeout(() => r(false), 300)),
    ]);
    if (exitedOnEof) return;

    try {
      this.child.kill('SIGTERM');
    } catch {
      // ignore
    }

    const exitedOnTerm = await Promise.race([
      this.exitPromise.then(() => true),
      new Promise<boolean>((r) => setTimeout(() => r(false), 700)),
    ]);
    if (exitedOnTerm) return;

    try {
      this.child.kill('SIGKILL');
    } catch {
      // ignore
    }
    await this.exitPromise;
  }
}

/**
 * 基于 ManagedNdjsonProcess 的双向 JSON-RPC 2.0 端点（支持 Codex app-server 与 OpenCode ACP）。
 */
export class JsonRpcStdioPeer {
  private readonly proc: ManagedNdjsonProcess;
  private nextSeq = 1;
  private readonly pendingCalls = new Map<
    JsonRpcId,
    {
      resolve: (value: Record<string, unknown>) => void;
      reject: (error: Error) => void;
    }
  >();
  private readonly includeJsonRpcHeader: boolean;
  private exitError: Error | null = null;

  public constructor(options: {
    readonly executable: string;
    readonly args: readonly string[];
    readonly cwd: string;
    readonly env?: Readonly<Record<string, string>>;
    readonly includeJsonRpcHeader?: boolean;
    readonly onNotification: (notification: JsonRpcIncomingNotification) => void;
    readonly onServerRequest: (request: JsonRpcIncomingRequest) => void;
    readonly onExit?: (error: Error) => void;
  }) {
    this.includeJsonRpcHeader = options.includeJsonRpcHeader ?? true;
    this.proc = new ManagedNdjsonProcess({
      executable: options.executable,
      args: options.args,
      cwd: options.cwd,
      env: options.env,
      onLine: (msg) => {
        const hasId = typeof msg.id === 'string' || typeof msg.id === 'number';
        const method = typeof msg.method === 'string' ? msg.method : undefined;

        if (hasId && !method) {
          const id = msg.id as JsonRpcId;
          const pending = this.pendingCalls.get(id);
          if (!pending) return;
          this.pendingCalls.delete(id);
          if (msg.error && typeof msg.error === 'object') {
            const errObj = msg.error as Record<string, unknown>;
            pending.reject(
              new Error(typeof errObj.message === 'string' ? errObj.message : JSON.stringify(errObj))
            );
            return;
          }
          const resultObj =
            msg.result && typeof msg.result === 'object' && !Array.isArray(msg.result)
              ? (msg.result as Record<string, unknown>)
              : { value: msg.result };
          pending.resolve(resultObj);
          return;
        }

        if (hasId && method) {
          const params =
            msg.params && typeof msg.params === 'object' && !Array.isArray(msg.params)
              ? (msg.params as Record<string, unknown>)
              : {};
          options.onServerRequest({
            id: msg.id as JsonRpcId,
            method,
            params,
          });
          return;
        }

        if (method) {
          const params =
            msg.params && typeof msg.params === 'object' && !Array.isArray(msg.params)
              ? (msg.params as Record<string, unknown>)
              : {};
          options.onNotification({ method, params });
        }
      },
      onExit: ({ code, signal, stderrTail }) => {
        const detail = stderrTail ? ` (${stderrTail})` : '';
        const err = new Error(
          `CLI 进程已退出 (code=${String(code)}, signal=${String(signal)})${detail}`
        );
        this.exitError = err;
        for (const [, pending] of this.pendingCalls) {
          pending.reject(err);
        }
        this.pendingCalls.clear();
        options.onExit?.(err);
      },
    });
  }

  public isAlive(): boolean {
    return this.proc.isAlive();
  }

  public request(
    method: string,
    params?: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<Record<string, unknown>> {
    if (this.exitError) {
      return Promise.reject(this.exitError);
    }
    const id = this.nextSeq++;
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const onAbort = () => {
        this.pendingCalls.delete(id);
        reject(new Error(`请求 ${method} 已被中断。`));
      };
      if (signal?.aborted) {
        onAbort();
        return;
      }
      signal?.addEventListener('abort', onAbort, { once: true });

      this.pendingCalls.set(id, {
        resolve: (value) => {
          signal?.removeEventListener('abort', onAbort);
          resolve(value);
        },
        reject: (err) => {
          signal?.removeEventListener('abort', onAbort);
          reject(err);
        },
      });

      try {
        this.proc.writeJsonLine({
          ...(this.includeJsonRpcHeader ? { jsonrpc: '2.0' } : {}),
          id,
          method,
          ...(params !== undefined ? { params } : {}),
        });
      } catch (err) {
        this.pendingCalls.delete(id);
        signal?.removeEventListener('abort', onAbort);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  public notify(method: string, params?: Record<string, unknown>): void {
    this.proc.writeJsonLine({
      ...(this.includeJsonRpcHeader ? { jsonrpc: '2.0' } : {}),
      method,
      ...(params !== undefined ? { params } : {}),
    });
  }

  public respond(id: JsonRpcId, result: Record<string, unknown>): void {
    this.proc.writeJsonLine({
      ...(this.includeJsonRpcHeader ? { jsonrpc: '2.0' } : {}),
      id,
      result,
    });
  }

  public async dispose(): Promise<void> {
    await this.proc.dispose();
  }
}
