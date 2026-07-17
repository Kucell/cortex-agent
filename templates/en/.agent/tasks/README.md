# Task Pipeline

`.agent/tasks/` stores durable, machine-readable task contracts. It complements rather than replaces `.agent/plans/task-progress.md`: the plan remains the human roadmap, while each `<task-id>.json` records the task stage, gate evidence, dependencies, and artifact references.

## Layout

```text
.agent/tasks/
├── README.md
├── index.json
├── index.schema.json
├── task.schema.json
└── <task-id>.json
```

`index.json` is a compact discovery index. The task file is authoritative for pipeline state. Workflows that create or update a task must update both files atomically when practical and must not infer that a missing task file means the roadmap task is complete.

## Stages And Gates

The only forward stage order is:

```text
draft -> spec -> plan -> implement -> validate -> review -> done
```

| Transition | Owning workflow | Gate requirements |
| :--- | :--- | :--- |
| `draft -> spec` | `/plan` or `/arch-design` | Title, description, acceptance criteria, priority, dependencies, and source references are recorded. |
| `spec -> plan` | `/plan` | A final `spec` artifact and a final `plan` artifact exist; architecture-impacting tasks also have a final, user-approved `architecture` artifact. |
| `plan -> implement` | `/start-task` | Dependencies are at `done`; required plan and architecture artifacts are final; writable scope and validation commands are known. |
| `implement -> validate` | `/ship` | A final `implementation` artifact references an existing Artifact Bus envelope or execution-report file whose payload records the implementation diff, commits, and changed paths. |
| `validate -> review` | `/ship` | A final `validation` artifact records commands and passing evidence. Failed validation blocks the transition. |
| `review -> done` | `/ship` | A final `review` artifact has no blocking findings. `--no-review` requires an explicit user choice and a `waived` gate with the reason recorded. Conditional release-note and published-doc requirements are satisfied or `/ship` records the not-applicable decision in the gate `reason` and cites final `decision` evidence; the whole gate is not waived. |

Stages never move backward. A failed check leaves the current stage unchanged and marks the target gate `blocked`; remediation appends new artifacts and rechecks the same gate. Correction of an accidental stage write requires explicit user approval and a recorded reason. `status = blocked` does not change `stage`.

Only the workflow named in the table may mark its gate `passed` or `waived`. Read-only queries and dashboards may report gate state but must not advance it. Future decision/waitpoint support may add approval evidence without changing this ownership rule.

## Artifact Kinds

Task files contain references, not artifact bodies. Artifact payloads remain append-only under `.agent/artifacts/<task-id>/` or in another existing source-of-truth file.

| Kind | Meaning | Existing Artifact Bus envelope |
| :--- | :--- | :--- |
| `spec` | Scope, acceptance criteria, and constraints | `plan` |
| `architecture` | Approved architecture proposal or decision-ready design | `plan` |
| `plan` | Executable steps, dependencies, and validation commands | `plan` |
| `implementation` | Diff, commit, execution report, or changed-path evidence | `execution` |
| `validation` | Test, lint, security, or manual validation evidence | `validation` |
| `review` | Architecture or code review verdict | `review` |
| `decision` | Explicit human or architecture decision | `note` until the decision store exists |
| `learning` | Reusable verified learning | `note` |
| `handoff` | Ownership transfer and resume context | `handoff` |
| `release-note` | User-visible delivery summary | `note` |
| `published-doc` | Published docs paths and verification evidence | `note` |

When the current Artifact Bus lacks the canonical kind, use the mapped envelope kind and put the canonical value in `payload.artifact_kind`. The task's `artifacts[].kind` always uses the canonical value above. This compatibility rule avoids changing existing Artifact Bus readers.

An artifact satisfies a gate only when its task entry has `status: "final"`, its referenced file exists, and the gate lists that reference in `evidence_refs`. Commit IDs, diff summaries, and changed paths belong inside an Artifact Bus envelope or execution-report payload; they are not valid task artifact `ref` values by themselves. Superseded artifacts remain traceable but never satisfy a new gate.

## Write Rules

- `/plan` creates task files and advances them through `spec` to `plan` after the corresponding artifacts are final.
- `/arch-design` appends an `architecture` artifact; user approval is required before it is final or used by a gate.
- `/start-task` is the only workflow that may pass or block `plan -> implement`; it must do so before implementation edits begin.
- `/ship` owns `implement -> validate`, `validate -> review`, and `review -> done`, including completion-gate evidence and conditional not-applicable decisions.
- `/publish-docs` consumes only final artifacts and returns either a final `published-doc` envelope reference or failure evidence. It does not mutate the task record or completion gate; `/ship` validates and records the returned reference.
- Preserve timestamps in UTC ISO 8601 form and update `updated_at` after every task mutation.
- Do not copy full proposals, diffs, logs, prompts, credentials, or generated docs into task JSON.
- Do not mutate task records through Management API until an explicit task write gate is added there.
