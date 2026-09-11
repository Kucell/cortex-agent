# Project Scope in Agent Registry and Team Pack

> Status: accepted (P-002 / M-037, merged at e89e567, 2026-09-11)
> Source: Tencent/teamai-cli multi-project-management design (adapted to Cortex actual contracts)

## Problem

An agent registry entry and a Team Pack file need an explicit project visibility scope. The existing
contracts are the per-agent JSON registry (`.agent/agents/<agent_id>.json`) and the Team Pack
`files[]` merge primitive; project scope must be delivered through those real primitives, not a new
directory convention, and must not break v1 installs.

## Design

### 1. Agent registry v1 extension (additive, optional)

Each entry keeps `schema_version: 1` and gains two optional fields:

- `projects`: array of kebab-case ids (`/^[a-z0-9]+(?:-[a-z0-9]+)*$/`), unique, max 32.
- `recall`: `"enabled" | "disabled"` (default `disabled`).

Unknown project ids or invalid recall values fail loudly (`ERR_AGENT_PROJECTS_INVALID`,
`ERR_AGENT_RECALL_INVALID`). `projects[]` is an authorization-free subscription scope; the task
primary key remains `mission_id`. New CLI: `agent projects set|list|members` (alias `agents`).

### 2. Team Pack manifest v2

`schema_version: 2` accepts an optional `projects` array on each `files[]` entry
(absent or `[]` = global). `validateManifestShape` rejects a v1 manifest carrying file projects.
Project scope enters the canonical pack hash and the manifest fingerprint only when non-empty, so
v1 hashes stay stable. `buildMergePlan`/install selection:

- No scoped files: behavior identical to v1.
- Scoped files present without an explicit `--agent`: fail closed
  (`ERR_AGENT_SELECTION_REQUIRED`).
- With `--agent`: per-file selection `global | project_intersection | project_miss`; a miss is
  recorded as decision `skip` in both the plan and the receipt
  (`selection_agent_id`, `selection_reason` on each file entry).

### 3. Conflict safety

Duplicate target paths fail before any write (`ERR_TEAM_PACK_DUPLICATE_TARGET`); receipts and
merge evidence remain append-only; `verifyChecks` accepts v1 and v2.

## Validation

- 69/69 affected suites (registry + team-pack + new project-scope tests) at MS-001 validation.
- CLI E2E: fail-closed without `--agent`; deterministic selection with `--agent`;
  apply + receipt evidence (global / intersection / miss).
- VC-008 (existing Team Pack suite, v1 fixtures, rollback) passed unchanged.

## Boundaries

No `registry.yaml`; no new top-level Team Pack dirs; no role-audience metadata; no automatic
agent binding (needs ARI P-007 evidence and separate approval); recall/knowledge-retrieval never
selects agents on its own.
