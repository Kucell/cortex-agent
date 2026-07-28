---
name: coordination
description: Report and inspect vendor-neutral multi-agent task coordination through the public Cortex Agent CLI.
---

# Agent Coordination

Use `cortex-agent task` and `cortex-agent event`; do not edit journal, snapshot,
lease, cursor, or delivery files directly. Discover the exact machine contract
with `cortex-agent help task --json`.

Read operations are side-effect free:

```bash
cortex-agent task status --project . --task T-001
cortex-agent task list --project .
cortex-agent event list --project . --task T-001
cortex-agent query coordination-tasks --project . --state READY_FOR_REVIEW
```

Write commands delegate the complete event envelope to the Coordination
Application Service using `--event-json`. The service is the only owner of
schema, actor, sequence, transition, journal, and snapshot rules.

ACK confirms delivery only. It never approves a Decision, releases a Waitpoint,
commits, pushes, merges, publishes, dispatches, or changes task state.

Runtime data stays under `.agent-runtime/coordination/` and is Git ignored.
Team Packs may distribute only `.agent/coordination/README.md`,
`notification-policy.json`, and schemas; never journals, snapshots, leases,
cursors, delivery records, sockets, PIDs, absolute paths, tokens, or prompts.
