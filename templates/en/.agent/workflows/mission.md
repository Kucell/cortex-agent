---
name: mission
description: Coordinate durable multi-milestone work with resumable state, independent validation, and explicit human Decisions.
---

# Mission Workflow (/mission)

Use Mission for work spanning multiple phases, sessions, or independent validation gates.

## Commands

```text
/mission create --from-proposal <path>
/mission status <mission-id>
/mission run <mission-id>
/mission validate <mission-id> <milestone-id>
/mission resume <mission-id>
```

Mission state lives under `.agent/missions/<mission-id>/` and includes `mission-plan.md`, `command-log.md`, milestone files, and a validation contract. Use the provided resource templates when creating these files.

## Operating Rules

- Every milestone has explicit acceptance criteria, validation evidence, dependencies, and an owner.
- Read-only research, validation, and documentation may run in parallel. Mutating work requires non-overlapping ownership, locks, Queue/Run/Session state, and a handoff plan.
- A user choice is durable only as a resource-bound Decision. `--gate approve`, Dashboard input, prior approval, or silence is not authorization.
- Destructive operations, credentials, and external side effects always require a Decision plus blocking Waitpoint. Mission never automatically resets, reverts, pushes, deploys, publishes, or accesses credentials.

## State Machine

```text
CREATE -> PLAN -> DISPATCH -> EXECUTE -> VALIDATE -> COMPLETE
                     |          |           |
                     +-> RESUME +-> HUMAN_DECISION
```

On every resume, first run `node .agent/skills/runtime-continuity/scripts/index.js resume-bundle --project "$(basename "$(pwd)")"`, then read the mission plan, active milestone, command log, Task/Run/Queue/Session state, locks, handoffs, Decisions, and Waitpoints. If a blocking Waitpoint exists, enter `HUMAN_DECISION` and stop the protected action.

## CREATE and PLAN

1. Read the approved proposal and verify scope.
2. Generate a stable Mission ID and create the mission directory from templates.
3. Decompose the proposal into ordered milestones with acceptance criteria and explicit dependencies.
4. Define the validation contract before implementation, including commands, independent validator expectations, required artifacts, and failure behavior.
5. Mark safe parallel opportunities and exclusive write scopes.

## DISPATCH and EXECUTE

Create Task, Run, Queue, Session, lock, Runtime Continuity checkpoint, and handoff records through their owning APIs. Keep one coordinator owner for mission transitions. Checkpoint meaningful phase changes; never infer progress from chat alone.

## VALIDATE

Run the milestone's declared commands and independent semantic review. Record exact command, exit code, evidence refs, validator, and conclusion. A passing command without semantic acceptance evidence is insufficient. Failed validation keeps the milestone blocked and records the repair path.

## HUMAN_DECISION

1. Define the exact protected resource and select one supported action: `architecture`, `merge`, `release`, `destructive`, `credential`, or `external_side_effect`.
2. Architecture approval uses `type=architecture`, `action=architecture`, and the exact proposal/artifact revision digest. It never authorizes destructive or external effects.
3. Compute a stable resource digest and include its first 8-12 characters in both IDs.
4. Create an open Decision and blocking Waitpoint owned by `/mission`:

   ```bash
   cortex-agent decisions request --project . \
     --decision-id D-<mission-id>-<choice>-<resource-digest8> \
     --gate mission \
     --payload-json '{"type":"<type>","requested_by":"/mission","prompt":"<explicit choice>","options":["approve","reject","revise"],"gate":{"action":"<architecture|merge|release|destructive|credential|external_side_effect>","resource_ref":"<exact-resource-ref>"}}'

   cortex-agent waitpoints create --project . \
     --waitpoint-id WP-<mission-id>-<choice>-<resource-digest8> \
     --gate mission \
     --owner-workflow /mission \
     --reason "<why human choice is required>" \
     --action <same-action> \
     --resource-ref "<same-resource-ref>" \
     --decision-id D-<mission-id>-<choice>-<resource-digest8>
   ```

5. Stop and direct the user to `/approve decision D-<mission-id>-<choice>-<resource-digest8>`.
6. On resume, recompute the resource and reject stale, mismatched, rejected, or revision-requested Decisions.
7. Only `/mission` may release its Waitpoint:

   ```bash
   cortex-agent waitpoints release --project . \
     --waitpoint-id WP-<mission-id>-<choice>-<resource-digest8> \
     --gate owner \
     --owner-workflow /mission \
     --decision-id D-<mission-id>-<choice>-<resource-digest8> \
     --released-by /mission
   ```

Release authorizes only the exact recorded resource and does not transfer Task gate ownership.

## COMPLETE and Future Routing

Complete only when every milestone and validation gate passes, required artifacts exist, and the mission record contains final evidence. At a multi-source project integration boundary, report that the project-level Checkpoint integration route is pending approval. Do not name or invoke an unapproved or nonexistent workflow.

Dashboard and read-only queries never perform Mission transitions, resolve Decisions, or release Waitpoints.
