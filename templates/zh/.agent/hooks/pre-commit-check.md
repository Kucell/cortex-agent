# 钩子：提交前检查 (Pre-Commit Check)

## 触发时机
此钩子在 `git commit` 操作完成之前自动触发。

## 目的
确保代码质量，防止常见错误进入代码库。

## 执行步骤
1.  **识别暂存文件**：获取所有已暂存待提交的文件列表。
2.  **运行代码检查工具**：对每个暂存文件运行项目配置的代码检查工具（例如，ESLint、Ruff）并检查错误。
3.  **检查敏感信息**：扫描暂存文件中的硬编码密钥、API 密钥或其他敏感信息。
4.  **验证测试覆盖率**：（可选）运行快速测试覆盖率检查，确保新代码得到充分测试。

## 结果
-   如果任何步骤失败，提交过程将被中止，并向用户显示解释失败原因的错误消息。
-   如果所有步骤都通过，则允许提交继续进行。

---

# 钩子适配器：Claude Code 治理 (T-ACN-017)

## 概述
Claude Code 钩子适配器将 Claude Code 钩子桥接到协调机器，对代理生命周期执行治理。每个钩子负载在到达协调服务之前都会经过验证、脱敏和限速处理。

## 钩子映射

| 钩子名称 | 协调事件 | 说明 |
|---------|---------|------|
| `SessionStart` | `task.accepted` | 仅通过真实启动器（需要 CORTEX_LAUNCH_CONTEXT）|
| `PostToolUse` | `task.progress` | 限速（5000ms 窗口），窗口内合并 |
| `TestStart` | `task.testing` | 从测试信号自动检测（npm test、vitest、jest 等）|
| `Notification` | `task.input_required` | 原始负载被剥离；仅转发 requestedAction |
| `Permission` | `task.input_required` | 原始负载被剥离；仅转发 requestedAction |
| `ReadyForReview` | `task.ready_for_review` | 仅转发允许的证据引用 |
| `Stop` | — | 永不推断完成；协调器决定终止状态 |
| `SubagentStop` | — | 永不推断完成；协调器决定终止状态 |

## 安全契约
1. **失败关闭**：未知钩子名称被静默忽略。
2. **脱敏**：prompt、session、path、command、tool payload 和凭据始终被脱敏。
3. **限速**：PostToolUse 每个工具名称每 5000ms 限制 1 次发射。
4. **测试信号**：带有测试命令（npm test、vitest、jest、node --test 等）的 PostToolUse 映射到 `task.testing`。
5. **证据验证**：仅转发匹配允许模式（ARTIFACT-*、RUN-*、./relative、src/、lib/、tests/、docs/）的证据引用。
6. **不推断完成**：Stop 和 SubagentStop 永不发射 `task.completed` 或 `task.failed`。

## 集成
适配器位于 `lib/coordination/claude-hook-adapter.js`。使用 `createClaudeHookAdapter({ rateLimitMs })` 创建实例，并通过 `adapter.dispatch(hookName, payload)` 分发钩子负载。每个处理程序返回一个包含 `ok`、`code` 和 `eventType` 字段的结构化结果。
