# Bound Task gap report

The package-owned read-only diagnostic is available through:

    cortex-agent query next-action [--project <path>] [--task <T-id> ...]

The same path is exposed by the existing local SDK:

    createLocalCortexClient(ctx).management.query("next-action", { task: "T-id" })

This first implementation delivers a sourced Task diagnostic. It does not complete
the C-lane ready-candidate/actual-binding acceptance. Its observed Tasks currently
remain INSUFFICIENT_EVIDENCE because scope, Mission relation, budget, approval pair,
live ownership, current product CI/review and Host evidence have no reviewed
canonical mapping in this entry point. execution_authorized is always false.

## Read boundary

The exact bin route is selected before eager command/Host modules load. Only
--project and --task are accepted. Bad flags, help flags (there is no existing
query help contract), extra words and multiple project selectors fail with status
2 before adapter/project reads. Other command spellings retain the legacy
dispatcher. The existing management query formatter, SDK facade and local
transport remain the output path. A capability lookup for this exact CLI route
returns the package-owned projection before any project management script spawn.

The descriptor is a bounded, regular, single-link, no-follow local UTF-8 file.
It supplies project identity and an explicit local Git locator/ref. It is recorded
as a binding observation, not a same-commit canonical project proof. The project
source remains not_observed. No caller may supply sources, proof, Host, lease,
scope, decision, waitpoint or revision objects through query filters.

A package-owned read-only Git adapter supplies the original canonical Task reader.
It uses rev-parse, ls-tree and cat-file only, with fixed per-child environment,
5-second child timeout and 1 MiB + 1 output bound. Lazy fetch and replace objects
are disabled by both Git flags and environment; all transports are denied.
Only regular Git blob modes 100644/100755 and valid bounded UTF-8 are accepted.
The existing global GitGovernanceStore is unchanged. Unsupported Git safety flags
produce an unavailable source (or explicit project-discovery error), without an
ordinary-read fallback. This requires Git supporting --no-lazy-fetch and
--no-replace-objects. These capabilities are tested rather than inferred from a
version string. Local PATH still selects the installed Git executable; this is
not an adversarial executable sandbox.

The locator must identify the actual worktree top-level, or the actual git-dir of
an explicit bare repository. It cannot inherit a repository from an ancestor
folder. Git-dir/worktree identity is pinned and checked on every revision read.
Task/index reads use one typed governance commit token. The adapter rechecks the
descriptor digest, canonical project/agent/repository paths and ref after reading.
Changed bindings/ref discard every recommendation. The observation is a bounded
read-time consistency check, not a lease, fence or guarantee against changes
after return. Filesystem bindings, remote locators, missing binding and unreadable
sources are explicit gaps. No CoordinationApplicationService.getTask/listTasks
or recoverSnapshot path is used.

## Focused evidence

    node --test tests/next-action/bound-query.test.js

The 30 cases run the actual bin entrypoint and actual local SDK, with all fixtures
in new temporary directories. Before/after snapshots include every file content,
mode and mtime plus directory entries and mtime. A preload audits the exact source
closure, instruments common network APIs, blocks non-allowlisted child operations and
rejects the reviewed filesystem write APIs. The subprocess environment is an explicit whitelist
without inherited Host CLI, NODE_OPTIONS or NODE_PATH. This is audited
instrumentation, not OS network/filesystem isolation.

The near-miss spelling case stops at the unchanged legacy-dispatch module boundary;
it does not claim the full legacy command closure was run. Ref/binding race cases
perform one labeled fixture-side mutation and permit only its expected changed
paths; query write attempts remain zero. They do not claim that the entire fixture
was unchanged during the adversarial mutation. Partial-clone coverage uses only a
local synthetic promisor repository, with no network target. Replace-ref coverage
uses two local fixture commits.

The package retains its existing Node >=16 declaration. Added source uses APIs
available on that baseline; the focused node:test harness is for Node 18/22/24.
Node 16 execution is not covered by that harness. Unsupported O_NOFOLLOW or
O_NONBLOCK semantics fail closed rather than reading an unsafe descriptor.

## Next canonical mapping, proposed only

Existing paths that can be reused as read sources are:
- tasks/<task_id>.json and tasks/index.json (the current minimal Task projection)
- missions/<mission_id>/mission-plan.md, validation-contract.json and milestone
  files (Mission Lite's existing owner-workflow directory); the Mission JSON
  schema describes a structured summary, but a canonical summary path/registry
  still needs to be established rather than guessed
- decisions/<decision_id>.json and waitpoints/<waitpoint_id>.json (canonical paired
  gate records with action/resource and Task/Mission relations)

The current Task schema has no authoritative Mission/scope/budget/plan-digest
link. Neither dispatch-plan.schema.json nor orchestration-plan.schema.json can
fill this gap: they describe read-only derived plans, omit a canonical
project/Task/Mission/scope/digest/validity contract, and cannot grant authority.
lib/dispatch/plan.js also builds synthetic Host/lease defaults; it is not a source
for this diagnostic. No name-based Mission inference is acceptable.

The minimum next proposal is one versioned, canonical plan artifact owned by the
existing plan workflow, stored beside its canonical Task/Mission records in the
same governance revision. A new structured artifact beside the existing Mission
Lite plan (for example missions/<mission_id>/advisory-plan.json) is a design
proposal only, not created or read by this implementation. It needs:
- explicit project_id, task_id, mission_id and plan_id, all resolvable and unique;
- repository identity, product commit, branch, allowed paths/operations, operation
  and effect-sink identity, risk and required Host capabilities;
- exact validation commands, bounded budget with unit/source, stop conditions,
  created_at/expires_at and an external digest over canonical plan bytes (no
  self-referential in-file digest);
- the expected gate action/resource_ref/owner_workflow and explicit Decision and
  Waitpoint references, whose Task/Mission relations must match this artifact.

The current pure advisor pairedGate consumes a flat DTO and requires a Decision
expires_at field that the real canonical schema does not provide. A separately
reviewed canonical pair adapter and corresponding pure advisor change are needed;
a loader must not manufacture the missing DTO field merely to obtain ADVICE_READY.
The future reader must validate the real canonical schemas, unique references
and identical revision, then compare the pair using its actual fields. Decision
does not have expires_at: do not copy Waitpoint expiry into it. Plan validity,
Decision resolution and Waitpoint expiry/release remain separate facts. Reuse of
the D-lane strict pair validator should be a reviewed pure read adapter, without
invoking its owning workflow or minting admission.

This artifact alone cannot make a candidate ready. Current exact-head CI/review,
live lease/fence/backend, health and real Host evidence require their own read
adapters and independent scope/recency checks. Any ready recommendation still
presents advice only; execution admission remains with its owning workflow.
