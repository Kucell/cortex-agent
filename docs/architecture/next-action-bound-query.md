# Bound Task gap report

The package-owned read-only diagnostic is available through:

    cortex-agent query next-action [--project <path>] [--task <T-id> ...]

The same path is exposed by the existing local SDK:

    createLocalCortexClient(ctx).management.query("next-action", { task: "T-id" })

This diagnostic observes canonical Tasks and, when present, bounded committed
advisory plans, Mission identity contracts and actual Decision/Waitpoint records.
It does not complete C-lane ready-candidate/actual-binding acceptance. Current
product CI/review, canonical project proof, health, live ownership and Host evidence
remain explicit gaps; a matched plan/pair alone cannot produce ADVICE_READY.
execution_authorized is always false.

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
Task/index, plan, Mission contract and pair reads use one typed governance commit token. The adapter rechecks the
descriptor digest, canonical project/agent/repository paths and ref after reading.
Changed bindings/ref discard every recommendation. The observation is a bounded
read-time consistency check, not a lease, fence or guarantee against changes
after return. Filesystem bindings, remote locators, missing binding and unreadable
sources are explicit gaps. No CoordinationApplicationService.getTask/listTasks
or recoverSnapshot path is used.

## Focused evidence

    node --test tests/next-action/bound-query.test.js

The 45 cases run the actual bin entrypoint and actual local SDK, with all fixtures
in new temporary directories. Before/after snapshots include every file content,
mode and mtime plus directory entries and mtime. A preload audits the exact source
closure, instruments common network APIs, blocks non-allowlisted child operations and
rejects the reviewed filesystem write APIs. The subprocess environment is an explicit whitelist
without inherited Host CLI, NODE_OPTIONS or NODE_PATH. This is audited
instrumentation, not OS network/filesystem isolation.

The near-miss spelling case stops at the unchanged legacy-dispatch module boundary;
it does not claim the full legacy command closure was run. Ref/binding race cases
perform one labeled fixture-side mutation and permit only its expected changed
paths; query write attempts remain zero. The fixed binding fault writes through
captured open/write/close primitives without disabling the product guard. Ref
mutation permits only mtime changes for its two directory rows; the full entry
set, directory type/mode/size and all unrelated snapshots remain equal. They do not claim that the entire fixture
was unchanged during the adversarial mutation. Partial-clone coverage uses only a
local synthetic promisor repository, with no network target. Replace-ref coverage
uses two local fixture commits.

The package retains its existing Node >=16 declaration. Added source uses APIs
available on that baseline; the focused node:test harness is for Node 18/22/24.
Node 16 execution is not covered by that harness. Unsupported O_NOFOLLOW or
O_NONBLOCK semantics fail closed rather than reading an unsafe descriptor.

## Canonical advisory plan and Mission identity

The package now understands the closed schema in
lib/next-action/advisory-plan.schema.json. A committed plan is read only at:

    missions/<M-id>/advisory-plans/<AP-id>.json

The explicit project_id/task_id/mission_id must agree with the bound descriptor,
selected canonical Task, and the Mission directory. task_source binds the fixed
tasks/<T-id>.json path and its complete Git blob SHA1 identity (not a commit SHA)
to the unique typed same-commit Task read receipt. The mapped source refs include
that blob identity. Any Task byte change, including an ordinary status update,
invalidates the old plan/pair mapping until a reviewed replacement is committed.
This is a conservative read-only observation limitation, not a production
continuous-execution contract. Existing nonempty Task validation commands must
exactly equal the plan commands; a weaker plan cannot overwrite them. A Task that
has not declared validation commands may acquire an explicit plan, but no command
is treated as executed or verified. No filename/title-based
Task-to-Mission inference is used. The existing Mission Lite materializer's
missions/<M-id>/validation-contract.json supplies minimal Mission identity:
schema_version=2, matching mission_id and a full SHA256 of its exact UTF-8 bytes.
The plan names that fixed contract path and digest. This is identity/link
observation, not complete Mission-schema validation. Contract states.current,
milestones and gates never become completion or validation evidence, and the
16-character proposal_hash is not a scope digest.

Plan fields explicitly declare repository, branch, product commit, allowed paths
and operations, risk, validation commands, budget estimate with units, required
Host capabilities, stop conditions, and a finite created_at/expires_at interval.
These declarations do not prove that the product checkout/head, budget reservation,
capabilities or effects are available. The declared product_commit is not supplied
as the advisor's observed current product head.

The plan's full SHA256 is computed outside the document from the actual stored
bytes, including whitespace. Its approval resource is derived as:

    artifact:missions/<M-id>/advisory-plans/<AP-id>.json#sha256:<full-64-hex-digest>

There is no self-referential embedded plan_digest. Editing any plan byte breaks
reuse of a pair referencing the previous digest. Two active plans for a selected
Task conflict; the reader does not select the newest. When no active plan exists,
multiple expired/future alternatives also conflict. One expired/future plan is
reported with its independent validity failure.

The reader enumerates all entries under missions, decisions and waitpoints as
needed at the same commit: at most 512 regular nodes per namespace, 32 plans,
128 records of each pair kind, 1 MiB per read and 4 MiB aggregate plan/contract/pair
bytes. The Git command retains its 1 MiB + 1 output limit. A non-regular node,
malformed reserved path, duplicate entry, incomplete/changed revision, read
failure or exceeded bound prevents complete-source mapping. Pair metadata files
(index.json, index.schema.json, the bundled-kind schema filename and README.md)
are regular-node checked but are not pair records; indexes are not authoritative
enumeration sources. No record is chosen from an incomplete prefix.

A task filter limits projected Tasks. Every encountered advisory plan still
undergoes shape/path/project validation; Mission links and pair mapping are read
for selected Tasks. No Task-provided scope, plan_digest, Mission or authorization
extras are trusted. Plans absent from the committed namespace remain unknown.

## Actual canonical paired gate

The canonical branch of the pure advisor uses the existing bundled closed
Decision/Waitpoint schemas. It does not adapt real records into the older flat
DTO by inventing Decision.expires_at.

This first canonical plan version supports only action external_side_effect with
owner_workflow /mission. A different workflow/action requires a separate reviewed
contract. Both records must identify the plan's exact resource, one exact Task
and Mission, and the explicit Decision/Waitpoint IDs. artifact_refs and released
Waitpoint evidence_refs must include the full resource reference. Every record
naming the same resource is counted; duplicate alternatives block rather than
using the first approved or latest pair.

Approved Decision selection must be approve with an actual resolution record;
open/rejected/canceled/superseded and contradictory selections cannot pass.
Waitpoint must link that Decision, be released by the expected workflow, have
valid release chronology and a finite future deadline. Plan validity, Decision
resolution, and Waitpoint expiry are independently checked. Provenance strings
(requested_by, resolved_by, released_by, workflow_gate) are observations and do
not authenticate an Owner. A matched pair supplies no lease, fence or grant.

## Pure producer and owning workflow boundary

prepareAdvisoryPlan accepts bounded JSON text, validates the closed schema, and
returns normalized draft content, path, exact SHA256 and resource_ref with
write_permitted:false and execution_authorized:false. It accepts no object
getters/toJSON hooks, writes nothing, and is not a new CLI mutation command.

An owning Mission workflow may review and persist such a draft through its own
existing authorized change process. It must separately request the canonical
Decision/Waitpoint against the exact committed resource. This implementation
does not create real plans, governance records, approvals or defaults at query
time, and does not add template hooks. Committed observations remain revocable;
the effect owner must re-read its actual authority at admission and at the sink.

Additional unit/protocol fixtures are in:

    node --test tests/next-action/canonical-plan.test.js

The focused set contains 45 actual-bin/SDK fixtures, 28 plan/pair unit fixtures,
and 11 existing SDK/query regressions: 84 unique cases. Repeating this set on
Node 18/22/24 is compatibility coverage, not 252 independent acceptance cases.
Fixture execution is Tier I evidence. It is not real Host acceptance, operational
governance writes, current product CI/review binding, or effect-sink admission.

## Remaining actual-binding work

The artifact/pair path removes the missing canonical Mission/scope/approval
mapping when matching records exist. It still cannot supply current exact-head
product CI and independent review, canonical project proof, live owner lease,
fencing/backend consistency, health, or a real online Host capability observation.
Each needs a separately reviewed source with scope, revision and recency checks.
Even a future ready recommendation presents advice only; execution admission
remains with the owning workflow.
