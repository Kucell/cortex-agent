# Graphify × Cortex Agent Plugin

> Connects Graphify knowledge graphs to Cortex Agent's Artifact Bus and Handoff protocol,
> so incoming agents can navigate the codebase via subgraph instead of re-exploring from scratch.

## Prerequisites

```bash
pip install graphifyy && graphify install
```

> macOS externally-managed environments: `pip install --break-system-packages graphifyy && graphify install`
>
> Windows PATH issues: use `pipx install graphifyy`

Full docs: https://github.com/safishamsi/graphify

## Initialize the Knowledge Graph

Run from the project root:

```bash
# Code-only graph (no LLM API key required)
graphify update .

# Full graph (code + docs + Markdown, requires API key)
ANTHROPIC_API_KEY=sk-... graphify .
```

Output structure:

```text
graphify-out/
├── graph.json       Persistent knowledge graph (read by extract-subgraph.js)
├── graph.html       Interactive visualization (open in browser)
└── GRAPH_REPORT.md  Key nodes and community summaries
```

## How It Works

```
Codebase → graphify update . → graphify-out/graph.json
                                        ↓
             extract-subgraph.js --task T-C06 --files "lib/commands.js"
                                        ↓
             .agent/artifacts/T-C06/graphify-subgraph.json
                                        ↓
             Artifact Bus (kind: knowledge-graph) ← coordinator can reference
                                        ↓
             Handoff JSON (graphify_context field) ← incoming agent navigates directly
```

## Usage

### 1. Generate a task subgraph (run before /handoff)

```bash
node .agent/plugins/graphify/scripts/extract-subgraph.js \
  --task T-C06 \
  --files "lib/commands.js,.agent/skills/handoff/SKILL.md"
```

Output: `.agent/artifacts/<task_id>/graphify-subgraph.json`

### 2. Query the graph directly in Claude Code

```
/graphify query "how does the handoff protocol relate to the artifact bus?"
/graphify path "handoff-protocol.js" "artifact-bus.js"
/graphify explain "coordinator"
```

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

If `graphify-out/graph.json` is missing, `extract-subgraph.js` exits silently (exit 0).
Handoff continues normally with `graphify_context.enabled: false`.
