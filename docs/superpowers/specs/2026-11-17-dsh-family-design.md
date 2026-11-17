# `@ugreen/dsh-family`（智能体家庭）设计规格书

- **日期**：2026-11-17
- **目标宿主**：DeepSeek Harness（Desktop & Web Profile，`>=0.1.7-rc.1` / `0.2.x`）
- **定位**：基于「身体（本机 CLI）+ 灵魂（角色提示词）= 具身家庭成员」理念的智能体自治与协作插件

---

## 1. 背景与核心设计哲学

市面上主流的编程智能体 CLI（`Claude Code`、`Codex`、`OpenCode` 以及 `DeepSeek Harness` 自身）各自拥有成熟的推理能力、工具生态、上下文记忆与安全权限机制。但在日常开发中，它们彼此孤立，且缺乏稳定的角色人格与跨智能体自主沟通渠道。

`@ugreen/dsh-family` 将这些 CLI 组织为一个像真人团队一样运作的**智能体家庭（Agents Family）**，严格遵循以下四条核心原则：

1. **身体与灵魂解耦（`1 CLI : N Members`）**
   - **身体（Body）**：本机安装的 `claude`、`codex`、`opencode` 或宿主 `dsh` 自身。同一具身体可被任意多个家庭成员复用。
   - **灵魂（Soul）**：赋予该成员的身份定位、专业边界、性格风格与工作准则提示词。
2. **大脑黑盒与记忆自治（零内部存储侵入）**
   - 插件只在本地保存「家庭户口本（成员档案）」，**绝不接管或重建 CLI 内部的记忆存储与上下文数据库**。
   - 成员在会话中被唤醒后作为常驻具身实例保持在线，多轮上下文完全由底层 CLI 自身的大脑维护。
3. **完全尊重个体意志（原生权限透传）**
   - 插件**绝不在外层发明独立的权限档位，也不篡改本机各 CLI 原有的权限配置**。
   - 若成员 A 的底层 CLI 判定某次操作需要人类审批，插件仅作为「传声筒」将其原始询问与选项呈递给用户并回传点击结果；若成员 B 的底层 CLI 判定可直接放行，则静默自主完成。
4. **独立闭环与「家庭手机」自主协作**
   - 成员平时各自独立工作（自己的上下文自己清楚，互不污染）。
   - 每个被唤醒的成员随身配有一部**「家庭手机（`family-phone`）」**。遇到跨领域问题、方案评审或需要他人配合时，成员可自主拨号联系其他家庭成员探讨方案、请求协助；被呼叫成员依据自身灵魂立场独立判断——**既可协同配合、补充建议，也有权明确拒绝不合理或越界的请求**。

---

## 2. 系统总体架构与目录边界

项目采用标准 DeepSeek Harness 双端组合包（Bundle）形态，所有 TypeScript 源码启用严格类型检查（`strict: true`），**全仓禁止使用 `any` 标记类型**。

```text
dsh-family/
├── package.json                 # 声明 dsh.bundle 与 dsh.client 元数据
├── cordis.patch.yml             # 插入节点 id: dsh-family
├── tsconfig.json                # 严格 TS 配置（noImplicitAny / strict）
├── scripts/
│   ├── build.mjs                # esbuild 打包 dist/{index,client,phone-mcp}.js
│   └── install-desktop.mjs      # 一键安装/卸载至 ~/.dsh/profiles/desktop
├── src/
│   ├── core/
│   │   ├── types.ts             # 全部领域契约与严格类型定义（零 any）
│   │   ├── member-registry.ts   # ~/.dsh/family/members.json 户口本持久化与内置模板
│   │   ├── soul-composer.ts     # 灵魂提示词组装（用户灵魂 + 具身身份与手机使用自觉）
│   │   ├── cli-locator.ts       # macOS/Linux/NVM/Homebrew 可执行文件探测与体检
│   │   └── family-hub.ts        # 常驻成员生命周期、单成员串行队列、审批路由与事件广播
│   ├── phone/
│   │   ├── phone-bus.ts         # 127.0.0.1:0 随机密钥鉴权的本地家庭手机通信总线（含防死锁/跳数限制）
│   │   └── phone-mcp-stdio.ts   # 配发给外部 CLI 子进程的轻量 stdio MCP 服务入口
│   ├── drivers/
│   │   ├── driver.ts            # BodyDriver 与 LiveMemberSession 抽象契约
│   │   ├── json-rpc-peer.ts     # 通用 NDJSON / JSON-RPC 2.0 双向流帧解析器
│   │   ├── claude-driver.ts     # Claude Code stream-json + host permission 双向驱动
│   │   ├── codex-driver.ts      # Codex app-server --stdio JSON-RPC 双向驱动
│   │   ├── opencode-driver.ts   # OpenCode acp (Agent Client Protocol) 双向驱动
│   │   └── dsh-native-driver.ts # DSH 进程内 ctx.subagents / ctx.agents 原生驱动
│   ├── host/
│   │   ├── dsh-types.ts         # DSH Cordis 宿主最小类型面声明
│   │   └── index.ts             # 注册 family_* 工具、系统提示词名册、@点名拦截与 Web API/SSE
│   └── client/
│       ├── api.ts               # 前端类型化请求与 SSE 实时状态订阅模型
│       ├── FamilyWorkbench.tsx  # 左侧栏「智能体家庭」主工作台（家庭客厅 + 成员与灵魂工坊）
│       ├── ApprovalBanner.tsx   # 全局/面板双栖「成员举手请求批示」原样确认组件
│       ├── FamilyToolCard.tsx   # 对话流内 family_assign 实时协作与通话动态卡片
│       ├── styles.ts            # 作用域隔离样式注入
│       └── index.tsx            # DSH Web Client Slots 注册入口
└── tests/
    ├── member-registry.test.ts  # 户口本校验、启停与持久化单测
    ├── phone-bus.test.ts        # 家庭手机一对一通话、自主拒绝、占线防死锁与跳数上限单测
    ├── drivers.test.ts          # Mock 子进程仿真验证四大驱动双向流、灵魂注入与审批回传
    └── host-plugin.test.ts      # Cordis 工具注册、@成员点名拦截与生命周期回收单测
```

---

## 3. 核心领域模型与类型契约

### 3.1 家庭成员档案（户口本 `~/.dsh/family/members.json`）

```ts
export type BodyKind = 'claude' | 'codex' | 'opencode' | 'dsh'

export interface BodySpec {
  readonly kind: BodyKind
  /** 可选自定义可执行文件绝对路径或命令名；省略时由 cli-locator 自动解析 */
  readonly command?: string
  /** 可选透传给底层 CLI 的额外原生启动参数；默认为空数组，不干预 CLI 默认模型与权限 */
  readonly extraArgs?: readonly string[]
}

export interface FamilyMember {
  /** 唯一短标识，格式 ^[a-z][a-z0-9-]{0,31}$，保留词 lead 不可用 */
  readonly id: string
  /** 家庭显示称呼，如「架构师大哥」「前端妹妹」 */
  readonly name: string
  /** 头像 Emoji 或预设图标标识 */
  readonly avatar: string
  /** 一句话角色定位与擅长领域，展示在主对话名册与家庭手机通讯录中 */
  readonly specialty: string
  /** 绑定的 CLI 身体 */
  readonly body: BodySpec
  /** 灵魂提示词：性格、专业准则、职责边界与行事风格 */
  readonly soulPrompt: string
  /** 是否在岗可用；休假成员不出现在通讯录与自动调度名单中 */
  readonly enabled: boolean
  readonly createdAt: string
  readonly updatedAt: string
}
```

首次初始化若 `members.json` 不存在，提供一键载入可选预设家庭模板（如架构师、前端工程师、后端工程师、代码审查员）的能力，不强制锁定任何身体，用户可自由新建、修改或清空。

### 3.2 灵魂组装协议（`composeAwakeningSoul`）

在唤醒任意身体时，将用户填写的 `soulPrompt` 与一段轻量的**具身协作自觉提示词**拼装后注入身体：
- **自我认知**：明确自身称呼 `name`、唯一代号 `@${id}` 与专长职责 `specialty`。
- **独立与协作准则**：属于自身职责内的工作直接动手独立闭环；遇到跨端接口对齐、方案拿不准或需他人配合时，主动使用随身 `family_phone`（先看 `phone_contacts`，再拨打 `phone_call` 或发起 `phone_roundtable`）。
- **独立意志与拒绝权**：接到其他家庭成员来电时，站在自身专业视角审视——赞同时积极配合或给出具体方案；若认为对方诉求越界、方向错误或存在隐患，**必须直言提出异议或明确拒绝并给出替代建议**，不做盲从传声筒。

### 3.3 具身会话与流式事件契约（`LiveMemberSession`）

```ts
export interface ApprovalOption {
  readonly optionId: string
  readonly label: string
  readonly kind?: 'allow' | 'allow_always' | 'deny'
}

export type MemberActivityState =
  | 'sleeping'
  | 'idle'
  | 'working'
  | 'in_call'
  | 'awaiting_approval'
  | 'error'

export type MemberStreamEvent =
  | { readonly kind: 'text_delta'; readonly delta: string }
  | { readonly kind: 'status'; readonly summary: string }
  | {
      readonly kind: 'approval_requested'
      readonly requestId: string
      readonly title: string
      readonly detail?: string
      readonly options: readonly ApprovalOption[]
    }
  | { readonly kind: 'turn_done'; readonly finalText: string }

export interface AwakenMemberContext {
  readonly scopeId: string
  readonly member: FamilyMember
  readonly composedSoul: string
  readonly cwd: string
  readonly phoneMcp: PhoneMcpLaunchSpec
  readonly signal: AbortSignal
}

export interface LiveMemberSession {
  sendTurn(prompt: string, signal: AbortSignal): AsyncIterable<MemberStreamEvent>
  replyApproval(requestId: string, optionId: string): Promise<void>
  dispose(): Promise<void>
}
```

---

## 4. 四大身体双向神经驱动规格

在 macOS 桌面端（Electron）环境下，宿主默认 `PATH` 往往不包含 `~/.nvm`、`/opt/homebrew/bin` 或 `~/.local/bin`。`cli-locator.ts` 会在清理后的环境变量基础上自动补全常见用户级可执行目录，确保桌面端无需手动配置路径即可发现已安装的 `claude`、`codex`、`opencode`。

### 4.1 `ClaudeDriver`（连接 `claude`）
- **常驻进程启动参数**：
  ```text
  claude -p --verbose
    --input-format stream-json
    --output-format stream-json
    --include-partial-messages
    --permission-prompts host
    --append-system-prompt <composedSoul>
    --mcp-config <serializedPhoneMcpConfig>
    [...extraArgs]
  ```
- **对话驱动**：向 `stdin` 写入单行 JSON 用户消息帧；从 `stdout` 按行解析 `stream_event` / `assistant` 增量文本、工具动作摘要，收到 `type: 'result'` 时结算当前轮次 `turn_done`。
- **原生审批透传**：当读取到 `type: 'control_request'` 且 `request.subtype === 'can_use_tool'` 时，提取工具名与输入摘要发出 `approval_requested`（选项为 `allow` 允许执行、`deny` 拒绝执行）；用户点击后向 `stdin` 写入对应的 `control_response` 帧放行或驳回。

### 4.2 `CodexDriver`（连接 `codex`）
- **常驻进程启动参数**：
  ```text
  codex app-server --stdio
    -c mcp_servers.family_phone.command="node"
    -c mcp_servers.family_phone.args=["<dist/phone-mcp.js>"]
    -c mcp_servers.family_phone.env={...}
    [...extraArgs]
  ```
- **初始化与灵魂绑定**：通过 stdio JSON-RPC 2.0 发送 `initialize` 与 `initialized`，随后调用 `thread/start` 传入 `{ cwd, developerInstructions: composedSoul }`（不传 `approvalPolicy` 与 `sandbox`，完全保留用户 `~/.codex/config.toml` 的原生设定），保存返回的 `threadId`。
- **对话驱动**：每轮向同一 `threadId` 发送 `turn/start`，订阅 `item/agentMessage/delta` 等流式通知直至收到 `turn/completed`。
- **原生审批透传**：当收到服务端发起的 JSON-RPC 请求（如命令执行或文件变更审批请求）时，将其提供的决策项（如允许本次、本会话允许、拒绝）原样转为 `approval_requested`；用户点击后以该 JSON-RPC `id` 回复决策对象。

### 4.3 `OpenCodeDriver`（连接 `opencode`）
- **常驻进程启动参数**：`opencode acp [...extraArgs]`（遵循标准 Agent Client Protocol JSON-RPC 2.0）。
- **初始化与灵魂绑定**：执行 `initialize` 握手后，调用 `session/new` 传入 `{ cwd, mcpServers: [{ name: 'family_phone', command: 'node', args: [...], env: [...] }] }` 获取 `sessionId`。首轮交互时前置注入 `<composedSoul>` 建立持续会话人格。
- **对话驱动**：每轮调用 `session/prompt`，监听 `session/update`（提取 `agent_message_chunk` 与 `tool_call` 状态）直至 `session/prompt` 返回结束原因。
- **原生审批透传**：当收到 `session/request_permission` 请求时，将其携带的 `options`（含 `optionId`、`name`、`kind`）一字不改映射为 `approval_requested`；用户点击后回复 `{ outcome: { outcome: 'selected', optionId } }`（若轮次被取消则回复 `{ outcome: { outcome: 'cancelled' } }`）。

### 4.4 `DshNativeDriver`（连接 DeepSeek Harness 自身）
- **运行机制**：优先复用当前运行中的 DSH 宿主进程内能力（无需要求系统全局安装独立 `dsh` CLI）。
  - 在存在父级活跃 `Agent` 的会话内，首次唤醒调用 `ctx.subagents.startActivation({ provider: 'spawn', name: member.id, label: member.name, cwd, prompt, delivery: 'caller' })` 创建可续接子会话，后续轮次通过 `ctx.subagents.sendMessage` 驱动同一 `childId`。
  - 若在独立客厅无父级 `Agent` 场景下唤醒，而宿主公开了 `ctx.agents` 创建接口则直接创建受管会话；若运行环境配置了显式 `body.command`（外部 `dsh` CLI），也可降级走 `dsh acp` 标准 ACP 通道。
- **手机配发与权限**：在宿主 `ctx.tools` 注册表上按调用 `Agent` 的 `session.id` 作用域动态开放同款 `phone_*` 工具；权限直接走 DSH 宿主原生审批体系。

---

## 5. 「家庭手机（`family-phone`）」跨成员通讯总线与防死锁设计

### 5.1 物理通信架构
1. 宿主启动 `FamilyPhoneBus`，在 `127.0.0.1:0`（系统随机空闲端口）开启仅本机回环可访问的轻量 HTTP JSON 端点，并生成单次运行期随机 32 字节十六进制密钥 `busToken`。
2. 唤醒任意外部 CLI 成员时，为其生成的临时 `family_phone` MCP 配置均指向插件内置的 `dist/phone-mcp.js`，并通过受控环境变量注入：
   - `DSH_FAMILY_BUS_URL`: `http://127.0.0.1:<port>`
   - `DSH_FAMILY_BUS_TOKEN`: `<busToken>`
   - `DSH_FAMILY_SCOPE_ID`: `<scopeId>`
   - `DSH_FAMILY_CALLER_ID`: `<member.id>`
3. 该机制在 DSH Desktop、DSH Web、Headless 模式及 Vitest 测试中行为完全一致，且不修改用户任何本地全局配置文件。

### 5.2 手机工具定义
每个成员的 `family_phone` 提供以下 3 个工具：

1. **`phone_contacts`**：无必填参数。返回当前在岗的其他家庭成员名片列表（`id`、`name`、`specialty`、`bodyKind`、当前状态 `idle | working | in_call | awaiting_approval`）。
2. **`phone_call`**：
   - 入参：`{ to: string, intent: 'discuss' | 'request_help' | 'sync', message: string }`
   - 行为：向目标成员 `to` 发起通话。目标成员若尚未唤醒则在相同项目目录 `cwd` 下自动唤醒；向其投递格式化来电消息（注明来电成员姓名、代号、意图与内容），等待其独立思考或操作完毕后，将回复文本与通话记录 ID 返回给主叫方。
3. **`phone_roundtable`**：
   - 入参：`{ participants: readonly string[], topic: string, context: string }`
   - 行为：并发拨通多位家庭成员征求各自专业视角的方案评估或异议，汇总每位成员的真实答复后一次性返回给发起人。

### 5.3 死锁消除与防无限转接护栏
跨智能体同步调用最核心的风险是回环死锁（`A` 等 `B` 回话时 `B` 又同步呼叫 `A`）与无限踢皮球：
- **通话链动态追踪（`currentTurnCallChain`）**：由于每个成员都是跨轮次常驻进程，呼叫链不能写死在启动环境变量中，而由宿主 `FamilyHub` 在该成员当前活跃轮次（每个 `(scopeId, memberId)` 同一时刻仅执行一个轮次）的内存上下文中动态维护 `readonly string[]`。例如人类派活给 `arch-bro`（其 `currentTurnCallChain` 为 `[]`），`arch-bro` 通过手机呼叫 `fe-sis` 时，总线读取主叫方 `arch-bro` 当前轮次的链并追加自身，使 `fe-sis` 本轮执行的 `currentTurnCallChain` 变为 `['arch-bro']`。
- **占线回环秒拒（消除死锁）**：若 `fe-sis` 在处理该来电期间调用 `phone_call({ to: 'arch-bro' })`，总线检测到 `'arch-bro'` 已在当前 `currentTurnCallChain` 中，**不进入队列等待，立即返回结构化占线提示**：
  > `成员「架构师大哥 (arch-bro)」正拿着电话等待你的本次回复，无需反向拨号。请直接在当前回复中向 TA 提出你的反问、修改建议或拒绝理由。`
- **最大通话跳数限制（`MAX_CALL_HOPS = 3`）**：当 `currentTurnCallChain.length >= 3` 时拒绝继续向下游第 4 层转拨，提示当前成员先向上游汇报阶段性判断或分歧点。
- **全程留痕广播**：每次拨号、接听、回复摘要均生成 `PhoneCallRecord` 事件，通过 SSE 实时推送到前端「家庭客厅」与主对话协作卡片。

---

## 6. 混合派活流转与用户交互体验

### 6.1 三条派活入口汇聚至 `FamilyHub`
同一个 DSH 会话（`scopeId = sessionId`）在三条入口间共享同一批在线具身成员实例：
1. **主对话统筹（DSH Lead 工具集）**：
   - `ctx.systemPrompt` 注册 `dsh-family:roster` 段落，动态列出当前在岗家庭成员及其专长，指导主 Agent 将专业任务或并行任务通过 `family_assign` 交由家庭成员独立或协作完成。
   - `family_assign`：支持一次指派 1 至多个成员任务（`tasks: [{ memberId, goal, cwd?, fresh? }]`），多成员并发推进，返回各成员最终结论及期间发生的「家庭手机通话纪要」。
   - `family_status`：查询家庭成员在线状态、身体就绪情况与待处理审批。
   - `family_interrupt`：中断指定成员正在执行的当前轮次。
2. **主输入框 `@成员ID` 点名直派**：
   - 监听 `agent/pre-step` 瀑布流事件，当检测到用户输入包含 `@<已启用成员ID>` 时，自动附加上下文路由指引，要求主 Agent 直接将需求原汁原味委派给被点名的家庭成员处理。
3. **左侧「智能体家庭」工作台一对一直聊**：
   - 用户可在工作台选定关联的工作区会话（或默认独立工作区），点击任意家庭成员直接发消息交代任务、实时观看其思考与输出流，无需经过主对话转述。

### 6.2 界面结构（DSH Web / Desktop Client）
1. **左侧一级常驻入口**：通过 `sidebar.panellist` 与 `main` Slot 挂载「智能体家庭」工作台，包含两个视图页签：
   - **「家庭客厅」**：左栏为成员在线状态列表（区分空闲、独立推进中、通话协商中、举手待批示）；中栏为选中成员的实时对话与动作流（支持发送指令、中断当前动作、重置唤醒新身体）；右栏为实时滚动的**「家庭手机动态墙」**（清晰展示成员间谁找了谁、讨论了什么、达成了合作还是拒绝了提议）。
   - **「成员与灵魂工坊」**：顶部展示本机 `claude`、`codex`、`opencode`、`dsh` 四具身体的实时体检状态与探测路径（支持一键重新体检）；下方为成员卡片网格与新建/编辑抽屉（配置代号、称呼、头像、专长、选择身体、编写灵魂提示词或套用参考模板）。
2. **对话流内嵌协作卡（`tool.call.toolview`）**：为 `family_assign` 渲染紧凑美观的成员并行进度卡与成员间通话折叠摘要。
3. **双栖「举手批示」横幅（`ApprovalBanner`）**：通过 `conversation.input.top`（或工作台顶部常驻条）双端挂载——只要任一成员的 CLI 发出 `approval_requested`，用户在主聊天窗或家庭客厅都能第一时间看到该成员的原样选项按钮并一键批复。

---

## 7. 异常容错、安全围栏与资源生命周期

1. **进程异常退出自愈**：
   - 若某成员的底层 CLI 子进程非预期退出（崩溃、被系统杀死或协议断流），当前进行中的 `sendTurn` 以清晰的诊断信息结算并自动驳回该成员名下挂起的未决审批，同时将该成员实例标记为已休眠移除；下次人类或其他成员再呼叫 TA 时，自动拉起全新健康的身体进程，不影响其他家庭成员。
2. **优雅回收零残留**：
   - 所有 `LiveMemberSession` 子进程、`FamilyPhoneBus` HTTP 监听以及前端样式/订阅均通过 Cordis `ctx.effect()` 注册释放钩子。
   - 插件热更新、卸载或退出 DSH 桌面端时，依次执行「关闭 stdin → 等待宽限期退出 → 发送终止信号回收进程树」，确保不残留后台孤儿 CLI 进程。
3. **安全边界**：
   - `/dsh-family/api/*` 复用宿主 `connection.requestRejection` 校验浏览器会话合法性。
   - `FamilyPhoneBus` 仅绑定 `127.0.0.1` 且每次请求强制校验 `Authorization: Bearer <busToken>`，杜绝跨站请求或本机未授权进程伪造调用。
   - 子进程启动均基于环境变量脱敏策略，不将无关宿主凭据泄露到日志或前端响应中。

---

## 8. 测试与验收标准

1. **类型安全检查**：`pnpm run typecheck`（`tsc --noEmit`）零报错，全仓源码与测试代码零 `any`。
2. **自动化单元测试（`vitest run`）**：
   - `member-registry.test.ts`：校验成员 ID 规范、重复拦截、模板导入与 JSON 原子落盘。
   - `drivers.test.ts`：使用可控 Node Mock 子进程完整模拟 `claude`（`stream-json` + `can_use_tool` 审批往返）、`codex`（`app-server` JSON-RPC 握手、流式增量与审批回复）、`opencode`（`acp` 会话、MCP 透传与 `request_permission` 选项回传）及异常断流恢复。
   - `phone-bus.test.ts`：验证成员 A 拨打成员 B 协同分析、成员 B 基于灵魂设定拒绝不合理请求、`A -> B -> A` 占线回环秒拒无死锁，以及超过 3 跳自动熔断。
   - `host-plugin.test.ts`：验证 `family_*` 工具注册、系统提示词动态名册生成、`@成员ID` 预步骤路由增强与插件卸载全量清理。
3. **构建与桌面端安装闭环**：
   - `pnpm run build` 正常产出 `dist/index.js`、`dist/client.js` 与 `dist/phone-mcp.js`。
   - `pnpm run install:desktop` 可非破坏式安装至 `~/.dsh/profiles/desktop`，保留现有全部其他插件。
