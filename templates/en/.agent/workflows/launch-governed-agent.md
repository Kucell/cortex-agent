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
8. Bind the governed child monitor to a single execution attempt by passing
   `taskId`, `operationId` and `attemptId` (or the launch identifier that
   uniquely identifies the attempt). The monitor must project a terminal
   `attempt_disposition` and write `monitoring_terminal=true` exactly once
   per attempt; the heartbeat pump must stop polling on
   `monitoring_terminal=true` and must not retry the same attempt. A new
   attempt requires a fresh monitor binding; old pause receipts and cursors
   must not be reused.
9. Start an explicit notification pump when low-latency delivery is required:

   ```bash
   cortex-agent notification pump \
     --project <absolute-project-path> \
     --consumer <consumer-id> \
     --target coordinator:root \
     --adapter codex \
     --watch
   ```

10. On `READY_FOR_REVIEW`, do not ACK automatically. Independently inspect the
    diff, run the validation contract, and verify checkpoint commit, tests,
    and receipt. Only then update the owning Mission, Plan, and
    `task-progress.md`.
11. Notify the user immediately for input-required, blocked, failed, ownership
    conflict, or authority outside the approved scope. The notification MUST
    be emitted at most once per terminal disposition (`attempt_review_ready`,
    `attempt_attention_required`, `attempt_closed`, `attempt_inconsistent`)
    and must be paired with the monitor's `monitoring_terminal=true`
    persistence. Do not repeatedly notify unchanged heartbeats or the same
    terminal disposition.
12. Fenced manual reconciliation (P-005 §5): when an attempt lands in
    `attempt_attention_required` or `attempt_inconsistent`, the coordinator
    may publish a fenced reconciliation only after re-acquiring an
    ownership lease on the same `task:<task-id>` scope with a fresh fencing
    token and binding it to the actor session. The reconciliation MUST walk
    the bounded BLOCKED -> EXECUTING -> TESTING -> READY_FOR_REVIEW
    sequence via the public Task API, and MUST include at least one
    `validation_refs` evidence entry. Stale leases, missing evidence, or any
    non-BLOCKED / non-STALE Task state MUST fail closed without mutating
    the Task or its lease.
13. A foreground `--watch` ends with its Codex task. On resume, restart it or
    use a bounded recurring status check; journaled state remains authoritative.

## Pi receipt boundary

Pi must run as a governed one-shot process. Its receipt may contain only
identifiers, bounded summaries, exit status, timestamps, artifact references,
and SHA-256 digests. It must not contain prompts, responses, credentials,
private sessions, file bodies, or exact token usage.

## .agent Path Authorization (T-AGR-001)

**Scope**: `.agent/` applies only to Cortex-managed projects. Projects without a `.agent/` directory are not managed.

**Managed Project Detection**:
governed launch performs this check before spawning the child:
1. worktree's `.agent/` must exist and be a directory
2. must contain both `rules/` and `workflows/` subdirectories
3. Both satisfied → "managed project"; a private `agentRootGrant` is built with `canonicalAgentRoot` and relative-path operation grants

**Authorization Content**:
- Managed project: private `agentRootGrant` written to `CORTEX_LAUNCH_CONTEXT` only — never to public Task events/receipts
- Unmanaged project: no grant; PreToolUse defers to Claude default

**Automatic Injection**:
- Child process spawn injects `--add-dir=<canonical .agent>` before the `"--"` prompt separator
- Caller-supplied external `--add-dir` values are always rejected

**PreToolUse Gate**:
- Business code paths: deferred
- Shared `.agent/` read/write: denied when no grant
- Bash touching shared `.agent/`: denied by default (runtime updates via Cortex CLI/API)
- Path canonicalizes to nearest existing ancestor (anti-symlink / non-existent file escape)

**Authorization Propagation**:
- Managed parent → child: child's read/write must be subsets of parent's `grant.delegate.{read,write}`
- Parent without delegation: fail closed
- Absolute paths never appear in public events

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
