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

- At mission create/resume/run boundaries, call `cortex-agent dashboard ensure --project . --reason mission`; it is a no-op unless the project explicitly enabled automation.
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

### 5.5 Link the binding branch (MS-003)

Read `git rev-parse --abbrev-ref HEAD` and look it up in `.agent/branches/registry.json`:

- If the current branch is a named branch (`feat/<slug>` / `fix/<slug>` / etc.) and the registry has a matching entry:
  - Prepend a `Branch: <branch-name>` line to `mission-plan.md` for bidirectional mission ↔ branch linking
  - Write the new Mission ID into the registry entry's `mission_id` field via `updateBranch` (the CLI's `branch sync` does not mutate `mission_id`; a small helper or direct registry write is needed)
  - One-liner:
    ```bash
    current_branch=$(git rev-parse --abbrev-ref HEAD)
    if cortex-agent branch show "$current_branch" --json >/dev/null 2>&1; then
      sed -i.bak "1a\\
    Branch: ${current_branch}
    " .agent/missions/M-xxx/mission-plan.md
    fi
    ```
- If the current branch is not in the registry (ad-hoc mission / not in a proposal context) → skip silently, no error
- Idempotent: if `mission-plan.md` already has a `Branch:` line, keep the existing value (do not overwrite)

### Mark `merge_ready` after a successful VALIDATE (MS-003)

After `/mission validate M-xxx MS-xxx` passes, if the mission is bound to a named branch (Step 5.5 wrote `mission_id`), call `branch ready` to mark the branch as merge-eligible:

```bash
cortex-agent branch ready <current-branch> \
  --validation-artifact .agent/missions/M-xxx/milestones/MS-xxx.md
```

- Expected exit 0; the registry entry's status flips from `active` to `merge_ready`
- Gate 1 (working tree clean) must pass; if the mission ends with unstaged changes, commit first
- Gate 2 (`commits_ahead >= 0`) must pass; if behind, run `branch sync` once
- Gate 3 (validation artifact exists) must pass; the milestone file must be on disk
- On `/mission COMPLETE`, prompt the user to run `cortex-agent branch merge <current-branch> --to main`

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

## Recording Points

`/mission` owns activity at every state transition. Record an event after milestone state changes and a delivery receipt after validation contract execution:

```bash
# After a milestone transition (PLAN -> CONTRACT, EXECUTE -> VALIDATE, etc.)
node .agent/skills/activity-recording/scripts/index.js record-event \
  --kind coordination \
  --source /mission \
  --summary "Mission <MISSION_ID> milestone <MS-XXX> -> <next-state>" \
  --actor-type workflow \
  --actor-id /mission \
  --dedupe-key "mission:<MISSION_ID>:<MS-XXX>:transition"

# After validation contract execution
node .agent/skills/activity-recording/scripts/index.js record-receipt \
  --kind delivery \
  --source /mission \
  --activity-refs ACT-mission-<MISSION_ID>-<MS-XXX>-validate \
  --availability available \
  --redaction not_applicable \
  --dedupe-key "mission:<MISSION_ID>:<MS-XXX>:validate:receipt"
```

If the helper is missing or recording is unavailable, continue with the legacy workflow behavior and skip the call. Do not invent receipts.
