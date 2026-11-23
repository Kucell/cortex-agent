# v1.16.x L3 验收证据与缺口矩阵（R0）

> 状态：REVIEW_ONLY / NOT_A_RELEASE_GATE / 2026-11-23。
> 本文是基于指定 GitHub 文件读取的验收准备记录；既不授予任何 L3 执行权限，也不声明目前 AUTH-01～14 或 L3-E2E-01～08 已整体 PASS。
> 跟踪任务：[产品 Issue #193](https://github.com/Kucell/cortex-agent/issues/193)。原始授权契约位于治理仓 PR #16 的 `plans/proposals/projects/full-automation-evolution/l3-authorization-contract-v1.md`，原始统一计划位于同目录 `v1.16.0-unified-mission-plan.md`。

## 1. 当前真实源与测试入口

| 观察面 | 2026-11-23 当前 main 源码 blob | 观察事实 | 证据等级 |
| --- | --- | --- | --- |
| Decision 隔离 | `tests/communication/decision-resolution-isolation.test.js` `82268a5c` | 3 种模板变体 × 4 种 Decision 结果的非耦合断言，以及批准后显式 release 用例；运行时新建临时项目并对比全部文件快照 | **TEST_EXISTS / 本轮未执行** |
| Decision CI | `.github/workflows/decision-resolution-isolation.yml` `828da4f5` | Node 22/24、`workflow_dispatch`、按 SHA 拉取并验证 blob、测试及 serializer schema；应验证目标 run 是否真正覆盖指定当前 main SHA | **WORKFLOW_EXISTS / 本轮未执行** |
| 严格授权原型 | `lib/dispatch/l3-authorization.js` `03b58d06`、`tests/dispatch/l3-authorization.test.js` `96f67bad` | 源码声明 **ISOLATED SCRATCH PROTOTYPE**；基于注入 fixture，不连接真实 GovernanceStore 或 Host，永不授予 effect | **FIXTURE_ONLY** |
| 严格授权 CI | `.github/workflows/v116-d-l3-auth-review.yml` `a86971b6` | 精确 PR head 的 D1 文件及 Node 22/24 fixture 测试；没有证明真实 Owner/Lease/Host 或 L3 E2E | **WORKFLOW_EXISTS / NOT_HOST_E2E** |
| 公开 dispatch | `lib/dispatch/cli.js` `43029153` | `dispatch execute` 仍进入 `PHASE_ZERO_STUB`；公开 CLI 不具备真实 L3 自动执行入口 | **BLOCKED / NOT_SUPPORTED** |
| 手动内部 dispatch | `lib/dispatch/execute.js` `ad89e6bd` | 存在显式手动调用编排，源码声明 `automatic_dispatch_enabled`、`daemon_enabled` 保持 false | **NOT_EQUIVALENT_TO_L3** |

上述 blob 前缀用于精确复查；正式验收仍需记录完整源 SHA、Git tree、实际执行环境、Run URL、退出码、可复算 artifact digest 和独立 reviewer。

## 2. AUTH-01～14 映射（不捏造 PASS）

| ID | 原始契约要求概要 | 已定位入口 | 本轮正式验收状态 |
| --- | --- | --- | --- |
| AUTH-01 | Decision 批准但 Waitpoint 未独立 release 时零副作用 | Decision isolation 测试；D1 fixture | **PARTIAL / 真实效应拒绝 NOT_RUN** |
| AUTH-02 | 错误项目/任务、陈旧 digest/revision 必须拒绝 | D1 fixture | **NOT_RUN（真实来源）** |
| AUTH-03 | 撤销/过期/Owner 身份变更拒绝 | D1 fixture | **NOT_RUN（真实来源）** |
| AUTH-04 | 越界路径、软链、受保护分支拒绝 | D1 fixture + 现有路径检查 | **NOT_RUN（真实 effect）** |
| AUTH-05 | 伪造 Host、CI、PR “approved” 不授权 | D1 fixture | **NOT_RUN（真实来源）** |
| AUTH-06 | 有依赖的 3-Task Mission 在真实 Host 受限执行 | 尚无本轮真实 Host chain | **NOT_RUN** |
| AUTH-07 | 风险升级/计划变更需新审批 | D1 fixture | **NOT_RUN（真实来源）** |
| AUTH-08 | Host 不支持/离线应 DEFERRED + durable handoff | 需真实 Host 失联 | **NOT_RUN** |
| AUTH-09 | 双设备 Lease/CAS 竞争只有一个写者 | 需两个真实写者及权威 store | **NOT_RUN** |
| AUTH-10 | 预算耗尽/运行中撤销应停止并可复原 | 需运行中取消及 journal | **NOT_RUN** |
| AUTH-11 | synthetic dry-run、Phase-0 stub 不得算 L3 | CLI/source inspection | **SOURCE_CONFIRMED / E2E NOT_RUN** |
| AUTH-12 | push/PR/merge/release 需独立 gate，拒绝副作用 | 需真实权限边界试验 | **NOT_RUN** |
| AUTH-13 | 旧项目升级不得静默开启 L3 | 需安装包/旧项目实测及运行态检查 | **NOT_RUN（L3 专项）** |
| AUTH-14 | 缺独立 reviewer/test receipt 时不得 COMPLETE | 需真实 review flow 验收 | **NOT_RUN** |

`PARTIAL`、`SOURCE_CONFIRMED`、`FIXTURE_ONLY` 都不是 G0/E2E `PASS`。原契约要求全部 AUTH 验收落在实际分支源码上；每条必须有确切用例和观察产物才可升为 PASS。

## 3. L3-E2E-01～08

原始统一计划要求 8 类真实 L3 E2E 验收、跨项目和权限撤销等场景，但本轮未读取到针对 **当前 main exact HEAD** 的完整编号用例正文与运行回执。因此仅登记整个集合 **NOT_VERIFIED**；不得自行虚构 E2E-01～08 逐条内容、PASS 或运行次数。请 E 从权威 QA 矩阵确认测试描述和版本后再逐项填证据。

## 4. 可直接执行的最小测试入口（需要真实 CI / 本地受控环境）

1. 在精确 main SHA 上运行 `node --test tests/communication/decision-resolution-isolation.test.js` 以及 `node --test tests/communication/serializer-schema.test.js`。已有 CI `Decision Resolution Isolation` 支持手动 dispatch，但必须核对 `SOURCE_HEAD`。
2. 在精确 main SHA 上运行 `node --test tests/dispatch/l3-authorization.test.js`；结果明确标 **fixture-only**，不用于升格真实 AUTH 或 L3 E2E。
3. 对 `dispatch execute` 进行 **无副作用** CLI 负向验收：期待 `PHASE_ZERO_STUB`，并确认没有 Operation/Task/Lease 写入、没有 Host 调用。不得通过重写 CLI 测试绕过 stub。
4. 冻结真实独立 Host/Worker、测试项目、repo/branch/path、预算、撤销方式和 dry-run/real-run 界线；正式 Authority/Lease/Decision/Waitpoint 验收前 **不执行实际 mutating dispatch**。
5. 在获正式授权的测试沙盒里验证至少 3 个依赖 Task 的正常路径和撤销/过期/失联/恢复路径；每个 Task 有单独审查、证据和 durable handoff。
6. E 独立核对 exact-head 源、Command、CI、Run、Host 观测与 PASS/FAIL/NOT_RUN，不以评论、PR 状态、合成 Host 或绿 CI 代替。

## 5. Gate 与版本兼容

- 产品 `1.16.0` 的 advisor-only 能力不能被 README、CHANGELOG、测试代码或 Chat Review receipt 升格成 L3。
- 1.16.x patch 只允许兼容/权限/CI/恢复相关修复；新增公开连续派发 API 需正式 scope/版本 ADR，依 SemVer 归入下一 minor。
- A 检查权威 GovernanceStore 中真实 Owner/Lease 和资源绑定的 Decision + owning released Waitpoint；E 负责独立验收。GitHub Issue/PR 评论本身不是权威状态。
- 没有可靠 Host、独立审查或明确资源范围时保持 **BLOCKED/NOT_RUN**，不得以用户的“继续”自动铸造不受限 Mission grant。

## 6. 待 E 审查的明确问题

1. 实际安装后的 `zh/en` 模板是否都从共享层取得正确 Management API 行为？
2. `decision-resolution-isolation` 的快照测试是否足以排除各类其他写入通道（包括直接文件写入）？
3. D1 fixture 的各类负向断言如何映射到真实 authority source / effect sink 及 canonical revision？
4. M-044 相关真机证据与 L3 E2E 的交叉覆盖有哪些、哪些属于不同项目或不同授权域？
5. 是否存在已被独立确认的完整 L3-E2E-01～08 矩阵？必须读取并绑定具体版本，不允许按计划推测。
