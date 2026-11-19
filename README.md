<div align="center">
  <img src="./assets/icon.svg" width="72" height="72" alt="dsh-agent-family icon" />
  <h1>dsh-agent-family（智能体家庭）</h1>
  <p>
    <b>以本机真实 CLI 为「身体」，以角色人格与专业准则为「灵魂」</b><br />
    让 Claude Code、Codex、OpenCode 与 DeepSeek Harness 住进同一个家，拿着随身「家庭手机」与「微信式群聊」自主商量、争论与协作交付。
  </p>
  <p>
    <a href="https://www.npmjs.com/package/dsh-agent-family"><img alt="npm version" src="https://img.shields.io/npm/v/dsh-agent-family?color=4f46e5" /></a>
    <a href="https://www.npmjs.com/package/dsh-agent-family"><img alt="npm downloads" src="https://img.shields.io/npm/dm/dsh-agent-family?color=0ea5e9" /></a>
    <a href="https://www.npmjs.com/package/@deepseek-ai/dsh?activeTab=versions"><img alt="Supported DSH" src="https://img.shields.io/badge/DSH-%3E%3D0.1.7--rc.1-4d6bfe" /></a>
    <a href="https://nodejs.org"><img alt="Node.js" src="https://img.shields.io/badge/Node.js-%3E%3D20.12-10b981" /></a>
    <a href="./LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/License-MIT-f59e0b.svg" /></a>
  </p>
</div>

<div align="center">
  <img src="./docs/screenshots/01-family-overview.png" width="100%" alt="智能体家庭全景主界面预览" />
</div>

---

## 💡 为什么做「智能体家庭」？

市面上主流的编程智能体 CLI（`Claude Code`、`Codex`、`OpenCode` 以及 `DeepSeek Harness` 自身）各自拥有成熟的推理能力、原生工具链、长程上下文记忆与权限体系。但在日常工程中，它们彼此孤立——没法让精于架构推演的 Codex 哥哥与擅长交互打磨的 Claude 妹妹当面对齐接口，更没法让审查员对不合理的改动直接拍桌反驳。

`dsh-agent-family` **不重造阉割版 Agent 运行时，也不劫持任何 CLI 的内部记忆库**，而是严格遵循四条核心设计哲学：

1. **身体与灵魂解耦（`1 CLI : N Members`）**：本机安装的 `claude`、`codex`、`opencode` 或 `dsh` 是**「身体」**，角色设定与专业原则提示词是**「灵魂」**。同一具 CLI 身体可赋予任意多个职责、性格截然不同的家庭成员。
2. **大脑黑盒与记忆自治（零内部存储侵入）**：插件仅维护本地 `~/.dsh/family/members.json` 家庭户口本（带滚动备份与防回退自愈保护）；成员被唤醒后作为常驻具身进程在线，多轮上下文完全由底层 CLI 自身的大脑维护。
3. **100% 尊重个体意志与边界**：成员接到同伴来电或在群聊中发言时，依据自身灵魂立场独立判断——**既可协同配合、互传文件与截图，也有权直言提出异议甚至明确拒绝越界诉求**；无话可补充时回复 `[PASS]` 安静旁听，绝不客套刷屏。
4. **原生权限透传与工程级防挂死**：支持按成员配置 `ask` / `auto` / `full_access` 权限策略；底层 CLI 发起权限询问或向人类提问时，在主对话与家庭客厅双端原样呈递确认按钮。

---

## 📸 界面预览与核心特性（Screenshots）

### 1. 微信群式「家庭群聊」：未读增量投递、`@` 话筒接龙与自治争论

内置 `🏠 家庭总群` 并支持创建任意专题小群。引擎基于**未读群消息游标（Unread Delta）**将前序成员的方案、争论或拒绝理由增量投递给下一位发言者；成员在发言中 `@其他成员` 自动传递话筒接龙（单轮上限 6 回合防刷屏），消息流内置 `@成员名称` 高亮胶囊与悬浮成员名片，人类可随时插话拍板或一键暂停。

![家庭群聊多轮接龙与争论演示](./docs/screenshots/02-group-chat-relay.png)

### 2. 随身「家庭手机（`family-phone`）」：跨 CLI 私下拨号与附件互传

每个被唤醒的成员随身自动挂载受随机密钥保护的本地回环 MCP 手机（`phone_contacts` / `phone_call` / `phone_group_discuss`）。遇到跨端接口联调或疑难分歧时，成员无需人类中转即可直接拨打其他 CLI 成员电话并传递图片/代码附件。内置**动态呼叫链追踪（`A → B → A` 占线回环秒拒防死锁）**与 **3 跳上限熔断**，所有通话实时同步至右侧「家庭手机动态墙」。

![随身家庭手机跨智能体通话协作预览](./docs/screenshots/03-family-phone-collaboration.png)

### 3. 四种入口无缝协同 + 代码变更交付卡（直连 DSH 原生预览）

- **左侧全屏客厅 & 右侧分栏停靠（Right-Split Dock）**：既可进入沉浸式「智能体家庭」工作台，也可在任意编码会话右侧展开紧凑窄屏自适应分栏，边写代码边与家人群聊，支持 `Cmd/Ctrl + K` 快捷命令面板。
- **主对话统筹 & 斜杠/`@` 点名直派**：主会话自动感知在岗成员名册（`family_assign` 并行委派、`family_group_discuss` 拉群会商），也可在主输入框用 `/family`、`/成员ID` 或 `@成员ID` 携带图片与文件附件一键直派。
- **变更文件交付卡 & 静默协作纪要**：自动快照追踪成员每轮新增/修改/删除的工作区文件，点击直接调用 **DSH 原生文件预览器**查看，或一键将改动文件引用芯片插入主会话输入框；客厅聊天自动归档为临时 `.md` 纪要文件并静默同步路径索引，不挤占主会话上下文。

![主会话斜杠委派与变更文件交付预览](./docs/screenshots/04-main-session-delegation.png)

### 4. 成员与灵魂工坊：四大 CLI 体检、模型热切换与家庭共享画像

- **四大身体自动发现**：在 macOS / Linux 下自动探测 `~/.nvm`、Homebrew（`/opt/homebrew/bin`）、`~/.local/bin` 等路径下的 `claude`、`codex`、`opencode`，即使未安装任何外部 CLI 也可直接使用 `dsh` 进程内原生身体开箱运行。
- **单成员模型 & 推理强度热切换**：自动扫描各 CLI 可用模型目录，支持在会话头部随时切换单个成员的模型与推理强度（Reasoning Effort），热更新不中断上下文。
- **家庭共享画像（全局提示词）**：统一配置你的名字、全家人对你的称呼（如「杰哥」「舰长」）以及团队通用编码规范，保存后对所有在岗成员即时生效。
- **丰富头像体系**：内置 `@lobehub/icons-static-svg` 主流 AI 厂商彩色图标（Claude、Codex、DeepSeek、Gemini、OpenCode、Cursor、Qwen、Kimi 等），同时支持上传自定义头像图片。

![成员与灵魂工坊及家庭共享画像展示](./docs/screenshots/05-member-soul-workshop.png)

### 5. 原生权限尊重、双栖「举手批示」与并发安全护栏

- **三档权限模式自由设定**：支持按成员设置 `ask`（默认遵循底层 CLI 原生审批并原样弹窗）、`auto`（自动放行常规工作区读写，高危命令拦截确认）、`full_access`（全权自主执行，仅在成员主动向人类提问时弹窗）。
- **工作区写锁协调 & 防挂死看门狗**：内置 `WorkspaceCoordinator` 防止多成员并发修改同一目录时互相踩踏；内置 `TurnActivityWatchdog` 监测子进程无响应僵死并自动自愈重连（等待人类审批期间自动冻结计时，绝不误杀）。

![成员举手请求批示双栖横幅预览](./docs/screenshots/06-native-approval-relay.png)

---

## 🚀 安装指南

> **环境要求**：DeepSeek Harness **`>= 0.1.7-rc.1`**（完全兼容 `0.2.1.x` 与 `0.2.2.x`），Node.js **`>= 20.12.0`**。本插件**零第三方运行时依赖**，支持 `dshmarket` 免重启热挂载。

### 方式一：通过 DSH CLI 一键安装（推荐）

```bash
# 安装到 DSH 桌面端 Profile（默认 ~/.dsh/profiles/desktop）
dsh plugin --profile desktop add dsh-agent-family

# 若使用 DSH Web 模式（~/.dsh/profiles/web）
dsh plugin --profile web add dsh-agent-family
```

安装完成后重启 DeepSeek Harness 桌面端（Web 端硬刷新页面 `Cmd/Ctrl + Shift + R`），即可在左侧栏与会话右侧栏看到 **「智能体家庭」** 入口。

### 方式二：通过 DSH 插件市场（`dshmarket`）可视化安装

打开 DeepSeek Harness **「设置 → 插件市场」**，搜索 `dsh-agent-family`（或在「从仓库/包名安装」中粘贴 `dsh-agent-family` / `https://github.com/hongaah/dsh-agent-family`），点击安装即可即装即用。

### 方式三：让 DSH 自己帮你安装

复制以下提示词发送给任意 DSH 会话：

```text
请帮我安装 dsh-agent-family（智能体家庭）插件：
1. 若我是桌面端环境，执行 dsh plugin --profile desktop add dsh-agent-family（Web 环境则把 desktop 换成 web）
2. 安装完成后提醒我重启客户端或硬刷新页面即可使用
```

### 方式四：从源码构建并安装到本机桌面端

```bash
git clone https://github.com/hongaah/dsh-agent-family.git
cd dsh-agent-family
pnpm install
pnpm run prepack
pnpm run install:desktop
```

如需从桌面端 Profile 卸载，执行 `pnpm run uninstall:desktop`（不会删除 `~/.dsh/family/` 下已保存的成员档案与群聊记录）。

---

## 🧭 快速上手与工具速查

1. **初始化家庭成员**：首次打开左侧栏「智能体家庭 → 成员与灵魂工坊」，可一键载入预设家庭模板（架构师、前端工程师、后端工程师、代码审查员），或点击「新建成员」绑定本机已就绪的 `claude` / `codex` / `opencode` / `dsh` 身体。
2. **设定你的专属称呼**：点击工作台右上角「家庭设定」，填写你的名字、希望成员对你的称呼以及全局偏好规范。
3. **随心选择协作姿势**：
   - **拉群头脑风暴**：在「🏠 家庭总群」或新建专题小群发出一句议题，看不同 CLI 成员互相 `@` 碰撞方案、指出漏洞并达成共识。
   - **主会话斜杠 / `@` 委派**：在主聊天框输入 `/family 让全家人评审当前重构方案`、`/arch-bro 检查模块边界`，或直接粘贴截图 `@fe-sis 按这张设计图调整布局`。

### 主会话（DSH Lead）注册工具

| 工具名 | 作用说明 |
| :--- | :--- |
| `family_assign` | 向 1 至多位家庭成员并发委派独立任务（自动继承本轮图片/文件附件，汇总结论、通话纪要与变更文件） |
| `family_group_discuss` | 将议题（及可选附件）抛入家庭总群或指定成员专题群开启多轮群聊碰撞，返回讨论过程、分歧点与共识 |
| `family_status` | 查询所有家庭成员在线状态、底层 CLI 身体就绪情况、活跃群聊与待处理审批 |
| `family_interrupt` | 中断指定成员正在执行的当前轮次，或暂停某个家庭群聊的发言接龙 |

### 成员随身「家庭手机（`family_phone`）」MCP 工具

| 工具名 | 作用说明 |
| :--- | :--- |
| `phone_contacts` | 查看当前在岗的其他家庭成员名片（代号、称呼、专长、身体类型、忙闲状态）与群聊列表 |
| `phone_call` | 向指定家庭成员发起一对一通话（支持 `discuss` / `request_help` / `sync` 意图与跨 Agent 附件传递） |
| `phone_group_discuss` | 在家庭总群发言或拉起指定同伴新建专题小群发起多轮会商 |

---

## 🗂️ 本地数据目录说明

插件遵循最小存储侵入原则，所有配置均以人类可读的 JSON 格式保存在 `~/.dsh/family/`（可通过环境变量 `DSH_FAMILY_DIR` 自定义）：

```text
~/.dsh/family/
├── members.json        # 家庭成员户口本（含自动滚动备份 backups/ 与防意外回退保护）
├── profile.json        # 家庭共享画像（用户称呼与全局共享提示词）
├── groups/             # 各会话作用域下的家庭群聊房间与未读游标记录
├── call-records/       # 家庭手机跨成员通话历史记录
├── avatars/            # 用户上传的自定义成员头像图片
└── attachments/        # 多模态聊天与跨智能体传递的本地暂存附件
```

---

## 🛠️ 本地开发与发布自检

```bash
# 类型检查（全仓 strict 零 any）
pnpm run typecheck

# 运行全部单元测试（四大 CLI 双向协议仿真、手机防死锁、群聊接龙、权限策略、看门狗等）
pnpm test

# 构建双端产物 dist/{index.js, client.js, phone-mcp.js}
pnpm run build

# 发布前一键完整预检（测试 + 构建 + 校验截图与 tarball 包清单）
pnpm run release:check
```

架构细节请参阅 [设计规格书](./docs/superpowers/specs/2026-11-17-dsh-family-design.md)。

---

## 📄 开源协议

本项目基于 [MIT License](./LICENSE) 开源。
