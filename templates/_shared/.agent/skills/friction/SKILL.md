---
name: friction
description: Privacy-preserving friction signal contract (P-003 / M-003A). Record canonical REDACTED friction signal events (tool_denied / tool_failed / tool_retried / user_interrupted / user_correction / lifecycle_stop) through the owned runtime writer into .agent/runtime-evidence/friction/signals.jsonl. Aggregate-only redaction: no prompts, user messages, command arguments, tool output, credentials, file content, or free-form correction text may ever enter an event. Zero dependency.
area: aiapp
summary: Canonical redacted friction signal events via the owned runtime writer; closed schema, append-only JSONL, aggregate-only redaction.
---

# Friction Signal Contract Skill

Host-aware, redacted friction signals that let a human decide whether to
sediment an experience. The signal contract is defined before any scoring:
capability gaps must degrade conservatively to `not_observed`, never to an
inferred "zero friction".

## Redaction boundary (hard rule)

No prompt, user message, command/tool argument, tool output, credential, file
content, or free-form correction text may ever enter an event. The canonical
event is closed-schema and carries only: counts, signal type, observability
level, an opaque `evidence_ref`, a session id, a host, a timestamp, and a
redaction posture (`aggregate_only` / `full`). Adapters must pre-strip
free-form text BEFORE handing a candidate event to the validator.

## Signals (closed vocabulary)

`tool_denied` · `tool_failed` · `tool_retried` · `user_interrupted` ·
`user_correction` · `lifecycle_stop`

## Observability (closed enum)

`observed` (structured native event) · `derived` (deterministic derivation)
· `not_observed` (not currently claimable) · `not_supported` (explicitly unsupported)

Any adapter lacking a signal produces no event for it; `not_supported` and
`not_observed` are distinct and are never scored as zero friction.

## Host matrix (frozen, MS-001)

| host | tool_denied | tool_failed | tool_retried | user_interrupted | user_correction | lifecycle_stop |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| dsh | not_observed | derived | derived | not_observed | not_observed | derived |
| pi (absent) | not_supported | not_supported | not_supported | not_supported | not_supported | not_supported |

`HostCapabilityDescriptor.friction_signals` declares the per-host matrix;
`friction_lifecycle_events` names the lifecycle events a host exposes;
`redaction_level` is `aggregate_only` for real hosts.

## Commands

### Record a canonical redacted friction signal event

```bash
node .agent/skills/friction/scripts/record-signal.js --project <root> \
  --session S-<session> --host <host> --type <signal> --observability <level> \
  [--count 1] [--evidence-ref run:R-001/event:42]
```

- Appends one validated line to `.agent/runtime-evidence/friction/signals.jsonl`.
- Generates `signal_id: FS-<uuid>` when not supplied.
- Rejects any event that violates the closed schema (fail-loud, no partial write).

### Read signals back

```bash
node .agent/skills/friction/scripts/record-signal.js --read --project <root>
```

Parses the JSONL, skips malformed lines (reports how many), prints the
canonical events.

## Friction Score

`friction-score.js` reads canonical redacted FS events and returns a
**non-persistent** assessment: `{score, coverage, signals, recommendation}`.

- `coverage` is always part of the output: observed / derived / not_observed /
  not_supported / absent per signal. A signal with no events but declared
  not_supported/not_observed contributes ZERO to the score - and the output
  states that explicitly (never an inferred zero-friction).
- `recommendation` is `none` | `consider` | `suggest`. It is derived from
  score AND matrix coverage; `suggest` requires observed/derived support.
- The assessment is aggregate-only: counts, signal names, observability
  levels, coverage - no prompts, messages, args, output, credentials.

```bash
node .agent/skills/friction/scripts/friction-score.js --project <root> [--session <S-id>] [--host-matrix dsh|pi]
```

## Human-Gated Draft (/share-learnings)

`share-learnings.js` creates an experience draft ONLY after explicit user
confirmation:

```bash
node .agent/skills/friction/scripts/share-learnings.js --session <S-id> --title <title> [--body <path>] [--confirm]
```

- WITHOUT `--confirm`: refuses (exit 2) and creates NOTHING. A score
  recommendation NEVER auto-creates a draft.
- WITH `--confirm`: writes `/tmp/exp-<session-id>-draft.md` and prints a diff
  for human review. The draft is not committed, not upvoted, not promoted.

## Assessment State Machine

`FrictionAssessment` journals transitions append-only:

```text
observed -> assessed -> suggested -> user_approved | dismissed | expired
```

Terminal states (`user_approved` / `dismissed` / `expired`) are preserved -
no transition out of them is legal. Journal lines carry only stable ids,
state names, an actor label and an opaque `evidence_ref` (redaction guard).
## No terminal parsing

Events are produced only through the owned runtime writer / run journal path.
This skill never parses host terminal output and never invents a private
`events.jsonl`.