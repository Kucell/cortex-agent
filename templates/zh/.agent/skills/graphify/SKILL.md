---
name: graphify
description: 查询当前项目的 Graphify 知识图谱。支持 query（关键词检索）、path（两文件最短路径）、explain（节点解释）、extract（子图提取）。需要 graphify-out/graph.json 存在。T-GWG-001：每个子命令现在都先运行 freshness preflight，过期或不兼容时 fail closed。
area: swe
summary: 查询当前项目的 Graphify 知识图谱。支持 query（关键词检索）、path（两文件最短路径）、explain（节点解释）、extract（子图提取）。需要 graphify-out/graph.json 存在。T-GWG-001：每个子命令现在都先运行 freshness preflight，过期或不兼容时 fail closed。
---

# Graphify Skill

## 触发

`/graphify <子命令> [参数]`

## Freshness Preflight（T-GWG-001）

Graphify 是**可选插件**。项目没有 `.agent/plugins/graphify/` 目录时，技能状态为
`not_applicable`，宿主直接回退到源码探索，不会触碰图谱。

当插件存在时，每个子命令在读取 `graphify-out/graph.json` 之前都会先运行
**freshness preflight**。Preflight 按以下顺序检查：

1. Schema + Graphify major-version 兼容性。
2. Manifest 完整性（计数 vs `nodes`/`links`）。
3. 图年龄 vs `governance.max_age_days`。
4. Source HEAD 血统（`sourceHead` 是否在当前 HEAD 可达）。
5. 工作树 dirty 范围。

Preflight 失败时，子命令必须：

- 打印 `cortex-agent graphify preflight --json` 的结构化 `verdict`。
- 拒绝静默返回旧图（fail closed）。
- 提示 `branchDeltaRequired`，让调用方执行 `git diff sourceHead..HEAD` 并重新
  `Read` 变更后的源文件。

无论模式如何，`graphify-out/.graphify-stale.json` 都会被当作硬阻断处理。运行
`cortex-agent graphify update --reason "<text>"` 刷新。

## 可用性检查

优先运行 preflight（比直接解析 JSON 图快，并给出结构化 verdict）：

```bash
cortex-agent graphify preflight --json
```

`verdict.result == "fresh"` 或 `"skipped"` 时图谱可安全查询；如果是 `"stale"` 或
`"blocked"`，**不要**直接读 `graphify-out/graph.json`，而是把过期原因反馈给用户，
提示其先刷新图谱。

## 子命令

### `/graphify query "<问题>"`

在知识图谱中检索与问题相关的节点和关系。

步骤：
1. 运行 `cortex-agent graphify preflight --query "<问题>" --json`。
2. 如果 `pass: false`，把 verdict 返回给用户，不要继续。
3. 否则读取 `graphify-out/graph.json`。
4. 过滤 `label` 或 `source_file` 匹配问题关键词的节点。
5. 对每个匹配节点，包含其直接邻居（1 跳），来自 `links[]`。
6. 输出摘要：节点 label、所在文件、关系类型（`relation` 字段）。
7. 如果 `branchDeltaRequired: true`，追加提示让调用方同时 `Read` 命中的当前源文件
   （图谱拓扑只是提示，不是事实）。

### `/graphify path "<文件A>" "<文件B>"`

查找两个文件在图谱中的最短连接路径。

步骤：
1. 运行 preflight（同上）。
2. 读取 `graphify-out/graph.json`。
3. 找到 `source_file` 包含文件A或文件B的节点。
4. 从文件A节点出发，通过 `links[]` 做 BFS 到文件B节点。
5. 输出路径：`文件A → [中间节点] → 文件B`，附关系类型。

深度超过 5 仍未找到时，回复"未找到直接路径"。

### `/graphify explain "<节点名称或文件>"`

解释某个节点（函数、类、文件）在项目图谱中的角色。

步骤：
1. 运行 preflight。
2. 读取 `graphify-out/graph.json`。
3. 找到匹配 label 或 source_file 的节点。
4. 展示：类型（`file_type`）、它调用了什么（出边）、谁调用了它（入边）、所属社区
   （`community`）。
5. 如果 `branchDeltaRequired: true`，追加提示让调用方 `Read` 当前源文件。

### `/graphify extract --task <任务ID> --files "<文件>"`

运行子图提取脚本，生成任务级子图并注册到 Artifact Bus：

```bash
node .agent/plugins/graphify/scripts/extract-subgraph.js \
  --task <任务ID> \
  --files "<逗号分隔的文件列表>"
```

成功后报告输出路径和节点/边数量。

## 输出格式

- `query` 和 `explain`：紧凑表格或项目列表，不输出原始 JSON，控制在 30 行以内。
- `path`：单行箭头链路图。
- `extract`：显示脚本的成功输出。

## /ship 阶段的 Freshness 收口

作为 `/ship` 的一部分时，本技能承担 **Graphify freshness gate** 的责任。Ship 之前：

1. 运行 `cortex-agent graphify context --json`，检查 `staleReasons`。
2. 任意过期原因为真时，运行 `cortex-agent graphify update --task <ship-task-id> --reason "pre_ship_refresh"`。
3. 更新完成后，运行 `cortex-agent graphify receipt --task <ship-task-id> --json`，
   确认 `result == "fresh"` 且 receipt 绑定到当前 source HEAD。
4. 如果拿不到 fresh receipt，门禁 FAIL——禁止 ship。

Receipt 持久化在 `<project>/.agent/artifacts/graphify/<task-id>/receipt.json`，字段
包含 `sourceHead`、`manifestDigest`、`generationMode`、`result`、`policy`、`mode`、
`reasons`、`branch`、`worktreeRole`。