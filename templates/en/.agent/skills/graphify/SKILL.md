---
name: graphify
description: Query the Graphify knowledge graph for the current project. Supports query, path, explain, and subgraph extraction. Requires graphify-out/graph.json to be present.
---

# Graphify Skill

## Trigger

`/graphify <subcommand> [args]`

## Availability Check

Before executing any subcommand, check whether `graphify-out/graph.json` exists:

```bash
test -f graphify-out/graph.json && echo "available" || echo "not available"
```

If not available, respond:
> Graphify 图谱未找到（`graphify-out/graph.json` 不存在）。
> 运行 `graphify update .` 生成代码图谱，或 `ANTHROPIC_API_KEY=sk-... graphify .` 生成完整图谱。

## Subcommands

### `/graphify query "<question>"`

Search the knowledge graph for nodes and relationships relevant to the question.

Steps:
1. Read `graphify-out/graph.json`
2. Filter nodes whose `label` or `source_file` matches keywords in the question
3. For each matched node, include its direct neighbors (1 hop) from `links[]`
4. Present a summary: node labels, source files, and relationship types (`relation` field)

### `/graphify path "<file-a>" "<file-b>"`

Find the shortest connection path between two files in the graph.

Steps:
1. Read `graphify-out/graph.json`
2. Find all nodes where `source_file` contains `file-a` or `file-b`
3. Run BFS from file-a nodes toward file-b nodes via `links[]`
4. Report the path as: `file-a → [intermediate nodes] → file-b` with relation labels

If no path found within depth 5, report "no direct path found".

### `/graphify explain "<node-label-or-file>"`

Explain the role of a node (function, class, or file) in the project graph.

Steps:
1. Read `graphify-out/graph.json`
2. Find nodes matching the label or source_file
3. Show: what it is (`file_type`), what it calls (outgoing links), what calls it (incoming links), which community it belongs to (`community` field)

### `/graphify extract --task <task_id> --files "<files>"`

Run the extract-subgraph script to generate a task-scoped subgraph and register it to Artifact Bus.

```bash
node .agent/plugins/graphify/scripts/extract-subgraph.js \
  --task <task_id> \
  --files "<comma-separated files>"
```

Report the output path and node/edge counts on success.

## Output Format

For `query` and `explain`, present results as a compact table or bulleted list. Do not dump raw JSON. Keep the response under 30 lines.

For `path`, show the chain as a one-line arrow diagram.

For `extract`, show the success message from the script output.
