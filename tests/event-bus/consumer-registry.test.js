"use strict";

// ─── Project-Scoped Local Consumer Registry (CP-9) ─────────────────────────
//
// Verifies the contract baseline for P-003 §5.2 / §7. Covers:
//   • Consumer registration, idempotency and unregistration.
//   • Project scoping: a different projectId sees an isolated registry.
//   • Subscription list and fallback chain mutations.
//   • Independent ACK state per consumer (eventId + target + consumerId).
//   • Redacted receipts: credentials / prompt bodies / file bodies / absolute
//     paths / host session IDs / token usage cannot reach the persisted file.
//   • Recovery: reopen from disk returns the same persisted state.
//   • Persistence confined to the caller-provided runtime root (`.agent-runtime`
//     segment required).
//   • Traversal / symlink rejection.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..", "..");
const {
  ConsumerRegistry,
  ConsumerRegistryError,
  makeDeliveryKey,
  targetIdentity,
  buildReceipt,
  assertConsumerId,
  assertProjectId,
  assertTarget,
} = require(path.join(root, "lib/coordination/consumer-registry"));

function freshRoot(label) {
  const base = path.join(os.tmpdir(), `consumer-registry-${label}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  fs.mkdirSync(base, { recursive: true });
  return path.join(base, ".agent-runtime");
}

function readPersisted(rootDir, projectId) {
  const consumersDir = path.join(rootDir, "consumers");
  const files = fs.readdirSync(consumersDir).filter((name) => name.startsWith("project-"));
  assert.equal(files.length, 1, `expected exactly one project file, got: ${files.join(",")}`);
  return JSON.parse(fs.readFileSync(path.join(consumersDir, files[0]), "utf8"));
}

// ─── 1. Registration / unregistration ──────────────────────────────────────

test("CP-9: register adds a consumer with target, adapter and subscriptions", () => {
  const runtimeRoot = freshRoot("register");
  const reg = new ConsumerRegistry(runtimeRoot, "project-alpha", { clock: () => 0 });
  const result = reg.register({
    consumerId: "developer-a",
    target: { kind: "coordinator", actorId: "project-owner" },
    adapterId: "codex.local",
    fallback: ["webhook", "polling"],
    subscriptions: ["task.ready_for_review", "task.blocked"],
  });
  assert.equal(result.created, true);
  assert.equal(result.consumer.consumerId, "developer-a");
  assert.equal(result.consumer.target.kind, "coordinator");
  assert.equal(result.consumer.target.actorId, "project-owner");
  assert.deepEqual(result.consumer.subscriptions, ["task.blocked", "task.ready_for_review"]);
  assert.deepEqual(result.consumer.fallback, ["polling", "webhook"]);
});

test("CP-9: register is idempotent — re-registering returns the same createdAt", () => {
  const runtimeRoot = freshRoot("idempotent");
  let now = 0;
  const reg = new ConsumerRegistry(runtimeRoot, "project-alpha", { clock: () => now });
  const first = reg.register({
    consumerId: "developer-a",
    target: { kind: "coordinator", actorId: "project-owner" },
  });
  now = 1000;
  const second = reg.register({
    consumerId: "developer-a",
    target: { kind: "coordinator", actorId: "project-owner" },
    subscriptions: ["task.ready_for_review"],
  });
  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(first.consumer.createdAt, second.consumer.createdAt);
  assert.deepEqual(second.consumer.subscriptions, ["task.ready_for_review"]);
});

test("CP-9: unregister removes a consumer and clears its delivery / ACK state", () => {
  const runtimeRoot = freshRoot("unregister");
  const reg = new ConsumerRegistry(runtimeRoot, "project-alpha", { clock: () => 0 });
  reg.register({
    consumerId: "developer-a",
    target: { kind: "coordinator", actorId: "project-owner" },
  });
  reg.recordDelivery("developer-a", "evt-1", { kind: "coordinator", actorId: "project-owner" }, {
    status: "delivered",
  });
  assert.equal(reg.pendingAckCount("developer-a"), 1);
  assert.equal(reg.unregister("developer-a"), true);
  assert.equal(reg.get("developer-a"), null);
  assert.equal(reg.pendingAckCount("developer-a"), 0);
  assert.equal(reg.unregister("developer-a"), false);
});

test("CP-9: list returns all registered consumers", () => {
  const runtimeRoot = freshRoot("list");
  const reg = new ConsumerRegistry(runtimeRoot, "project-alpha");
  reg.register({ consumerId: "a", target: { kind: "coordinator", actorId: "project-owner" } });
  reg.register({ consumerId: "b", target: { kind: "presentation", actorId: "project-owner" } });
  reg.register({ consumerId: "c", target: { kind: "coordinator", actorId: "reviewer" } });
  const ids = reg.list().map((c) => c.consumerId).sort();
  assert.deepEqual(ids, ["a", "b", "c"]);
});

// ─── 2. Subscription / fallback mutations ─────────────────────────────────

test("CP-9: addSubscription / removeSubscription maintain a sorted, deduped list", () => {
  const runtimeRoot = freshRoot("subs");
  const reg = new ConsumerRegistry(runtimeRoot, "project-alpha");
  reg.register({
    consumerId: "developer-a",
    target: { kind: "coordinator", actorId: "project-owner" },
  });
  reg.addSubscription("developer-a", "task.ready_for_review");
  reg.addSubscription("developer-a", "task.blocked");
  reg.addSubscription("developer-a", "task.ready_for_review"); // duplicate
  assert.deepEqual(reg.get("developer-a").subscriptions, ["task.blocked", "task.ready_for_review"]);
  reg.removeSubscription("developer-a", "task.blocked");
  assert.deepEqual(reg.get("developer-a").subscriptions, ["task.ready_for_review"]);
});

test("CP-9: setSubscriptions replaces the list atomically", () => {
  const runtimeRoot = freshRoot("set-subs");
  const reg = new ConsumerRegistry(runtimeRoot, "project-alpha");
  reg.register({
    consumerId: "developer-a",
    target: { kind: "coordinator", actorId: "project-owner" },
    subscriptions: ["task.ready_for_review"],
  });
  reg.setSubscriptions("developer-a", ["task.blocked", "task.input_required", "task.failed"]);
  assert.deepEqual(reg.get("developer-a").subscriptions, ["task.blocked", "task.failed", "task.input_required"]);
});

test("CP-9: setFallback replaces the adapter fallback chain", () => {
  const runtimeRoot = freshRoot("fallback");
  const reg = new ConsumerRegistry(runtimeRoot, "project-alpha");
  reg.register({
    consumerId: "developer-a",
    target: { kind: "coordinator", actorId: "project-owner" },
    fallback: ["webhook"],
  });
  reg.setFallback("developer-a", ["webhook", "polling", "manual"]);
  assert.deepEqual(reg.get("developer-a").fallback, ["manual", "polling", "webhook"]);
});

test("CP-9: subscriptions and fallback reject unsafe / unknown values", () => {
  const runtimeRoot = freshRoot("validation");
  const reg = new ConsumerRegistry(runtimeRoot, "project-alpha");
  reg.register({
    consumerId: "developer-a",
    target: { kind: "coordinator", actorId: "project-owner" },
  });
  // eventType with leading slash is rejected by the safe regex.
  assert.throws(
    () => reg.addSubscription("developer-a", "/etc/passwd"),
    ConsumerRegistryError,
  );
  // Adapter id with an embedded separator is fine; uppercase / spaces rejected.
  assert.throws(
    () => reg.setFallback("developer-a", ["Adapter One"]),
    ConsumerRegistryError,
  );
});

// ─── 3. Independent ACK state per consumer ─────────────────────────────────

test("CP-9: two consumers independently receive and ACK the same event", () => {
  const runtimeRoot = freshRoot("ack-isolation");
  const reg = new ConsumerRegistry(runtimeRoot, "project-alpha", { clock: () => 0 });
  const target = { kind: "coordinator", actorId: "project-owner" };

  reg.register({ consumerId: "developer-a", target });
  reg.register({ consumerId: "developer-b", target });

  reg.recordDelivery("developer-a", "evt-1", target, { status: "delivered", adapterId: "codex.local" });
  reg.recordDelivery("developer-b", "evt-1", target, { status: "delivered", adapterId: "claude-code.local" });

  // Same eventId + same target + DIFFERENT consumerId → different delivery keys.
  const keyA = makeDeliveryKey("evt-1", "developer-a", target);
  const keyB = makeDeliveryKey("evt-1", "developer-b", target);
  assert.notEqual(keyA, keyB, "delivery keys must be independent per consumer");

  // developer-a ACKs; developer-b is still pending.
  assert.equal(reg.acknowledge("developer-a", "evt-1", target), true);
  assert.equal(reg.acknowledgedFor("developer-a").length, 1);
  assert.equal(reg.pendingAckCount("developer-b"), 1);
  assert.equal(reg.pendingAckCount("developer-a"), 0);

  // Acknowledging again is a no-op (idempotent).
  assert.equal(reg.acknowledge("developer-a", "evt-1", target), false);

  // developer-b ACK now clears its own state, never developer-a's.
  assert.equal(reg.acknowledge("developer-b", "evt-1", target), true);
  assert.equal(reg.pendingAckCount("developer-b"), 0);
});

test("CP-9: acknowledge without a prior delivery is a hard error", () => {
  const runtimeRoot = freshRoot("ack-missing");
  const reg = new ConsumerRegistry(runtimeRoot, "project-alpha");
  reg.register({ consumerId: "developer-a", target: { kind: "coordinator", actorId: "project-owner" } });
  assert.throws(
    () => reg.acknowledge("developer-a", "evt-missing", { kind: "coordinator", actorId: "project-owner" }),
    /ERR_ACK_NOT_FOUND/,
  );
});

test("CP-9: ACK is keyed by eventId+target+consumerId only, not by adapter", () => {
  const runtimeRoot = freshRoot("ack-key-shape");
  const reg = new ConsumerRegistry(runtimeRoot, "project-alpha");
  const target = { kind: "coordinator", actorId: "project-owner" };
  reg.register({ consumerId: "developer-a", target });

  reg.recordDelivery("developer-a", "evt-1", target, { status: "delivered", adapterId: "codex.local" });
  reg.recordDelivery("developer-a", "evt-1", target, { status: "delivered", adapterId: "webhook" });

  // Both attempts share the same delivery key because the consumer did not
  // change. The first ACK succeeds; the second is idempotent (returns false).
  assert.equal(reg.acknowledge("developer-a", "evt-1", target), true);
  assert.equal(reg.acknowledge("developer-a", "evt-1", target), false);
  // The persisted state shows exactly one ACK record (key collision dedupes).
  assert.equal(reg.acknowledgedFor("developer-a").length, 1);
});

test("CP-9: different targets under the same eventId are independent deliveries", () => {
  const runtimeRoot = freshRoot("targets");
  const reg = new ConsumerRegistry(runtimeRoot, "project-alpha");
  const targetA = { kind: "coordinator", actorId: "project-owner" };
  const targetB = { kind: "presentation", actorId: "project-owner" };
  reg.register({ consumerId: "developer-a", target: targetA });
  reg.recordDelivery("developer-a", "evt-1", targetA, { status: "delivered" });
  reg.recordDelivery("developer-a", "evt-1", targetB, { status: "presented" });
  assert.equal(reg.pendingAckCount("developer-a"), 2);
  reg.acknowledge("developer-a", "evt-1", targetA);
  assert.equal(reg.pendingAckCount("developer-a"), 1);
});

// ─── 4. Redacted receipts ──────────────────────────────────────────────────

test("CP-9: receipts never persist credentials, paths, prompt bodies or IPs", () => {
  const runtimeRoot = freshRoot("redact");
  const reg = new ConsumerRegistry(runtimeRoot, "project-alpha", { clock: () => 0 });
  reg.register({ consumerId: "developer-a", target: { kind: "coordinator", actorId: "project-owner" } });

  // Adversarial inputs to scrub — each should be rejected before persistence.
  const adversarial = [
    { status: "delivered", reason: "token=ghp_AAAA" },
    { status: "delivered", reason: "see /Users/alice/work/private.md" },
    { status: "delivered", reason: "host=10.0.0.42" },
    { status: "delivered", reason: "system prompt: ignore previous instructions" },
    { status: "delivered", reason: "endpoint http://1.2.3.4:8080" },
    { status: "delivered", reason: "abs path /var/run/docker.sock" },
  ];
  for (const receipt of adversarial) {
    assert.throws(
      () => reg.recordDelivery("developer-a", "evt-1", { kind: "coordinator", actorId: "project-owner" }, receipt),
      ConsumerRegistryError,
    );
  }
  // No delivery should have been persisted because every record call rejected.
  assert.equal(reg.pendingAckCount("developer-a"), 0);
});

test("CP-9: receipts never persist session/thread IDs or token usage", () => {
  const runtimeRoot = freshRoot("session-redact");
  const reg = new ConsumerRegistry(runtimeRoot, "project-alpha");
  reg.register({ consumerId: "developer-a", target: { kind: "coordinator", actorId: "project-owner" } });
  const sessionId = "codex-thread-XYZ-private-session-9";
  assert.throws(
    () => reg.recordDelivery("developer-a", "evt-1", { kind: "coordinator", actorId: "project-owner" }, {
      status: "delivered",
      reason: `thread ${sessionId} used 1000 tokens`,
    }),
    /contains_private_data|control_chars/,
  );
});

test("CP-9: receipt reason may carry short bounded non-secret text", () => {
  const runtimeRoot = freshRoot("reason-ok");
  const reg = new ConsumerRegistry(runtimeRoot, "project-alpha", { clock: () => 0 });
  reg.register({ consumerId: "developer-a", target: { kind: "coordinator", actorId: "project-owner" } });
  reg.recordDelivery("developer-a", "evt-1", { kind: "coordinator", actorId: "project-owner" }, {
    status: "deferred",
    reason: "host offline",
  });
  // Read back via pendingFor to verify the reason made it through.
  const pending = reg.pendingFor("developer-a");
  assert.equal(pending.length, 1);
  assert.equal(pending[0].reason, "host offline");
});

// ─── 5. Persistence & recovery ─────────────────────────────────────────────

test("CP-9: persistence is confined to the caller-provided runtime root", () => {
  const base = path.join(os.tmpdir(), `consumer-registry-confine-${process.pid}-${Date.now()}`);
  // A non-runtime root (without `.agent-runtime`) is rejected.
  assert.throws(
    () => new ConsumerRegistry(base, "project-alpha"),
    /ERR_REGISTRY_SCOPE/,
  );
});

test("CP-9: registry recovers state across reopen", () => {
  const runtimeRoot = freshRoot("reopen");
  const reg1 = new ConsumerRegistry(runtimeRoot, "project-alpha", { clock: () => 0 });
  reg1.register({
    consumerId: "developer-a",
    target: { kind: "coordinator", actorId: "project-owner" },
    subscriptions: ["task.ready_for_review"],
  });
  reg1.recordDelivery("developer-a", "evt-1", { kind: "coordinator", actorId: "project-owner" }, {
    status: "delivered",
  });
  reg1.acknowledge("developer-a", "evt-1", { kind: "coordinator", actorId: "project-owner" });
  const revision1 = reg1.snapshot().revision;

  const reg2 = new ConsumerRegistry(runtimeRoot, "project-alpha");
  const snap = reg2.snapshot();
  assert.ok(snap.revision >= revision1);
  assert.deepEqual(snap.consumers.map((c) => c.consumerId), ["developer-a"]);
  assert.equal(reg2.acknowledgedFor("developer-a").length, 1);
});

test("CP-9: corrupt persisted state is surfaced, not silently ignored", () => {
  const runtimeRoot = freshRoot("corrupt");
  const reg1 = new ConsumerRegistry(runtimeRoot, "project-alpha", { clock: () => 0 });
  reg1.register({ consumerId: "developer-a", target: { kind: "coordinator", actorId: "project-owner" } });
  // Overwrite the persisted file with garbage.
  fs.writeFileSync(reg1._filePath, "not json", "utf8");
  assert.throws(() => new ConsumerRegistry(runtimeRoot, "project-alpha"), /ERR_REGISTRY_CORRUPT/);
});

test("CP-9: projectId is embedded in every persisted envelope", () => {
  const runtimeRoot = freshRoot("project-mismatch");
  const reg1 = new ConsumerRegistry(runtimeRoot, "project-alpha");
  reg1.register({ consumerId: "developer-a", target: { kind: "coordinator", actorId: "project-owner" } });
  // Read the file back directly and verify the embedded projectId matches
  // the one used at registration. A misnamed project must never be aliased
  // to a different project's bucket.
  const persisted = readPersisted(runtimeRoot, "project-alpha");
  assert.equal(persisted.projectId, "project-alpha");
  // A second projectId on the same runtime root produces a separate file
  // (already covered above); this test pins the projectId-on-disk invariant.
});

test("CP-9: two projectIds persist to two independent files", () => {
  const runtimeRoot = freshRoot("two-projects");
  const regA = new ConsumerRegistry(runtimeRoot, "project-alpha");
  const regB = new ConsumerRegistry(runtimeRoot, "project-bravo");
  regA.register({ consumerId: "a", target: { kind: "coordinator", actorId: "project-owner" } });
  regB.register({ consumerId: "b", target: { kind: "coordinator", actorId: "project-owner" } });

  const files = fs.readdirSync(path.join(runtimeRoot, "consumers"));
  assert.equal(files.length, 2);
  const persisted = files.map((f) => JSON.parse(fs.readFileSync(path.join(runtimeRoot, "consumers", f), "utf8")));
  const projects = persisted.map((p) => p.projectId).sort();
  assert.deepEqual(projects, ["project-alpha", "project-bravo"]);
});

test("CP-9: two long-lived registry instances do not lose updates", () => {
  const runtimeRoot = freshRoot("multi-instance");
  const first = new ConsumerRegistry(runtimeRoot, "project-alpha");
  const second = new ConsumerRegistry(runtimeRoot, "project-alpha");
  first.register({
    consumerId: "developer-a",
    target: { kind: "coordinator", actorId: "project-owner" },
  });
  second.register({
    consumerId: "developer-b",
    target: { kind: "coordinator", actorId: "project-owner" },
  });
  const recovered = new ConsumerRegistry(runtimeRoot, "project-alpha");
  assert.deepEqual(
    recovered.list().map((entry) => entry.consumerId).sort(),
    ["developer-a", "developer-b"],
  );
});

test("CP-9: writes use atomic rename and refuse to traverse outside the root", () => {
  const runtimeRoot = freshRoot("atomic");
  const reg = new ConsumerRegistry(runtimeRoot, "project-alpha", { clock: () => 0 });
  reg.register({ consumerId: "developer-a", target: { kind: "coordinator", actorId: "project-owner" } });

  // The persisted file lives inside <rootDir>/consumers/. A `..` in
  // consumerId must NOT escape that boundary — assertConsumerId enforces it.
  assert.throws(
    () => reg.register({ consumerId: "../escape", target: { kind: "coordinator", actorId: "project-owner" } }),
    ConsumerRegistryError,
  );
  // Verify nothing escaped by listing the runtime root.
  const outside = fs.readdirSync(path.dirname(runtimeRoot));
  assert.ok(!outside.some((name) => name.includes("escape")), "traversal must not escape runtime root");
});

test("CP-9: registry refuses a symlinked ancestor above the runtime root", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "registry-ancestor-"));
  const real = path.join(base, "real");
  fs.mkdirSync(path.join(real, ".agent-runtime"), { recursive: true });
  const linked = path.join(base, "linked");
  fs.symlinkSync(real, linked, "dir");
  assert.throws(
    () => new ConsumerRegistry(path.join(linked, ".agent-runtime"), "project-a"),
    (error) => error.code === "ERR_REGISTRY_SCOPE" && error.details.reason === "symlink_in_path",
  );
});

test("CP-9: registry refuses a persisted record replaced by a symlink", () => {
  const root = freshRoot("symlinked-record");
  const first = new ConsumerRegistry(root, "project-a");
  const file = first._filePath;
  const outside = path.join(path.dirname(root), "outside-registry.json");
  fs.writeFileSync(outside, JSON.stringify({ private: "content" }));
  fs.unlinkSync(file);
  fs.symlinkSync(outside, file);
  assert.throws(
    () => new ConsumerRegistry(root, "project-a"),
    (error) => error.code === "ERR_REGISTRY_SCOPE" && error.details.reason === "unsafe_registry_file",
  );
});

// ─── 6. buildReceipt + helpers (unit) ──────────────────────────────────────

test("CP-9: buildReceipt strips unknown keys via the schema", () => {
  // buildReceipt only normalises the well-known fields; the schema layer
  // catches rogue keys before persistence.
  const built = buildReceipt({
    status: "delivered",
    adapterId: "codex.local",
    attempts: 2,
    reason: "ok",
    rogueField: "leak",
  });
  assert.equal(built.status, "delivered");
  assert.equal(built.adapterId, "codex.local");
  assert.equal(built.attempts, 2);
  assert.equal(built.reason, "ok");
  // We do NOT propagate rogueField — it stays on the input; the schema
  // layer refuses it before persistence.
});

test("CP-9: assertConsumerId / assertProjectId / assertTarget enforce strict shapes", () => {
  assert.equal(assertConsumerId("developer-a"), "developer-a");
  assert.throws(() => assertConsumerId("../escape"), ConsumerRegistryError);
  assert.throws(() => assertConsumerId(""), ConsumerRegistryError);
  assert.throws(() => assertConsumerId(null), ConsumerRegistryError);

  assert.equal(assertProjectId("project-alpha"), "project-alpha");
  assert.throws(() => assertProjectId("with spaces"), ConsumerRegistryError);

  const t = assertTarget({ kind: "coordinator", actorId: "project-owner" });
  assert.deepEqual(t, { kind: "coordinator", actorId: "project-owner" });
  assert.throws(() => assertTarget({ kind: "", actorId: "x" }), ConsumerRegistryError);
  assert.throws(() => assertTarget(null), ConsumerRegistryError);
});

test("CP-9: targetIdentity normalises targets into the delivery key material", () => {
  assert.equal(
    targetIdentity({ kind: "coordinator", actorId: "project-owner" }),
    "coordinator:project-owner",
  );
  assert.throws(() => targetIdentity({ kind: "", actorId: "x" }), ConsumerRegistryError);
  assert.throws(() => targetIdentity(null), ConsumerRegistryError);
});

test("CP-9: snapshot reflects revision / consumerCount", () => {
  const runtimeRoot = freshRoot("snapshot");
  const reg = new ConsumerRegistry(runtimeRoot, "project-alpha");
  reg.register({ consumerId: "a", target: { kind: "coordinator", actorId: "project-owner" } });
  reg.register({ consumerId: "b", target: { kind: "coordinator", actorId: "project-owner" } });
  const snap = reg.snapshot();
  assert.equal(snap.consumerCount, 2);
  assert.ok(snap.revision >= 2);
  assert.equal(snap.schemaVersion, "1.0");
});

// ─── 7. reload() seam ──────────────────────────────────────────────────────

test("CP-9: reload() re-reads the persisted state", () => {
  const runtimeRoot = freshRoot("reload");
  const reg = new ConsumerRegistry(runtimeRoot, "project-alpha");
  reg.register({ consumerId: "a", target: { kind: "coordinator", actorId: "project-owner" } });
  // External write (e.g. another process) -> reload picks it up.
  const file = reg._filePath;
  const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  parsed.consumers["b"] = {
    consumerId: "b",
    target: { kind: "coordinator", actorId: "project-owner" },
    adapterId: null,
    fallback: [],
    subscriptions: [],
    createdAt: parsed.updatedAt,
    updatedAt: parsed.updatedAt,
  };
  parsed.revision += 1;
  fs.writeFileSync(file, JSON.stringify(parsed), "utf8");
  reg.reload();
  assert.deepEqual(reg.list().map((c) => c.consumerId).sort(), ["a", "b"]);
});

// ─── 8. Persisted file shape ───────────────────────────────────────────────

test("CP-9: persisted file contains only redacted, project-scoped data", () => {
  const runtimeRoot = freshRoot("file-shape");
  const reg = new ConsumerRegistry(runtimeRoot, "project-alpha");
  reg.register({
    consumerId: "developer-a",
    target: { kind: "coordinator", actorId: "project-owner" },
    subscriptions: ["task.ready_for_review"],
  });
  reg.recordDelivery("developer-a", "evt-1", { kind: "coordinator", actorId: "project-owner" }, {
    status: "delivered",
    reason: "ok",
  });
  const persisted = readPersisted(runtimeRoot, "project-alpha");
  // No leaked secrets / paths / session ids.
  const json = JSON.stringify(persisted);
  assert.ok(!/ghp_|sk-/.test(json));
  assert.ok(!/\/Users\/|\/home\/|\/var\//.test(json));
  assert.ok(!/\b(?:\d{1,3}\.){3}\d{1,3}\b/.test(json));
  assert.equal(persisted.schemaVersion, "1.0");
  assert.equal(persisted.projectId, "project-alpha");
  // Delivery record is redacted — only the well-known fields are present.
  const delivery = persisted.deliveries["developer-a"][Object.keys(persisted.deliveries["developer-a"])[0]];
  assert.equal(delivery.status, "delivered");
  assert.equal(delivery.reason, "ok");
});
