# DSH (DeepSeek Harness) Integration — Cortex Agent

This project is wired to DSH (DeepSeek Harness) as a first-class dispatch adapter via `cortex-agent add dsh`, on par with Pi / Claude Code / Codex CLI.

## Prerequisites

- DSH CLI installed and `dsh` on `PATH` (`cortex-agent agent adapter probe dsh` should return `status=ready`).
- `cortex-agent init` has been run (root `AGENTS.md` and `.agent/` exist).

## Install

```bash
cortex-agent add dsh
```

This command:

1. Writes `.dsh/settings.json` (skills / prompts pointing at `.agent/`, merged with existing config).
2. Writes `.dsh/README.md` and `.dsh/AGENTS.md`.
3. Creates symlinks: `.dsh/skills` → `.agent/skills`, `.dsh/workflows` → `.agent/workflows`.

## Verify

```bash
cortex-agent agent adapter list          # should include dsh
cortex-agent agent adapter probe dsh     # status=ready / transport_supported=text-headless-v1
cortex-agent agent adapter health dsh    # status=ok (probe-backed, not just `which`)
```

## Dispatch

```bash
# Agent entry must use external.adapter_type === "dsh" (.agent/agents/<id>.json).
# The `dsh:` prefix is optional; when present it is checked against the entry.
cortex-agent agent dispatch-execute dsh:<agent-id> "review the schema"
cortex-agent agent dispatch-execute <agent-id> "review the schema"

# Opt-in bootstrap load (equivalent to _seed() auto-registration)
NODE_OPTIONS="--require ./lib/agents/adapters/dsh-bootstrap.js" \
  cortex-agent agent adapter health dsh
```

## Capability Boundaries (P-001 frozen vocabulary)

| Capability | Level | Notes |
| :--- | :--- | :--- |
| session.boundary | explicit | DSH session lifecycle self-reported via envelope |
| turn.boundary | adapter | chunk events carry turn/step, derivable via shadow backfill |
| message.boundary | unobservable | DSH does not expose message-level boundary events today |
| tool.before.observe / block | unsupported | pending M-018 verification of real DSH hooks |
| tool.update | unobservable | not exposed today |
| context.render.observe | unsupported | not exposed today |

> These are the static declarations in `discover().capability_descriptor`; the real launch surface is reported by `agent adapter probe dsh`.

## Transport and settlement (verified against dsh 0.2.1-rc.5)

```text
dsh --profile headless [--json] [--session-id <id>] -
  stdin  : task text (`-` reads the task from stdin; multi-line safe)
  stdout : NDJSON run events; {"type":"final","text":...} is the only settled signal
```

| status | condition |
| :--- | :--- |
| `ok` | exit 0 AND a `{"type":"final"}` event was observed |
| `blocked` | exit 0 without `final` (`reason=missing_settled_signal`) |
| `failed` | non-zero exit / `{"type":"error"}` / unparseable stdout |
| `timeout` | adapter-side timeout kill |

## Security Boundary

- The DSH adapter does **not** read `~/.dsh/sessions/` session storage (shadow usage is maintained separately by `scripts/dsh-usage-sync.js`).
- Fail-closed when the DSH CLI is absent or the probe is not `ready`: `health()` returns `ready: false`, dispatch returns `ERR_DSH_TRANSPORT_UNSUPPORTED` (`ERR_ADAPTER_SPAWN` when the gate is bypassed); other hosts are unaffected.
- No daemon / automatic dispatch is enabled; `cortex-agent add dsh` stays opt-in.
