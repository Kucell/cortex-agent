# Catalog Bridge — 4-kind catalog architecture (P-001 MS-002)

> **目的**:把 open-design 上游 4 planes (151 design-systems + 277 plugins + 100+ skills + 18 design-templates) 接入 cortex-agent,沿用 T-OD-001 的 content-addressed fetch + license ack + lock file 协议,扩展为 4 kind 通用 catalog。
> **状态**: P-001 MS-002 foundation shipped (2026-08-20)
> **版本**: v1.0
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

| # | Goal |
| :--- | :--- |
| G1 | **4 kind 通用 catalog 协议** — 同一份 lock file 容纳 design-system / plugin / skill / template |
| G2 | **lock schema v1 → v2 向后兼容** — T-OD-001 旧 lock 自动 migrate-to-v2,无信息丢失 |
| G3 | **content-addressed fetch + license ack 复用** — 4 kind 共享 lib/design/{fetch,license}.js 已 ship 资产 |
| G4 | **CLI 命令统一** — `cortex-agent design {system,plugin,skill,template} {list,install,...}`(MS-002 follow-up) |
| G5 | **零依赖 + 纯加法** — 沿用 architecture-design §3 原则,lib/design/* 主体零修改 |

---

## 3. 非目标

- ❌ plugin 转换器(open-design.json → cortex-agent plugin manifest)— 留给 MS-002 follow-up
- ❌ Brand-backed extractor(open-design daemon)— 独立 sprint
- ❌ Claude Design ZIP import — 独立 sprint
- ❌ 真实网络拉取 — 测试用 mock,真实拉取留给 pilot
- ❌ 修改 lib/design/* 主体行为

---

## 4. 核心设计

### 4.1 模块清单

```text
lib/catalog/
├── kind-map.js   # 4 kind 元数据 (kind → path/license 字段映射)
├── lockfile.js   # 4-kind lock schema v2 + v1 → v2 迁移
├── registry.js   # 4-kind catalog index(聚合 lib/design/registry.js + starter)
└── index.js      # 统一导出
```

| 模块 | 与 T-OD-001 关系 | 改动 |
| :--- | :--- | :--- |
| `kind-map.js` | 新增 | 4 kind 元数据 |
| `lockfile.js` | 新增(独立文件) | 不修改 lib/design/lockfile.js;v2 = 新 schema `{catalogs: []}`,v1 = lib/design/lockfile.js 的 `{systems: []}` 仍可读(自动迁移) |
| `registry.js` | 扩展(委托) | 调 lib/design/registry.loadCatalog 拉 design-system;3 其他 kind 走 starter index |
| `index.js` | 新增 | 统一 re-export |

### 4.2 Kind map 单一真理来源(`kind-map.js`)

```jsonc
{
  "design-system": {
    "upstreamSubdir": "design-systems",
    "installDir": ".agent/design-systems",
    "manifestFilename": "DESIGN.md",
    "licenseSources": [
      "manifest.json#/license",
      "DESIGN.md#frontmatter/license"
    ],
    "schemaVersion": "od-design-system-project/v1",
    "lockfileKindKey": "design-system",
    "capabilitiesCascade": true   // 仅 design-system 走 4-level cascade
  },
  "plugin": {
    "upstreamSubdir": "plugins",
    "installDir": ".agent/plugins",
    "manifestFilename": "manifest.json",
    "licenseSources": [
      "open-design.json#/license",
      "SKILL.md#frontmatter/license"
    ],
    "schemaVersion": "od-plugin-project/v1",
    "lockfileKindKey": "plugin",
    "capabilitiesCascade": false,
    "pluginConverter": "lib/catalog/plugin-converter.js"   // open-design.json → cortex-agent manifest
  },
  "skill": { ... },
  "template": { ... }
}
```

`capabilitiesCascade = true` 表示该 kind 走 4-level DESIGN.md cascade(仅 design-system);
`pluginConverter` 表示该 kind fetch 后需要从 open-design schema 转 cortex-agent manifest(仅 plugin)。

### 4.3 Lock schema v2

```jsonc
{
  "lockfileVersion": 2,
  "schemaVersion": "od-catalog-project/v1",
  "fetched_at": "ISO-8601",
  "upstream": "https://raw.githubusercontent.com/nexu-io/open-design/main",
  "catalogs": [
    { "kind": "design-system", "id": "linear-app", "sha256_manifest": "ab12...", "license": "Apache-2.0", ... },
    { "kind": "plugin", "id": "od-figma-migration", "sha256_manifest": "...", "license": "Apache-2.0", "taskKind": "figma-migration", ... },
    { "kind": "skill", "id": "open-design-launch-checklist", "sha256_skill_md": "...", "license": "Apache-2.0", ... },
    { "kind": "template", "id": "saas-landing", "sha256_template": "...", "sha256_index_html": "...", "license": "Apache-2.0", "mode": "prototype", ... }
  ]
}
```

**v1 → v2 迁移**(`lockfile.js:migrateV1ToV2`):
- 读 v1:解析 `systems[]`,每个 entry 加 `kind: "design-system"` 注入
- 标 `_migrated_from_v1: true` + `_v1_migration_note`
- 在 v2 写时剥离迁移元数据(干净 v2)
- 旧 `design-systems.lock` 文件保留(不删),新 `catalog.lock` 写入同目录

### 4.4 4 kind registry 聚合(`registry.js`)

```js
const idx = loadAllKinds();      // 同步,starter 兜底
const idx = await loadAllKindsAsync();   // 异步,design-system 走真上游
idx.kinds["design-system"]; // { entries: [{id, kind, ...}], source: "upstream" | "cache" | "starter" }
idx.kinds.plugin;
idx.kinds.skill;
idx.kinds.template;
```

**design-system 委托**: `loadDesignSystemEntries({fetcher, cachePath, forceRefresh})` 调用 T-OD-001 的 `lib/design/registry.loadCatalog(...)`,返回 entries 数组(已 ship 资产复用),registry adapter 在每个 entry 注入 `kind: "design-system"`。

**3 其他 kind starter 索引**(MS-002 follow-up 用真上游替换):
- plugin: `od-figma-migration`, `od-claude-design-bridge`
- skill: `open-design-launch-checklist`, `design-system-cascade`
- template: `saas-landing`, `guizang-ppt`, `html-ppt-master`

### 4.5 数据流

```mermaid
flowchart LR
  UP[("open-design 上游")]
  REG["registry.js"]
  KM["kind-map.js"]
  LCK["lockfile.js"]
  DS_REG["lib/design/registry.js (T-OD-001)"]
  SK["cortex-agent 设计版图"]
  
  UP -->|fetch| DS_REG
  DS_REG -->|design-system entries| REG
  KM -->|kind metadata| REG
  REG -->|catalogs[]| LCK
  LCK -->|.agent/catalog.lock| SK
  KM -->|kindMap| SK
```

---

## 5. 验收(MS-002 VC 对应)

| ID | 验证 | 状态 |
| :--- | :--- | :--- |
| VC-1 | T-OD-001 既有 118 tests 全绿(lib/design/* alias 不破坏) | ✅ |
| VC-6 | lock schema v1 → v2 向后兼容(端到端迁移测试通过) | ✅ |
| VC-9 | `bin/cli.js` 维持零依赖 | ✅(未触碰) |
| VC-10 | `architecture-guard` 0 violation | ✅ |
| VC-12 | catalog-cache 24h TTL(沿用 lib/design/registry,本 MS 不重新发明) | ✅ |
| VC-3 | `cortex-agent design plugin install ...` | ⏸ MS-002 follow-up |
| VC-4 | `cortex-agent design skill install ...` | ⏸ MS-002 follow-up |
| VC-5 | `cortex-agent design template install ...` | ⏸ MS-002 follow-up |
| VC-7 | `design system extract --from-url` | ⏸ MS-002 follow-up |
| VC-8 | `design import claude-design` | ⏸ MS-002 follow-up |
| VC-11 | license fail-closed + brand category 警示 | ⏸ MS-002 follow-up(已 ship 资产复用) |

---

## 6. 测试覆盖

| 文件 | 测试数 | 状态 |
| :--- | :--- | :--- |
| `tests/catalog/kind-map.test.js` | 21 | ✅ 全过 |
| `tests/catalog/lockfile-v2.test.js` | 26 | ✅ 全过 |
| `tests/catalog/registry.test.js` | 17 | ✅ 全过 |
| **MS-002 新测试** | **64** | ✅ |
| **既有 T-OD-001 回归** | **118** | ✅ |
| **MS-001 既有 deck 测试** | **66** | ✅ |

总基线: **248/248 PASS**(64 新 + 118 既有 design + 66 既有 deck)。

---

## 7. 端到端验证(本次 E2E)

```
1. 写 v1 lock (legacy T-OD-001 format)
   <cwd>/.agent/design-systems.lock → { lockfileVersion: 1, systems: [...] }
2. readLockfile() → 自动迁移
   - lockfileVersion: 1 → 2
   - schemaVersion: od-design-system-project/v1 → od-catalog-project/v1
   - systems[].kind: undefined → "design-system"
   - _migrated_from_v1: true
3. upsertEntry() × 3 (plugin + skill + template)
   - catalogs[]: 2 → 5
   - 4 kind 隔离正确
4. writeLockfile() → 干净 v2
   - 写入 <cwd>/.agent/catalog.lock
   - 剥离 _migrated_from_v1 元数据
5. readLockfile() → 重新读
   - catalogs[]: 5 (no migration metadata)
```

✅ 通过。

---

## 8. 后续(MS-002 follow-up)

| Task | Owner | Estimate |
| :--- | :--- | :--- |
| `lib/catalog/fetch.js` 4 kind 通用 fetch | TBD | 0.5 周 |
| `lib/catalog/license.js` 4 kind 字段归一化 | TBD | 0.3 周 |
| `lib/catalog/resolve.js` 沿用 lib/design/resolve.js(只 design-system) | TBD | 0.1 周 |
| `lib/catalog/plugin-converter.js` open-design.json → cortex-agent manifest | TBD | 0.5 周 |
| `lib/catalog/extract.js` Brand-backed extractor thin wrapper | TBD | 0.3 周 |
| `lib/catalog/claude-design-import.js` | TBD | 0.3 周 |
| `lib/commands/design.js` 4 subcommand (`system\|plugin\|skill\|template`) | TBD | 0.5 周 |
| 完整 18 测试 + 文档 + pilot verification | TBD | 0.5 周 |

---

## 9. 关联文档

- [P-001-catalog-bridge-proposal.md §4](../../.agent/plans/proposals/projects/open-design-integration/proposals/P-001-catalog-bridge-proposal.md)
- [MS-002 milestone spec](../../.agent/missions/M-ODI-001/milestones/MS-002.md)
- [pilot-verification.md §3 SamHMI](../../.agent/plans/proposals/projects/open-design-integration/pilot-verification.md)
- [T-OD-001 DESIGN.md cascade 已 ship 文档](../architecture/design-system.md)
- [MS-001 deck-workflow-design.md](./deck-workflow-design.md)(已 ship,2026-08-20)