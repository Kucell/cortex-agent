"use strict";

// @runner-timeout 600
// The contract cases build and compare large canonical payloads; under the
// parallel runner's load they exceed the default hang-detection window.

const { testRuntime } = require("../helpers/runtime-sandbox");

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const contract = require("../../lib/coordination/permit-witness-contract");
const { canonicalBytes, normalizeTargetState, targetStateDigest, createCheckpoint,
  assertCheckpointMatches, deriveTransition, LIMITS, MIGRATION_CHUNK_BYTES,
  writeTrustedCheckpointMigration, restoreTrustedCheckpointMigration } = contract;

const A = "a".repeat(64);
const B = "b".repeat(64);
function emptyState() {
  return { schema_version: 3, pins: [], revoked_fingerprints: [], applied_revocation_sequence: 0,
    highest_seen_revocation_sequence: 0, highest_accepted_permit_sequence: 0,
    last_observed_clock_ms: 0, clock_poisoned: false };
}
function pin() {
  // RFC 8032 public test vector, no private key needed by this contract.
  const key = crypto.createPublicKey({ format: "der", type: "spki", key: Buffer.from(
    "302a300506032b6570032100d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a", "hex") });
  return { decision_id: "D-test", instance_id: "target", public_key_pem: key.export({ type: "spki", format: "pem" }),
    fingerprint: crypto.createHash("sha256").update(key.export({ type: "spki", format: "der" })).digest("hex"),
    registered_at_ms: 10, source_digest: A, deployment_digest: B, run_id: "run",
    generation: "signed-run-generation", valid_from: 0, valid_until: 10000 };
}
function baseline(state = emptyState(), revision = 1) {
  return createCheckpoint({ authority_id: "authority", target_id: "target",
    store_generation: "authority-minted-store-generation", revision }, state);
}
function step(current, operation, facts, extra = {}) {
  return deriveTransition(current, { operation, checkpoint: current.checkpoint, ...extra }, facts);
}
function registered() { return step(baseline(), "register_pin", { pin: pin() }); }
function acceptFacts(overrides = {}) {
  return { now_ms: 100, permit_sequence: 1, fingerprint: pin().fingerprint,
    revocation: { sequence: 1, revoked_fingerprints: [] }, ...overrides };
}
function refuses(fn, code) {
  assert.throws(fn, (error) => error instanceof contract.PermitWitnessContractError &&
    (!code || error.code === code));
}

test("canonical v1 has fixed UTF-8 bytes independent of insertion order", () => {
  const value = { z: [true, null, -7], "中": "e\u0301\n😀", a: 12 };
  const vector = '{"a":12,"z":[true,null,-7],"中":"é\\n😀"}';
  assert.equal(canonicalBytes(value).toString("utf8"), vector);
  assert.deepEqual(canonicalBytes({ a: 12, "中": value["中"], z: value.z }), Buffer.from(vector));
  assert.notDeepEqual(canonicalBytes("e\u0301"), canonicalBytes("é"));
  assert.notDeepEqual(canonicalBytes([1, 2]), canonicalBytes([2, 1]));
  assert.equal(canonicalBytes({ "10": 10, "2": 2 }).toString(), '{"10":10,"2":2}');
});

test("canonical encoding refuses lossy values, exotic objects, cycles and sparse arrays", () => {
  const cycle = {}; cycle.self = cycle;
  const extraArray = [1]; extraArray.extra = 2;
  const hidden = {}; Object.defineProperty(hidden, "hidden", { value: 1 });
  const values = [undefined, NaN, Infinity, 1.1, -0, Number.MAX_SAFE_INTEGER + 1, 1n,
    Symbol("x"), () => {}, new Date(), Buffer.from("x"), new Set(), new Map(), cycle,
    [undefined], Array(1), extraArray, hidden, { a: undefined }, { [Symbol("x")]: 1 },
    Object.create({ inherited: 1 }), { toJSON() { return {}; } }];
  for (const value of values) refuses(() => canonicalBytes(value));
  let reads = 0;
  const getter = Object.defineProperty({}, "value", { enumerable: true, get() { reads += 1; return 1; } });
  refuses(() => canonicalBytes(getter));
  const array = [0]; Object.defineProperty(array, "0", { get() { reads += 1; return 1; } });
  refuses(() => canonicalBytes(array));
  assert.equal(reads, 0, "encoding must not execute accessors");
  assert.equal(canonicalBytes(JSON.parse('{"__proto__":{"x":1}}')).toString(), '{"__proto__":{"x":1}}');
  assert.equal(canonicalBytes("\ud800").toString(), '"\\ud800"');
  assert.equal(JSON.parse(canonicalBytes({ "\udfff": "\ud800" }).toString())["\udfff"], "\ud800");
});

test("encoding limits bound string, collection, nesting, node count and full body", () => {
  refuses(() => canonicalBytes("x".repeat(LIMITS.stringBytes + 1)));
  refuses(() => canonicalBytes(Array(LIMITS.entries + 1).fill(0)));
  let deep = 0;
  for (let i = 0; i <= LIMITS.depth; i += 1) deep = [deep];
  refuses(() => canonicalBytes(deep));
  refuses(() => canonicalBytes(Array(21).fill(Array(1000).fill(0))));
  refuses(() => canonicalBytes(Array(17).fill("x".repeat(65536))));
});

test("full state digest has a fixed domain-separated vector", () => {
  const state = emptyState();
  assert.equal(canonicalBytes(state).toString(),
    '{"applied_revocation_sequence":0,"clock_poisoned":false,"highest_accepted_permit_sequence":0,' +
    '"highest_seen_revocation_sequence":0,"last_observed_clock_ms":0,"pins":[],"revoked_fingerprints":[],"schema_version":3}');
  // Fixed vector intentionally independent of createCheckpoint implementation.
  assert.equal(targetStateDigest(state), "9ddca4594c2fdd726888c59d0c67ec7448f1b9effb306896b20c0a17087c1fab");
  assert.notEqual(targetStateDigest(state), crypto.createHash("sha256").update(canonicalBytes(state)).digest("hex"));
});

test("state encoding covers every authorization field and all pin carried fields", () => {
  const state = registered().state;
  const original = targetStateDigest(state);
  const mutations = [
    (s) => { s.pins = []; }, (s) => { s.revoked_fingerprints.push(A); },
    (s) => { s.applied_revocation_sequence = 1; s.highest_seen_revocation_sequence = 1; },
    (s) => { s.highest_seen_revocation_sequence = 2; },
    (s) => { s.highest_accepted_permit_sequence = 3; },
    (s) => { s.last_observed_clock_ms = 4; }, (s) => { s.clock_poisoned = true; },
    ...["decision_id", "instance_id", "run_id", "generation"].map((name) => (s) => { s.pins[0][name] += "-other"; }),
    ...["source_digest", "deployment_digest"].map((name) => (s) => { s.pins[0][name] = "c".repeat(64); }),
    ...["registered_at_ms", "valid_from", "valid_until"].map((name) => (s) => { s.pins[0][name] += 1; }),
  ];
  for (const mutate of mutations) {
    const changed = structuredClone(state); mutate(changed);
    assert.notEqual(targetStateDigest(changed), original);
  }
  for (const field of Object.keys(state)) {
    const incomplete = structuredClone(state); delete incomplete[field];
    refuses(() => normalizeTargetState(incomplete));
  }
});

test("state validation refuses legacy baselines, unknown fields, invalid cursors and pins", () => {
  for (const version of [1, 2, 4]) refuses(() => normalizeTargetState({ ...emptyState(), schema_version: version }));
  refuses(() => normalizeTargetState({ ...emptyState(), ignored: true }));
  for (const name of ["applied_revocation_sequence", "highest_seen_revocation_sequence",
    "highest_accepted_permit_sequence", "last_observed_clock_ms"]) {
    for (const value of [-1, "1", 1.5, null]) refuses(() => normalizeTargetState({ ...emptyState(), [name]: value }));
  }
  refuses(() => normalizeTargetState({ ...emptyState(), applied_revocation_sequence: 2 }));
  refuses(() => normalizeTargetState({ ...emptyState(), clock_poisoned: "false" }));
  for (const change of [{ fingerprint: A }, { public_key_pem: "-----BEGIN PRIVATE KEY-----" },
    { public_key_pem: "not a public key" }, { generation: 1 },
    { source_digest: "" }, { fingerprint: pin().fingerprint.toUpperCase() }, { extra: 1 }]) {
    refuses(() => normalizeTargetState({ ...emptyState(), pins: [{ ...pin(), ...change }] }));
  }
  for (const field of ["registered_at_ms", "valid_from", "valid_until"]) {
    for (const value of [null, "0", 1.5, Number.MAX_SAFE_INTEGER + 1, NaN, -Infinity]) {
      refuses(() => normalizeTargetState({ ...emptyState(), pins: [{ ...pin(), [field]: value }] }));
    }
  }
  refuses(() => normalizeTargetState({ ...emptyState(), pins: [pin(), pin()] }));
  refuses(() => normalizeTargetState({ ...emptyState(), revoked_fingerprints: [A, A] }));
  refuses(() => normalizeTargetState({ ...emptyState(), revoked_fingerprints: ["bad"] }));
});

test("carried source and deployment digests remain opaque nonempty text", () => {
  for (const field of ["source_digest", "deployment_digest"]) {
    for (const value of ["sha256:" + A, "build-label: release/测试", A.toUpperCase(), " ", "release-\ud800"]) {
      const state = { ...emptyState(), pins: [{ ...pin(), [field]: value }] };
      const current = baseline(state);
      assert.equal(current.state.pins[0][field], value, "carried text must not be trimmed or rewritten");
      assert.deepEqual(assertCheckpointMatches(current, current.checkpoint).state, state);
    }
    for (const value of ["", null, undefined, 0, true, [], {}, new String("text")]) {
      refuses(() => baseline({ ...emptyState(), pins: [{ ...pin(), [field]: value }] }));
    }
  }
});

test("real ProtectedPinStore initialize/registerPin state forms a complete checkpoint", async (t) => {
  const { ProtectedPinStore, STATE_FILE } = require("../../lib/coordination/protected-pin-store");
  const historicalCases = [];
  for (const [encoding, public_key_pem] of [
    ["LF", pin().public_key_pem],
    ["CRLF", pin().public_key_pem.replace(/\n/g, "\r\n")],
    ["no-final-newline", pin().public_key_pem.trimEnd()],
  ]) {
    for (const [window, valid_from, valid_until] of [
      ["ordered", 0, 10000], ["equal", 10, 10], ["reversed", 20, 10], ["negative", -20, -10],
      ["negative-reversed", -10, -20],
      ["signed-limits", Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER],
    ]) {
      historicalCases.push([encoding + "/" + window, "sha256:" + A, "sha256:" + B,
        { public_key_pem, valid_from, valid_until, registered_at_ms: -5 }]);
    }
  }
  const otherKey = crypto.createPublicKey({ format: "der", type: "spki", key: Buffer.from(
    "302a300506032b656e032100d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a", "hex") });
  historicalCases.push(["historical-key-algorithm", "sha256:" + A, "sha256:" + B,
    { public_key_pem: otherKey.export({ type: "spki", format: "pem" }),
      fingerprint: crypto.createHash("sha256").update(otherKey.export({ type: "spki", format: "der" })).digest("hex") }]);
  for (const [label, sourceDigest, deploymentDigest, overrides = {}] of [
    ["prefixed", "sha256:" + A, "sha256:" + B],
    ["opaque", "source-build: 测试/v1", "deployment: release-42"],
    ["oversized-carried-label", "x".repeat(LIMITS.stringBytes + 1), "sha256:" + B],
    ["oversized-state-body", "x".repeat(LIMITS.bytes + 1), "sha256:" + B],
    ...historicalCases,
  ]) {
    await t.test(label, () => {
      const root = testRuntime("test-tmp");
      fs.mkdirSync(root, { recursive: true });
      const dir = fs.mkdtempSync(path.join(root, "permit-witness-contract-pin-"));
      try {
        const pinDir = path.join(dir, "pin");
        fs.mkdirSync(pinDir);
        // Actual storage/locking, with the existing explicit test-only permission mode.
        const store = ProtectedPinStore.initialize(pinDir, { decisionId: "D-test", anchorMode: "permissive" });
        const readState = () => store.criticalSection(() => JSON.parse(
          fs.readFileSync(path.join(pinDir, STATE_FILE), "utf8")));
        const initialState = readState();
        const initial = baseline(initialState);
        assert.deepEqual(initial.state, initialState);
        const expected = { ...pin(), ...overrides };
        const result = store.registerPin({
          batchIdentity: { decision_id: expected.decision_id, instance_id: expected.instance_id,
            fingerprint: expected.fingerprint }, publicKeyPem: expected.public_key_pem,
          sourceDigest, deploymentDigest, runId: expected.run_id, generation: expected.generation,
          validFrom: expected.valid_from, validUntil: expected.valid_until, nowMs: expected.registered_at_ms,
          write: (entry, fingerprint) => {
            fs.writeFileSync(path.join(pinDir, fingerprint + ".json"), JSON.stringify(entry), { flag: "wx", mode: 0o600 });
            return true;
          },
        });
        assert.equal(result.registered, true);
        const registeredState = readState();
        const checkpoint = baseline(registeredState, 2);
        assert.deepEqual(checkpoint.state, registeredState, "retain the complete real state body");
        assert.equal(checkpoint.state.pins[0].source_digest, sourceDigest);
        assert.equal(checkpoint.state.pins[0].deployment_digest, deploymentDigest);
        assert.deepEqual(checkpoint.state.pins[0], { ...expected,
          source_digest: sourceDigest, deployment_digest: deploymentDigest }, "preserve every historical field verbatim");
        assert.deepEqual(step(initial, "register_pin", { pin: result.pin }), checkpoint);
        if (expected.fingerprint === pin().fingerprint && expected.public_key_pem !== pin().public_key_pem) {
          const rewritten = structuredClone(checkpoint);
          rewritten.state.pins[0].public_key_pem = pin().public_key_pem;
          refuses(() => assertCheckpointMatches(rewritten, checkpoint.checkpoint), "ERR_WITNESS_STATE");
        }

        store.noteRevocationSeen(2);
        store.commitRevocation({ sequence: 1, revokedFingerprints: [A], permitSequence: 7 });
        store.observePermitClock(100);
        assert.throws(() => store.observePermitClock(99), { key: "ERR_CLOCK_INVALID" });
        const fullState = readState();
        const full = baseline(fullState, 3);
        assert.deepEqual(full.state, fullState);
        assert.equal(full.state.applied_revocation_sequence, 1);
        assert.equal(full.state.highest_seen_revocation_sequence, 2);
        assert.equal(full.state.highest_accepted_permit_sequence, 7);
        assert.equal(full.state.last_observed_clock_ms, 100);
        assert.equal(full.state.clock_poisoned, true);
        assert.deepEqual(full.state.revoked_fingerprints, [A]);
        assert.deepEqual(full.state.pins, checkpoint.state.pins, "later transitions must not delete or rewrite history");
        assert.equal(full.checkpoint.full_state_digest, targetStateDigest(fullState));
        assert.deepEqual(assertCheckpointMatches(full, full.checkpoint), full);
        const tampered = structuredClone(full);
        tampered.state.pins[0].source_digest += "-changed";
        refuses(() => assertCheckpointMatches(tampered, full.checkpoint), "ERR_WITNESS_STATE");
        refuses(() => step(full, "observe_clock", { now_ms: 101 }, { state: initialState }));
        assert.deepEqual(readState(), fullState, "contract validation must not change the real store");
      } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    });
  }
});

test("set ordering and object insertion order normalize without dropping history", () => {
  const second = pin();
  const key = crypto.createPublicKey({ format: "der", type: "spki", key: Buffer.from(
    "302a300506032b65700321003d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c", "hex") });
  second.public_key_pem = key.export({ type: "spki", format: "pem" });
  second.fingerprint = crypto.createHash("sha256").update(key.export({ type: "spki", format: "der" })).digest("hex");
  const state = { ...emptyState(), pins: [pin(), second], revoked_fingerprints: [B, A] };
  const reversed = Object.fromEntries(Object.entries({ ...state, pins: [second, pin()], revoked_fingerprints: [A, B] }).reverse());
  assert.equal(targetStateDigest(state), targetStateDigest(reversed));
  assert.deepEqual(normalizeTargetState(state).revoked_fingerprints, [A, B]);
  assert.equal(normalizeTargetState(state).pins.length, 2);
  assert.deepEqual(state.revoked_fingerprints, [B, A], "normalization must not mutate input");
});

test("checkpoint retains full recoverable state and binds authority, target and store generation", () => {
  const current = registered();
  assert.deepEqual(Object.keys(current).sort(), ["checkpoint", "state"]);
  assert.equal(current.checkpoint.revision, 2);
  assert.equal(current.state.pins[0].generation, "signed-run-generation");
  assert.equal(current.checkpoint.store_generation, "authority-minted-store-generation");
  assert.deepEqual(assertCheckpointMatches(current, current.checkpoint), current);
  for (const field of ["authority_id", "target_id", "store_generation", "full_state_digest"]) {
    const value = field === "full_state_digest" ? A : "other";
    refuses(() => assertCheckpointMatches(current, { ...current.checkpoint, [field]: value }), "ERR_WITNESS_CHECKPOINT_CONFLICT");
  }
  for (const revision of [1, 3]) refuses(() => assertCheckpointMatches(current,
    { ...current.checkpoint, revision }), "ERR_WITNESS_CHECKPOINT_CONFLICT");
  const tampered = structuredClone(current); tampered.state.last_observed_clock_ms += 1;
  refuses(() => assertCheckpointMatches(tampered, current.checkpoint), "ERR_WITNESS_STATE");
  refuses(() => assertCheckpointMatches({ checkpoint: current.checkpoint }, current.checkpoint));
  for (const change of [{ format_version: 2 }, { revision: 0 }, { full_state_digest: "bad" }, { extra: true }]) {
    refuses(() => assertCheckpointMatches(current, { ...current.checkpoint, ...change }));
  }
});

test("checkpoint envelope boundary reserves request, migration manifest and future revision bytes", (t) => {
  const root = migrationRoot(t);
  const directory = path.join(root, "bundle");
  // Each identity is below the raw string limit, but JSON escaping expands NUL
  // sixfold. Tune the last field to make the worst-case manifest exactly 1 MiB.
  const binding = { authority_id: "\0".repeat(58000), target_id: "\0".repeat(58000),
    store_generation: "\0".repeat(58000), revision: 9 };
  const envelope = (b) => ({ format_version: 1, checkpoint: { format_version: 1, ...b,
    revision: Number.MAX_SAFE_INTEGER, full_state_digest: "0".repeat(64) },
  chunk_bytes: MIGRATION_CHUNK_BYTES, chunks: Number.MAX_SAFE_INTEGER,
  bytes: Number.MAX_SAFE_INTEGER, chain_digest: "f".repeat(64) });
  const padding = LIMITS.bytes - canonicalBytes(envelope(binding)).length;
  assert.ok(padding > 0 && 58000 + padding < LIMITS.stringBytes);
  binding.store_generation += "x".repeat(padding);
  assert.equal(canonicalBytes(envelope(binding)).length, LIMITS.bytes);
  const current = createCheckpoint(binding, { ...emptyState(), pins: [pin()] });
  assert.ok(canonicalBytes({ operation: "note_revocation_seen", checkpoint: current.checkpoint }).length <= LIMITS.bytes);
  for (const [operation, facts] of [
    ["register_pin", { pin: (() => {
      const other = pin();
      const der = Buffer.from("302a300506032b6570032100" + "1".repeat(64), "hex");
      const key = crypto.createPublicKey({ format: "der", type: "spki", key: der });
      other.public_key_pem = key.export({ type: "spki", format: "pem" });
      other.fingerprint = crypto.createHash("sha256").update(der).digest("hex");
      return other;
    })() }],
    ["apply_revocation", { sequence: 1, revoked_fingerprints: [] }],
    ["note_revocation_seen", { sequence: 1 }],
    ["observe_clock", { now_ms: 1 }],
    ["accept_permit", acceptFacts()],
  ]) {
    assert.ok(canonicalBytes({ operation, checkpoint: current.checkpoint }).length <= LIMITS.bytes);
    const advanced = step(current, operation, facts);
    assert.equal(advanced.checkpoint.revision, 10);
    assert.deepEqual(assertCheckpointMatches(advanced, advanced.checkpoint), advanced);
  }
  const last = createCheckpoint({ ...binding, revision: Number.MAX_SAFE_INTEGER - 1 }, emptyState());
  const lastAdvanced = step(last, "observe_clock", { now_ms: 1 });
  assert.equal(lastAdvanced.checkpoint.revision, Number.MAX_SAFE_INTEGER);
  const manifest = writeTrustedCheckpointMigration(directory, lastAdvanced, lastAdvanced.checkpoint);
  assert.ok(canonicalBytes(manifest).length <= LIMITS.bytes);
  assert.deepEqual(restoreTrustedCheckpointMigration(directory, lastAdvanced.checkpoint), lastAdvanced);

  const justOver = { ...binding, store_generation: binding.store_generation + "x" };
  assert.throws(() => canonicalBytes(envelope(justOver)));
  refuses(() => createCheckpoint(justOver, emptyState()));
  const malformed = { ...current.checkpoint, store_generation: justOver.store_generation };
  assert.ok(canonicalBytes(malformed).length < LIMITS.bytes);
  refuses(() => assertCheckpointMatches({ ...current, checkpoint: malformed }, malformed));

  // Reproduce the previously accepted 1 MiB checkpoint: the checkpoint alone
  // encodes but neither request nor intent does. It must fail before creating
  // a directory or scanning the trusted state.
  const old = { ...current.checkpoint };
  old.store_generation += "x".repeat(LIMITS.bytes - canonicalBytes(old).length);
  assert.equal(canonicalBytes(old).length, LIMITS.bytes);
  assert.ok(Buffer.byteLength(old.store_generation) <= LIMITS.stringBytes);
  assert.throws(() => canonicalBytes({ operation: "observe_clock", checkpoint: old }));
  assert.throws(() => canonicalBytes({ format_version: 1, checkpoint: old, chunk_bytes: MIGRATION_CHUNK_BYTES }));
  refuses(() => createCheckpoint({ authority_id: old.authority_id, target_id: old.target_id,
    store_generation: old.store_generation, revision: old.revision }, emptyState()));
  const rejectedDirectory = path.join(root, "unusable");
  refuses(() => writeTrustedCheckpointMigration(rejectedDirectory, { ...current, checkpoint: old }, old));
  assert.equal(fs.existsSync(rejectedDirectory), false);
});

test("client cannot supply a state, digest, facts, revision, identity or control operation", () => {
  const current = registered();
  for (const extra of [{ state: emptyState() }, { next_state: emptyState() }, { facts: { verified: true } },
    { full_state_digest: A }, { revision: 100 }, { verified: true }, { authority_id: "other" },
    { store_generation: "other" }, { operation_id: "not-yet-supported" }]) {
    refuses(() => step(current, "observe_clock", { now_ms: 100 }, extra));
  }
  for (const operation of ["reset", "recover", "replace_state", "clear_clock_poison", "unknown"]) {
    refuses(() => step(current, operation, {}), "ERR_WITNESS_OPERATION");
  }
  refuses(() => step(current, "observe_clock", { now_ms: 100, state: emptyState() }));
  refuses(() => step(current, "accept_permit", { verified: true }));
  refuses(() => step(current, "observe_clock", undefined));
});

test("registration only appends and cannot rewrite an existing pin", () => {
  const current = registered();
  refuses(() => step(current, "register_pin", { pin: pin() }), "ERR_WITNESS_PIN_EXISTS");
  refuses(() => step(current, "register_pin", { pin: { ...pin(), decision_id: "other" } }), "ERR_WITNESS_PIN_EXISTS");
  assert.equal(current.state.pins.length, 1);
});

test("revocation advances exactly one entry and preserves seen high water and permit replay state", () => {
  let current = registered();
  current = step(current, "note_revocation_seen", { sequence: 4 });
  const next = step(current, "apply_revocation", { sequence: 1, revoked_fingerprints: [B, A] });
  assert.equal(next.state.applied_revocation_sequence, 1);
  assert.equal(next.state.highest_seen_revocation_sequence, 4);
  assert.equal(next.state.highest_accepted_permit_sequence, 0);
  assert.deepEqual(next.state.revoked_fingerprints, [A, B]);
  assert.deepEqual(next.state.pins, current.state.pins);
  assert.equal(next.checkpoint.revision, current.checkpoint.revision + 1);
  refuses(() => step(next, "apply_revocation", { sequence: 2, revoked_fingerprints: [A] }), "ERR_WITNESS_REVOCATION_REGRESSION");
  for (const sequence of [1, 3]) refuses(() => step(next, "apply_revocation",
    { sequence, revoked_fingerprints: [A, B] }), "ERR_WITNESS_REVOCATION_CHAIN");
  for (const sequence of [1, 4]) refuses(() => step(next, "note_revocation_seen", { sequence }), "ERR_WITNESS_NO_CHANGE");
});

test("acceptance derives replay, next revocation entry and time in one proposed full state", () => {
  const current = registered();
  const before = structuredClone(current);
  const facts = acceptFacts();
  const next = step(current, "accept_permit", facts);
  assert.equal(next.state.highest_accepted_permit_sequence, 1);
  assert.equal(next.state.applied_revocation_sequence, 1);
  assert.equal(next.state.highest_seen_revocation_sequence, 1);
  assert.equal(next.state.last_observed_clock_ms, 100);
  assert.deepEqual(next.state.pins, current.state.pins);
  assert.deepEqual(current, before);
  assert.deepEqual(facts, acceptFacts());
  assert.equal(next.checkpoint.revision, current.checkpoint.revision + 1);
  assert.equal(next.checkpoint.full_state_digest, targetStateDigest(next.state));
  assert.equal(Object.hasOwn(next, "authorization"), false);
  refuses(() => step(next, "accept_permit", acceptFacts({ revocation: { sequence: 2, revoked_fingerprints: [] } })),
    "ERR_WITNESS_PERMIT_REPLAY");
  const later = step(next, "accept_permit", acceptFacts({ permit_sequence: 7, now_ms: 101,
    revocation: { sequence: 2, revoked_fingerprints: [] } }));
  assert.equal(later.state.highest_accepted_permit_sequence, 7, "authority sequences can have gaps");
});

test("rejected acceptance changes nothing; valid revocation remains independently derivable", () => {
  const current = registered();
  const before = structuredClone(current);
  const revocation = { sequence: 1, revoked_fingerprints: [pin().fingerprint] };
  refuses(() => step(current, "accept_permit", acceptFacts({ revocation })), "ERR_WITNESS_SIGNER");
  assert.deepEqual(current, before);
  const revoked = step(current, "apply_revocation", revocation);
  assert.equal(revoked.state.highest_accepted_permit_sequence, 0);
  assert.deepEqual(revoked.state.revoked_fingerprints, [pin().fingerprint]);
  assert.equal(revoked.state.pins.length, 1, "revocation never removes registration history");
  refuses(() => step(revoked, "accept_permit", acceptFacts({ revocation: { sequence: 2,
    revoked_fingerprints: [pin().fingerprint] } })), "ERR_WITNESS_SIGNER");
  refuses(() => step(current, "accept_permit", acceptFacts({ fingerprint: A })), "ERR_WITNESS_SIGNER");
  refuses(() => step(current, "accept_permit", acceptFacts({ revocation: null })));
  const ahead = step(current, "note_revocation_seen", { sequence: 3 });
  refuses(() => step(ahead, "accept_permit", acceptFacts()), "ERR_WITNESS_REVOCATION_CHAIN");
});

test("clock rollback proposes persistent poison without lowering time; clearing is unavailable", () => {
  const timed = step(registered(), "observe_clock", { now_ms: 100 });
  const poisoned = step(timed, "observe_clock", { now_ms: 99 });
  assert.equal(poisoned.state.clock_poisoned, true);
  assert.equal(poisoned.state.last_observed_clock_ms, 100);
  assert.equal(poisoned.checkpoint.revision, timed.checkpoint.revision + 1);
  refuses(() => step(poisoned, "accept_permit", acceptFacts()), "ERR_WITNESS_CLOCK");
  const later = step(poisoned, "observe_clock", { now_ms: 101 });
  assert.equal(later.state.clock_poisoned, true);
  refuses(() => step(timed, "accept_permit", acceptFacts({ now_ms: 99 })), "ERR_WITNESS_CLOCK");
  refuses(() => step(timed, "observe_clock", { now_ms: 100 }), "ERR_WITNESS_NO_CHANGE");
  refuses(() => step(poisoned, "observe_clock", { now_ms: 98 }), "ERR_WITNESS_NO_CHANGE");
  // A poisoned clock does not suppress an independently valid revocation.
  const revoked = step(poisoned, "apply_revocation", { sequence: 1, revoked_fingerprints: [A] });
  assert.equal(revoked.state.clock_poisoned, true);
  assert.deepEqual(revoked.state.revoked_fingerprints, [A]);
});

test("revision and revocation overflow fail closed without modifying the baseline", () => {
  const current = baseline(emptyState(), Number.MAX_SAFE_INTEGER);
  refuses(() => step(current, "observe_clock", { now_ms: 1 }));
  assert.equal(current.state.last_observed_clock_ms, 0);
  const exhausted = baseline({ ...emptyState(), applied_revocation_sequence: Number.MAX_SAFE_INTEGER,
    highest_seen_revocation_sequence: Number.MAX_SAFE_INTEGER });
  refuses(() => step(exhausted, "apply_revocation", { sequence: Number.MAX_SAFE_INTEGER, revoked_fingerprints: [] }),
    "ERR_WITNESS_REVOCATION_CHAIN");
});

test("stale proposals conflict after advance; derivation alone provides no concurrent exclusion", () => {
  const current = registered();
  const one = step(current, "observe_clock", { now_ms: 1 });
  const two = step(current, "observe_clock", { now_ms: 2 });
  assert.equal(one.checkpoint.revision, two.checkpoint.revision);
  assert.notEqual(one.checkpoint.full_state_digest, two.checkpoint.full_state_digest);
  refuses(() => deriveTransition(one, { operation: "observe_clock", checkpoint: current.checkpoint }, { now_ms: 2 }),
    "ERR_WITNESS_CHECKPOINT_CONFLICT");
});

test("a full checkpoint round-trips across a process without hidden reconstruction state", (t) => {
  const root = testRuntime("test-tmp");
  fs.mkdirSync(root, { recursive: true });
  const dir = fs.mkdtempSync(path.join(root, "permit-witness-contract-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "checkpoint.json");
  const current = step(registered(), "accept_permit", acceptFacts());
  fs.writeFileSync(file, canonicalBytes(current));
  const modulePath = require.resolve("../../lib/coordination/permit-witness-contract");
  const child = spawnSync(process.execPath, ["-e", `
    const fs = require('node:fs');
    const c = require(process.argv[1]);
    const current = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
    c.assertCheckpointMatches(current, current.checkpoint);
    process.stdout.write(c.canonicalBytes(current));
  `, modulePath, file], { encoding: "utf8", timeout: 10000 });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.error, undefined);
  assert.equal(child.stdout, canonicalBytes(current).toString());
  assert.deepEqual(JSON.parse(child.stdout), current);
});

function migrationRoot(t) {
  const root = testRuntime("test-tmp");
  fs.mkdirSync(root, { recursive: true });
  const dir = fs.mkdtempSync(path.join(root, "permit-witness-migration-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function numberedHash(index) { return index.toString(16).padStart(64, "0"); }
function historicalState() {
  const template = pin();
  const pins = Array.from({ length: LIMITS.entries + 1 }, (_, index) => {
    const der = Buffer.from("302a300506032b6570032100" + numberedHash(index + 1), "hex");
    const key = crypto.createPublicKey({ type: "spki", format: "der", key: der });
    return { ...template, fingerprint: crypto.createHash("sha256").update(der).digest("hex"),
      public_key_pem: key.export({ type: "spki", format: "pem" }), source_digest: "史".repeat(400) };
  });
  // Pairs straddle the streaming encoder's string boundary; isolated UTF-16
  // code units and JSON escapes must also survive without normalization.
  pins[0].source_digest = "x".repeat(4095) + "😀" + "\\\n\ud800中".repeat(20000) + "\udfff";
  return { ...emptyState(), pins,
    revoked_fingerprints: Array.from({ length: 17000 }, (_, index) => numberedHash(index + 1)),
    applied_revocation_sequence: 9, highest_seen_revocation_sequence: 11,
    highest_accepted_permit_sequence: 73, last_observed_clock_ms: 999, clock_poisoned: true };
}
function referenceCanonical(value) {
  if (Array.isArray(value)) return "[" + value.map(referenceCanonical).join(",") + "]";
  if (value && typeof value === "object") return "{" + Object.keys(value).sort().map(
    (key) => JSON.stringify(key) + ":" + referenceCanonical(value[key])).join(",") + "}";
  return JSON.stringify(value);
}

test("trusted history exceeds every online size ceiling without losing bytes or future transitions", () => {
  const state = historicalState();
  const before = structuredClone(state);
  const current = baseline(state, 28);
  assert.equal(current.state.pins.length, 1025);
  assert.equal(current.state.revoked_fingerprints.length, 17000);
  const bytes = Buffer.from(referenceCanonical(current.state));
  assert.ok(bytes.length > LIMITS.bytes);
  assert.equal(current.checkpoint.full_state_digest, crypto.createHash("sha256")
    .update("cortex-permit-witness-target-state-v1\n").update(bytes).digest("hex"));
  assert.deepEqual(state, before);
  assert.deepEqual(current.state.pins.find((p) => p.fingerprint === state.pins[0].fingerprint), state.pins[0]);
  assert.deepEqual(assertCheckpointMatches(current, current.checkpoint), current);
  const timed = step(current, "observe_clock", { now_ms: 1000 });
  assert.deepEqual(timed.state.pins, current.state.pins);
  assert.deepEqual(timed.state.revoked_fingerprints, current.state.revoked_fingerprints);
  const next = step(timed, "apply_revocation", { sequence: 10,
    revoked_fingerprints: [...current.state.revoked_fingerprints, A] });
  assert.equal(next.state.revoked_fingerprints.length, 17001);
  assert.equal(next.state.highest_seen_revocation_sequence, 11);
  assert.equal(next.state.highest_accepted_permit_sequence, 73);
  assert.equal(next.state.clock_poisoned, true);
  assert.equal(next.checkpoint.revision, 30);
  refuses(() => step(next, "apply_revocation", { sequence: 11,
    revoked_fingerprints: current.state.revoked_fingerprints }), "ERR_WITNESS_REVOCATION_REGRESSION");
  // A trusted argument is a separate host responsibility, never a request flag.
  for (const extra of [{ trusted: true }, { offline: true }, { state }, { facts: state },
    { history: Array(1025).fill(0) }, { payload: "x".repeat(65537) }]) {
    refuses(() => step(current, "observe_clock", { now_ms: 1000 }, extra));
  }
  refuses(() => canonicalBytes(current));
  refuses(() => canonicalBytes(state.pins[0].source_digest));
  refuses(() => deriveTransition(current, { operation: "x".repeat(65537), checkpoint: current.checkpoint }, {}));
  refuses(() => deriveTransition(current, { operation: "observe_clock", checkpoint: {
    ...current.checkpoint, target_id: "x".repeat(65537) } }, { now_ms: 1000 }));
});

test("large trusted facts and state still reject accessors, sparse arrays, duplicates and unknown data", () => {
  let reads = 0;
  const getter = { ...pin() };
  Object.defineProperty(getter, "source_digest", { enumerable: true, get() { reads += 1; return "x"; } });
  refuses(() => baseline({ ...emptyState(), pins: [getter] }));
  const sparse = Array(1025); sparse[1024] = A;
  refuses(() => baseline({ ...emptyState(), revoked_fingerprints: sparse }));
  const array = [A];
  Object.defineProperty(array, "0", { enumerable: true, get() { reads += 1; return A; } });
  refuses(() => step(baseline(), "apply_revocation", { sequence: 1, revoked_fingerprints: array }));
  const facts = Object.defineProperty({}, "pin", { enumerable: true, get() { reads += 1; return pin(); } });
  refuses(() => step(baseline(), "register_pin", facts));
  refuses(() => step(baseline(), "register_pin", { pin: { ...pin(), extra: true } }));
  const duplicate = Array.from({ length: 1025 }, (_, i) => numberedHash(i)); duplicate.push(duplicate[0]);
  refuses(() => step(baseline(), "apply_revocation", { sequence: 1, revoked_fingerprints: duplicate }));
  assert.equal(reads, 0);
});

test("offline bundle is bounded per record and restores complete large history in a fresh process", (t) => {
  const root = migrationRoot(t);
  const directory = path.join(root, "bundle");
  const current = baseline(historicalState(), 28);
  const manifest = writeTrustedCheckpointMigration(directory, current, current.checkpoint);
  assert.ok(manifest.bytes > LIMITS.bytes);
  assert.ok(manifest.chunks > 64);
  for (const name of fs.readdirSync(directory)) {
    assert.ok(fs.statSync(path.join(directory, name)).size <= (name.endsWith(".bin") ? MIGRATION_CHUNK_BYTES : LIMITS.bytes));
  }
  assert.deepEqual(restoreTrustedCheckpointMigration(directory, current.checkpoint), current);
  assert.deepEqual(writeTrustedCheckpointMigration(directory, current, current.checkpoint), manifest, "resume is idempotent");
  const expectedFile = path.join(root, "authority-checkpoint.json");
  fs.writeFileSync(expectedFile, canonicalBytes(current.checkpoint));
  const child = spawnSync(process.execPath, ["-e", `
    const fs = require('node:fs');
    const c = require(process.argv[1]);
    const expected = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));
    const restored = c.restoreTrustedCheckpointMigration(process.argv[2], expected);
    process.stdout.write(JSON.stringify({ checkpoint: restored.checkpoint,
      pins: restored.state.pins.length, revoked: restored.state.revoked_fingerprints.length,
      poison: restored.state.clock_poisoned, permit: restored.state.highest_accepted_permit_sequence,
      next: c.deriveTransition(restored, { operation: 'observe_clock', checkpoint: expected },
        { now_ms: 1000 }).checkpoint.revision }));
  `, require.resolve("../../lib/coordination/permit-witness-contract"), directory, expectedFile],
  { encoding: "utf8", timeout: 15000 });
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout), { checkpoint: current.checkpoint, pins: 1025,
    revoked: 17000, poison: true, permit: 73, next: 29 });
});

test("offline restore refuses omissions, substitution, order changes, forged manifests and foreign baselines", (t) => {
  const root = migrationRoot(t);
  const directory = path.join(root, "bundle");
  const current = baseline({ ...emptyState(), pins: [{ ...pin(), source_digest: "x".repeat(40000) }] });
  writeTrustedCheckpointMigration(directory, current, current.checkpoint);
  const saved = new Map(fs.readdirSync(directory).map((name) => [name, fs.readFileSync(path.join(directory, name))]));
  const chunks = [...saved.keys()].filter((name) => name.endsWith(".bin")).sort();
  function restoreFiles() {
    for (const name of fs.readdirSync(directory)) fs.unlinkSync(path.join(directory, name));
    for (const [name, bytes] of saved) fs.writeFileSync(path.join(directory, name), bytes);
  }
  function rejected(mutate) {
    mutate();
    assert.throws(() => restoreTrustedCheckpointMigration(directory, current.checkpoint));
    restoreFiles();
  }
  rejected(() => fs.unlinkSync(path.join(directory, chunks[1])));
  rejected(() => fs.unlinkSync(path.join(directory, "intent.json")));
  rejected(() => fs.unlinkSync(path.join(directory, "manifest.json")));
  rejected(() => fs.writeFileSync(path.join(directory, chunks[0]), saved.get(chunks[0]).subarray(0, 30)));
  rejected(() => fs.writeFileSync(path.join(directory, chunks[0]), Buffer.alloc(MIGRATION_CHUNK_BYTES + 1)));
  rejected(() => fs.writeFileSync(path.join(directory, chunks[1]), saved.get(chunks[0])));
  rejected(() => {
    fs.writeFileSync(path.join(directory, chunks[0]), saved.get(chunks[1]));
    fs.writeFileSync(path.join(directory, chunks[1]), saved.get(chunks[0]));
  });
  rejected(() => fs.writeFileSync(path.join(directory, "extra.bin"), "unexplained history"));
  for (const mutate of [
    (m) => { m.bytes -= 1; }, (m) => { m.chunks += 1; }, (m) => { m.chunk_bytes *= 2; },
    (m) => { m.chain_digest = A; }, (m) => { m.checkpoint.revision += 1; },
    (m) => { m.checkpoint.full_state_digest = A; }, (m) => { m.format_version = 2; },
    (m) => { m.extra = true; },
  ]) rejected(() => {
    const m = JSON.parse(saved.get("manifest.json")); mutate(m);
    fs.writeFileSync(path.join(directory, "manifest.json"), canonicalBytes(m));
  });
  rejected(() => {
    // An attacker can recompute an unkeyed chunk chain/manifest. Only the
    // independently supplied authority checkpoint establishes the baseline.
    const first = saved.get(chunks[0]).toString();
    assert.ok(first.includes('"last_observed_clock_ms":0'));
    fs.writeFileSync(path.join(directory, chunks[0]), first.replace('"last_observed_clock_ms":0', '"last_observed_clock_ms":1'));
    let chain = crypto.createHash("sha256").update("cortex-permit-witness-migration-v1\n")
      .update(canonicalBytes(current.checkpoint)).digest("hex");
    for (let index = 0; index < chunks.length; index += 1) {
      const bytes = fs.readFileSync(path.join(directory, chunks[index]));
      chain = crypto.createHash("sha256").update("cortex-permit-witness-migration-chunk-v1\n")
        .update(canonicalBytes({ previous: chain, index, bytes: bytes.length })).update(bytes).digest("hex");
    }
    const manifest = JSON.parse(saved.get("manifest.json")); manifest.chain_digest = chain;
    fs.writeFileSync(path.join(directory, "manifest.json"), canonicalBytes(manifest));
  });
  rejected(() => {
    const manifest = JSON.parse(saved.get("manifest.json"));
    manifest.bytes = Number.MAX_SAFE_INTEGER;
    manifest.chunks = Math.ceil(manifest.bytes / MIGRATION_CHUNK_BYTES);
    fs.writeFileSync(path.join(directory, "manifest.json"), canonicalBytes(manifest));
  });
  for (const field of ["authority_id", "target_id", "store_generation", "revision", "full_state_digest"]) {
    const expected = { ...current.checkpoint, [field]: field === "revision" ? 2 : field === "full_state_digest" ? A : "foreign" };
    refuses(() => restoreTrustedCheckpointMigration(directory, expected), "ERR_WITNESS_MIGRATION_CONFLICT");
  }
  refuses(() => restoreTrustedCheckpointMigration(directory, undefined));
  refuses(() => writeTrustedCheckpointMigration(directory, current, undefined));
  const changed = baseline({ ...current.state, last_observed_clock_ms: 1 });
  refuses(() => writeTrustedCheckpointMigration(directory, changed, changed.checkpoint), "ERR_WITNESS_MIGRATION_CONFLICT");
  assert.deepEqual(restoreTrustedCheckpointMigration(directory, current.checkpoint), current);
});

test("offline migration refuses incomplete legacy evidence and linked bundle paths", (t) => {
  const root = migrationRoot(t);
  const current = baseline();
  const directory = path.join(root, "bundle");
  for (const version of [1, 2]) {
    const unproven = { checkpoint: current.checkpoint, state: { ...emptyState(), schema_version: version } };
    refuses(() => writeTrustedCheckpointMigration(directory, unproven, current.checkpoint));
    assert.equal(fs.existsSync(directory), false);
  }
  const incomplete = structuredClone(current); delete incomplete.state.highest_accepted_permit_sequence;
  refuses(() => writeTrustedCheckpointMigration(directory, incomplete, current.checkpoint));
  assert.equal(fs.existsSync(directory), false);
  writeTrustedCheckpointMigration(directory, current, current.checkpoint);
  const linkedDirectory = path.join(root, "linked-bundle");
  fs.symlinkSync(directory, linkedDirectory, "dir");
  refuses(() => restoreTrustedCheckpointMigration(linkedDirectory, current.checkpoint));
  refuses(() => writeTrustedCheckpointMigration(linkedDirectory, current, current.checkpoint));
  const chunk = path.join(directory, "chunk-000000000000.bin");
  const other = path.join(root, "outside.bin");
  fs.renameSync(chunk, other);
  fs.symlinkSync(other, chunk);
  assert.throws(() => restoreTrustedCheckpointMigration(directory, current.checkpoint));
  assert.throws(() => writeTrustedCheckpointMigration(directory, current, current.checkpoint));
  fs.unlinkSync(chunk);
  fs.linkSync(other, chunk);
  refuses(() => restoreTrustedCheckpointMigration(directory, current.checkpoint));
  refuses(() => writeTrustedCheckpointMigration(directory, current, current.checkpoint));
  assert.equal(fs.readFileSync(other).toString(), referenceCanonical(current.state));
});

test("migration resumes from every interrupted file write/fsync boundary using the same full baseline", (t) => {
  const root = migrationRoot(t);
  const current = baseline({ ...emptyState(), pins: [{ ...pin(), source_digest: "x".repeat(20000) }] });
  // One intent, two chunks, one manifest; each has a write, file fsync and
  // directory fsync, plus directory creation's parent fsync. Throw only after
  // a real partial write or completed fsync, leaving actual on-disk residue.
  let boundaryCount = 0;
  const write = fs.writeSync;
  const sync = fs.fsyncSync;
  fs.writeSync = function (...args) { boundaryCount += 1; return write.apply(this, args); };
  fs.fsyncSync = function (...args) { boundaryCount += 1; return sync.apply(this, args); };
  try { writeTrustedCheckpointMigration(path.join(root, "count"), current, current.checkpoint); }
  finally { fs.writeSync = write; fs.fsyncSync = sync; }
  assert.equal(boundaryCount, 13);
  for (let interrupt = 1; interrupt <= boundaryCount; interrupt += 1) {
    const directory = path.join(root, "interrupted-" + interrupt);
    let operations = 0;
    fs.writeSync = function (fd, bytes, offset, length, position) {
      if (++operations === interrupt) {
        write.call(this, fd, bytes, offset, Math.max(1, Math.floor(length / 2)), position);
        throw new Error("interrupted write");
      }
      return write.call(this, fd, bytes, offset, length, position);
    };
    fs.fsyncSync = function (...args) {
      sync.apply(this, args);
      if (++operations === interrupt) throw new Error("interrupted fsync");
    };
    try { assert.throws(() => writeTrustedCheckpointMigration(directory, current, current.checkpoint), /interrupted/); }
    finally { fs.writeSync = write; fs.fsyncSync = sync; }
    try {
      const restored = restoreTrustedCheckpointMigration(directory, current.checkpoint);
      assert.deepEqual(restored, current, "only an already complete bundle can restore before resume");
    } catch (error) { assert.ok(error instanceof contract.PermitWitnessContractError || error.code === "ENOENT"); }
    const manifest = writeTrustedCheckpointMigration(directory, current, current.checkpoint);
    assert.deepEqual(restoreTrustedCheckpointMigration(directory, current.checkpoint), current);
    assert.deepEqual(writeTrustedCheckpointMigration(directory, current, current.checkpoint), manifest);
  }
});

test("restart after abrupt process exit resumes prefixes; corrupted residue is never overwritten", (t) => {
  const root = migrationRoot(t);
  const directory = path.join(root, "bundle");
  const current = baseline({ ...emptyState(), pins: [{ ...pin(), source_digest: "x".repeat(40000) }] });
  const source = path.join(root, "verified-source.json");
  fs.writeFileSync(source, JSON.stringify(current));
  const modulePath = require.resolve("../../lib/coordination/permit-witness-contract");
  const child = spawnSync(process.execPath, ["-e", `
    const fs = require('node:fs');
    const c = require(process.argv[1]);
    const current = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));
    const write = fs.writeSync;
    let writes = 0;
    fs.writeSync = function(fd, bytes, offset, length, position) {
      if (++writes === 3) {
        write(fd, bytes, offset, 7, position);
        process.exit(71);
      }
      return write(fd, bytes, offset, length, position);
    };
    c.writeTrustedCheckpointMigration(process.argv[2], current, current.checkpoint);
  `, modulePath, directory, source], { encoding: "utf8", timeout: 10000 });
  assert.equal(child.status, 71, child.stderr);
  assert.throws(() => restoreTrustedCheckpointMigration(directory, current.checkpoint));
  const partial = path.join(directory, "chunk-000000000001.bin");
  assert.equal(fs.statSync(partial).size, 7);
  const prefix = fs.readFileSync(partial);
  fs.writeFileSync(partial, "corrupt");
  refuses(() => writeTrustedCheckpointMigration(directory, current, current.checkpoint), "ERR_WITNESS_MIGRATION_CONFLICT");
  assert.equal(fs.readFileSync(partial).toString(), "corrupt");
  fs.writeFileSync(partial, prefix);
  const resumed = spawnSync(process.execPath, ["-e", `
    const fs = require('node:fs');
    const c = require(process.argv[1]);
    const current = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));
    c.writeTrustedCheckpointMigration(process.argv[2], current, current.checkpoint);
  `, modulePath, directory, source], { encoding: "utf8", timeout: 10000 });
  assert.equal(resumed.status, 0, resumed.stderr);
  fs.unlinkSync(source);
  assert.deepEqual(restoreTrustedCheckpointMigration(directory, current.checkpoint), current);
});
