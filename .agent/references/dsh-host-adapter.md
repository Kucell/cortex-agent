---
title: DSH First-Class Host Adapter
module: dsh-host-adapter
module_path: lib/agents/adapters/dsh.js
module_type: adapter
keywords: [dsh, deepseek-harness, dispatch-adapter, first-class, P-006, M-029]
status: stable
owner: Kucell
last_verified: 2026-08-19
verified_by: mission-coordinator
sources:
  - lib/agents/adapters/dsh.js
  - lib/agents/adapters/dsh-bootstrap.js
  - docs/host-dsh-integration.md
  - docs/architecture/dsh-host-adapter.md
  - .agent/plans/proposals/projects/agent-runtime-interoperability/proposals/P-006-dsh-host-adapter-proposal.md
linked_decisions:
  - D-ARI-P006-promote-dsh-firstclass
  - D-TCP-004-add-dsh-host
updated_at: 2026-08-19
source: local-verification
---

# DSH First-Class Host Adapter

DSH (DeepSeek Harness) 是 Cortex Agent 的 first-class dispatch adapter（与 Pi / Claude Code / Codex CLI 同等地位），由 M-029 / P-006 交付（2026-08-19 done）。

## 关键文件

| 文件 | 职责 |
| :--- | :--- |
| `lib/agents/adapters/dsh.js` | `DshAdapter extends BaseAdapter` — discover/health/invoke/cancel/report 五方法 + P-001 capability descriptor + 6 类失败模式 |
| `lib/agents/adapters/dsh-bootstrap.js` | opt-in `--require` 加载入口（镜像 codey-pi-bootstrap） |
| `lib/agents/registry-adapter-types.js` | `VALID_ADAPTER_TYPES_EXT` 加 `"dsh"`（additive） |
| `lib/agents/adapters/index.js#_seed()` | try/catch 注入 `DshAdapter`（与 codex 同源） |
| `lib/coordination/adapter-core.js` | `REGISTERED_ADAPTER_IDS` 加 `dsh.local` / `dsh.dev` |
| `lib/registry/index.js` | `PLATFORM_REGISTRY.dsh` — `cortex-agent add dsh` |
| `templates/{zh,en}/integrations/dsh/` | README.md / AGENTS.md / settings.json（双语对称） |
| `docs/host-dsh-integration.md` | 四节集成指南（安装/注册/dispatch/限制） |

## 硬约束

- 零 npm 依赖（`node:child_process` / `node:fs` / `node:path` 仅内置）。
- `lib/agents/registry.js`（M-002 frozen）零修改。
- dispatch adapter 不读 `~/.dsh/sessions/`（shadow usage 由 `scripts/dsh-usage-sync.js` 独占）。
- DSH CLI 缺失时 fail closed：`health()` → `ready: false`，`invoke()` → `ERR_ADAPTER_SPAWN`。
- 能力声明 `tool.before.*` / `context.render.observe` = `unsupported`（待 P-007 follow-up）。

## 验证命令

```bash
node --test tests/agent/agent-adapter-dsh.test.js          # 31/31
node --test tests/cli/add-host-dsh.test.js                 # 4/4
node --test tests/agent/*.test.js tests/coordination/*.test.js tests/host-adapter/shadow-usage/*.test.js tests/scripts/dsh-usage-sync.test.js tests/cli/add-host-dsh.test.js tests/commands/platform.test.js tests/platform/*.test.js  # 1131/1131
cortex-agent agent adapter health dsh                      # ready: true（DSH CLI 在 PATH 时）
```
