# Feedback Inbox (P-001 · M-024)

> This is the English projection of the P-001 feedback pipeline docs. The authoritative example lives at `templates/_shared/.agent/config/feedback.json.example`; behavior is defined in `lib/feedback/`.

## Enable the inbox

1. Copy `templates/_shared/.agent/config/feedback.json.example` to `<project>/.agent/config/feedback.json`.
2. Set `enabled` to `true`.
3. Flip `adapters.cortex_diagnostic` and/or `adapters.evolution_observation` as needed.
4. Capture via `cortex-agent feedback log ...` or by a registered adapter calling `feedback ingest-event`.

## Defaults

- `enabled=false`: every write command is a no-op; `feedback status` stays read-only.
- `nudge.enabled=false`: SessionStart emits no feedback nudge.
- `lib/feedback/redact.js` scrubs PII/credential content before any value reaches disk. Prompts, transcripts, tokens, full stacks, arbitrary env vars and business payloads are never collected.

## Exit codes

| Code | Meaning |
| :--- | :--- |
| 0 | Success |
| 2 | Project uninitialized or inbox root unresolvable |
| 3 | Argument / schema error |
| 4 | I/O failure during write or read |
| 5 | Write path disabled (not applicable to status) |
| 6 | Config or permission is unsafe |

## Scope

- In scope: local immutable event storage, whitelist schema, write-before redaction, unified config, three CLI subcommands, default-disabled SessionStart nudge.
- Out of scope: issue candidates, GitHub writes, Task sync, release integration, automatic writes to `.agent/memory/feedback/`.