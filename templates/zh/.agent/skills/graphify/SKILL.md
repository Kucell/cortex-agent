---
name: graphify
description: 查询当前项目的 Graphify 知识图谱。支持 query（关键词检索）、path（两文件最短路径）、explain（节点解释）、extract（子图提取）。需要 graphify-out/graph.json 存在。
---

# Graphify Skill

## 触发

`/graphify <子命令> [参数]`

## 可用性检查

执行任何子命令前，先检查 `graphify-out/graph.json` 是否存在：

```bash
test -f graphify-out/graph.json && echo "available" || echo "not available"
```

不存在时回复：
> Graphify 图谱未找到（`graphify-out/graph.json` 不存在）。
> 运行 `graphify update .` 生成代码图谱，或 `ANTHROPIC_API_KEY=sk-... graphify .` 生成完整图谱。

## 子命令

### `/graphify query "<问题>"`

在知识图谱中检索与问题相关的节点和关系。

步骤：
1. 读取 `graphify-out/graph.json`
2. 过滤 `label` 或 `source_file` 匹配问题关键词的节点
3. 对每个匹配节点，包含其直接邻居（1 跳），来自 `links[]`
4. 输出摘要：节点 label、所在文件、关系类型（`relation` 字段）

### `/graphify path "<文件A>" "<文件B>"`

查找两个文件在图谱中的最短连接路径。

步骤：
1. 读取 `graphify-out/graph.json`
2. 找到 `source_file` 包含文件A或文件B的节点
3. 从文件A节点出发，通过 `links[]` 做 BFS 到文件B节点
4. 输出路径：`文件A → [中间节点] → 文件B`，附关系类型

深度超过 5 仍未找到时，回复"未找到直接路径"。

### `/graphify explain "<节点名称或文件>"`

解释某个节点（函数、类、文件）在项目图谱中的角色。

步骤：
1. 读取 `graphify-out/graph.json`
2. 找到匹配 label 或 source_file 的节点
3. 展示：类型（`file_type`）、它调用了什么（出边）、谁调用了它（入边）、所属社区（`community`）

### `/graphify extract --task <任务ID> --files "<文件>"`

运行子图提取脚本，生成任务级子图并注册到 Artifact Bus：

```bash
node .agent/plugins/graphify/scripts/extract-subgraph.js \
  --task <任务ID> \
  --files "<逗号分隔的文件列表>"
```

成功后报告输出路径和节点/边数量。

## 输出格式

- `query` 和 `explain`：紧凑表格或项目列表，不输出原始 JSON，控制在 30 行以内
- `path`：单行箭头链路图
- `extract`：显示脚本的成功输出
