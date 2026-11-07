---
title: "Runtime Artifact Location"
description: 'Classify every script, log, and output by lifetime. Cross-command, review, or handoff artifacts belong under .agent/; process-local scratch may use the OS temp directory only when it is deleted and verified within the same top-level command.'
type: rule
scope: L1
applicable_to:
  - all
linked_workflows: []
linked_skills: []
owner: Kucell
last_verified: 2026-11-07
status: stable
linked_decisions: ["D-OKF-001"]
---

# Runtime Artifact Location

> **Core rule**: choose a script, log, or output's location by its lifetime. If it
> must survive the producing process, or will be read by another command, reviewer,
> handoff, or task, it belongs under the project's `.agent/` directory. The OS temp
> directory is reserved for process plumbing that is deleted and verified within the
> same top-level command.
>
> **Cross-command means durable**: creating a script with `apply_patch`, recording its
> path for a later command, or letting another agent read its output crosses that
> boundary. Such files must not live in `/tmp`, `os.tmpdir()`, `%TEMP%`, or `$TMPDIR`.

Three questions determine the answer; the filename alone does not:

1. Must it survive after the current process or top-level command ends?
2. Will another command, reviewer, agent, or resumed task read it?
3. Is it a reusable probe, measurement, or delivery asset?

If any answer is yes, use the `.agent/` lifecycle table below.

---

## Lifetime and destination

| Lifetime / use | Location | Closeout requirement |
|---|---|---|
| Valid only while one process or top-level command runs | OS temp directory | Delete and verify absence in the same command |
| Needed across commands or for short review, but not durable evidence | `.agent/debug/temp/<task>-<run-id>/` | Keep a file inventory and retention condition |
| Reusable across tasks | `.agent/skills/<skill>/scripts/` | Provide an entry point and tests |
| Mission-specific tool or long-lived evidence | `.agent/missions/<id>/scripts/` or `evidence/` | Bind to source identity and verification result |
| Machine-readable summary for another agent | `.agent/artifacts/` | Keep compact references, hashes, and payloads |

Do not evade the rule by renaming a directory to `temp`, `scratch`, or `debug`.
Lifetime and consumer determine placement.

---

## Why .agent/ and not /tmp

/tmp is a scratch space with a short life: the OS reaps it, a session teardown
clears it, and a container restart wipes it. An artifact that a later session, a
teammate, or an independent reviewer needs to read must therefore not live there.

.agent/ is the project persistent, project-scoped state directory. An artifact
written there:

1. **Survives session and host changes** — switching from Codex to Claude to Qoder
   does not lose it, because it travels with the project.
2. **Is discoverable** — the location is predictable, so the next session knows
   where to look without being told.
3. **Is reviewable** — it can be committed, diffed, and audited, or deliberately
   excluded by an explicit, reviewable decision rather than by accident.

Whether .agent/ itself is committed is a separate, per-project decision
(`cortex-agent track` / `cortex-agent untrack`). This rule is about *where the
artifact lives*, not about whether the directory is under version control: an
artifact in .agent/ is reachable across sessions either way, and an artifact in
/tmp is not.

The same applies to **scripts**: a probe, a fixture generator, or a one-off
measurement script is a reusable asset, not scratch. Write it under .agent/
next to the artifacts it produces, so the next person can re-run it.

---

## Where things go

    .agent/
    ├── runtime-evidence/          # feature-produced runtime state
    │   └── <feature>/<id>.<ext>   # per-run output, per-sample observations
    ├── debug/                     # AI debug artifacts (not feature state)
    │   ├── screenshots/           # UI screenshots
    │   ├── logs/                  # temporary server / browser / command logs
    │   └── temp/                  # scratch JSON, probe output
    ├── missions/<mission-id>/
    │   ├── evidence/              # long-lived verification evidence
    │   └── scripts/               # reusable probe / measurement scripts
    ├── skills/<skill>/runs/       # a skill own per-run output
    └── metrics/                   # health / self-check snapshots

### Choosing a directory

| Situation | Path | Example |
| :--- | :--- | :--- |
| Feature runtime state (per-run, per-sample) | .agent/runtime-evidence/<feature>/<id>.<ext> | .agent/runtime-evidence/telemetry/run-20261028.jsonl |
| AI debug output (screenshots, scratch, logs) | .agent/debug/<subdir>/ | .agent/debug/screenshots/login-error-20261028.png |
| Evidence tied to a mission | .agent/missions/<id>/evidence/ | .agent/missions/M-025/evidence/P-008-attempt.json |
| A reusable probe or measurement script | .agent/missions/<id>/scripts/ or .agent/skills/<skill>/scripts/ | .agent/missions/M-044/scripts/acl-win/privilege-probe.ps1 |
| A skill own per-run output | .agent/skills/<skill>/runs/ | .agent/skills/retrieval-trajectory/runs/T-DEMO-001.jsonl |

If no existing directory fits, create .agent/runtime-evidence/<feature-slug>/.
Do **not** create a new top-level directory outside .agent/.

---

## Naming

Use <run-id-or-sample-id>.<ext>:

- <run-id>: R-<yyyyMMdd>-<short-uuid>, or a feature-defined stable id
  (pipeline-20261028-174532).
- <sample-id>: the natural stable id of the sample (assessment id, receipt id),
  so records correlate across runs.
- Scripts: kebab-case, describing what they measure
  (privilege-context-probe.ps1, probe-07-toctou-and-pin.cjs).

---

## What not to do

- ❌ **Do not write runtime artifacts or scripts to /tmp** (or os.tmpdir(),
  %TEMP%, $TMPDIR). They are reclaimed by the system and lost with the session.
- ❌ **Do not write them to the project root.** It pollutes git status and makes
  them invisible to the next session.
- ❌ **Do not write them to ~/.agent/ or ~/.cache/.** Those are host-private
  caches; they do not travel with the project.
- ❌ **Do not add runtime artifacts to .agent/.gitignore.** That deletes them from
  the project state directory. If a directory is too noisy, use a retention
  policy or size-based archive, and make that choice explicit.
- ❌ **Do not treat .agent/debug/ as release evidence.** Long-lived evidence
  belongs in .agent/missions/<id>/evidence/ or the project documentation assets.

### Cross-command boundary

A top-level command is one indivisible host invocation, including synchronous child
processes in its process tree. The boundary has been crossed when:

- `apply_patch`, `Write`, or `Edit` creates a file and a later tool command uses it;
- command A creates a script or output and command B reads, uploads, forwards, or
  updates it by absolute path;
- shell redirection, `tee`, `cp`, `mv`, or a program argument writes to a temp path
  but cleanup happens in another command;
- a temp path is persisted in task progress, a handoff, README, configuration, or
  another durable document.

Cross-command material must be created under `.agent/` directly. For a probe or output
needed briefly for review, use `.agent/debug/temp/<task>-<run-id>/` and record each
file's purpose and retention condition in `inventory.json`.

### Single-command process plumbing

Process plumbing may use the OS temp directory only when all of these hold:

- its lifetime is bounded by a provable cleanup path in the same top-level command;
- `trap`, `finally`, or an equivalent mechanism cleans up on success, failure, and
  interruption;
- absence is verified before the command returns;
- the path is not written into durable documentation, configuration, or a variable
  table consumed by another command.

Examples are a child-process context file (mode `0600`), a throwaway compile directory,
and a fixture created and removed inside one test case. A PowerShell, Python, Node, or
shell probe reused across commands is not process plumbing.

### Task closeout

Before a task is complete, inventory every temp path created by the run and classify it
as one of:

- `deleted`: removed and verified absent;
- `promoted`: moved under `.agent/debug/temp/` or a longer-lived destination and all
  references updated;
- `owned_by_live_process`: still used by a named running process, with the process and
  retention condition recorded.

Any unclassified path makes the closeout `TEMP_ARTIFACT_CLOSEOUT_INCOMPLETE`. "Will clean
later" is not a completed state.

---

## Fixing a violation

If an artifact or script was written to the wrong place:

1. Create the correct directory under .agent/.
2. Move the source script output path (usually one or two
   path.join(root, ...) calls) and its input path.
3. Update the test expected path.
4. git mv the old files to preserve history.
5. Re-run the tests, then land the change on its own.

Do **not** fix this by adding a .gitignore entry — that hides the symptom and
leaves the artifact lost.

---

## Mechanical check

`pnpm check:runtime-artifact-location` scans the L1 templates, skills, workflows, and
framework code for writes that may place artifacts in a temp directory. It recognizes
the Node write APIs, `apply_patch` `Add/Update File` targets, shell redirection,
`tee`, `cp`, `mv`, and common `--output` arguments. A form whose lifecycle cannot be
proved fails closed; the author must choose an explicit `.agent/` destination or add a
documented exception.

When a host exposes a Stop event, use it to inventory the run's temp paths and record
`deleted`, `promoted`, or `owned_by_live_process` for each one. If the host has no
blocking Stop gate, the same closeout remains a task-completion requirement and the
result must be reported explicitly.

---

## Cross-references

- .agent/rules/ai-debug-artifacts.md — the dedicated .agent/debug/ space for
  AI debug output that is not feature state.
- .agent/rules/runtime-state-integration.md — the contract every stateful
  feature must satisfy, including where its evidence lives.
- .agent/rules/core-principles.md — the summary line that points here.
