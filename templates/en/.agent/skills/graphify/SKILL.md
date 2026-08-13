---
name: graphify
description: Query the Graphify knowledge graph for the current project. Supports query, path, explain, and subgraph extraction. Requires graphify-out/graph.json to be present. T-GWG-001: every subcommand now runs a freshness preflight and fails closed when the graph is stale or incompatible.
area: swe
summary: Query the Graphify knowledge graph for the current project. Supports query, path, explain, and subgraph extraction. Requires graphify-out/graph.json to be present. T-GWG-001: every subcommand now runs a freshness preflight and fails closed when the graph is stale or incompatible.
---

# Graphify Skill

## Trigger

`/graphify <subcommand> [args]`

## Freshness Preflight (T-GWG-001)

Graphify is **optional**. When the project has no `.agent/plugins/graphify/` directory the
skill is `not_applicable` and the host falls back to source exploration without touching
the graph.

When the plugin is present, every subcommand runs a **freshness preflight** before reading
`graphify-out/graph.json`. The preflight checks (in order):

1. Schema + Graphify major-version compatibility.
2. Manifest integrity (counts vs `nodes`/`links`).
3. Graph age vs `governance.max_age_days`.
4. Source HEAD lineage (`sourceHead` reachable from current HEAD?).
5. Working-tree dirty extent.

If the preflight fails, the subcommand must:

- Print the structured `verdict` from `cortex-agent graphify preflight --json`.
- Refuse to silently return the stale graph (fail closed).
- Surface the `branchDeltaRequired` hint so the caller can `git diff sourceHead..HEAD`
  and re-read changed files from source.

A stale marker (`.graphify-stale.json` under `graphify-out/`) is honored as a hard block,
regardless of mode. Run `cortex-agent graphify update --reason "<text>"` to refresh.

## Availability Check

Run the preflight first (it is faster than parsing the JSON graph and gives a structured verdict):

```bash
cortex-agent graphify preflight --json
```

If `verdict.result == "fresh"` or `verdict.result == "skipped"`, the graph is safe to query.
If `verdict.result == "stale"` or `"blocked"`, do NOT read `graphify-out/graph.json` blindly;
report the stale reasons and ask the operator to refresh the graph first.

## Subcommands

### `/graphify query "<question>"`

Search the knowledge graph for nodes and relationships relevant to the question.

Steps:
1. Run `cortex-agent graphify preflight --query "<question>" --json`.
2. If `pass: false`, return the verdict to the user; do NOT proceed.
3. Otherwise, read `graphify-out/graph.json`.
4. Filter nodes whose `label` or `source_file` matches keywords in the question.
5. For each matched node, include its direct neighbors (1 hop) from `links[]`.
6. Present a summary: node labels, source files, and relationship types (`relation` field).
7. If `branchDeltaRequired: true`, append a note that the caller MUST also `Read`
   the matched source files (graph-derived topology is a hint, not a fact).

### `/graphify path "<file-a>" "<file-b>"`

Find the shortest connection path between two files in the graph.

Steps:
1. Run preflight (same as above).
2. Read `graphify-out/graph.json`.
3. Find all nodes where `source_file` contains `file-a` or `file-b`.
4. Run BFS from file-a nodes toward file-b nodes via `links[]`.
5. Report the path as: `file-a → [intermediate nodes] → file-b` with relation labels.

If no path found within depth 5, report "no direct path found".

### `/graphify explain "<node-label-or-file>"`

Explain the role of a node (function, class, or file) in the project graph.

Steps:
1. Run preflight.
2. Read `graphify-out/graph.json`.
3. Find nodes matching the label or source_file.
4. Show: what it is (`file_type`), what it calls (outgoing links), what calls it
   (incoming links), which community it belongs to (`community` field).
5. If `branchDeltaRequired: true`, append a hint to `Read` the current source.

### `/graphify extract --task <task_id> --files "<files>"`

Run the extract-subgraph script to generate a task-scoped subgraph and register it to
Artifact Bus.

```bash
node .agent/plugins/graphify/scripts/extract-subgraph.js \
  --task <task_id> \
  --files "<comma-separated files>"
```

Report the output path and node/edge counts on success.

## Output Format

For `query` and `explain`, present results as a compact table or bulleted list. Do not
dump raw JSON. Keep the response under 30 lines.

For `path`, show the chain as a one-line arrow diagram.

For `extract`, show the success message from the script output.

## Ship-time Freshness Closure

When running as part of `/ship`, the skill is responsible for the **Graphify freshness
gate**. Before shipping:

1. Run `cortex-agent graphify context --json` and inspect `staleReasons`.
2. If any stale reason is present, run `cortex-agent graphify update --task <ship-task-id> --reason "pre_ship_refresh"`.
3. After the update, run `cortex-agent graphify receipt --task <ship-task-id> --json`
   and confirm `result == "fresh"` + the receipt is bound to the current source HEAD.
4. If the update cannot produce a fresh receipt, the gate FAILS — do not ship.

The receipt is persisted at `<project>/.agent/artifacts/graphify/<task-id>/receipt.json`
and includes `sourceHead`, `manifestDigest`, `generationMode`, `result`, `policy`,
`mode`, `reasons`, `branch`, and `worktreeRole`.