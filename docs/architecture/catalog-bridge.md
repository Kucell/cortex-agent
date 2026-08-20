# Catalog Bridge — 4-kind catalog architecture (P-001 MS-002)

> **目的**:把 open-design 上游 4 planes (151 design-systems + 277 plugins + 100+ skills + 18 design-templates) 接入 cortex-agent,沿用 T-OD-001 的 content-addressed fetch + license ack + lock file 协议,扩展为 4 kind 通用 catalog。
> **状态**: P-001 MS-002 ship (协议层 0d57ffb) + MS-002 follow-up ship (CLI + license 4 kind + plugin converter + resolve 4 kind)
> **版本**: v1.1
> **关联**: [P-001-catalog-bridge-proposal.md](../../.agent/plans/proposals/projects/open-design-integration/proposals/P-001-catalog-bridge-proposal.md) · [MS-002.md](../../.agent/missions/M-ODI-001/milestones/MS-002.md)

---

## 1. 背景与动机

cortex-agent 已有 catalog 能力集中在 1 kind:

| Kind | 实现 | 状态 |
| :--- | :--- | :--- |
| design-system | `lib/design/*` + `cortex-agent design {list,install,...}` | ✅ T-OD-001 ship (151 systems) |
| plugin | `lib/agents/registry.js` + `cortex-agent plugin {list,install,...}` | ✅ M-002 ship (本地 plugin) |
| skill | `.agent/skills/` + `cortex-agent skill browse` | ✅ M-002 ship (本地 skill) |
| template | ❌ 缺 | **本次补齐** |

open-design 上游提供 4 plane 大规模 catalog(plugin 277 + skill 100+ + template 18 + system 151),cortex-agent 必须把这些上游 catalog 通过统一的 catalog 协议接入,而不是每个 kind 重新发明 lock/license/fetch 协议。

---

## 2. 目标

| # | Goal | Status |
| :--- | :--- | :--- |
| G1 | **4 kind 通用 catalog 协议** — 同一份 lock file 容纳 design-system / plugin / skill / template | ✅ MS-002 协议层 |
| G2 | **lock schema v1 → v2 向后兼容** — T-OD-001 旧 lock 自动 migrate-to-v2,无信息丢失 | ✅ MS-002 协议层 |
| G3 | **content-addressed fetch + license ack 复用** — 4 kind 共享 lib/design/{fetch,license}.js 已 ship 资产 | ✅ MS-002 follow-up |
| G4 | **CLI 命令统一** — `cortex-agent design {system,plugin,skill,template} {list,install,...}` | ✅ MS-002 follow-up(legacy 100% 兼容 + 4 kind 扩展) |
| G5 | **plugin converter** — open-design.json → cortex-agent plugin manifest | ✅ MS-002 follow-up |
| G6 | **零依赖 + 纯加法** — 沿用 architecture-design §3 原则,lib/design/* 主体零修改 | ✅ |

---

## 3. 非目标

- ❌ **Brand-backed extractor** (open-design daemon) — 独立 sprint(需要 daemon 启动)
- ❌ **Claude Design ZIP import** — 独立 sprint(复杂 unzip + 转换)
- ❌ **plugin / skill / template fetch 端到端实跑** — MS-002 follow-up round 2(本轮只 ship catalog / license / resolve / converter / CLI subcommand;fetch 留给下一轮)
- ❌ **修改 lib/design/* 主体行为**

---

## 4. 核心设计

### 4.1 模块清单(MS-002 + follow-up 完整)

```text
lib/catalog/
├── kind-map.js          # 4 kind 元数据(MS-002)
├── lockfile.js          # v2 multi-kind + v1→v2 迁移(MS-002)
├── registry.js          # 4-kind catalog index(MS-002)
├── index.js             # 统一 re-export(MS-002)
├── resolve.js           # 4-kind resolve + readManifest + verifyInstall (MS-002 follow-up)
├── license.js           # 4-kind license normalize/format/isAcceptable/promptAck (MS-002 follow-up)
└── plugin-converter.js  # open-design.json → cortex-agent manifest (MS-002 follow-up)

lib/commands/design.js   # 4-kind CLI dispatcher(MS-002 follow-up)
bin/cli.js               # 单 require + 1 case line (MS-002 follow-up,additive)
lib/cli/contract.js      # design 契约条目扩展 (MS-002 follow-up)
```

### 4.2 Resolve (`lib/catalog/resolve.js`)

设计-system 委托 T-OD-001 `lib/design/resolve.resolveCascade`(4-level cascade 主体零修改),3 其他 kind 走单源(`<cwd>/.agent/<installDir>/<id>/<manifest>`):

| API | 用途 |
| :--- | :--- |
| `checkInstalled(kind, id, cwd)` | 检查 <id> 是否安装,返回 root 或 null |
| `readManifest(kind, id, cwd)` | 读 <id> 的 per-kind manifest(JSON 解析 / 文本原样返回) |
| `resolveEffective(kind, id, cwd)` | design-system 走 4-level cascade,其他 3 kind 走 installed / missing |
| `listInstalled(kind, cwd)` | 列所有已安装的 <id> |
| `listAllInstalled(cwd)` | 跨 4 kind 列出 |
| `verifyInstall(kind, id, cwd)` | 检查 installed 是否完整(present + missing[]) |

### 4.3 License (`lib/catalog/license.js`)

设计-system 委托 T-OD-001 `lib/design/license.formatLicenseWarning` + `isLicenseAcceptable`(license rule set 零漂移),3 其他 kind 走简化 prompt(无 brand category check):

| API | 用途 |
| :--- | :--- |
| `normalizeLicense(kind, fileTree)` | 提取 `{value, source}`(走 kind-map licenseSources 顺序) |
| `formatLicenseWarning(entry, kind)` | 返回 multi-line prompt text(string) |
| `isAcceptable(entry, kind, opts)` | `{acceptable, reason}`,design-system 走 T-OD-001 |
| `promptAck(entry, kind, opts)` | yes 跳过 / 否则 readline 交互 |

### 4.4 Plugin converter (`lib/catalog/plugin-converter.js`)

| Open-Design 字段 | Cortex-Agent 字段 | 说明 |
| :--- | :--- | :--- |
| `od.kind` | `taskKind`(fallback) | 仅 `plugin` / `skill` 支持,其他 reject |
| `od.name` | `id`(`sanitize to kebab-case`) | 非 alphanumeric 结果 reject |
| `od.version` | `version` | 必填 |
| `od.mode` | `mode`(默认 `code`) | |
| `od.capabilities[]` | `capabilities[]` | |
| `od.inputs[]` | `inputs[]` | |
| `od.repository` | `origin` | |
| 顶层 `license` | `license`(default `Apache-2.0`) | 可被 override |
| 未知 `od.*` | `x-open-design` 字典 | **lossless**:未知字段保留供 audit |

原 `open-design.json` 保留在 `<id>/open-design.json`(audit);转后 manifest 写入 `<id>/manifest.json`(cortex-agent runtime)。

### 4.5 4 kind CLI dispatcher (`lib/commands/design.js`)

```bash
# Legacy(100% 向后兼容,T-OD-001 不动):
cortex-agent design list [--available|--installed|--all] [--json]
cortex-agent design install <id>... [--yes] [--force] [--no-cache] [--json]
cortex-agent design upgrade [<id>] [--yes] [--no-cache] [--json]
cortex-agent design remove <id>... [--json]
cortex-agent design show <id> [--json]
cortex-agent design resolved [--json]
cortex-agent design refresh-catalog

# 新 4 kind:
cortex-agent design system <sub> [opts]                 # alias of legacy
cortex-agent design plugin list [--available|--installed] [--json]
cortex-agent design plugin show <id> [--json]
cortex-agent design skill list [--available|--installed] [--json]
cortex-agent design skill show <id> [--json]
cortex-agent design template list [--available|--installed|--mode <mode>] [--json]
cortex-agent design template show <id> [--json]
```

**退出码**:0 success / 1 generic / 2 user error / 3 network / 4 license rejected(T-OD-001 一致)。

**plugin / skill / template MVP 范围**:本轮 ship catalog / list / show(走 `lib/catalog/{registry,resolve}`)。`install` 在 MS-002 follow-up round 2 落地(`lib/catalog/fetch.js` 4 kind 通用 fetch),目前 `install` 返回 exit 1 + stderr `fetch not yet implemented`。

---

## 5. 验收(MS-002 + MS-002 follow-up VC 对应 P-001 §6)

| ID | 验证 | 状态 |
| :--- | :--- | :--- |
| VC-1 | T-OD-001 既有 118 tests 全绿 | ✅ |
| VC-2 | `lib/templates/pptx.js` 零依赖(MS-001 已 ship,本提案不相关) | ✅ |
| VC-3 | `cortex-agent design plugin install ...` | ⏸ MS-002 follow-up round 2 |
| VC-4 | `cortex-agent design skill install ...` | ⏸ MS-002 follow-up round 2 |
| VC-5 | `cortex-agent design template install ...` | ⏸ MS-002 follow-up round 2 |
| VC-6 | lock schema v1 → v2 向后兼容 | ✅ |
| VC-7 | `design system extract --from-url` | ⏸ 独立 sprint(需要 daemon) |
| VC-8 | `design import claude-design` | ⏸ 独立 sprint |
| VC-9 | `bin/cli.js` 维持零依赖 | ✅ |
| VC-10 | `architecture-guard` 0 violation | ✅(inline check) |
| VC-11 | license fail-closed + brand category 警示 | ✅(design-system 走 T-OD-001) |
| VC-12 | catalog-cache 24h TTL(沿用 lib/design/registry) | ✅ |

---

## 6. 测试覆盖

| 文件 | 测试数 | 状态 |
| :--- | :--- | :--- |
| `tests/catalog/kind-map.test.js` | 21 | ✅ |
| `tests/catalog/lockfile-v2.test.js` | 26 | ✅ |
| `tests/catalog/registry.test.js` | 17 | ✅ |
| `tests/catalog/resolve.test.js` | 16 | ✅ |
| `tests/catalog/license-4kind.test.js` | 24 | ✅ |
| `tests/catalog/plugin-converter.test.js` | 23 | ✅ |
| `tests/commands/design-4kind.test.js` | 22 | ✅ |
| **MS-002 + follow-up** | **149** | ✅ |
| T-OD-001 既有 design 测试 | 118 | ✅ |
| MS-001 deck 测试 | 66 | ✅ |
| **总基线** | **333/333 PASS** | |

---

## 7. 端到端验证(E2E)

```bash
$ cortex-agent design plugin list --json
{ "kind": "plugin", "source": "starter", "count": 2,
  "entries": [{ "id": "od-figma-migration", ... }, { "id": "od-claude-design-bridge", ... }] }

$ cortex-agent design template list
template (3):
    saas-landing
    guizang-ppt
    html-ppt-master
(0 installed · 3 available upstream)

$ cortex-agent design list                # legacy 设计-system 100% 兼容
(Installed: none)

$ cortex-agent design system list         # alias 也 100% 工作
(Installed: none)

$ cortex-agent design help
Usage: cortex-agent design <subcommand|kind> [options]
Kinds (P-001 MS-002): system / plugin / skill / template
...
```

---

## 8. 后续(MS-002 follow-up round 2)

| Task | Owner | Estimate |
| :--- | :--- | :--- |
| `lib/catalog/fetch.js` 4 kind 通用 fetch | TBD | 0.5 周 |
| `lib/catalog/extract.js` Brand-backed extractor(需要 daemon) | TBD | 0.3 周 |
| `lib/catalog/claude-design-import.js` ZIP import | TBD | 0.3 周 |
| `lib/commands/design.js` round 2:`<kind> install <id>...` 端到端 | TBD | 0.5 周 |
| 完整 18 测试 + 文档 + pilot verification | TBD | 0.5 周 |

---

## 9. 关联文档

- [P-001-catalog-bridge-proposal.md §4](../../.agent/plans/proposals/projects/open-design-integration/proposals/P-001-catalog-bridge-proposal.md)
- [MS-002 milestone spec](../../.agent/missions/M-ODI-001/milestones/MS-002.md)
- [pilot-verification.md §3 SamHMI](../../.agent/plans/proposals/projects/open-design-integration/pilot-verification.md)
- [T-OD-001 DESIGN.md cascade 已 ship 文档](../architecture/design-system.md)
- [MS-001 deck-workflow-design.md](./deck-workflow-design.md)(已 ship,2026-08-20)
- [D-ODI-002 lock schema v1→v2 向后兼容](../../.agent/plans/proposals/projects/open-design-integration/decisions/D-ODI-002.md)