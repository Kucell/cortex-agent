---
name: prototype
description: Generate doc prototypes (Mermaid + Anime.js) or UI prototypes (Pixso MCP) from requirements, and output a validation-contract.
---

# Prototype Design Workflow (/prototype)

## Usage

/prototype <task-id> [--mode doc|ui|both] [--fidelity low|mid|high]

Default: --mode both, --fidelity low

### When to Use

- **Visual anchor before requirement sign-off**: Align the team on core user paths with flow diagrams and animated HTML before formal architecture design begins.
- **Early stage of UI-heavy projects**: Quickly generate Pixso design frames as a lightweight alternative to hand-drawn wireframes or Figma files, then move straight into interaction review.
- **Lightweight flow validation**: Use `--mode doc --fidelity low` to output a Mermaid diagram and map out complex business flows without introducing extra tooling dependencies.
- **Requirements-to-implementation bridge**: The output `validation-contract.json` can serve directly as the acceptance baseline for the `/ship` delivery phase.

## State Machine

REQUIREMENTS -> ROUTE -> [DOC_PROTOTYPE | UI_PROTOTYPE | BOTH] -> CONTRACT -> DONE

## Phase 1: REQUIREMENTS

Read task description, extract:
- Core user flow (Happy Path)
- Key entities and interaction nodes
- Project type (UI-heavy / API / mixed)

If `.agent/prd/` or `.agent/prds/` contains a related PRD, read these files first:

- `state.json`
- `prd.md`
- `flows.md`
- `screens.md`
- `acceptance-criteria.md`

Use them as prototype design input instead of relying only on the conversation requirement.

## Phase 2: ROUTE

Route based on --mode and project type:
| mode | execution path |
|------|----------------|
| doc  | -> DOC_PROTOTYPE |
| ui   | -> UI_PROTOTYPE |
| both | -> DOC_PROTOTYPE -> UI_PROTOTYPE (serial) |

> **--mode both failure handling**: If DOC_PROTOTYPE fails, log the error and continue executing UI_PROTOTYPE. Report all failed paths in the DONE phase.

> **Pixso MCP unavailable - automatic fallback**: If the Pixso MCP tool is unreachable (connection timeout, not installed, or insufficient permissions), automatically fall back to `doc` mode and continue execution: skip the UI_PROTOTYPE phase and generate only `flow.md` and (per fidelity) `prototype.html`. In the DONE phase, add the note `ui path skipped: MCP unavailable` to the summary and omit the `runtime` assertion from `validation-contract.json`.

### --fidelity Fidelity level description

| fidelity | output |
|----------|--------|
| low      | flow.md (Mermaid diagram, text-readable only) |
| mid      | flow.md + basic prototype (simplified Anime.js HTML nodes / Pixso core frames, Happy Path coverage) |
| high     | flow.md + full prototype (complete Anime.js HTML interaction timeline / full Pixso state frames, all branches covered) |

Default: `--fidelity low` (fast output, flow.md only)

## Phase 3a: DOC_PROTOTYPE

### Step 1: Mermaid Flow Diagram

Generate `.agent/prototypes/<task-id>/flow.md` containing:
- User action sequence diagram (sequenceDiagram)
- Page/state transition diagram (stateDiagram-v2)

### Step 2: Anime.js HTML Prototype

Generate `.agent/prototypes/<task-id>/prototype.html`:
- Based on the structure and style of `docs/assets/coordinator-dispatch.html`
- Map requirement steps to Anime.js timeline nodes
- Dark terminal style, Play / Reset controls
- Load animejs via CDN (https://unpkg.com/animejs@latest/lib/anime.min.js), no build step required

Node structure (each requirement step maps to one .node):

```html
<div class="node" id="step-N">
  <div class="label">Step N</div>
  <div class="name">[action]</div>
  <div class="status">[status]</div>
</div>
```

Skip condition: Do not generate this file when `--fidelity low`.

## Phase 3b: UI_PROTOTYPE

### Step 1: Invoke Pixso MCP

Call the pixso MCP tool with the requirements description and user flow to generate design frames.

Record output to `.agent/prototypes/<task-id>/pixso-frames.json`:

```json
{
  "file_id": "<pixso-file-id>",
  "frames": [
    { "name": "Step N - [page name]", "url": "<pixso-frame-url>" }
  ],
  "export_hint": "In Pixso, select all frames -> export as PNG/SVG -> place in docs/assets/prototypes/<task-id>/"
}
```

Skip condition: Do not call Pixso MCP or generate this file when `--fidelity low`.

## Phase 4: CONTRACT

Call `.agent/skills/validation-contract/` skill (CREATE mode) to generate a validation contract based on prototype artifacts.

Required assertion types in the contract:
- `type: "manual"` - whether the prototype aligns with the requirements description (manual confirmation)
- `type: "docs"` - whether the flow.md Mermaid diagram covers all user flows
- `type: "runtime"` (UI path) - whether the Pixso frame links are accessible

> **Note (--fidelity low)**: The `runtime` assertion for the UI path is only generated when `pixso-frames.json` exists; it is automatically skipped when `--fidelity low`.

Output to `.agent/prototypes/<task-id>/validation-contract.json`.

If a related PRD exists, write generated prototype paths or Pixso frame information back to the PRD `links.json`, or mention in DONE that a human should run `/prd design <prd-id>` to update design status.

## Phase 5: DONE

Output summary:

```text
/prototype complete: <task-id>

  Mode: <doc|ui|both>
  Flow diagram: .agent/prototypes/<task-id>/flow.md
  HTML prototype: .agent/prototypes/<task-id>/prototype.html (doc path, skipped at low fidelity)
  Pixso frames: .agent/prototypes/<task-id>/pixso-frames.json (ui path, skipped at low fidelity)
  Validation contract: .agent/prototypes/<task-id>/validation-contract.json

  Recommended next step: /arch-design (if architecture design needed) | /ship <task-id> (if implementing directly)
```

## Output Directory Structure

```text
.agent/prototypes/<task-id>/
├── flow.md
├── prototype.html
├── pixso-frames.json
└── validation-contract.json
```

