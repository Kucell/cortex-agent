# Graphify × Cortex Agent Plugin

> Connects Graphify knowledge graphs to Cortex Agent's Artifact Bus and Handoff protocol,
> so incoming agents can navigate the codebase via subgraph instead of re-exploring from scratch.

## Prerequisites

```bash
npx graphify init        # Initialize .graphify/ directory
npx graphify scan        # Build the project knowledge graph (.graphify/map.json)
```

Full docs: https://github.com/safishamsi/graphify

## How It Works

```
Codebase → Graphify full map → extract-subgraph.js → task-scoped subgraph
                                                              ↓
                                    Artifact Bus (kind: knowledge-graph)
                                                              ↓
                                    Handoff JSON (graphify_context field)
                                                              ↓
                                              Incoming agent navigates directly
```

## Usage

### 1. Generate a task subgraph (run before /handoff)

```bash
node .agent/plugins/graphify/scripts/extract-subgraph.js \
  --task T-C06 \
  --files "lib/commands.js,.agent/skills/handoff/SKILL.md"
```

Output: `.agent/artifacts/<task_id>/graphify-subgraph.json`

### 2. Subgraph auto-registers to Artifact Bus

The script writes a `kind: knowledge-graph` artifact automatically.
The coordinator can reference it during handoff.

### 3. Handoff carries graph context

The handoff JSON's `graphify_context` field points to the subgraph path:

```json
{
  "graphify_context": {
    "enabled": true,
    "subgraph_path": ".agent/artifacts/T-C06/graphify-subgraph.json",
    "relevant_files": ["lib/commands.js"],
    "entry_functions": ["upgrade()"]
  }
}
```

## Configuration

Edit `.agent/plugins/graphify/config.yml` to adjust scan scope and subgraph depth.

## Fallback Behavior

If Graphify is not installed (`.graphify/map.json` missing), `extract-subgraph.js`
exits silently without error. Handoff continues normally with `graphify_context.enabled: false`.
