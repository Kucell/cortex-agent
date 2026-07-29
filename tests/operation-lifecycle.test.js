"use strict";

const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const lifecycle = require("../lib/runtime-state/operation-lifecycle");

const AT = "2026-07-29T01:30:00.000Z";
function operation(attempt = 1, retry = null) {
  return lifecycle.createOperation({ operation_id: `OP-PILOT-${attempt}`, attempt, kind: "manual_dispatch", relations: { task_id: "T-ARI-001", run_id: "R-M-010", session_id: "S-M-010", workspace_id: "W-PILOT", retry_of_operation_id: retry }, actor: { workflow: "/mission", agent_id: "pi-agent", task_id: "T-ARI-001", mission_id: "M-010", run_id: "R-M-010", session_id: "S-M-010", workspace_id: "W-PILOT" }, owner: "operation-lifecycle", workflow: "/mission", action: { name: "dispatch" }, input_summary: { requirement_id: "REQ-PILOT", redacted: true }, target: { repository: "cortex-agent", host: "pi" }, target_revision: "REV-1", created_at: AT });
}
function readiness() { return lifecycle.createReadiness({ revision: "REV-1", verdict: "ready", operation: { kind: "manual_dispatch" }, resolved: { agents: ["pi"] }, inspected_at: AT }); }
function authorization() { return lifecycle.createAuthorization({ authorization_id: "AUTH-PILOT", decision_id: "D-M010-P006-c2e7b17a", decision_source: "management-api", policy: "frozen-revision", reason: "resource-bound approval", scope: { repository: "cortex-agent", revision: "REV-1" }, validity: { mode: "single" }, created_at: AT }); }

function advance(initial, statuses) {
  let current = initial; const events = []; const rd = readiness(); const auth = authorization();
  for (const status of statuses) { const result = lifecycle.transition(current, status, { at: AT, readiness: status === "inspected" ? rd : undefined, authorization: status === "authorized" ? auth : undefined, evidence_refs: ["EV-REDACTED"] }); current = result.operation; events.push(result.event); }
  return { current, events };
}

test("Operation legal lifecycle is append-only and replayable", () => {
  const source = operation();
  const { current, events } = advance(source, ["inspected", "awaiting_authorization", "authorized", "executing", "failed"]);
  assert.equal(current.status, "failed");
  assert.equal(events[1].previous_event_id, events[0].event_id);
  assert.equal(lifecycle.replay(source, events).status, "failed");
  assert.throws(() => lifecycle.transition(current, "succeeded", { at: AT }), (error) => error.code === "ERR_ILLEGAL_TRANSITION");
});

test("blocked or failed work requires a new attempt and preserves retry relation", () => {
  const failed = advance(operation(), ["inspected", "authorized", "executing", "failed"]).current;
  const retry = operation(2, failed.operation_id);
  assert.equal(retry.status, "planned");
  assert.equal(retry.relations.retry_of_operation_id, failed.operation_id);
  assert.notEqual(retry.operation_id, failed.operation_id);
});

test("readiness is deterministic for the same revision and dry-run input", () => assert.deepEqual(readiness(), readiness()));

test("single authorization is revision-bound and cannot be consumed by unrelated future work", () => {
  const auth = authorization(); const first = lifecycle.authorizeForOperation(auth, operation(), AT);
  assert.deepEqual(first.consumed_operation_ids, ["OP-PILOT-1"]);
  assert.throws(() => lifecycle.authorizeForOperation(first, operation(2, "OP-PILOT-1"), AT), (error) => error.code === "ERR_AUTHORIZATION_CONSUMED");
});

test("durable single authorization cannot be double-spent", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "p006-auth-consume-"));
  const auth = authorization();
  const first = lifecycle.consumeAuthorization(root, auth, operation(), AT);
  assert.deepEqual(first.consumed_operation_ids, ["OP-PILOT-1"]);
  assert.throws(
    () => lifecycle.consumeAuthorization(root, auth, operation(2, "OP-PILOT-1"), AT),
    (error) => error.code === "ERR_AUTHORIZATION_CONSUMED",
  );
  const persisted = JSON.parse(fs.readFileSync(
    path.join(root, ".agent", "authorizations", "AUTH-PILOT.json"),
    "utf8",
  ));
  assert.deepEqual(persisted.consumed_operation_ids, ["OP-PILOT-1"]);
});

test("authorization lock reclaims only a confirmed dead owner", () => {
  const deadRoot = fs.mkdtempSync(path.join(os.tmpdir(), "p006-auth-dead-lock-"));
  const deadDir = path.join(deadRoot, ".agent", "authorizations");
  fs.mkdirSync(deadDir, { recursive: true });
  fs.writeFileSync(path.join(deadDir, "AUTH-PILOT.json.lock"), JSON.stringify({
    pid: 99999999,
    nonce: "dead-owner",
  }));
  const consumed = lifecycle.consumeAuthorization(deadRoot, authorization(), operation(), AT);
  assert.deepEqual(consumed.consumed_operation_ids, ["OP-PILOT-1"]);

  const liveRoot = fs.mkdtempSync(path.join(os.tmpdir(), "p006-auth-live-lock-"));
  const liveDir = path.join(liveRoot, ".agent", "authorizations");
  fs.mkdirSync(liveDir, { recursive: true });
  const liveLock = path.join(liveDir, "AUTH-PILOT.json.lock");
  fs.writeFileSync(liveLock, JSON.stringify({ pid: process.pid, nonce: "live-owner" }));
  assert.throws(
    () => lifecycle.consumeAuthorization(liveRoot, authorization(), operation(), AT),
    (error) => error.code === "ERR_AUTHORIZATION_CONFLICT",
  );
  assert.equal(fs.existsSync(liveLock), true);
});

test("writer persists resource plus journal and projections are read-only and legacy-safe", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "p006-lifecycle-"));
  const source = operation(); lifecycle.writeAttempt(root, source);
  const first = lifecycle.writeTransition(root, source, "inspected", { at: AT, readiness: readiness() });
  const before = fs.readFileSync(path.join(root, ".agent", "operations", `${source.operation_id}.json`), "utf8");
  assert.equal(lifecycle.readProjection(root, "operations").summary.total, 1);
  assert.equal(lifecycle.readProjection(root, "authorizations").summary.total, 0);
  assert.equal(fs.readFileSync(path.join(root, ".agent", "operations", `${source.operation_id}.json`), "utf8"), before);
  assert.equal(first.event.type, "operation.inspected");
  assert.equal(lifecycle.readProjection(path.join(root, "legacy"), "operations").summary.total, 0);
});

test("writeAttempt rejects the same operation id bound to a different plan", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "p006-operation-identity-"));
  const first = operation();
  lifecycle.writeAttempt(root, first);
  const conflicting = lifecycle.createOperation({
    ...first,
    status: undefined,
    input_summary: { ...first.input_summary, plan_id: "P-DIFFERENT" },
  });
  assert.throws(
    () => lifecycle.writeAttempt(root, conflicting),
    (error) => error.code === "ERR_OPERATION_CONFLICT",
  );
});

test("concurrent writers cannot replace an operation with a different plan", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "p006-operation-race-"));
  const barrier = path.join(root, "barrier");
  const modulePath = path.join(__dirname, "..", "lib", "runtime-state", "operation-lifecycle.js");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const worker = `
    const fs = require("node:fs");
    const lifecycle = require(process.env.LIFECYCLE_MODULE);
    const source = lifecycle.createOperation({
      operation_id: "OP-RACE",
      attempt: 1,
      kind: "manual_dispatch",
      relations: { task_id: "T-RACE", run_id: "R-RACE", session_id: "S-RACE", workspace_id: "W-RACE" },
      actor: { workflow: "/mission", agent_id: "race-agent", task_id: "T-RACE" },
      owner: "operation-lifecycle",
      workflow: "/mission",
      action: { name: "dispatch" },
      input_summary: { requirement_id: "REQ-RACE", plan_id: process.env.PLAN_ID, redacted: true },
      target: { repository: "cortex-agent", host: "pi" },
      target_revision: "REV-RACE",
      created_at: "${AT}",
    });
    fs.appendFileSync(process.env.BARRIER, process.env.PLAN_ID + "\\n");
    const pause = new Int32Array(new SharedArrayBuffer(4));
    while (fs.readFileSync(process.env.BARRIER, "utf8").trim().split("\\n").length < 2) {
      Atomics.wait(pause, 0, 0, 5);
    }
    try {
      lifecycle.writeAttempt(process.env.ROOT, source);
      process.stdout.write(JSON.stringify({ ok: true, plan: process.env.PLAN_ID }));
    } catch (error) {
      process.stdout.write(JSON.stringify({ ok: false, plan: process.env.PLAN_ID, code: error.code }));
      process.exitCode = 2;
    }
  `;

  function run(planId) {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ["-e", worker], {
        env: {
          ...process.env,
          ROOT: root,
          BARRIER: barrier,
          PLAN_ID: planId,
          LIFECYCLE_MODULE: modulePath,
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => { stdout += chunk; });
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      child.on("error", reject);
      child.on("close", (status) => resolve({ status, stdout, stderr }));
    });
  }

  const results = await Promise.all([run("PLAN-A"), run("PLAN-B")]);
  assert.deepEqual(results.map(({ status }) => status).sort(), [0, 2]);
  const loser = JSON.parse(results.find(({ status }) => status === 2).stdout);
  assert.equal(loser.code, "ERR_OPERATION_CONFLICT");
  assert.equal(results.every(({ stderr }) => stderr === ""), true);

  const persisted = JSON.parse(fs.readFileSync(
    path.join(root, ".agent", "operations", "OP-RACE.json"),
    "utf8",
  ));
  assert.equal(["PLAN-A", "PLAN-B"].includes(persisted.input_summary.plan_id), true);
});

test("operation evidence stores summaries and unavailable usage, not private bodies", () => {
  const value = operation(); const serialized = JSON.stringify(value);
  assert.equal(value.usage.quality, "unavailable");
  for (const forbidden of ["prompt", "tool_payload", "file_body", "credential", "private_transcript", "exact_tokens"]) assert.equal(serialized.includes(forbidden), false);
});

test("writeCheckpoint persists a checkpoint and rejects forbidden private bodies", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "p006-checkpoint-"));
  const source = operation();
  lifecycle.writeAttempt(root, source);
  const checkpoint = lifecycle.writeCheckpoint(root, {
    schema_version: "1.0",
    checkpoint_id: "CHK-OP-PILOT-1",
    taken_at: "2026-07-29T01:30:00.000Z",
    operation_id: source.operation_id,
    host_profile_ref: "H-PI-LOCAL",
    task_id: "T-ARI-001",
    trajectory_digest: "abc123",
    boundary_event_count: 1,
    revision: "checkpoint-rev-1",
    redacted_summary: { kind: "manual_dispatch", redacted: true },
  });
  assert.equal(checkpoint.checkpoint_id, "CHK-OP-PILOT-1");
  const persisted = JSON.parse(fs.readFileSync(path.join(root, ".agent", "checkpoints", "CHK-OP-PILOT-1.json"), "utf8"));
  assert.equal(persisted.operation_id, source.operation_id);
  assert.equal(persisted.revision, "checkpoint-rev-1");
  assert.throws(() => lifecycle.writeCheckpoint(root, {
    schema_version: "1.0",
    checkpoint_id: "CHK-LEAKY",
    taken_at: "2026-07-29T01:30:00.000Z",
    operation_id: source.operation_id,
    host_profile_ref: "H-PI-LOCAL",
    task_id: "T-ARI-001",
    prompt: "secret prompt body",
  }), (err) => err.code === "ERR_FORBIDDEN_FIELD");
});

test("recoverOperation rebuilds a stale resource from the authoritative journal", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "p006-recover-"));
  const source = operation();
  lifecycle.writeAttempt(root, source);
  const first = lifecycle.transition(source, "inspected", { at: AT, readiness: readiness() });
  const journal = path.join(root, ".agent", "operations", "events.jsonl");
  fs.appendFileSync(journal, `${JSON.stringify(first.event)}\n`);
  const result = lifecycle.recoverOperation(root, source.operation_id);
  assert.equal(result.recovered, true);
  assert.equal(result.resource.latest_event_id, first.event.event_id);
  assert.equal(result.resource.status, "inspected");
  assert.equal(result.resource.readiness_ref, readiness().readiness_id);
  const result2 = lifecycle.recoverOperation(root, source.operation_id);
  assert.equal(result2.recovered, false);
  assert.equal(fs.readFileSync(journal, "utf8").trim().split("\n").length, 1);
});

test("recovery fails closed when a resource claims an event absent from journal", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "p006-recover-invalid-"));
  const source = operation();
  lifecycle.writeAttempt(root, source);
  const advanced = lifecycle.transition(source, "inspected", { at: AT, readiness: readiness() });
  fs.writeFileSync(
    path.join(root, ".agent", "operations", `${source.operation_id}.json`),
    JSON.stringify(advanced.operation, null, 2),
  );
  assert.throws(
    () => lifecycle.recoverOperation(root, source.operation_id),
    (error) => error.code === "ERR_RECOVERY_JOURNAL_MISSING",
  );
});

test("writeTransition leaves a replayable journal and matching resource", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "p006-order-"));
  const source = operation();
  lifecycle.writeAttempt(root, source);
  const result = lifecycle.writeTransition(root, source, "inspected", { at: AT, readiness: readiness() });
  const persisted = JSON.parse(fs.readFileSync(path.join(root, ".agent", "operations", `${source.operation_id}.json`), "utf8"));
  assert.equal(persisted.latest_event_id, result.event.event_id);
  const journal = fs.readFileSync(path.join(root, ".agent", "operations", "events.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(journal[journal.length - 1].event_id, result.event.event_id);
  assert.equal(lifecycle.replay(source, journal).latest_event_id, persisted.latest_event_id);
});

test("replay rejects forged event types, resource types, and duplicate ids", () => {
  const source = operation();
  const first = lifecycle.transition(source, "inspected", { at: AT, readiness: readiness() }).event;
  assert.throws(
    () => lifecycle.replay(source, [{ ...first, type: "operation.completed" }]),
    (error) => error.code === "ERR_REPLAY_EVENT_TYPE",
  );
  assert.throws(
    () => lifecycle.replay(source, [{ ...first, resource_type: "task" }]),
    (error) => error.code === "ERR_REPLAY_CHAIN",
  );
  const afterFirst = lifecycle.transition(source, "inspected", { at: AT, readiness: readiness() }).operation;
  const second = lifecycle.transition(afterFirst, "awaiting_authorization", { at: AT }).event;
  assert.throws(
    () => lifecycle.replay(source, [first, { ...second, event_id: first.event_id }]),
    (error) => error.code === "ERR_REPLAY_CHAIN",
  );
});

test("readiness, authorization, and transition values reject secrets", () => {
  const secret = `sk-${"a".repeat(24)}`;
  assert.throws(
    () => lifecycle.createReadiness({
      revision: "REV-1", verdict: "ready", operation: {},
      warnings: [secret], inspected_at: AT,
    }),
    (error) => error.code === "ERR_SENSITIVE_VALUE",
  );
  assert.throws(
    () => lifecycle.createAuthorization({
      authorization_id: "AUTH-SECRET", decision_id: "D-SECRET",
      decision_source: "test", policy: "single", reason: secret,
      scope: {}, created_at: AT,
    }),
    (error) => error.code === "ERR_SENSITIVE_VALUE",
  );
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "p006-event-secret-"));
  const source = operation();
  lifecycle.writeAttempt(root, source);
  assert.throws(
    () => lifecycle.writeTransition(root, source, "inspected", {
      at: AT, readiness: readiness(), message: secret,
    }),
    (error) => error.code === "ERR_SENSITIVE_VALUE",
  );
});

test("readProjection redacts forbidden fields and rejects tainted writes", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "p006-redact-"));
  const leaky = {
    schema_version: "1.0",
    operation_id: "OP-LEAKY",
    attempt: 1,
    kind: "manual_dispatch",
    status: "inspected",
    relations: { task_id: "T-1", run_id: "R-1", session_id: "S-1", workspace_id: "W-1", parent_operation_id: null, retry_of_operation_id: null, compensation_for_operation_id: null },
    actor: {}, owner: "test", workflow: "/mission",
    action: {}, input_summary: { redacted: true, prompt: "SECRET PROMPT" },
    target: {}, target_revision: "REV-1",
    authorization_ref: null, readiness_ref: null,
    usage: { quality: "unavailable" },
    evidence_refs: [], log_cursor_refs: [], latest_event_id: null,
    created_at: AT, updated_at: AT,
  };
  // writeAttempt must fail closed on a tainted input.
  assert.throws(() => lifecycle.writeAttempt(root, leaky), (err) => err.code === "ERR_FORBIDDEN_FIELD");
  // A legacy resource on disk is sanitized on read.
  fs.mkdirSync(path.join(root, ".agent", "operations"), { recursive: true });
  fs.writeFileSync(path.join(root, ".agent", "operations", "OP-LEAKY.json"), JSON.stringify(leaky, null, 2));
  const projection = lifecycle.readProjection(root, "operations");
  assert.equal(projection.resources[0].input_summary.prompt, "[REDACTED]");

  const authorizations = path.join(root, ".agent", "authorizations");
  fs.mkdirSync(authorizations, { recursive: true });
  fs.writeFileSync(path.join(authorizations, "AUTH-LEAKY.json"), JSON.stringify({
    authorization_id: "AUTH-LEAKY",
    reason: "-----BEGIN PRIVATE KEY----- fake",
  }));
  const authorizationProjection = lifecycle.readProjection(root, "authorizations");
  assert.equal(authorizationProjection.resources[0].reason, "[REDACTED]");
});

test("canonicalize produces a key-order-independent hash for logically equal values", () => {
  const a = { b: 1, a: 2, c: { y: 1, x: 2 } };
  const b = { c: { x: 2, y: 1 }, a: 2, b: 1 };
  assert.equal(lifecycle.stableHash(a), lifecycle.stableHash(b));
  assert.notEqual(lifecycle.stableHash({ a: 1 }), lifecycle.stableHash({ a: 2 }));
});
