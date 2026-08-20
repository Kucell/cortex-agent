---
name: dsh-firstclass-adapter
description: DSH (DeepSeek Harness) 已从 TCP shadow host 提升为 first-class dispatch adapter（M-029/P-006，2026-08-19 done）。可复用事实：注册路径、能力声明、安全边界、后续 P-007。
type: project
created: 2026-08-19
tags: [dsh, deepseek-harness, adapter, dispatch, M-029, P-006, first-class]
---

# DSH First-Class Adapter（M-029 / P-006）

## 事实

- **状态**: P-006 done（2026-08-19）；M-029 COMPLETE（MS-001~004 PASS + MS-005 WAIVED-OPTIONAL）。
- **决策**: `D-ARI-P006-promote-dsh-firstclass`（architecture / approved / interactive-user）—— DSH 从 Token Control Plane 第三 governed shadow host（`D-TCP-004`，仅 usage measurement）提升为与 Pi / Claude Code / Codex CLI 同等的 first-class dispatch adapter。
- **实现**:
  - `lib/agents/adapters/dsh.js` — `DshAdapter extends BaseAdapter` 五方法契约（discover/health/invoke/cancel/report）+ P-001 capability descriptor + 6 类失败模式。
  - `lib/agents/adapters/dsh-bootstrap.js` — opt-in `--require` 加载入口（镜像 codey-pi-bootstrap）。
  - 注册路径（全部 additive）：`VALID_ADAPTER_TYPES_EXT` 加 `"dsh"`、`_seed()` try/catch、`adapter-core.js#REGISTERED_ADAPTER_IDS` 加 `dsh.local`/`dsh.dev`；`lib/agents/registry.js`（M-002 frozen）零修改。
  - 平台集成：`PLATFORM_REGISTRY.dsh` + `templates/{zh,en}/integrations/dsh/`（6 文件）+ `cortex-agent add dsh`。
  - 文档：`docs/host-dsh-integration.md`（四节）+ `docs/architecture/dsh-host-adapter.md`。

## 关键约束

- **零 npm 依赖**：dsh.js / dsh-bootstrap.js 只用 `node:child_process` / `node:fs` / `node:path`。
- **安全边界**：dispatch adapter **不读** `~/.dsh/sessions/`（shadow usage 由 `scripts/dsh-usage-sync.js` 独占）；DSH CLI 缺失时 fail closed（`ERR_ADAPTER_SPAWN`）。
- **能力声明**：`tool.before.observe/block`、`context.render.observe` = `unsupported`（无真实 hook 证据，M-018 未实施）。
- **不自动启用**：`cortex-agent add dsh` 保持 opt-in；无 daemon / 自动 dispatch。

## 复用提示

- 新宿主接入 first-class dispatch：照抄 dsh.js 结构（五方法 + `_seed()` try/catch + `VALID_ADAPTER_TYPES_EXT` + bootstrap + 双语模板 + host 文档 + fake-binary 测试）。
- 测试基线当前 1131/1131（`node --test tests/agent/*.test.js tests/coordination/*.test.js tests/host-adapter/shadow-usage/*.test.js tests/scripts/dsh-usage-sync.test.js tests/cli/add-host-dsh.test.js tests/commands/platform.test.js tests/platform/*.test.js`）。

## 后续（P-007 follow-up）

- 获得 DSH 真实 `beforeToolCall` / `transformContext` hook 证据后，单列提案把 `tool.before.*` / `context.render.observe` 从 `unsupported` 提升并接入 P-001 gate 契约（参考 `lib/host-adapter/pi-rpc-capability.js` 模式）。
