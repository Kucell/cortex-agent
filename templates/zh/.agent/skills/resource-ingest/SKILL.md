---
name: resource-ingest
description: 外部资源自动灌入（受 OpenViking `client.add_resource` 启发）。把 URL / 文件 / git 仓库自动写入 `.agent/resources/external/`，自动生成 L0/L1 + 注册到 context-index.json + uri-map.json + MANIFEST.json。零 LLM 依赖，纯确定性。
area: swe
summary: 外部资源自动灌入（受 OpenViking `client.add_resource` 启发）。把 URL / 文件 / git 仓库自动写入 `.agent/resources/external/`，自动生成 L0/L1 + 注册到 context-index.json + uri-map.json + MANIFEST.json。零 LLM 依赖，纯确定性。
---

# 资源灌入 (Resource Ingest)

## 目标

把 OpenViking 风格的"自动 add resource" 适配到 cortex-agent：

- 外部知识（API 文档、RFC、竞品实现、vendor README）不再"复制粘贴"，而是显式声明 source + slug
- 灌入后自动生成 L0/L1 摘要，与 `context-budget` 的 L0/L1 框架无缝衔接
- 跨项目可重放（每次灌入写入 `MANIFEST.json` 含 content_hash，可检测陈旧）

## 三种入口

```bash
# 1) URL：fetch HTML → strip → markdown
node .agent/skills/resource-ingest/scripts/ingest.js \
  --url https://example.com/api-docs \
  --source example --slug api-docs --write

# 2) 本地文件：直接复制
node .agent/skills/resource-ingest/scripts/ingest.js \
  --file ./external-doc.md \
  --source vendor-x --slug doc --write

# 3) git 仓库：要求先 clone 到 .agent/resources/_cache/{source}_{slug}/
git clone --depth 1 https://github.com/foo/bar .agent/resources/_cache/foo_bar
node .agent/skills/resource-ingest/scripts/ingest.js \
  --git https://github.com/foo/bar \
  --source github --slug foo-bar --write
```

## 写入位置

```text
.agent/resources/
├── MANIFEST.json                         # append-only 灌入日志
├── external/
│   └── {source}/
│       └── {slug}.md                     # 每个资源一个文件
└── _cache/
    └── {source}_{slug}/                  # git clone 缓存（可手动重建）
```

每个资源文件包含：

```yaml
---
name: api-docs
source: example
uri: cortex://resources/example/api-docs
content_hash: db91b93ab1bb13aa           # SHA-256 前 16 位
ingested_at: 2026-07-24T05:42:11.952Z
origin: https://example.com/api-docs      # 原始来源
---
# ... 实际内容 ...
```

## 联动机制

每次 `--write` 自动完成 4 件事：

1. **写入资源文件**到 `.agent/resources/external/{source}/{slug}.md`
2. **追加 `MANIFEST.json`** 记录 `ingested_at / content_hash / bytes`
3. **更新 `uri-map.json`** 的 `resources` scope 时间戳
4. **更新 `context-index.json`** 新增 module 条目（含 `uri` / `ref_path`）

如果带上 `--refresh-l0l1`，还会跑一遍 `build-l0l1.js --file {target} --inject-index`，为新资源生成 L0/L1。

## 验收

- `MANIFEST.json` 每次灌入追加 1 条
- `context-index.json` 的总 module 数 = 旧 + 新
- `URI` 通过 `uri-resolver --uri "cortex://resources/example/api-docs"` 解析为 `.agent/resources/external/example/api-docs.md`
- L0/L1 注入：`build-l0l1.js --all` 后 100% 有 L0（包括 external/）

## 边界

- **不做**深度爬取（v1 仅入口页面/README）
- **不做**版权检查（用户自己负责）
- **不做**自动增量更新（手动 `--write` 才会覆盖）
- **不强制** git clone（先 clone 再 ingest 是用户责任）
- **不替代** `references/`（项目内部架构 vs 外部资源 — 明确分层）

## 与其他组件的关系

- **依赖**：`build-l0l1.js`（L0/L1 生成）+ `uri-resolver`（URI 解析）+ `context-budget`（检索）
- **仓库**：`resources/MANIFEST.json` 由 `cleanup-debug` 后续清理
- **访问**：`skill-selector` 与 `context-budget` 自动读 `resources/` 作为 Tier 2 候选
- **审计**：`uri-resolver --check` 会扫到 `.agent/resources/` 下的相对引用
