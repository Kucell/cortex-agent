---
title: "Runtime Artifact Location"
description: '> All runtime artifacts produced by a cortex-agent-managed project — logs, probe scripts, per-run output, observations, scratch JSON — must live under the project .agent/ directory, never in /tmp, the home directory, or the project root.'
type: rule
scope: L1
applicable_to:
  - all
linked_workflows: []
linked_skills: []
owner: Kucell
last_verified: 2026-10-28
status: stable
linked_decisions: ["D-OKF-001"]
---

# Runtime Artifact Location

> **Core rule**: in a project managed by cortex-agent, everything the agent produces while
> running, debugging, or investigating — logs, probe scripts, per-run output,
> observations, scratch JSON, screenshots — belongs under the project .agent/
> directory. It does **not** belong in /tmp, the home directory, or the project root.

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

### The one legitimate exception

Short-lived **process plumbing** may use the OS temp directory, provided it is
genuinely ephemeral and holds nothing that must survive the process:

- a private context file passed to a child process and deleted right after;
- a scratch build directory for a throwaway compile;
- a test fixture directory created and removed inside a single test case.

The test is simple: **if the artifact has value after the process exits, it
belongs under .agent/.** A secret-bearing context file also belongs nowhere
persistent — it must be mode 0600 and removed on completion, which is why it is
not a runtime artifact but process plumbing.

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

## Cross-references

- .agent/rules/ai-debug-artifacts.md — the dedicated .agent/debug/ space for
  AI debug output that is not feature state.
- .agent/rules/runtime-state-integration.md — the contract every stateful
  feature must satisfy, including where its evidence lives.
- .agent/rules/core-principles.md — the summary line that points here.
