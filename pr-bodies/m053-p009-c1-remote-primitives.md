## Problem

跨机受管许可链需要一种**不能与本机 managed caller 身份互换**的远端对端身份：
签发端必须能把「这台机器上的这个进程」与「另一台机器上的那个进程」区分开，
并且对远端对端的信任事实要有可验证的落点。

本 PR 引入两个**纯逻辑原语**，为跨机信任的 Owner 裁定提供可评审的实现基础。

## Change

- `lib/governed/remote-peer-trust.js`：校验钉住的信任配置，逐字段核验远端签名事实
  （钉住公钥、实例、epoch、宿主进程绑定、连接与 TLS 密钥绑定、挑战、新鲜度、
  钟差、scope 包含），产出 `kind = remote-peer` 的不透明远端对端对象。
- `lib/governed/remote-peer-session.js`：单连接会话（挑战握手、挑战一次性、请求与
  票据绑定、序号严格递增、重放登记不淘汰而 fail-closed、生命周期），以及每次调用
  都要经过的逐调用 authority 闸门（会话状态、peer epoch、权威 lease 与 fencing、
  撤销新鲜度、票据绑定、请求绑定、截止时间裁剪到 lease 剩余寿命）。
- 时间上界按 R5 冻结（握手 5s、事实龄 1s、票 2s、请求 5s、撤销陈旧 15s、钟差 2s）：
  信任配置可收紧，**放宽一律拒绝**而非静默截断。所有拒绝都带稳定拒绝码与出错字段名，
  没有部分接受路径。
- `docs/architecture/remote-peer-primitives.md`：原语的职责边界与冻结口径。

## Why a separate branch from PR #178

原语变更与 PR #178（跨机票据代理）是**不同改动面**：本 PR 只提供**纯逻辑原语**，
不装配、不开 socket、不接线。PR #178 的票据代理是装配层切片。合入顺序不影响
PR #178 的可读性。

本分支由 `87a50523` cherry-pick 到最新 `main`（`f7e163d3`）而来，以消除旧基线。

## Validation

- `node --test tests/governed/remote-peer-primitives.test.js` → **65/65**。
- `node scripts/check-l3-boundary.js` → 0 violations。
- GitHub Actions 由本 PR 的 Pipeline 覆盖（与仓库既有门禁一致）。

## Boundary

- 本 PR **不签名、不签发许可、不开 socket**，不涉及 Windows 设备动作、服务 / ACL /
  账号或桌面敏感操作。
- 两个原语**尚未接入 permit-bridge 装配层**；装配层是独立切片（PR #178）。
- 跨机受管对端信任的 Owner 门（INV-13 / G-Q2）**未解除**。本 PR 只提供原语，
  不代表跨机信任已被接受，也不构成生产准入路径。
- 结论上限：测试域可签发、可取件、可验签；不宣称生产可用、不宣称受保护身份已验证。

## 对应裁定

`D-M053-MS008-P009-R1-TRUSTED-W-OPEN`、`R2R3-CONNECTION-TOPOLOGY-OPEN`、
`R4-TRUSTED-CONTEXT-OPEN`、`R5-TIMING-REVOCATION-OPEN`、
`D-M053-MS008-G0-CONNECTION-BINDING-BASIS-OPEN`、`D-M053-MS008-G0-A-SCOPE-NARROW-OPEN`。
