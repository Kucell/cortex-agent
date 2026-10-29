"use strict";

// Synthetic controller composition tests only. No GitHub authentication,
// canonical approval, live Owner/lease, Host, network or effect sink exists.
const assert = require("node:assert/strict");
const test = require("node:test");
const { createStrictDomainBoundary, ENTRY_OPERATIONS } = require("../../lib/dispatch/strict-domain-entry");

const NOW = Date.parse("2026-10-16T09:00:00.000Z");
const REVISION = { store_kind: "git", value: "a".repeat(40) };
const DIGEST = "sha256:" + "b".repeat(64);
const clone = (value) => JSON.parse(JSON.stringify(value));

function fixture(domain = "strict") {
  const f = { reads: 0, effects: 0, authorizations: 0, clock: NOW };
  f.request = {
    project_root: "/synthetic/project",
    project_id: "P-SYNTHETIC",
    resource_ref: "task:T-SYNTHETIC",
    resource_digest: DIGEST,
    operation_id: "OP-SYNTHETIC",
    expected_revision: clone(REVISION),
    payload: { task: "T-SYNTHETIC", text: "original" },
  };
  f.binding = {
    schema_version: 1, domain,
    project_identity: { kind: "project_id", value: "P-SYNTHETIC" },
    project_root: f.request.project_root,
    backend: { kind: "git", locator: "synthetic/governance", ref: "refs/heads/inert" },
    revision: clone(REVISION),
    resource_ref: f.request.resource_ref, resource_digest: DIGEST,
    observed_at: new Date(NOW).toISOString(),
    expires_at: new Date(NOW + 30_000).toISOString(),
  };
  f.resolve = () => { f.reads++; return clone(f.binding); };
  f.authorize = async (_context, run) => { f.authorizations++; return await run(); };
  f.continuation = (request) => { f.effects++; return { text: request.payload.text }; };
  f.create = (operation = "dispatch.execute") => createStrictDomainBoundary({
    resolveBinding: (request) => f.resolve(request),
    withAuthorization: (context, run) => f.authorize(context, run),
    now: () => f.clock,
  }).bind(operation, (request, context) => f.continuation(request, context));
  return f;
}

test("controller dependencies are mandatory; no default trusted source", () => {
  for (const options of [{}, { resolveBinding() {} }, { withAuthorization() {} }]) {
    assert.throws(() => createStrictDomainBoundary(options), { code: "ERR_STRICT_CONTROLLER_REQUIRED" });
  }
});

test("positive manual classification reaches existing continuation without strict grant", async () => {
  const f = fixture("manual");
  assert.deepEqual(await f.create()(f.request), { text: "original" });
  assert.equal(f.reads, 1);
  assert.equal(f.effects, 1);
  assert.equal(f.authorizations, 0);
});

test("strict fixture backend owns positive continuation; arbitrary return cannot replace result", async () => {
  const f = fixture();
  f.authorize = async (context, run) => {
    f.authorizations++;
    assert.equal(context.operation, "dispatch.execute");
    assert.equal(context.binding.project_identity.value, f.request.project_id);
    assert.equal(context.binding.backend.ref, "refs/heads/inert");
    assert.equal(context.request.operation_id, "OP-SYNTHETIC");
    assert.equal(Object.isFrozen(context.request.payload), true);
    assert.equal(Object.isFrozen(context.binding.backend), true);
    await run();
    return { forged: "success" };
  };
  assert.deepEqual(await f.create()(f.request), { text: "original" });
  assert.equal(f.reads, 2);
  assert.equal(f.authorizations, 1);
  assert.equal(f.effects, 1);
});

for (const operation of ENTRY_OPERATIONS) {
  test(operation + ": unknown binding cannot reach its registered continuation", async () => {
    const f = fixture();
    f.binding.domain = "unknown";
    await assert.rejects(f.create(operation)(f.request), { code: "ERR_STRICT_BINDING_UNRESOLVED" });
    assert.equal(f.effects, 0);
  });
}

const invalidBindings = [
  ["missing", (f) => { f.binding = null; }],
  ["ambiguous", (f) => { f.binding = [f.binding, clone(f.binding)]; }],
  ["missing backend", (f) => { delete f.binding.backend; }],
  ["unknown field", (f) => { f.binding.allow = true; }],
  ["different project", (f) => { f.binding.project_identity.value = "P-OTHER"; }],
  ["different root", (f) => { f.binding.project_root = "/synthetic/other"; }],
  ["different resource", (f) => { f.binding.resource_ref = "task:T-OTHER"; }],
  ["different digest", (f) => { f.binding.resource_digest = "sha256:" + "c".repeat(64); }],
  ["different revision", (f) => { f.binding.revision.value = "c".repeat(40); }],
  ["wrong backend kind", (f) => { f.binding.backend.kind = "filesystem"; }],
  ["missing git ref", (f) => { f.binding.backend.ref = null; }],
  ["expired", (f) => { f.binding.expires_at = new Date(NOW).toISOString(); }],
  ["stale", (f) => { f.binding.observed_at = new Date(NOW - 60_001).toISOString(); }],
  ["future observation", (f) => { f.binding.observed_at = new Date(NOW + 1).toISOString(); }],
];
for (const [name, mutate] of invalidBindings) {
  test(name + " binding fails before any continuation", async () => {
    const f = fixture(); mutate(f);
    await assert.rejects(f.create()(f.request));
    assert.equal(f.effects, 0);
    assert.equal(f.authorizations, 0);
  });
}

test("unreadable source is blocked rather than downgraded to manual", async () => {
  const f = fixture();
  f.resolve = () => { throw new Error("unreadable"); };
  await assert.rejects(f.create()(f.request), { code: "ERR_STRICT_BINDING_UNREADABLE" });
  assert.equal(f.effects, 0);
});

for (const value of [false, true, { approved: true }, "manual"]) {
  test("caller L3/authority fields cannot supply or disable trust: " + JSON.stringify(value), async () => {
    const f = fixture();
    f.request.l3 = value;
    await assert.rejects(f.create()(f.request), { code: "ERR_STRICT_REQUEST_INVALID" });
    assert.equal(f.effects, 0);
  });
}

for (const value of [true, { approved: true }, { authentication: "STRUCTURAL_MATCH_ONLY", authority: "none" }]) {
  test("backend return data without run is not authorization: " + JSON.stringify(value), async () => {
    const f = fixture();
    f.authorize = async () => value;
    await assert.rejects(f.create()(f.request), { code: "ERR_STRICT_AUTHORIZATION_NOT_RUN" });
    assert.equal(f.effects, 0);
  });
}

test("backend failure blocks continuation and closes retained callback", async () => {
  const f = fixture(); let retained;
  f.authorize = async (_context, run) => { retained = run; throw new Error("revoked"); };
  await assert.rejects(f.create()(f.request), /revoked/);
  assert.throws(() => retained(), { code: "ERR_STRICT_CONTINUATION_CLOSED" });
  assert.equal(f.effects, 0);
});

test("backend scope that returns without awaiting run cannot start a delayed effect", async () => {
  const f = fixture();
  f.authorize = (_context, run) => { run(); return true; };
  await assert.rejects(f.create()(f.request), { code: "ERR_STRICT_CONTINUATION_CLOSED" });
  assert.equal(f.effects, 0);
});

test("run is one-shot and unusable after the backend scope settles", async () => {
  const f = fixture(); let retained;
  f.authorize = async (_context, run) => {
    retained = run;
    await run();
    assert.throws(() => run(), { code: "ERR_STRICT_CONTINUATION_CLOSED" });
  };
  await f.create()(f.request);
  assert.throws(() => retained(), { code: "ERR_STRICT_CONTINUATION_CLOSED" });
  assert.equal(f.effects, 1);
});

test("caller mutation while authorization awaits cannot change the exact request", async () => {
  const f = fixture();
  f.authorize = async (_context, run) => {
    f.request.payload.text = "mutated";
    f.request.project_id = "P-OTHER";
    return await run();
  };
  assert.deepEqual(await f.create()(f.request), { text: "original" });
});

test("changed binding before continuation fails even if replacement says manual", async () => {
  const f = fixture();
  f.authorize = async (_context, run) => { f.binding.domain = "manual"; return await run(); };
  await assert.rejects(f.create()(f.request), { code: "ERR_STRICT_BINDING_CHANGED" });
  assert.equal(f.effects, 0);
});

test("expiry while authorization awaits blocks continuation", async () => {
  const f = fixture();
  f.authorize = async (_context, run) => { f.clock += 30_000; return await run(); };
  await assert.rejects(f.create()(f.request), { code: "ERR_STRICT_BINDING_STALE" });
  assert.equal(f.effects, 0);
});

test("cached success remains behind a fresh backend check on every invocation", async () => {
  const f = fixture(); const enter = f.create();
  f.continuation = () => { f.effects++; return { idempotent: true }; };
  assert.deepEqual(await enter(f.request), { idempotent: true });
  f.authorize = async () => { throw new Error("revoked"); };
  await assert.rejects(enter(f.request), /revoked/);
  assert.equal(f.effects, 1);
});

test("input accessors are rejected without executing project code", async () => {
  const f = fixture(); let reads = 0;
  Object.defineProperty(f.request.payload, "hook", { enumerable: true, get() { reads++; return true; } });
  await assert.rejects(f.create()(f.request), { code: "ERR_STRICT_INPUT_INVALID" });
  assert.equal(reads, 0);
  assert.equal(f.effects, 0);
});

test("array-valued revisions and digests cannot pass scalar validation", async () => {
  for (const field of ["revision", "digest"]) {
    const f = fixture();
    if (field === "revision") {
      f.request.expected_revision.value = ["a".repeat(40)];
      f.binding.revision.value = ["a".repeat(40)];
    } else {
      f.request.resource_digest = [DIGEST];
      f.binding.resource_digest = [DIGEST];
    }
    await assert.rejects(f.create()(f.request));
    assert.equal(f.effects, 0);
    assert.equal(f.authorizations, 0);
  }
});

test("backend failure after awaited continuation does not imply zero effects", async () => {
  const f = fixture();
  f.authorize = async (_context, run) => {
    await run();
    throw new Error("synthetic-post-effect-backend-failure");
  };
  await assert.rejects(f.create()(f.request), /synthetic-post-effect-backend-failure/);
  assert.equal(f.effects, 1);
});

test("continuation failure after an effect requires outcome reconciliation", async () => {
  const f = fixture();
  f.continuation = () => {
    f.effects++;
    throw new Error("synthetic-partial-effect");
  };
  await assert.rejects(f.create()(f.request), /synthetic-partial-effect/);
  assert.equal(f.effects, 1);
});
