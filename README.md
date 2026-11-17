# dsh-agent-family（智能体家庭）

DeepSeek Harness 智能体家庭插件：将本机安装的 CLI（`claude`、`codex`、`opencode` 与 `DeepSeek Harness` 自身）作为**「身体」**，将角色设定与专业原则提示词作为**「灵魂」**，创造出能够像真人一样独立闭环或通过**随身「家庭手机」与「家庭群聊」**自主协作、争论甚至拒绝不合理要求的家庭成员。

## 核心特性

- **`1 CLI : N Agents` 身体与灵魂解耦**：同一个 CLI 可创建任意多个不同职责、不同性格的家庭成员。
- **零内部记忆侵入 & 100% 尊重 CLI 自身意志**：插件仅保存 `~/.dsh/family/members.json` 成员户口本，不自建记忆库、不套外层权限锁；各成员的多轮记忆与是否发起审批完全由底层 CLI 自己决定，需要人类批示时原样透传确认按钮。
- **随身「家庭手机（`family-phone`）」**：每个唤醒的成员自动临时挂载 `phone_contacts`、`phone_call`、`phone_group_discuss`，支持跨 CLI 成员私下请教、协作或基于灵魂立场明确拒绝（内置占线回环防死锁与 3 跳上限）。
- **微信群式「家庭群聊」**：内置 `🏠 家庭总群` 与自定义专题群，基于未读群消息增量投递、`@成员ID` 话筒接龙与 `[PASS]` 静默旁听机制，让人类与多位成员同处一室高效会商。
- **三种派活方式自由切换**：主对话管家统筹（`family_assign` / `family_group_discuss`）、聊天框 `@成员ID` 点名直派、左侧栏「智能体家庭」客厅群聊或一对一直聊。

## 本地构建、测试与安装到 DSH 桌面端

```bash
pnpm install
pnpm run typecheck
pnpm test
pnpm run build
pnpm run install:desktop
```

安装完成后完全退出并重新打开 DeepSeek Harness 桌面端，即可在左侧栏看到 **「智能体家庭」** 入口。如需卸载执行 `pnpm run uninstall:desktop`。
