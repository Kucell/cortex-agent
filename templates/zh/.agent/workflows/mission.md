---
name: mission
description: Orchestrate long-running, multi-milestone work with scoped plans, validation contracts, structured handoffs, command logs, and independent validation.
---

# Mission Lite Workflow (/mission)

Use `/mission` for work that is too large for a single `/start-task` → `/ship` loop: multi-feature changes, multi-day work, or tasks that need milestone validation before advancing.

Do not use Mission Lite for small fixes, single-file edits, or routine documentation updates. Use `/start-task`, `/ship`, `/bug-fix`, or `/handoff` instead.

## Usage

```text
/mission create "migrate auth module"
/mission status M-001
/mission resume M-001
/mission validate M-001 MS-001
```

## State Machine

```text
SCOPE -> PLAN -> CONTRACT -> EXECUTE_FEATURE -> HANDOFF -> RESUME -> VALIDATE_MILESTONE -> FIX_OR_ADVANCE -> COMPLETE
```

## Core Rules

- Code changes are serial by default.
- Parallel work is allowed for read-only research, validation, or documentation only.
- Every milestone must have a validation contract before implementation begins.
- Worker output is not proof. Validators must rely on the contract, diff, command output, runtime evidence, and necessary source files.
- Failed validation creates a follow-up fix task or returns to planning; do not let a Worker self-repair indefinitely.
- Record key commands with exit codes in `command-log.md`.
- Handoff uses the T-C06 dual-artifact protocol: Markdown for humans, JSON for `AGENT_RESUME`, and Artifact Bus `kind: handoff` when available.
- **Commits must follow the `/commit` workflow**: every commit made during a mission (per milestone or at completion) must go through Steps 1–5 of the commit workflow defined in `.agent/workflows/commit.md` — load context, analyze staged changes, generate a Conventional Commits message, get user confirmation, then execute.
- A user choice is durable only when recorded as a resource-bound Decision. `--gate approve`, Dashboard input, prior approval, or silence is not authorization.
- Destructive operations, credential use, and external side effects always require a Decision plus a blocking Waitpoint. Mission never automatically resets, reverts, pushes, deploys, publishes, or accesses credentials.

## Files

Create mission state under:

```text
.agent/missions/M-xxx/
├── mission-plan.md
├── validation-contract.json
├── command-log.md
├── milestones/
│   └── MS-001.md
└── handoffs/
    ├── YYYYMMDD-HHMMSS-{focus}.md
    └── H-YYYYMMDD-HHMMSS-{focus}.json
```

Use these templates when creating files:

```text
.agent/resources/templates/mission/mission-plan.md
.agent/resources/templates/mission/command-log.md
.agent/resources/templates/mission/milestone.md
```

## CREATE

1. Read project instructions and context:
   - `AGENTS.md`
   - `.agent/rules/core-principles.md`
   - `.agent/rules/architecture-design.md`
   - `.agent/rules/task-decomposition.md`
   - `.agent/rules/code-standards.md`
   - `.agent/plans/task-progress.md`
   - `.agent/plans/context-manifest.json` when it exists
2. Confirm the work belongs in Mission Lite:
   - multiple features, multiple milestones, or multi-day scope
   - non-trivial validation requirements
   - cross-agent or cross-session continuation is likely
3. Allocate the next mission ID (`M-001`, `M-002`, ...).
4. Create `.agent/missions/M-xxx/` and child folders.
5. Create `mission-plan.md` from `.agent/resources/templates/mission/mission-plan.md`, then fill:
   - goal
   - non-goals
   - scope boundaries
   - features
   - milestones (use `.agent/resources/templates/task-breakdown.md` to reason about task size, dependencies, and parallel opportunities before finalizing)
   - sequencing
   - risks
   - exit criteria
6. Use the `validation-contract` skill in CREATE mode to write `validation-contract.json`.
7. Create `command-log.md` from `.agent/resources/templates/mission/command-log.md`.
8. Create the first milestone file from `.agent/resources/templates/mission/milestone.md`.
9. Present the mission plan and contract summary for confirmation before implementation.

## STATUS

1. Read `.agent/missions/M-xxx/mission-plan.md`.
2. Read `validation-contract.json`.
3. Read `command-log.md`.
4. Read the latest milestone file under `milestones/`.
5. Report:
   - current state
   - current milestone
   - completed work
   - failed or waived assertions
   - commands run and latest exit codes
   - next recommended action

## RESUME

1. Read project instructions and required rules.
2. Run Runtime Continuity resume bundle:
   ```bash
   PROJECT_NAME=$(basename "$(pwd)")
   node .agent/skills/runtime-continuity/scripts/index.js resume-bundle --project "$PROJECT_NAME"
   ```
3. Read the mission state files.
4. If a JSON handoff exists, run `node .agent/handoffs/scripts/handoff-protocol.js resume-prompt --payload-file <handoff.json>`.
5. Check `git status --short` before changing files.
6. Compare the mission state, handoff payload, Runtime Continuity archive, Artifact Bus state, and current repository state.
7. If stale, report the mismatch and propose a recovery step.
8. Continue from the current state:
   - if no contract exists, return to CONTRACT
   - if a handoff is pending, go to RESUME and follow `next_action`
   - if a blocking Waitpoint exists, go to HUMAN_DECISION and do not continue the protected action
   - if worker output exists but no validation exists, go to VALIDATE_MILESTONE
   - if validation failed, go to FIX_OR_ADVANCE
   - if all milestones passed, go to COMPLETE

## HANDOFF

1. Record a Runtime Continuity checkpoint or archive for the current mission state:
   ```bash
   PROJECT_NAME=$(basename "$(pwd)")
   node .agent/skills/runtime-continuity/scripts/index.js checkpoint \
     --project "$PROJECT_NAME" \
     --gate agent \
     --phase handoff \
     --message "Mission handoff for M-xxx"
   ```
2. Use `/handoff create` semantics to write Markdown and JSON handoff files.
3. Validate the JSON payload:
   ```bash
   node .agent/handoffs/scripts/handoff-protocol.js validate --payload-file .agent/missions/M-xxx/handoffs/H-xxx.json
   ```
4. Publish the JSON payload to Artifact Bus when available:
   ```bash
   node .agent/handoffs/scripts/handoff-protocol.js publish --payload-file .agent/missions/M-xxx/handoffs/H-xxx.json --markdown-path .agent/missions/M-xxx/handoffs/xxx.md --agent-id coordinator
   ```
5. Record the handoff paths and Runtime Continuity event/archive paths in `command-log.md` or the current milestone.
6. Release Progress Locks held by the handing-off agent, or let TTL expire if the agent is unavailable.

## HUMAN_DECISION

When architecture, risk, destructive behavior, credentials, merge/release, or an external side effect requires a human choice:

1. Define the exact protected resource before asking. Use one supported action: `architecture`, `merge`, `release`, `destructive`, `credential`, or `external_side_effect`.
2. Architecture approval uses `type=architecture`, `action=architecture`, and binds `resource_ref` to the exact proposal/artifact revision digest. It never grants destructive or external-side-effect permission; those consequences require separate Decisions.
3. Compute a stable `resource-digest` from the complete resource reference. Include its first 8-12 characters in both the Decision and Waitpoint IDs so changed resources cannot collide with terminal records.
4. Create an open Decision and a blocking Waitpoint owned by `/mission`:

   ```bash
   cortex-agent decisions request --project . \
     --decision-id D-<mission-id>-<choice>-<resource-digest8> \
     --gate mission \
     --type <architecture|risk|approval|merge|release> \
     --requested-by mission-coordinator \
     --prompt "<specific user choice>" \
     --action <architecture|merge|release|destructive|credential|external_side_effect> \
     --resource-ref "<exact-resource-ref>"

   cortex-agent waitpoints create --project . \
     --waitpoint-id WP-<mission-id>-<choice>-<resource-digest8> \
     --gate mission \
     --owner-workflow /mission \
     --reason "<why execution must stop>" \
     --action <same-action> \
     --resource-ref "<same-resource-ref>" \
     --decision-id D-<mission-id>-<choice>-<resource-digest8>
   ```

5. Stop the protected action and direct the user to `/approve decision D-<mission-id>-<choice>-<resource-digest8>`.
6. On resume, recompute the resource and digest, read the Decision, and reject stale, mismatched, rejected, or revision-requested choices.
7. Only `/mission` may release its Waitpoint:

   ```bash
   cortex-agent waitpoints release --project . \
     --waitpoint-id WP-<mission-id>-<choice>-<resource-digest8> \
     --gate owner \
     --owner-workflow /mission \
     --decision-id D-<mission-id>-<choice>-<resource-digest8> \
     --released-by mission-coordinator
   ```

Release authorizes only the exact recorded resource. It does not transfer Task gate ownership. If a milestone reaches a multi-source project integration boundary, report that the project-level Checkpoint integration route is pending approval; do not invoke an unapproved or nonexistent workflow.

## VALIDATE

1. Read `validation-contract.json`.
2. Run `validation-contract` in CHECK mode.
3. Read the relevant diff and command log.
4. Run required commands from blocking assertions when safe.
5. Use runtime evidence templates from `docs/reliability/` for runtime assertions.
6. Write or update `milestones/MS-xxx.md` from `.agent/resources/templates/mission/milestone.md` with:
   - assertions checked
   - evidence
   - command exit codes
   - pass/fail status
   - follow-up fix tasks, if any
7. Move to `FIX_OR_ADVANCE`.

## FIX_OR_ADVANCE

- If blocking assertions failed:
  1. Create a follow-up fix task in `.agent/plans/task-progress.md` or the mission milestone file.
  2. Return to `EXECUTE_FEATURE`.
- If validation passed and more milestones remain:
  1. **Commit milestone changes**: run `/commit` (follow `.agent/workflows/commit.md` Steps 1–5) to commit all staged changes before advancing.
  2. Advance to the next milestone.
  3. Ensure its validation contract exists.
- If all milestones passed:
  1. Move to `COMPLETE`.

## COMPLETE

1. Confirm all milestones passed or have explicit waivers.
2. **Final commit**: if any changes remain unstaged or uncommitted, run `/commit` (follow `.agent/workflows/commit.md` Steps 1–5) before archiving.
3. Archive or preserve mission state:
   - keep `.agent/missions/M-xxx/` while active
   - after completion, move stable summaries to `docs/exec-plans/completed/` when useful
   - do not delete command logs or milestone evidence
4. Run knowledge checks where applicable:
   - `node .agent/skills/knowledge-lint/scripts/index.js`
   - `node .agent/skills/doc-gardening/scripts/index.js`
5. Update `.agent/plans/task-progress.md`.
6. Summarize:
   - mission outcome
   - commits or changed files
   - validation status
   - remaining risks
   - recommended next task

## Quality Bar

- Mission state must be recoverable without prior conversation context.
- Validation contracts must exist before milestone implementation.
- Command logs must include exit codes or a clear reason a command was not run.
- Handoffs must reference existing artifacts by path instead of copying bulky content.
- The workflow must remain template-driven and platform-independent.

## Runtime State Writes

- `CREATE` opens coordinator session `S-<mission-id>` and checkpoints Run `R-<mission-id>` with `phase=planning`.
- `STATUS` and `RESUME` heartbeat the same owner session with the current milestone and activity.
- Milestone execution may use `queues upsert/item --gate mission`; validation records `done` or `blocked` only after contract evidence exists.
- `HANDOFF` pauses the source session through `--gate handoff`; `COMPLETE` closes it through `--gate mission` and completes the Run.
- A read-only query or Dashboard render never performs these transitions.

---

## Mission Worktree 协同补充

当 mission 的多个 milestone 可并行推进时，读取 `.agent/rules/worktree-collaboration.md`，并在 mission plan 中记录：

- milestone 对应的 worktree path / branch / owner agent
- 每个 worktree 的 base commit 和目标合并分支
- handoff、Artifact Bus、locks 的状态引用
- 每个 worktree 的及时提交点
- 合并后的主线验证命令和证据要求

mission 不能只因为子 worktree 验证通过就完成；必须在合并目标 worktree 重新验证后才能推进到 COMPLETE。

## Communication Runtime Integration

`/mission` 通过 HUMAN_DECISION 暴露人类决策但不接管 Task gate ownership：

- 当子任务需要人类裁决时，`decisions request --gate mission` 创建 HUMAN_DECISION，绑定 `resource-digest` 与 `relations.mission_ids`。
- 立即 `waitpoints create --owner-workflow /mission --reason "Mission decision required" --action <merge|release|risk> --resource-ref <resource>` 阻塞后续推进。
- 用户通过 `decisions resolve --gate user` 批准后，`/mission` 调用 `waitpoints release --gate owner` 解锁下游 run。
- `/mission` 不转移 Task gate ownership —— Task Pipeline 仍由 `/start-task`、`/ship` 等 owning workflow 持有；mission 只暴露与消费决策。
- Checkpoint 状态挂在 Decision / Waitpoint 的 relations 上，pending approval 时标记 `Checkpoint`，其余 run 仍可推进到不依赖该决策的位置。
