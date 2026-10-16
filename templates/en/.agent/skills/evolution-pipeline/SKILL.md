---
name: evolution-pipeline
description: Explicit project-local archive intake and immutable, metadata-only learning proposals. No automatic memory updates or Host invocation.
area: agent-tuning
summary: Opt-in archive proposal queue with scoped deduplication and replay-safe immutable files.
---

# Archive Learning Proposals

## Scope

A manual session archive may opt in to a project-local proposal queue. Without
the flag, archive behavior is unchanged. The automatic continuity guard never
enables this option.

This path records source references, SHA-256 digests, observation counts and
generic verification reminders. It does not copy archive text into a proposal.
The archive remains private to the selected project. No model is invoked, no
memory/index is updated, and no Task or execution permission is created.

## Commands

Run only within the explicitly selected project and scope:

```sh
cortex-agent session archive --project <name> --gate user --queue-learning-proposal
node .agent/skills/evolution-pipeline/scripts/evolve.js --enqueue --archive <archive-id> --project <name> --proposal-only
node .agent/skills/evolution-pipeline/scripts/evolve.js --worker --once --proposal-only
node .agent/skills/evolution-pipeline/scripts/evolve.js --replay <EVO-P-id> --proposal-only
```

Proposal-only list/status inspect only reserved EVO-P- records; they do not read
legacy queue/dead-letter objects. --enqueue-from-latest, --dead-letter and --loop
are deliberately unsupported in this mode; specify one archive explicitly.

Add --dry-run to proposal enqueue or the one-shot worker for a read-only preview.
A preview allocates no queue record. Proposal replay and polling do not support
--dry-run; the proposal-only worker requires --once.

CLI flags are request inputs, not proof of owner, consent, approval or effect
admission. Real project execution and framework promotion require their own
workflow gates.

## Persistence and replay

- Queue: .agent/tasks/evolution/EVO-P-<digest>.json
- Proposal: .agent/tasks/evolution/_proposals/EVO-P-<digest>.json
- The key includes project name, a digest of the current canonical workspace
  path, archive ID and the SHA-256 of exact archive bytes.
- Queue inputs and proposal outputs are immutable. Identical replay verifies
  existing bytes without rewriting them. Conflicting records fail closed.
- A changed archive creates a new key. Copying an old task to another workspace
  cannot reuse its identity. A workspace move requires fresh intake.
- Complete files are published with create-if-absent hard links. A process exit
  before publication can leave an ignored .tmp. An exit between publishing the
  hard link and unlinking the temporary name leaves a multi-link record that is
  preserved and blocked for explicit repair; replay never guesses ownership or
  deletes old temporary links. Ordinary replay resumes only single-link records.
  This is not distributed fencing or a claim of power-loss durability.
- Stored queue status remains pending. The list/worker reads the verified
  proposal receipt to derive proposal_only; changed sources or conflicts derive
  blocked. These statuses never mean verification passed or authority granted.

Archive success is preserved if optional proposal intake fails. The archive
response reports learning_proposal.status as unavailable; it does not erase the
archive or silently retry against another project.

## Existing legacy worker

The legacy deterministic memory writer remains a separate explicit workflow.
Its older queue entries are excluded by --worker --once --proposal-only.
New archive proposal entries cannot fall through to legacy memory/index writes
or legacy replay mutation. Do not treat keyword classification as AI reasoning,
a verified learning outcome, or a governed automatic effect.

## Evidence boundary

Temporary-directory tests cover the actual archive API and library session
facade, one-shot worker, default-off behavior, scoped deduplication, independent
process races, process-exit recovery/blocked states, source conflicts and zero-write previews.
The fixture preload intercepts common Node network APIs before module loading
and bounds child processes. It is an in-process test guard, not OS-level network
isolation. These tests establish local file integration only. They do not establish two
heterogeneous L2 projects, a real AI Host, or SelfEvolutionE2E acceptance.
