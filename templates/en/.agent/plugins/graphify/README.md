# Graphify × Cortex Agent Plugin

> Connects Graphify knowledge graphs to Cortex Agent's Artifact Bus and Handoff protocol,
> so incoming agents can navigate the codebase via subgraph instead of re-exploring from scratch.
>
> **T-GWG-001 — Optional by design.** When `.agent/plugins/graphify/` is missing,
> Cortex Agent records `not_applicable` and falls back to source exploration
> without touching the filesystem beyond a single stat() call. When the plugin
> is present, `init` and `doctor --fix` idempotently install the post-commit
> hook (without overwriting unrelated user hooks), code changes trigger AST
> incremental updates, semantic changes (docs / proposals / rules / images)
> leave a durable ignored stale marker, and `query`/`path`/`explain` /
> `preflight` fail closed on stale knowledge instead of silently trusting it.

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

The CLI surface `cortex-agent graphify update --project <root>` is the
preferred entrypoint — it writes the freshness receipt at
`<project>/.agent/artifacts/graphify/global/receipt.json` and clears any
stale marker.

## Cortex Agent CLI Surface (T-GWG-001)

| Subcommand | Purpose |
| :--- | :--- |
| `graphify context` | Resolve and print the Graphify context (mode, source HEAD, age, fallback reason). Read-only. |
| `graphify preflight --query "<text>"` | Run the freshness gate. Exits non-zero when the graph is stale/incompatible. |
| `graphify update --reason "<text>"` | Re-run `graphify update .` and persist a freshness receipt on success. |
| `graphify doctor` | Report plugin state (CLI / config / graph / hooks / freshness). `--fix` repairs the post-commit hook idempotently. |
| `graphify receipt --task <task-id>` | Read the most recent freshness receipt (default task: `global`). |

All subcommands exit 0 and emit `not_applicable` when the project has not
opted in. No mutation, no install.

## Freshness Lifecycle

| Trigger | Action |
| :--- | :--- |
| `cortex-agent init` | Idempotently install the Graphify post-commit hook (skips when the project has no plugin). |
| `cortex-agent doctor --fix` | Repair the Graphify post-commit hook when missing; never overwrites an unrelated user hook. |
| `git commit` (code only) | Hook runs `graphify update .` for AST-level incremental update; clears any stale marker. |
| `git commit` (semantic only) | Hook writes `graphify-out/.graphify-stale.json` (gitignored); queries fail closed until the next update. |
| `graphify query` / `path` / `explain` | Each wrapper runs the freshness preflight and refuses to silently return the stale graph. |
| `/ship` | Owns the freshness closure: refreshes the graph if stale, writes the freshness receipt bound to source HEAD, blocks ship when the receipt cannot be produced. |

## Output Structure

```text
graphify-out/
├── graph.json               Persistent knowledge graph (read by extract-subgraph.js)
├── graph.html               Interactive visualization (open in browser)
├── GRAPH_REPORT.md          Key nodes and community summaries
├── manifest.json            Generation provenance (schema / source HEAD / counts / mode)
└── .graphify-stale.json     Ignored stale marker written by semantic-only commits

.agent/artifacts/graphify/<task-id>/receipt.json   Freshness receipt
```

## How It Works

```
Codebase → graphify update . → graphify-out/graph.json + manifest.json
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

### 2. Query the graph directly in your AI assistant

```
/graphify query "how does the handoff protocol relate to the artifact bus?"
/graphify path "handoff-protocol.js" "artifact-bus.js"
/graphify explain "coordinator"
```

Every subcommand runs the freshness preflight first. If the graph is stale
the subcommand refuses to read it and returns the structured verdict instead.

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

Edit `.agent/plugins/graphify/config.yml` to adjust scan scope and subgraph
depth. Per-project overrides can be placed in
`.agent/plugins/graphify/policy.local.yml` and follow this shape:

```yaml
mode: required-for-topology    # off | advisory | required-for-topology
max_age_days: 7
allow_primary_worktree_fallback: true
require_branch_delta_readback: true
```

When `mode: required-for-topology` is set, cross-module / call-chain /
architecture queries will fail closed if the freshness gate reports
`stale` / `blocked`.

## Fallback Behavior

If `graphify-out/graph.json` is missing, `extract-subgraph.js` exits silently
(exit 0). Handoff continues normally with `graphify_context.enabled: false`.
The Cortex Agent CLI surface records the missing graph via the `fallbackReason`
field on `graphify context --json` output.