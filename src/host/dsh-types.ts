/**
 * DeepSeek Harness (Cordis) 宿主最小类型面声明。
 * 严格遵循零 `any` 约束，所有动态边界均使用显式接口或 `unknown` 收窄。
 */

export interface DshHttpRequest {
  url?: string;
  method?: string;
  headers: Record<string, string | string[] | undefined>;
  on?(event: 'close' | 'error', listener: () => void): void;
  [Symbol.asyncIterator](): AsyncIterator<string | Uint8Array>;
}

export interface DshHttpResponse extends NodeJS.WritableStream {
  statusCode: number;
  headersSent?: boolean;
  writeHead(status: number, headers?: Record<string, string>): void;
  write(chunk: string | Uint8Array): boolean;
  destroy(error?: Error): this;
  readonly writableEnded?: boolean;
  flushHeaders?(): void;
}

export interface DshWebRoute {
  readonly kind: 'exact' | 'prefix';
  readonly path: string;
  readonly handler: (req: DshHttpRequest, res: DshHttpResponse) => void | Promise<void>;
}

export interface DshWebServer {
  register(route: DshWebRoute): () => void;
}

export interface DshConnectionService {
  requestRejection?(request: {
    headers: Record<string, string | string[] | undefined>;
  }): 401 | 403 | undefined;
}

export interface DshPermissionPresetsService {
  readonly names?: readonly string[];
  set?(session: DshSessionHandle, presetName: string): void;
}

export interface DshApprovalService {
  setPolicy?(agent: DshOwnedAgent, policy: 'ask' | 'never'): void;
}

export interface DshModelSelection {
  readonly provider: string;
  readonly model: string;
  readonly reasoningEffort?: string;
}

export interface DshLlmProviderInfo {
  readonly id: string;
  readonly name: string;
}

export interface DshLlmModelMetadata {
  readonly provider: string;
  readonly id: string;
  readonly name?: string;
  readonly reasoningEfforts?: readonly string[];
}

export interface DshLlmService {
  listProviders?(): readonly DshLlmProviderInfo[];
  listModels?(provider: string): Promise<readonly DshLlmModelMetadata[]>;
}

export interface DshAgentDefaultModelService {
  currentSelection?(): DshModelSelection | undefined;
}

export interface DshSessionEventRecord {
  readonly seq: number;
  readonly type: string;
  readonly data: Record<string, unknown>;
}

export interface DshSessionHandle {
  readonly id?: string;
  readonly seq?: number;
  readonly header: { readonly cwd?: string } & Record<string, unknown>;
  snapshotEvents?(fromSeq?: number): readonly DshSessionEventRecord[];
}

export interface DshHostSessionStore {
  get(id: string): DshSessionHandle | undefined;
}

export interface DshWorkingDirectoryService {
  readonly defaultDirectory?: string;
  get(session: DshSessionHandle): string | undefined;
}

export interface DshAgentLike {
  readonly session: DshSessionHandle & { readonly id: string };
  readonly model?: {
    current?(): DshModelSelection | undefined;
  };
  readonly ctx?: DshHostContext;
}

export interface DshAgentScopedEventMap {
  'session/event': (
    session: DshSessionHandle & { readonly id: string },
    event: DshSessionEventRecord
  ) => void;
  'agent/assistant-stream': (payload: {
    readonly agent?: unknown;
    readonly frame: Record<string, unknown>;
  }) => void;
  'agent/error': (payload: { readonly agent?: unknown; readonly error: unknown }) => void;
}

export interface DshAgentScopedContext {
  readonly systemPrompt?: DshSystemPromptService;
  readonly tools?: DshToolsRegistry;
  on<K extends keyof DshAgentScopedEventMap>(
    event: K,
    listener: DshAgentScopedEventMap[K]
  ): () => void;
}

export interface DshOwnedAgent {
  readonly id: string;
  readonly session: DshSessionHandle & { readonly id: string };
  readonly ctx: DshAgentScopedContext;
  readonly model?: {
    current?(): DshModelSelection | undefined;
    select?(selection: DshModelSelection): void;
  };
  followup(message: Record<string, unknown>): void;
  cancel?(cause: { readonly kind: 'user' | 'disposed' }): void;
}

export interface DshOwnedAgentHandle {
  readonly agent: DshOwnedAgent;
  dispose(): Promise<void>;
}

export interface DshAgentsRegistry {
  get?(sessionId: string): DshAgentLike | undefined;
  create?(options: {
    readonly sessionId: string;
    readonly meta?: Record<string, unknown>;
    readonly agentOptions?: Record<string, unknown>;
    readonly signal?: AbortSignal;
    readonly setup?: (
      agentCtx: DshAgentScopedContext,
      agent: DshOwnedAgent
    ) => void | Promise<void>;
  }): Promise<DshOwnedAgentHandle>;
}

export interface DshContentTextBlock {
  readonly type: 'text';
  readonly text: string;
}

export interface DshSubagentResult {
  readonly output: ReadonlyArray<{ readonly type: string; readonly text?: string }>;
  readonly diagnostic?: string;
  readonly stopReason: string;
}

export interface DshSubagentActivation {
  readonly childId: string;
  readonly name: string;
  readonly result: Promise<DshSubagentResult>;
  dispose(): Promise<void>;
}

export interface DshSubagentRuntime {
  startActivation(spec: {
    readonly provider: string;
    readonly label: string;
    readonly name?: string;
    readonly cwd?: string;
    readonly prompt: readonly DshContentTextBlock[];
    readonly parent: DshAgentLike;
    readonly signal: AbortSignal;
    readonly delivery: 'parent' | 'caller';
  }): Promise<DshSubagentActivation>;
}

export interface DshToolRunContext {
  readonly callId: string;
  readonly name: string;
  readonly arguments: unknown;
  readonly signal: AbortSignal;
  readonly agent?: DshAgentLike;
}

export interface DshRawToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly timeoutMs?: number;
  readonly parameters: Record<string, unknown>;
  readonly output: {
    readonly schema: Record<string, unknown>;
    readonly render: (args: unknown, value: unknown) => DshContentTextBlock[];
    readonly presentationMeta?: (args: unknown, value: unknown) => unknown;
  };
  readonly execute: (args: Record<string, unknown>, exec: DshToolRunContext) => Promise<unknown>;
}

export interface DshToolsRegistry {
  register(
    tool: DshRawToolDefinition,
    options?: { readonly when: () => boolean | Promise<boolean> }
  ): () => void;
  restrict?(filter: {
    readonly allow?: readonly string[];
    readonly deny?: readonly string[];
  }): () => void;
}

export interface DshSystemPromptService {
  getSectionOrder?(key: string): number | undefined;
  section(spec: {
    readonly name: string;
    readonly order: number;
    readonly interpolate?: boolean;
    readonly text: string | (() => string);
  }): () => void;
}

export interface DshPreStepMessage {
  readonly id?: string;
  readonly role?: string;
  readonly content: Array<{ readonly type: string; readonly text?: string } & Record<string, unknown>>;
  readonly source?: Record<string, unknown>;
}

export type DshPreStepDecision =
  | { readonly kind: 'reject'; readonly reason?: string }
  | ({ readonly kind: 'enter'; readonly messages: DshPreStepMessage[] } & Record<string, unknown>);

export interface DshPreStepPayload {
  readonly agent: DshAgentLike;
  readonly messages: DshPreStepMessage[];
  readonly step: number;
  readonly signal: AbortSignal;
}

export interface DshSubagentEndInfo {
  readonly id: string;
  readonly parentSessionId: string;
  readonly result: DshSubagentResult;
}

export interface DshHostEventMap {
  'agent/pre-step': (
    payload: DshPreStepPayload,
    next: () => Promise<DshPreStepDecision>
  ) => Promise<DshPreStepDecision>;
  'subagent/end': (info: DshSubagentEndInfo) => void;
}

export interface DshCommandInvocation {
  readonly commandId: string;
  readonly agent: DshAgentLike;
  readonly rawInput: string;
  readonly attachments?: readonly unknown[];
  readonly signal: AbortSignal;
}

export interface DshCommandResult {
  readonly kind: 'success' | 'error';
  readonly text?: string;
}

export interface DshCommandDefinition {
  readonly definitionId?: string;
  readonly name: string;
  readonly description: string;
  readonly input?: {
    readonly hint: string;
    readonly attachments?: boolean;
  };
  readonly recordInput?: boolean;
  readonly handler: (
    invocation: DshCommandInvocation
  ) => DshCommandResult | Promise<DshCommandResult>;
}

export interface DshCommandsRegistry {
  register(definition: DshCommandDefinition): () => void;
}

export interface DshHostContext {
  readonly webServer?: DshWebServer;
  readonly sessions: DshHostSessionStore;
  readonly tools: DshToolsRegistry;
  readonly commands?: DshCommandsRegistry;
  readonly systemPrompt?: DshSystemPromptService;
  readonly logger?: {
    info(msg: string, ...args: unknown[]): void;
    warn(msg: string, ...args: unknown[]): void;
    error(msg: string, ...args: unknown[]): void;
  };
  get(name: string): unknown;
  effect(
    fn: () => (() => void) | void | Generator<() => void, void, unknown>,
    label?: string
  ): () => void;
  inject(deps: readonly string[], callback: (scoped: DshHostContext) => void | (() => void)): () => void;
  plugin?(fn: (sub: DshHostContext) => void): { dispose(): void };
  on<K extends keyof DshHostEventMap>(event: K, listener: DshHostEventMap[K]): () => void;
}
