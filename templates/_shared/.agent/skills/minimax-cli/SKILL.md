---
name: minimax-cli
description: Governed-tool adapter for the locally installed MiniMax CLI (`mmx`). Exposes a closed-set capability snapshot (text/image/video/speech/music/vision/search), portable Skill discovery across Claude Code/Cursor/Pi/Codex, and a fail-closed gateway that routes through existing Tool Gate / Authorization / Readiness / Operation / lease / boundary-event owners. The probe allow-list is strictly `mmx --version`, `mmx --help`, `mmx <resource> --help`; `auth_state` is forced to `unknown`; ready/blocked requires separate authorization. Never invokes paid / network / generation subcommands.
model: sonnet
tools:
  - Read
  - Bash
  - Grep
  - Glob
area: swe
summary: Governed-tool adapter for the locally installed MiniMax CLI (`mmx`). Exposes a closed-set capability snapshot (text/image/video/speech/music/vision/search), portable Skill discovery across Claude Code
---

# minimax-cli (governed-tool adapter, M-011 / ARI P-005)

> Frozen proposal: `.agent/plans/proposals/projects/agent-runtime-interoperability/proposals/P-005-minimax-cli-governed-tool-adapter-proposal.md`
> Frozen SHA-256: `f377943b6eb73d44308a86d965229730ba2552613ae611e3e511457c13f4587d`
> Decision: `.agent/decisions/D-M011-ARI-P005-f377943b.json`
> Waitpoint: `.agent/waitpoints/WP-M011-ARI-P005-f377943b.json`

This Skill is a thin read-only surface for the **MiniMax CLI** (`mmx`) that:

- Discovers the local `mmx` binary and reads its version (`mmx --version`).
- Builds a closed `MiniMaxCliCapabilitySnapshot` for the seven resources (text/image/video/speech/music/vision/search) using `mmx --help` and `mmx <resource> --help` only.
- Enumerates portable Skill discovery paths across Claude Code / Cursor / Pi / Codex / common locations (read-only, no file creation).
- Exposes a governed-tool adapter gateway that composes existing owners (`lib/runtime-adapters/capability-aware-dispatch.js`, `lib/runtime-adapters/tool-gate.js`, `lib/runtime-state/operation-lifecycle.js`, `lib/runtime-adapters/boundary-event.js`) and **fails closed** whenever `auth_state !== "unknown"` or any gate is missing.

## Strict allow-list (VC-011-01-04)

The Skill may only invoke the following three `mmx` command families:

1. `mmx --version`
2. `mmx --help`
3. `mmx <resource> --help` (where `<resource>` ∈ `{text, image, video, speech, music, vision, search}`)

Any other `mmx` invocation is forbidden in this Mission and must raise `MiniMaxCliProbeError("ERR_PROBE_FAMILY_NOT_ALLOWED")` before exec.

## Auth posture

`auth_state` is always `"unknown"` and `auth_state_reason` is always `"auth_probing_disabled"`. Surfacing `ready` or `blocked` requires a separate authorization record (out of scope for this Mission).

## Forbidden subcommands (string-level grep guard)

- `mmx auth` (any subcommand: status / login / logout / refresh)
- `mmx config` (any subcommand: show / set / export-schema)
- `mmx quota`
- `mmx update`
- `mmx install`
- `mmx file` (any subcommand: upload / list / delete)
- `mmx text chat | repl`
- `mmx image generate`
- `mmx video generate | task get | download`
- `mmx speech synthesize | voices`
- `mmx music generate | cover`
- `mmx vision describe`
- `mmx search query`

## Public API

```js
const gateway = require("./lib/runtime-adapters/minimax-cli-governed-tool");

// Capability snapshot (only the 3 allow-listed families invoked):
const snapshot = gateway.probeGateway({ binary: "mmx" });
// snapshot.auth_state === "unknown"
// snapshot.no_credential === true
// snapshot.probe_families === ["version","help","resource_help"]

// Portable Skill discovery (no mmx calls, only fs.read):
const descriptors = gateway.discoverSkills("/path/to/project");

// Dispatch (fail-closed when auth_state !== "unknown"):
const result = gateway.dispatchRequirement(
  gateway.buildMinimaxCliRequirement({ resource: "text", subcommand: "chat" }),
  ownerFn,
  { now: new Date().toISOString(), snapshot }
);
// Without snapshot OR with auth_state !== "unknown": result.result === "unavailable"

// Async job metadata contract (no mmx invocation):
const reconciled = gateway.reconcileAsyncJob(null, jobDescriptor, { now: ... });
// reconciled.mmx_invocation === "skipped_in_this_mission"
```

## Files

- `lib/runtime-adapters/minimax-cli-capability-contract.js` — frozen schema + 3-family allow-list + auth readiness gate
- `lib/runtime-adapters/minimax-cli-probe.js` — safe probe (3 families only)
- `lib/runtime-adapters/minimax-cli-skill-discovery.js` — portable path enumeration
- `lib/runtime-adapters/minimax-cli-governed-tool.js` — composed gateway
- `scripts/m011-safe-probe.js` — evidence-producing CLI
- `scripts/m011-skill-discovery.js` — discovery CLI
- `.agent/missions/M-011/` — Mission M-011 evidence + validation contract

## Do not

- Invoke any `mmx` command outside the three allow-listed families.
- Read, print, or persist any value from `/Users/xueyq/.mmx/*` or env `MINIMAX_API_KEY` / `MINIMAX_TOKEN`.
- Surface `auth_state` other than `unknown` (requires separate authorization).
- Enable automatic dispatch or a persistent daemon.
- Commit, stage, push, publish, release, reset, stash, delete user files.
- Mutate frozen P-006 (`c2e7b17aa2c0cf21995da0bd4cb197bd6a8b1d514d2d66339558e03bc9ae16ca`).