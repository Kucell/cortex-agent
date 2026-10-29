# Codex Notification Pump — 本地真实宿主验收交接（2026-10-19）

状态：**LOCAL_VALIDATION_REQUIRED / NOT_RUN**  
目标：确认 Cortex Agent 的现有 Codex App Server Notification Adapter 是否真的能向 **既有 Codex Desktop/CLI 会话** 投递消息，而不只是向独立 App Server 返回成功状态。  
范围：本 PR 仅加入可选测试入口和回归测试；不变更产品调度、权限、Hook 或默认行为。真实设备验证前不得宣称 Desktop 已唤醒。

## 本地 Agent 接手指令

你是 Cortex Agent 的 Codex Host Acceptance Tester。只在隔离分支和测试会话上工作。先核验当前仓库基线、审批/Owner/Lease 和执行权限；禁止修改真实治理状态、自动 ACK、自动审批、合并、发布或直接操作生产队列。不得修改用户原有 Otty PermissionRequest Hook，亦不得把 Hook 视为外部消息 API。若需要对既有会话追加 Turn，必须由操作者明确确认选定测试线程。

1. 获取分支并核验差异（不要覆盖本地未提交内容）：

   ```bash
   git status --short --branch
   git fetch origin test/codex-notification-real-host-acceptance-20261019
   git switch -c local/codex-notification-validation FETCH_HEAD
   git diff --stat origin/main...HEAD
   node --version
   command -v codex
   codex --version
   ```

2. 先运行 **不连接真实宿主** 的测试：

   ```bash
   node --test tests/coordination/codex-real-host-handoff.test.js
   node scripts/validation/codex-notification-live-smoke.js --help
   ```

3. 打开 Codex Desktop 中的**指定测试会话**。从经过授权的 Codex 会话环境或本机配置取得真实 Thread ID，在本机 shell 设置 `CORTEX_CODEX_THREAD_ID`（**不得提交或公开这个 ID**）。先运行干跑：

   ```bash
   node scripts/validation/codex-notification-live-smoke.js
   ```

   只有操作者确认允许向该测试线程追加一条消息后才执行：

   ```bash
   node scripts/validation/codex-notification-live-smoke.js --execute
   ```

   实际调用路径为 `codex app-server --stdio` → `initialize` → `thread/resume` → `turn/start` → `turn/completed`。脚本打印 `rpc_turn_completed` **仅证明这一 RPC 路径成功，不证明已有 Desktop 窗口已出现新消息**。需要操作者在原窗口核对 Thread ID、原有上下文与可见消息；不要另开一个线程冒充唤醒成功。

4. 在独立测试工程中补验 Cortex Coordination 链路：使用项目现有 **合法治理工作流** 产生 `task.ready_for_review` 等可通知事件，由单实例 `notification pump --watch` 消费，检查 pending → delivery → ACK 和失败重试；勿直接注入生产 Journal。示意运行命令（替换为自己的隔离项目路径和目标）：

   ```bash
   cortex-agent notification pump --project /path/to/isolated-project \
     --consumer coordinator --target coordinator:root --adapter codex --watch
   ```

   事件创建、审批门禁及绑定必须遵守独立治理仓实际状态；如尚无授权，只执行前 1–3 项，不伪造流程事件或结果。

5. 额外场景：会话忙碌、未知/错误 Thread ID、Codex Desktop 关闭、App Server 无法启动、请求超时、重复事件、重启 Pump 后恢复。观察失败时是否维持 pending/deferred、不会错误 ACK、不会跨线程投递，更不能因通知而自动授予权限。若不能在隔离环境安全复现，标记 NOT_RUN。

## 验收矩阵

| 编号 | 场景 | 通过条件 |
| --- | --- | --- |
| C-01 | 无宿主回归 | Node 测试通过；默认 smoke 为 dry-run |
| C-02 | 实际 App Server | `turn/completed` 且 status=completed |
| C-03 | 原 Desktop 会话 | 相同原窗口出现通知且上下文连续；不接受单纯 RPC 成功 |
| C-04 | 原 CLI 会话 | 指定线程恢复并显示可核实的通知；与 Desktop 结果分别记录 |
| C-05 | Busy / 冲突 | 显式失败或 defer，不自动转向其他线程或自批权限 |
| C-06 | 离线 / 恢复 | 未确认消息仍可追踪且恢复时不重复错误 ACK |
| C-07 | Notification Pump E2E | 合法产生事件→投递→可审计反馈；不绕过 Owner/Lease、Decision/Waitpoint |
| C-08 | 权限 / Otty Hook | 请求通知与授权严格分离；Hook 不是默认自动审批入口 |

## 给 PR 回报的证据格式

- 设备、OS、Codex Desktop/CLI 版本、Cortex commit SHA（不要包含用户名、本机路径、凭证）。
- C-01 到 C-08 各自 PASS / FAIL / BLOCKED / NOT_RUN，附简述与时间。
- 脱敏 CLI 输出：`result`、`turnStatus`、`errorCode`；Thread ID 仅允许采用脚本输出的短哈希指纹。
- 原有 Desktop 窗口是否**可见**新消息，并说明是原会话、新开会话还是未显示。
- 如有缺陷：最小重现步骤、期望/实际结果、建议修复（如忙碌线程的 `turn/steer` 兼容性探测）；**先提修复建议，不默认放开授权或直接改已有代码**。

## 关闭条件

所有必要测试完成、PR 留下本地证据、审查明确通过后，才讨论合并。C-03 失败则**不能宣称已经实现原 Desktop 会话主动唤醒**。缺少真实设备、线程身份或治理审批时保留 Draft / BLOCKED 状态。
