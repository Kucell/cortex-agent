---
description: Explicitly launch Claude Code or Pi in an isolated worktree with a Cortex Coordination Task and notification pump.
---

# Launch Governed Agent

Use this workflow when a user asks Codex to run a development task through
Claude Code or Pi. Until `cortex-agent dispatch` is implemented, do not present
the reserved dispatch interface as an execution path. Launch the host process
explicitly and connect it to Cortex coordination.

## Required inputs

- Absolute project path
- Concrete task description and repository-relative ownership scope
- Execution host: `claude-code` or `pi`
- Notification consumer and coordinator target

## Procedure

1. Read the target project's `AGENTS.md`, `.agent/rules/`, active Mission,
   approved Plan, validation contract, and current task progress.
2. Inspect the target worktree before mutation. Create a separate worktree and
   preserve every uncommitted change in the user's current worktree.
3. Through the public Cortex Task API, create one Coordination Task and record
   its unique `taskId`, `operationId`, worktree, and Agent session reference.
   Acquire an ownership lease through the public CLI/API:
   `cortex-agent lease acquire --scope task:<task-id> --owner <host> --idempotency-key <key>`.
   If the installed Cortex version has no public acquire operation, record
   the ownership scope in a Task message and retain the failed attempt in
   the audit trail. Do not write directly to `.agent-runtime` or bypass
   fencing checks. (FAE-007 / M-013 ships the public acquire operation in
   cortex-agent 1.8.1+; this workflow no longer ships a 1.8.0 compatibility
   fallback.)
4. Start Claude Code or Pi through the Cortex wrapper/hook in a one-shot,
   governed process. A process started independently in another terminal is not
   assumed to emit Cortex events.
5. Limit the Agent to the approved worktree and ownership scope. It may read
   and edit scoped files, run builds/tests, stage scoped changes, and create a
   local checkpoint commit.
6. Forbid automatic push, merge, force-push, credential access, other-project
   mutation, scope expansion, and destructive Git actions.
7. Require public Task API events for accepted, progress, testing,
   ready-for-review, input-required, blocked, and failed states. Heartbeats and
   ordinary unchanged progress remain journal-only.
8. Start an explicit notification pump when low-latency delivery is required:

   ```bash
   cortex-agent notification pump \
     --project <absolute-project-path> \
     --consumer <consumer-id> \
     --target coordinator:root \
     --adapter codex \
     --watch
   ```

9. On `READY_FOR_REVIEW`, do not ACK automatically. Independently inspect the
   diff, run the validation contract, and verify checkpoint commit, tests, and
   receipt. Only then update the owning Mission, Plan, and `task-progress.md`.
10. Notify the user immediately for input-required, blocked, failed, ownership
    conflict, or authority outside the approved scope. Do not repeatedly notify
    unchanged heartbeats.
11. A foreground `--watch` ends with its Codex task. On resume, restart it or
    use a bounded recurring status check; journaled state remains authoritative.

## Pi receipt boundary

Pi must run as a governed one-shot process. Its receipt may contain only
identifiers, bounded summaries, exit status, timestamps, artifact references,
and SHA-256 digests. It must not contain prompts, responses, credentials,
private sessions, file bodies, or exact token usage.

## Prompt template

```text
In <project-name> at <absolute-project-path>, use <Claude Code|Pi> Agent to
complete: <task>.

Read AGENTS.md and the relevant Cortex rules, Mission, Plan, and validation
contract first. Create an isolated worktree and a Cortex Coordination Task.
Record taskId, operationId, worktree, and Agent session. Connect the Agent
through the Cortex wrapper/hook and start notification pump consumer
<consumer-id> targeting coordinator:root with the codex adapter.

Acquire an ownership lease through the public CLI/API:
`cortex-agent lease acquire --scope task:<task-id> --owner <host> --idempotency-key <key>`.
If the installed Cortex version has no public acquire operation, record
the ownership scope in the Task message, preserve the failed attempt as
audit evidence, and do not modify .agent-runtime or bypass fencing.

Allow scoped edits, builds, tests, git add, and a local checkpoint commit.
Forbid push, merge, force-push, credentials, other projects, destructive Git,
and scope expansion. Report lifecycle events through the public Task API.
On READY_FOR_REVIEW, Codex must independently validate before ACK or Mission
progression. Notify me only for material progress, input required, blocked,
failed, authority conflicts, or completion.
```
