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
   - `.agent/rules/code-standards.md`
   - `.agent/plans/task-progress.md`
   - `.agent/plans/context-manifest.json` when it exists
   - If `--from-proposal <path>` was passed: read the specified proposal file and use its Phase list as the milestone input source
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
   - features (if from a proposal, map from the proposal's Phase list)
   - milestones (if from a proposal, one milestone per Phase)
   - sequencing
   - risks
   - exit criteria
   - if from a proposal, add to the header: `> **Source Proposal**: <proposal-file-path>`
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
2. Read the mission state files.
3. If a JSON handoff exists, run `node .agent/handoffs/scripts/handoff-protocol.js resume-prompt --payload-file <handoff.json>`.
4. Check `git status --short` before changing files.
5. Compare the mission state, handoff payload, Artifact Bus state, and current repository state.
6. If stale, report the mismatch and propose a recovery step.
7. Continue from the current state:
   - if no contract exists, return to CONTRACT
   - if a handoff is pending, go to RESUME and follow `next_action`
   - if worker output exists but no validation exists, go to VALIDATE_MILESTONE
   - if validation failed, go to FIX_OR_ADVANCE
   - if all milestones passed, go to COMPLETE

## HANDOFF

1. Use `/handoff create` semantics to write Markdown and JSON handoff files.
2. Validate the JSON payload:
   ```bash
   node .agent/handoffs/scripts/handoff-protocol.js validate --payload-file .agent/missions/M-xxx/handoffs/H-xxx.json
   ```
3. Publish the JSON payload to Artifact Bus when available:
   ```bash
   node .agent/handoffs/scripts/handoff-protocol.js publish --payload-file .agent/missions/M-xxx/handoffs/H-xxx.json --markdown-path .agent/missions/M-xxx/handoffs/xxx.md --agent-id coordinator
   ```
4. Record the handoff paths in `command-log.md` or the current milestone.
5. Release Progress Locks held by the handing-off agent, or let TTL expire if the agent is unavailable.

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
  1. Advance to the next milestone.
  2. Ensure its validation contract exists.
- If all milestones passed:
  1. Move to `COMPLETE`.

## COMPLETE

1. Confirm all milestones passed or have explicit waivers.
2. Archive or preserve mission state:
   - keep `.agent/missions/M-xxx/` while active
   - after completion, move stable summaries to `docs/exec-plans/completed/` when useful
   - do not delete command logs or milestone evidence
3. Run knowledge checks where applicable:
   - `node .agent/skills/knowledge-lint/scripts/index.js`
   - `node .agent/skills/doc-gardening/scripts/index.js`
4. Update `.agent/plans/task-progress.md`.
5. **Proposal archiving** (if `mission-plan.md` has a `Source Proposal` field):
   1. Read the source proposal file.
   2. Prompt the user to distill the architecture output into a clean architecture document and write it to `docs/architecture/<topic>.md`.
   3. Back-fill the proposal file header:
      ```markdown
      > **Status**: done
      > **Archived Doc**: docs/architecture/<topic>.md
      ```
   4. Output: "📚 Architecture design archived to docs/architecture/<topic>.md — proposal status → done."
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
