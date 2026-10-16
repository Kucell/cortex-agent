# Strict fixture runtime candidate

This development-only opt-in adapter requires a complete source checkout and
is for a fresh synthetic temporary project only. Its fixed worker lives under
tests/fixtures and is excluded by package.json files; the current npm package
cannot run the enabled fixture. It is not a packaged AI Host capability. It is not
wired into the CLI, legacy dispatch, native endpoint, governed launcher, or a
default RuntimePort. Importing it does not start a process. No canary is
automatically executed by the accompanying tests.

## Boundaries

- Synthetic Decision, Waitpoint and Authorization records are test data. They
  do not authenticate a human, establish ownership, or give permission to run a
  canary. A real invocation still needs its separately approved resource scope.
  The upper admission workflow binding that approval to an exact root, project
  UUID, job/run ID, code SHA and deadline is not implemented here. Copies of the
  fixture records do not carry single-invocation authority; enabled/fixtureOnly
  and caller-supplied owner strings do not replace that missing admission gate.
- The fixed child is a cooperative Node script. It has no filesystem/network
  imports, arbitrary code, shell, subprocesses, inherited environment, or user
  data. These code constraints are not an OS security boundary. A same-UID
  malicious Host could access files or network. This is not an AI Host.
- The parent owns the fixed file sink, canonical Store reads, Operation writes,
  lease state and revocation. All supported writers share one lifetime lock and
  synchronous transaction. External changes detected between transactions
  quarantine the instance. This is not cross-writer CAS or adversarial atomic
  revocation: existing legacy writers do not participate in this protocol.
- The run journal records runtime evidence only. It does not replace Mission or
  Task truth and never asserts acceptance completion.
- An observed worker exit or a process-group signal does not prove a whole
  process tree stopped. Reports explicitly carry process_tree_verified=false.

## APIs

- lib/dispatch/strict-approval.js:
  prepareStrictDispatch({enabled,projectRoot,taskId,decisionId,waitpointId,
  ownerWorkflow,hostRef,idempotencyKey}). Default OFF. It reads the bound real
  FilesystemGovernanceStore, validates the supported bundled closed schemas,
  reads bounded raw bytes through one fd, rejects invalid UTF-8 and hard links,
  re-reads and revalidates the pair before interpreting cache, binds a cached
  record to canonical project/governance paths, and always reports
  execution_authorized=false and effect_permitted=false.
- lib/runtime-port/strict-fixture.js:
  createStrictFixtureRuntime({enabled,fixtureOnly,projectRoot,cancelGraceMs})
  returns {port,revoke,inspect,close} when explicitly enabled. Default OFF
  returns the disabled process adapter. Run payloads cannot inject callbacks,
  paths, scripts, commands, bodies or environment. The wrapper accepts only
  the validated fresh-fixture root and bounded options.
- RuntimePort methods: discoverRuntime(), health(), createRun({task_id}),
  getStatus(run_ref), wait(run_ref,{timeout_ms}), cancel(run_ref).
  createRun registers RunRef before deferred spawn; it does not await completion.
- lib/runtime-state/strict-fixture-sink.js:
  inspectStrictFixtureRecovery(projectRoot) is read-only and never replays an
  effect. Existing state requires explicit recovery review. A stale lifetime
  lock is never automatically stolen or removed.

Only T-FIXTURE-1, T-FIXTURE-2, T-FIXTURE-3 exist in this adapter. The sink requires
the previous run's successful recorded runtime outcome before starting the next
one. It permits one attempt per task and one active run, at most three runs,
task budgets up to 10 seconds and a total budget up to 60 seconds. If worker
exit is still unobserved, TERM is followed by KILL after at most 2 seconds,
then at most 1 second of exit observation.
These are cooperative runtime limits, not a proof that synchronous filesystem
I/O or arbitrary callback code is preemptible.

The project must be a canonical, private, current-UID directory directly below
the canonical OS temporary directory named cortex-l3-fixture-*. It must not be a
Git project and cannot already contain an Operation/output directory or lease
state/idempotency files. Canonical local paths are not stable ProjectIdentity. The scope
artifact is .agent/artifacts/strict-fixture-scope.json; its exact-byte revision
is bound through both records' gate.resource_ref and relations.artifact_refs.
Three existing-format Authorization records independently bind each task's
fixed output path, repository identity, scope revision and finite expiry. No
approved_scope or other fixture permission fields are added to Decision.

Before deferred spawn, an instance-owned synchronous onBeforeSpawn callback re-reads the canonical pair, Authorization, current Operation binding and lease/fence. A failed or overdue callback prevents spawn. This remains a cooperative same-process check, not cross-process atomicity.

Each effect has a durable intent before the fixed sink and a receipt after
fsync. An error after effect submission may mean an effect occurred; UNKNOWN
never means zero side effects. An intent without a receipt is never retried.
Revocation/cancellation denies subsequent sink calls before stopping the worker.
Any uncertain worker outcome preserves the lock for review. Completed output
receipts are checked against current raw file bytes/type at transaction entry,
including before successful stop or dependency progression. This integrity
check does not assert tests passed, independent review or Task acceptance.

## Verification status and bounded tests

Candidate source only. Node tests and real subprocess integration have NOT RUN
during source preparation. Static parsing of authored JavaScript text is not a
Node/runtime test result.

The bounded test commands, after review and integration, are:

    node --test tests/dispatch/strict-approval.test.js
    node --test tests/runtime-port/strict-fixture-process.test.js tests/runtime-port/strict-fixture.test.js
    node --test tests/runtime-state/strict-fixture-sink.test.js

The process tests replace child_process.spawn and process.kill with fakes. The
store tests use temporary synthetic authority/Operation/Lease state, one-start
negative cases, zero-artifact counters and an outside sentinel. FIFO and growing
source cases are mocked read/type conditions, not real FIFO or race evidence. They do not
spawn a process or execute a three-task loop. The fixed child fixture is not a
test entry point. Do not add a real enabled loop to automatic CI without the
separate scope approval.

Formal L3 acceptance still requires authenticated owning workflow, actual
authority writers sharing effect-admission synchronization, OS/tool isolation,
a real AI Host, independently reviewed task results, local/remote workspace
coverage and recovery evidence. Existing FilesystemGovernanceStore
compare-and-write is read/compare/rename, Operation.writeTransition can rewrite
Authorization, and legacy lease writers do not share a sink transaction. This
candidate deliberately does not claim those production gaps are closed.
