/**
 * `dsh-agent-family` 全部核心领域类型契约。
 * 遵循「身体（CLI）+ 灵魂（Prompt）= 具身家庭成员」设计哲学：
 * - 不存储任何 CLI 内部记忆库；
 * - 不定义任何外层权限规则（100% 透传 CLI 自身意志与审批选项）；
 * - 全仓严格类型化，禁用 `any`。
 */

export const BODY_KINDS = ['claude', 'codex', 'opencode', 'dsh'] as const;
export type BodyKind = (typeof BODY_KINDS)[number];

export const PERMISSION_MODES = ['ask', 'auto', 'full_access'] as const;
export type PermissionMode = (typeof PERMISSION_MODES)[number];

export interface BodySpec {
  readonly kind: BodyKind;
  /** 权限自主模式：ask(每次询问) / auto(自动模式，仅危险操作与 AskUser 询问) / full_access(完全访问，仅 AskUser 询问) */
  readonly permissionMode?: PermissionMode;
  /** 可选模型标识覆盖；留空或省略表示跟随该 CLI 自身默认配置 */
  readonly model?: string;
  /** 可选推理强度/思考快慢覆盖（如 low 秒回、medium 均衡、high 深度、xhigh 满血）；省略表示跟随 CLI 默认 */
  readonly reasoningEffort?: string;
  /** 可选自定义可执行文件路径或命令名；留空则自动探测本机安装路径 */
  readonly command?: string;
  /** 可选原生启动附加参数；默认空数组，模型与权限均沿用 CLI 自身配置 */
  readonly extraArgs?: readonly string[];
}

export interface BodyModelOption {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
  readonly isDefault?: boolean;
  readonly isFast?: boolean;
  readonly supportedEfforts?: readonly string[];
}

export interface BodyModelCatalog {
  readonly kind: BodyKind;
  readonly currentDefault?: string;
  readonly models: readonly BodyModelOption[];
  readonly supportsEffort: boolean;
  readonly defaultEfforts: readonly string[];
}

export interface FamilyMember {
  /** 唯一短标识，格式 `^[a-z][a-z0-9-]{0,31}$`（保留词 `lead` 不可用） */
  readonly id: string;
  /** 家庭称呼，如「架构师大哥」「前端妹妹」 */
  readonly name: string;
  /** 头像 Emoji 或短标识 */
  readonly avatar: string;
  /** 一句话角色定位与专长说明，展示在主对话名册与家庭手机通讯录中 */
  readonly specialty: string;
  /** 绑定的 CLI 身体 */
  readonly body: BodySpec;
  /** 灵魂提示词：角色立场、做事原则、专业边界 */
  readonly soulPrompt: string;
  /** 是否在岗可用 */
  readonly enabled: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreateMemberInput {
  readonly id: string;
  readonly name: string;
  readonly avatar?: string;
  readonly specialty: string;
  readonly body: BodySpec;
  readonly soulPrompt: string;
  readonly enabled?: boolean;
}

export interface UpdateMemberInput {
  readonly name?: string;
  readonly avatar?: string;
  readonly specialty?: string;
  readonly body?: BodySpec;
  readonly soulPrompt?: string;
  readonly enabled?: boolean;
}

export interface StarterMemberTemplate {
  readonly id: string;
  readonly name: string;
  readonly avatar: string;
  readonly specialty: string;
  readonly recommendedBody: BodyKind;
  readonly soulPrompt: string;
}

export interface FamilySharedProfile {
  /** 用户的真实姓名或昵称（例如「杨杰」） */
  readonly userName: string;
  /** 全体家庭成员对用户的统一称呼（例如「杰哥」「老板」「主理人」） */
  readonly userHonorific: string;
  /** 全体成员共享的家庭公约、全局提示词或公共背景知识 */
  readonly sharedPrompt: string;
  readonly updatedAt?: string;
}

export interface UpdateFamilyProfileInput {
  readonly userName?: string;
  readonly userHonorific?: string;
  readonly sharedPrompt?: string;
}

export interface BodyHealthStatus {
  readonly kind: BodyKind;
  readonly label: string;
  readonly available: boolean;
  readonly executablePath?: string;
  readonly mode: 'cli' | 'dsh-native';
  readonly note?: string;
}

export interface ApprovalOption {
  readonly optionId: string;
  readonly label: string;
  readonly kind?: 'allow' | 'allow_always' | 'deny';
}

export interface PendingApproval {
  readonly approvalId: string;
  readonly scopeId: string;
  readonly memberId: string;
  readonly memberName: string;
  readonly memberAvatar: string;
  readonly bodyKind: BodyKind;
  readonly requestId: string;
  readonly title: string;
  readonly detail?: string;
  readonly options: readonly ApprovalOption[];
  readonly allowCustomInput?: boolean;
  readonly createdAt: string;
}

export type MemberActivityState =
  | 'sleeping'
  | 'idle'
  | 'working'
  | 'in_call'
  | 'awaiting_approval'
  | 'error';

export type MemberStreamEvent =
  | { readonly kind: 'text_delta'; readonly delta: string }
  | { readonly kind: 'status'; readonly summary: string }
  | {
      readonly kind: 'approval_requested';
      readonly requestId: string;
      readonly title: string;
      readonly detail?: string;
      readonly options: readonly ApprovalOption[];
      readonly allowCustomInput?: boolean;
    }
  | { readonly kind: 'turn_done'; readonly finalText: string };

export interface PhoneMcpLaunchSpec {
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly httpUrl: string;
  readonly bearerToken: string;
}

export type WorkspaceFileChangeKind = 'added' | 'modified' | 'deleted';

export interface WorkspaceFileChange {
  /** 相对于会话工作目录 cwd 的规范化路径（使用 `/` 分隔） */
  readonly path: string;
  readonly kind: WorkspaceFileChangeKind;
  readonly additions?: number;
  readonly deletions?: number;
  /** 最近修改该文件的成员称呼或 ID */
  readonly byMemberName?: string;
}

export interface PendingMainSyncSummary {
  readonly scopeId: string;
  readonly changedFiles: readonly WorkspaceFileChange[];
  readonly noteCount: number;
  readonly updatedAt: string;
}

export interface MemberChatEntry {
  readonly id: string;
  readonly role: 'human' | 'lead' | 'peer' | 'member' | 'system';
  readonly authorName: string;
  readonly content: string;
  readonly statusSummary?: string;
  readonly streaming?: boolean;
  /** 该轮成员执行实际落盘的文件变更清单 */
  readonly changedFiles?: readonly WorkspaceFileChange[];
  readonly createdAt: string;
}

export interface MemberRuntimeSnapshot {
  readonly scopeId: string;
  readonly memberId: string;
  readonly state: MemberActivityState;
  readonly statusText?: string;
  readonly cwd?: string;
  readonly queueLength: number;
  readonly entries: readonly MemberChatEntry[];
  readonly unreadCount?: number;
  readonly lastActiveAt?: string;
}

export type PhoneCallIntent = 'discuss' | 'request_help' | 'sync';

export interface PhoneCallRecord {
  readonly id: string;
  readonly scopeId: string;
  readonly fromMemberId: string;
  readonly fromMemberName: string;
  readonly toMemberId: string;
  readonly toMemberName: string;
  readonly intent: PhoneCallIntent;
  readonly message: string;
  readonly status: 'ringing' | 'completed' | 'busy_rejected' | 'hop_limited' | 'failed';
  readonly reply?: string;
  readonly createdAt: string;
  readonly finishedAt?: string;
}

export interface GroupMessage {
  readonly id: string;
  readonly groupId: string;
  /** `'human' | 'lead' | 'system' | member.id` */
  readonly senderId: string;
  readonly senderName: string;
  readonly senderAvatar: string;
  readonly content: string;
  /** 消息正文中解析出的有效被 `@` 成员 ID 列表 */
  readonly mentions: readonly string[];
  /** 该成员在本轮群聊发言中实际落盘的文件变更清单 */
  readonly changedFiles?: readonly WorkspaceFileChange[];
  readonly createdAt: string;
}

export interface GroupStreamingDraft {
  readonly senderId: string;
  readonly senderName: string;
  readonly senderAvatar: string;
  readonly content: string;
  readonly statusSummary?: string;
}

export interface FamilyGroupRoom {
  /** 默认内置 `'family-main'`（🏠 家庭总群），也支持专题小群 */
  readonly id: string;
  readonly title: string;
  readonly scopeId: string;
  /** `'all_enabled'` 动态涵盖当前所有在岗成员；数组为固定成员子集 */
  readonly memberIds: 'all_enabled' | readonly string[];
  readonly messages: readonly GroupMessage[];
  /** 每个成员已投递到的消息下标，用于切片计算「未读群消息增量」 */
  readonly readCursors: Readonly<Record<string, number>>;
  /** 人类用户尚未阅读的新群聊回复条数 */
  readonly unreadCount: number;
  readonly activeSpeakerId: string | null;
  readonly streamingDraft?: GroupStreamingDraft | null;
  readonly lastPassMemberName?: string;
  readonly running: boolean;
}

export type FamilyFocusTarget =
  | { readonly kind: 'group'; readonly groupId: string }
  | { readonly kind: 'member'; readonly memberId: string };

export type FamilyRealtimeEvent =
  | { readonly type: 'roster_updated'; readonly members: readonly FamilyMember[] }
  | { readonly type: 'profile_updated'; readonly profile: FamilySharedProfile }
  | { readonly type: 'member_runtime'; readonly snapshot: MemberRuntimeSnapshot }
  | { readonly type: 'approval_opened'; readonly approval: PendingApproval }
  | { readonly type: 'approval_closed'; readonly approvalId: string; readonly selectedOptionId?: string }
  | { readonly type: 'phone_call_updated'; readonly record: PhoneCallRecord }
  | { readonly type: 'group_updated'; readonly room: FamilyGroupRoom }
  | { readonly type: 'main_sync_updated'; readonly summary: PendingMainSyncSummary }
  | { readonly type: 'focus_requested'; readonly scopeId: string; readonly target: FamilyFocusTarget };
