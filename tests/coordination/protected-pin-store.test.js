"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { spawn } = require("node:child_process");
const readline = require("node:readline");
const coordination = require("../../lib/coordination/protected-store-lock");

const {
  ProtectedPinStore,
  publicKeyFingerprint,
  sameBatchIdentity,
  DOMAIN_MARKER_FILE,
  BATCH_IDENTITY_FIELDS,
  REGISTRATION_CARRIED_FIELDS,
} = require("../../lib/coordination/protected-pin-store");
const anchorModule = require("../../lib/coordination/protected-anchor");
const delivery = require("../../lib/coordination/permit-delivery");

test("the carried registration fields are NOT part of the batch identity", () => {
  // The design (section 2.2.3, R3-B3 ruling 1) excludes every carried
  // field from the identity comparison: run_id / generation would kill a
  // legitimate reconnect, the validity window changes on renewal, and
  // the two digests do not tell batches apart.
  //
  // This is asserted rather than left to a comment, because a later
  // change that added run_id to the identity fields would otherwise
  // compile and pass every test that re-registers the same values --
  // and would silently start killing reconnects in production.
  for (const field of REGISTRATION_CARRIED_FIELDS) {
    assert.equal(
      BATCH_IDENTITY_FIELDS.includes(field),
      false,
      field + " must not be part of the batch identity",
    );
  }
  // And the identity is still exactly the design's triple.
  assert.deepEqual(BATCH_IDENTITY_FIELDS, ["decision_id", "instance_id", "fingerprint"]);
});

test("a private PEM is refused before any pin is written", () => {
  const f = fixture();
  try {
    const pair = crypto.generateKeyPairSync("ed25519");
    const privatePem = pair.privateKey.export({ type: "pkcs8", format: "pem" });
    const publicKeyPem = pair.publicKey.export({ type: "spki", format: "pem" });
    let wrote = false;
    assert.throws(() => f.store.registerPin({ batchIdentity: {
      decision_id: "D-test-pin", instance_id: "instance", fingerprint: publicKeyFingerprint(publicKeyPem),
    }, publicKeyPem: privatePem, write: () => { wrote = true; return true; } }), { key: "ERR_PERMIT_INPUT_INVALID" });
    assert.equal(wrote, false);
    assert.deepEqual(f.store.listPins(), []);
  } finally { f.cleanup(); }
});

function fixture(options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "coord-pin-"));
  const pinDir = path.join(dir, "pin");
  fs.mkdirSync(pinDir, { recursive: true });
  const store = ProtectedPinStore.initialize(pinDir, {
    decisionId: options.decisionId || "D-test-pin",
    // The development environment has no separate service identity, so the
    // permission contract is opted out of explicitly here.
    anchorMode: options.anchorMode || anchorModule.ANCHOR_MODE.permissive,
    serviceIdentity: options.serviceIdentity,
    platform: options.platform,
  });
  return {
    dir, pinDir, store,
    cleanup: () => { fs.rmSync(dir, { recursive: true, force: true }); },
  };
}

function keyPair() {
  return delivery.createBatchKeyPair();
}

function batchIdentityFor(key, overrides = {}) {
  return Object.assign({
    decision_id: "D-test-pin",
    instance_id: "test-instance",
    fingerprint: publicKeyFingerprint(key.publicKeyPem),
  }, overrides);
}

function codeOf(fn) {
  try {
    fn();
  } catch (error) {
    assert.ok(error, "expected an error, got nothing thrown");
    // The anchor module raises its own error type; the coordination modules
    // raise CoordinationError. Both carry the machine-readable key.
    assert.ok(error.key || error.code, "expected an error with a key, got " + error);
    return error.key || error.code;
  }
  return null;
}

// The registration action carries the design's field table (section 2.2).
// The pin store requires all six of them, so every registration in these
// tests supplies them through this helper. The values are arbitrary but
// well-formed: the fields are a CARRIED obligation, not an identity
// criterion, so nothing here depends on their particular contents.
function carried(overrides = {}) {
  return Object.assign({
    sourceDigest: "sha256:" + "a".repeat(64),
    deploymentDigest: "sha256:" + "b".repeat(64),
    runId: "run-test-1",
    generation: 7,
    validFrom: 1_000_000,
    validUntil: 1_000_000 + 3_600_000,
  }, overrides);
}

// The pin is written through an atomic create-if-absent. The test double
// writes a marker file with O_EXCL, which is the same primitive the real
// registration path uses.
function atomicCreate(target) {
  return (entry, fingerprint) => {
    try {
      const fd = fs.openSync(target, "wx", 0o600);
      fs.writeFileSync(fd, fingerprint);
      fs.closeSync(fd);
      return true;
    } catch (error) {
      if (error && error.code === "EEXIST") return false;
      throw error;
    }
  };
}

test("a pin registers once and is then reused by the same batch", () => {
  const f = fixture();
  try {
    const key = keyPair();
    const identity = batchIdentityFor(key);
    const target = path.join(f.dir, "pin.marker");

    const first = f.store.registerPin({
      ...carried(),
      batchIdentity: identity,
      publicKeyPem: key.publicKeyPem,
      nowMs: 1_000_000,
      write: atomicCreate(target),
    });
    assert.equal(first.registered, true);
    assert.equal(first.reused, false);

    // A reconnect of the SAME batch reuses the pin. It does not rewrite it
    // and it does not stop the route (design section 2.2.3).
    const again = f.store.registerPin({
      ...carried(),
      batchIdentity: identity,
      publicKeyPem: key.publicKeyPem,
      nowMs: 1_000_001,
      write: atomicCreate(target),
    });
    assert.equal(again.registered, false);
    assert.equal(again.reused, true);
    assert.equal(f.store.listPins().length, 1);
  } finally {
    f.cleanup();
  }
});

test("a pin from a DIFFERENT batch is refused and never overwritten", () => {
  // Design counterexample 24: reconnecting with a new batch must not
  // overwrite an existing pin. The route stops.
  const f = fixture();
  try {
    const key = keyPair();
    const target = path.join(f.dir, "pin.marker");
    f.store.registerPin({
      ...carried(),
      batchIdentity: batchIdentityFor(key),
      publicKeyPem: key.publicKeyPem,
      nowMs: 1_000_000,
      write: atomicCreate(target),
    });

    const otherIdentity = batchIdentityFor(key, { instance_id: "another-instance" });
    assert.equal(
      codeOf(() => f.store.registerPin({
        ...carried(),
        batchIdentity: otherIdentity,
        publicKeyPem: key.publicKeyPem,
        nowMs: 1_000_002,
        write: atomicCreate(target),
      })),
      "ERR_PIN_BATCH_MISMATCH",
    );
    // The original pin is untouched.
    assert.equal(f.store.listPins().length, 1);
    assert.equal(f.store.listPins()[0].instance_id, "test-instance");
  } finally {
    f.cleanup();
  }
});

test("a concurrent registrant that loses the race does not overwrite the winner", () => {
  // Design section 2.2.3: of two concurrent create-if-absent writers only
  // the first succeeds, the second gets EEXIST and does not overwrite.
  const f = fixture();
  try {
    const key = keyPair();
    const target = path.join(f.dir, "pin.marker");
    const identity = batchIdentityFor(key);

    const first = f.store.registerPin({
      ...carried(),
      batchIdentity: identity,
      publicKeyPem: key.publicKeyPem,
      nowMs: 1_000_000,
      write: atomicCreate(target),
    });
    assert.equal(first.registered, true);

    // The marker exists now, so the create-if-absent write reports EEXIST.
    assert.equal(
      codeOf(() => f.store.registerPin({
        ...carried(),
        batchIdentity: batchIdentityFor(key, { instance_id: "other" }),
        publicKeyPem: key.publicKeyPem,
        nowMs: 1_000_001,
        write: atomicCreate(target),
      })),
      "ERR_PIN_BATCH_MISMATCH",
    );
    assert.equal(fs.readFileSync(target, "utf8"), key.fingerprint);
  } finally {
    f.cleanup();
  }
});

test("an existing stale-looking lock is not moved or reclaimed", () => {
  const f = fixture();
  try {
    const lockPath = path.join(f.pinDir, ".pin-critical-section.lock");
    const content = JSON.stringify({ owner: "old", pid: 2147483647, token: "old", expiresAt: "2000-01-01T00:00:00Z" });
    fs.renameSync(lockPath, path.join(f.pinDir, "original-fence"));
    fs.writeFileSync(lockPath, content, { flag: "wx", mode: 0o600 });
    let ran = false;
    assert.equal(codeOf(() => f.store.criticalSection(() => { ran = true; })), "ERR_PIN_STATE_CORRUPT");
    assert.equal(ran, false);
    assert.equal(fs.readFileSync(lockPath, "utf8"), content);
    assert.equal(fs.readdirSync(f.pinDir).some((name) => name.includes(".stale.")), false);
  } finally { f.cleanup(); }
});

test("the fingerprint is derived from the key, not taken from the caller", () => {
  // Design counterexample 15: a fingerprint that disagrees with the
  // snapshot registration is refused. A self-reported fingerprint would
  // let the caller claim an identity the key does not have.
  const f = fixture();
  try {
    const key = keyPair();
    const identity = batchIdentityFor(key, { fingerprint: "f".repeat(64) });
    assert.equal(
      codeOf(() => f.store.registerPin({
        ...carried(),
        batchIdentity: identity,
        publicKeyPem: key.publicKeyPem,
        nowMs: 1_000_000,
        write: atomicCreate(path.join(f.dir, "pin.marker")),
      })),
      "ERR_PIN_FINGERPRINT_MISMATCH",
    );
    assert.equal(f.store.listPins().length, 0);
  } finally {
    f.cleanup();
  }
});

test("the revoked fingerprint set only ever grows", () => {
  // Design section 2.3.1 R4-B4 ruling 6: a commit that would drop a
  // fingerprint is refused and nothing advances.
  const f = fixture();
  try {
    f.store.commitRevocation({
      sequence: 1,
      revokedFingerprints: ["a".repeat(64), "b".repeat(64)],
    });
    const state = f.store.revocationState();
    assert.equal(state.appliedRevocationSequence, 1);
    assert.equal(state.revokedFingerprints.size, 2);

    assert.equal(
      codeOf(() => f.store.commitRevocation({
        sequence: 2,
        revokedFingerprints: ["a".repeat(64)],
      })),
      "ERR_REVOCATION_SET_NOT_MONOTONIC",
    );
    // Nothing advanced: neither the set nor the high-water mark.
    const after = f.store.revocationState();
    assert.equal(after.appliedRevocationSequence, 1);
    assert.equal(after.revokedFingerprints.size, 2);
  } finally {
    f.cleanup();
  }
});

test("the revoked set and the applied high-water mark advance together", () => {
  // Design section 2.3.1 R3-B2 ruling 3, local invariant B: on exit from
  // the critical section either both advanced or neither did.
  const f = fixture();
  try {
    f.store.commitRevocation({ sequence: 1, revokedFingerprints: ["a".repeat(64)] });
    f.store.commitRevocation({ sequence: 2, revokedFingerprints: ["a".repeat(64), "b".repeat(64)] });
    const state = f.store.revocationState();
    assert.equal(state.appliedRevocationSequence, 2);
    assert.equal(state.revokedFingerprints.size, 2);
  } finally {
    f.cleanup();
  }
});

test("a pin entry is never removed by a revocation", () => {
  // Design section 2.3.1 R4-B4 ruling 1: revocation does not remove the
  // public key from the pin. The pin records a registration fact; the
  // revoked set carries the validity judgement. Removing the entry would
  // also deadlock the protocol, because a revoked key could then never
  // sign the list that revokes it.
  const f = fixture();
  try {
    const key = keyPair();
    f.store.registerPin({
      ...carried(),
      batchIdentity: batchIdentityFor(key),
      publicKeyPem: key.publicKeyPem,
      nowMs: 1_000_000,
      write: atomicCreate(path.join(f.dir, "pin.marker")),
    });
    f.store.commitRevocation({ sequence: 1, revokedFingerprints: [key.fingerprint] });

    assert.equal(f.store.listPins().length, 1, "the pin entry survives the revocation");
    assert.equal(f.store.revocationState().revokedFingerprints.has(key.fingerprint), true);
  } finally {
    f.cleanup();
  }
});

test("the direct revocation registration advances the chain by one", () => {
  // Design section 2.3.1 R4-B4 ruling 5: the direct registration is the
  // one exception that does not depend on a cross-machine signature, and
  // it advances the revocation sequence by exactly one so the chain does
  // not break.
  const f = fixture();
  try {
    f.store.registerDirectRevocation({ fingerprint: "c".repeat(64), sequence: 1 });
    const state = f.store.revocationState();
    assert.equal(state.appliedRevocationSequence, 1);
    assert.equal(state.revokedFingerprints.has("c".repeat(64)), true);
  } finally {
    f.cleanup();
  }
});

test("direct revocation rejects gaps and replay without changing state", () => {
  const f = fixture();
  try {
    const fingerprint = "c".repeat(64);
    assert.throws(() => f.store.registerDirectRevocation({ fingerprint, sequence: 2 }),
      { key: "ERR_REVOCATION_SEQUENCE_BROKEN" });
    assert.equal(f.store.revocationState().appliedRevocationSequence, 0);
    assert.equal(f.store.revocationState().revokedFingerprints.size, 0);
    f.store.registerDirectRevocation({ fingerprint, sequence: 1 });
    assert.throws(() => f.store.registerDirectRevocation({ fingerprint: "d".repeat(64), sequence: 1 }),
      { key: "ERR_REVOCATION_SEQUENCE_BROKEN" });
    const state = f.store.revocationState();
    assert.equal(state.appliedRevocationSequence, 1);
    assert.deepEqual([...state.revokedFingerprints], [fingerprint]);
  } finally { f.cleanup(); }
});

test("the verification path only trusts the keys in the pin", () => {
  // Design section 2.3.1 R3-B2 ruling 2: Windows side trusts ONLY the
  // public key in the pin. A key carried by a list itself is never
  // accepted.
  const f = fixture();
  try {
    const key = keyPair();
    assert.equal(f.store.publicKeyFor(key.fingerprint), null);
    f.store.registerPin({
      ...carried(),
      batchIdentity: batchIdentityFor(key),
      publicKeyPem: key.publicKeyPem,
      nowMs: 1_000_000,
      write: atomicCreate(path.join(f.dir, "pin.marker")),
    });
    assert.equal(f.store.publicKeyFor(key.fingerprint), key.publicKeyPem);
    assert.equal(f.store.pinnedFingerprints().has(key.fingerprint), true);
  } finally {
    f.cleanup();
  }
});

test("the pin domain and the permit database directory are kept separate", () => {
  // Design section 4.2.4: the pin domain and the permit database
  // directory must not contain one another. On the two-machine deployment
  // the constraint holds automatically, but a deployment change must not be
  // allowed to violate it quietly.
  const f = fixture();
  try {
    assert.equal(
      codeOf(() => f.store.assertSeparateFromPermitDatabase(path.join(f.pinDir, "authority.sqlite"))),
      "ERR_ANCHOR_NOT_SEPARATE",
    );
    const elsewhere = path.join(f.dir, "elsewhere", "authority.sqlite");
    fs.mkdirSync(path.dirname(elsewhere), { recursive: true });
    fs.writeFileSync(elsewhere, "x");
    f.store.assertSeparateFromPermitDatabase(elsewhere);
  } finally {
    f.cleanup();
  }
});

test("the batch identity comparison is field by field", () => {
  const identity = {
    decision_id: "D-1",
    instance_id: "I-1",
    fingerprint: "f".repeat(64),
  };
  assert.equal(sameBatchIdentity(identity, { ...identity }), true);
  // A missing pin is undecidable, which the reconnect logic treats as NOT
  // the same batch -- the route stops rather than proceeding.
  assert.equal(sameBatchIdentity(null, identity), false);
  // The fields that are deliberately NOT part of the batch identity must
  // not make two pins look different.
  assert.equal(sameBatchIdentity(identity, { ...identity, run_id: "r-1", generation: 2 }), true);
});

test("the clock-poisoning marker is readable and settable", () => {
  const f = fixture();
  try {
    assert.equal(f.store.isClockPoisoned(), false);
    f.store.setClockPoisoned(true);
    assert.equal(f.store.isClockPoisoned(), true);
    f.store.setClockPoisoned(false);
    assert.equal(f.store.isClockPoisoned(), false);
  } finally {
    f.cleanup();
  }
});

test("on Windows the service identity must be declared, or the domain is refused", () => {
  // Design section 4.2.2's acceptance condition, and the reason the
  // design repeats it: on Windows the calling account is not necessarily
  // the service. Without the declaration the comparison degenerates into
  // comparing the caller with itself, and the check would prove nothing.
  //
  // The adapter is injected so that the Windows authorisation model can
  // be exercised on a development machine. The judgement the design cares
  // about -- "the declaration is mandatory on Windows" -- does not depend
  // on the host the test runs on.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "coord-pin-strict-"));
  try {
    const pinDir = path.join(dir, "pin");
    fs.mkdirSync(pinDir, { recursive: true });
    const serviceSid = "sid:S-1-5-80-1234567890-1234567890-1234567890-1234567890";
    const adapter = {
      writableIdentities: () => new Set([serviceSid]),
      currentIdentity: () => serviceSid,
      currentGroups: () => new Set(),
      ownerIdentity: () => serviceSid,
      normalizeIdentity: (value) => (typeof value === "string" && value.startsWith("sid:")
        ? value
        : null),
    };

    // No declaration on Windows: refused.
    assert.equal(
      codeOf(() => ProtectedPinStore.open(pinDir, {
        decisionId: "D-test-strict",
        anchorMode: anchorModule.ANCHOR_MODE.strict,
        platform: "windows",
        adapter,
      })),
      "ERR_ANCHOR_SERVICE_IDENTITY_INVALID",
    );

    // With the declaration the domain opens.
    const store = ProtectedPinStore.initialize(pinDir, {
      decisionId: "D-test-strict",
      anchorMode: anchorModule.ANCHOR_MODE.strict,
      platform: "windows",
      serviceIdentity: serviceSid,
      adapter,
    });
    assert.ok(store);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a declared service identity that is not the caller is refused", () => {
  // The declared identity has to BE the calling identity. A process that
  // merely CAN run as the service would otherwise pass the check by
  // definition.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "coord-pin-caller-"));
  try {
    const pinDir = path.join(dir, "pin");
    fs.mkdirSync(pinDir, { recursive: true });
    const serviceSid = "sid:S-1-5-80-1234567890-1234567890-1234567890-1234567890";
    const otherSid = "sid:S-1-5-21-1111111111-2222222222-3333333333-1001";
    const adapter = {
      writableIdentities: () => new Set([serviceSid]),
      currentIdentity: () => otherSid,
      currentGroups: () => new Set(),
      ownerIdentity: () => otherSid,
      normalizeIdentity: (value) => (typeof value === "string" && value.startsWith("sid:")
        ? value
        : null),
    };
    assert.equal(
      codeOf(() => ProtectedPinStore.open(pinDir, {
        decisionId: "D-test-caller",
        anchorMode: anchorModule.ANCHOR_MODE.strict,
        platform: "windows",
        serviceIdentity: serviceSid,
        adapter,
      })),
      "ERR_ANCHOR_SERVICE_IDENTITY_MISMATCH",
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// The state-loss defences (review blocking item B1).
//
// The old readState() turned EVERY read failure into an empty domain. That
// reset the applied revocation high-water mark and the revoked fingerprint
// set to zero, so a revoked key became authorised again. The state file
// being unreadable and the state file not existing are now different
// facts, and only the second one is an empty domain.

test("an explicitly initialized domain contains durable empty state", () => {
  const f = fixture();
  try {
    assert.equal(f.store.listPins().length, 0);
    assert.equal(f.store.revocationState().appliedRevocationSequence, 0);
    assert.equal(fs.existsSync(path.join(f.pinDir, DOMAIN_MARKER_FILE)), true);
    assert.equal(fs.existsSync(path.join(f.pinDir, "pin-state.json")), true);
  } finally {
    f.cleanup();
  }
});

test("an unreadable state file is refused, not read as an empty domain", () => {
  const f = fixture();
  try {
    const key = keyPair();
    f.store.registerPin({
      ...carried(),
      batchIdentity: batchIdentityFor(key),
      publicKeyPem: key.publicKeyPem,
      nowMs: 1_000,
      write: atomicCreate(path.join(f.dir, "pin.marker")),
    });
    const statePath = path.join(f.pinDir, "pin-state.json");
    fs.chmodSync(statePath, 0o000);
    try {
      assert.equal(codeOf(() => f.store.listPins()), "ERR_PIN_STATE_CORRUPT");
      assert.equal(codeOf(() => f.store.revocationState()), "ERR_PIN_STATE_CORRUPT");
    } finally {
      fs.chmodSync(statePath, 0o600);
    }
  } finally {
    f.cleanup();
  }
});

test("a deleted state file is refused, and the revoked set does not reset to empty", () => {
  const f = fixture();
  try {
    const key = keyPair();
    f.store.registerPin({
      ...carried(),
      batchIdentity: batchIdentityFor(key),
      publicKeyPem: key.publicKeyPem,
      nowMs: 1_000,
      write: atomicCreate(path.join(f.dir, "pin.marker")),
    });
    f.store.commitRevocation({
      sequence: 1,
      revokedFingerprints: ["a".repeat(64)],
    });
    assert.equal(f.store.revocationState().revokedFingerprints.size, 1);
    assert.equal(f.store.revocationState().appliedRevocationSequence, 1);

    // The domain was initialised, so the marker is present.
    assert.equal(fs.existsSync(path.join(f.pinDir, DOMAIN_MARKER_FILE)), true);
    fs.unlinkSync(path.join(f.pinDir, "pin-state.json"));

    // The loss is refused. The revocation state does not come back empty,
    // so the revoked key is not authorised again.
    assert.equal(codeOf(() => f.store.revocationState()), "ERR_PIN_STATE_CORRUPT");
    assert.equal(codeOf(() => f.store.listPins()), "ERR_PIN_STATE_CORRUPT");
  } finally {
    f.cleanup();
  }
});

test("the initialisation marker is written before the first state file", () => {
  const f = fixture();
  try {
    const key = keyPair();
    f.store.registerPin({
      ...carried(),
      batchIdentity: batchIdentityFor(key),
      publicKeyPem: key.publicKeyPem,
      nowMs: 1_000,
      write: atomicCreate(path.join(f.dir, "pin.marker")),
    });
    assert.equal(fs.existsSync(path.join(f.pinDir, DOMAIN_MARKER_FILE)), true);
    assert.equal(fs.existsSync(path.join(f.pinDir, "pin-state.json")), true);
  } finally {
    f.cleanup();
  }
});

function processFixture(t) {
  const f = fixture(), children = [];
  t.after(async () => {
    for (const child of children) if (child.proc.exitCode === null) child.proc.kill("SIGKILL");
    await Promise.all(children.map(child => child.done));
    f.cleanup();
  });
  function child(mode, version) {
    const proc = spawn(process.execPath, [path.join(__dirname, "fixtures/protected-pin-store-process.js"),
      f.pinDir, mode, path.join(f.dir, "release"), ...(version ? [version] : [])], { stdio: ["ignore", "pipe", "pipe"] });
    const events = [], waiters = [];
    let stderr = "", closed = false;
    proc.stderr.on("data", chunk => { stderr += chunk; });
    readline.createInterface({ input: proc.stdout }).on("line", line => {
      const event = JSON.parse(line); events.push(event);
      for (const waiter of [...waiters]) if (waiter.name === event.event) {
        waiters.splice(waiters.indexOf(waiter), 1); clearTimeout(waiter.timer); waiter.resolve(event);
      }
    });
    const done = new Promise((resolve, reject) => {
      proc.once("error", reject);
      proc.once("close", (code, signal) => {
        closed = true;
        for (const waiter of waiters.splice(0)) {
          clearTimeout(waiter.timer); waiter.reject(new Error(`missing ${waiter.name}: ${code}/${signal} ${stderr}`));
        }
        resolve({ code, signal });
      });
    });
    const result = { proc, done, events, wait(name) {
      const event = events.find(event => event.event === name);
      if (event) return Promise.resolve(event);
      if (closed) return Promise.reject(new Error(`child closed: ${stderr}`));
      return new Promise((resolve, reject) => {
        const waiter = { name, resolve, reject };
        waiter.timer = setTimeout(() => {
          waiters.splice(waiters.indexOf(waiter), 1); reject(new Error(`deadline: ${name} ${stderr}`));
        }, 12000);
        waiters.push(waiter);
      });
    } };
    children.push(result); return result;
  }
  return { ...f, child, release() { fs.writeFileSync(path.join(f.dir, "release"), "go"); } };
}

test("two real writers serialize read-decide-write and reject the losing replay", async t => {
  const f = processFixture(t), first = f.child("hold");
  await first.wait("paused");
  const second = f.child("write"); await second.wait("starting");
  f.release();
  assert.equal((await first.wait("result")).ok, true);
  assert.deepEqual(await second.wait("result"), { event: "result", ok: false, code: "ERR_REVOCATION_SEQUENCE_BROKEN" });
  assert.equal(f.store.revocationState().appliedRevocationSequence, 1);
  assert.equal(f.store.assertPermitReplayState(), 1);
  assert.deepEqual([...f.store.revocationState().revokedFingerprints], ["revoked"]);
});

test("contention times out without running business work or deleting either lock", async t => {
  const f = processFixture(t), lockPath = path.join(f.pinDir, coordination.FILE);
  const inode = fs.statSync(lockPath).ino, writer = f.child("hold");
  await writer.wait("paused");
  const contender = f.child("write"), started = Date.now();
  assert.deepEqual(await contender.wait("result"), { event: "result", ok: false, code: "ERR_COORDINATION_BUSY" });
  assert.ok(Date.now() - started < 10000);
  assert.equal(fs.statSync(lockPath).ino, inode);
  assert.equal(fs.existsSync(path.join(f.pinDir, ".pin-critical-section.lock")), true);
  f.release(); assert.equal((await writer.wait("result")).ok, true);
});

test("SIGKILL releases the same SQLite inode and keeps the previous state", async t => {
  const f = processFixture(t), lockPath = path.join(f.pinDir, coordination.FILE);
  const inode = fs.statSync(lockPath).ino;
  f.store.noteRevocationSeen(7);
  const writer = f.child("hold"); await writer.wait("paused"); writer.proc.kill("SIGKILL");
  assert.equal((await writer.done).signal, "SIGKILL");
  const store = ProtectedPinStore.open(f.pinDir, { decisionId: "D-test-pin", anchorMode: "permissive" });
  assert.equal(store.revocationState().highestSeenRevocationSequence, 7);
  store.commitRevocation({ sequence: 1, revokedFingerprints: ["retained"], permitSequence: 8 });
  assert.equal(store.assertPermitReplayState(), 8);
  assert.equal(fs.statSync(lockPath).ino, inode);
});

for (const kind of ["missing", "replaced", "symlink", "hardlink", "mode", "corrupt"]) {
  test(`SQLite lock ${kind} refuses reads, writes and reopen without repair`, () => {
    const f = fixture(), file = path.join(f.pinDir, coordination.FILE), backup = path.join(f.dir, "backup");
    try {
      const state = fs.readFileSync(path.join(f.pinDir, "pin-state.json"));
      if (kind === "missing") fs.unlinkSync(file);
      if (kind === "replaced") { fs.renameSync(file, backup); fs.copyFileSync(backup, file); }
      if (kind === "symlink") { fs.renameSync(file, backup); fs.symlinkSync(backup, file); }
      if (kind === "hardlink") fs.linkSync(file, backup);
      if (kind === "mode") fs.chmodSync(file, 0o666);
      if (kind === "corrupt") fs.writeFileSync(file, "broken");
      assert.throws(() => f.store.listPins());
      let ran = false;
      assert.throws(() => f.store.criticalSection(() => { ran = true; }));
      assert.equal(ran, false);
      assert.throws(() => ProtectedPinStore.open(f.pinDir, { decisionId: "D-test-pin", anchorMode: "permissive" }));
      assert.deepEqual(fs.readFileSync(path.join(f.pinDir, "pin-state.json")), state);
      assert.equal(fs.existsSync(file), kind !== "missing");
    } finally { f.cleanup(); }
  });
}

test("replaced lock during an outer section fences nested business work", () => {
  const f = fixture();
  try {
    let ran = false;
    assert.throws(() => f.store.criticalSection(() => {
      const file = path.join(f.pinDir, coordination.FILE), backup = path.join(f.dir, "backup");
      fs.renameSync(file, backup); fs.copyFileSync(backup, file);
      f.store.criticalSection(() => { ran = true; });
    }), { code: "ERR_COORDINATION_LOCK_REPLACED" });
    assert.equal(ran, false);
  } finally { f.cleanup(); }
});

test("same-handle nesting and thrown bodies release the stable lock", () => {
  const f = fixture();
  try {
    const file = path.join(f.pinDir, coordination.FILE), inode = fs.statSync(file).ino, primary = new Error("PRIMARY");
    assert.equal(f.store.criticalSection(() => f.store.criticalSection(() => 42)), 42);
    assert.throws(() => f.store.criticalSection(() => { throw primary; }), error => error === primary);
    assert.equal(f.store.criticalSection(() => true), true);
    assert.equal(fs.statSync(file).ino, inode);
    let ran = false;
    assert.throws(() => f.store.criticalSection(async () => { ran = true; }), { key: "ERR_PERMIT_INPUT_INVALID" });
    assert.equal(ran, false);
  } finally { f.cleanup(); }
});

function legacyStore(version = 2) {
  const Module = require("node:module"), filename = path.resolve(__dirname, "../../lib/coordination/protected-pin-store.js");
  const compiled = new Module(filename, module);
  compiled.filename = filename;
  compiled.paths = Module._nodeModulePaths(path.dirname(filename));
  compiled._compile(fs.readFileSync(path.join(__dirname, `fixtures/protected-pin-store-v${version}-source.txt`), "utf8"), filename);
  return compiled.exports.ProtectedPinStore;
}

test("open never provisions an empty, legacy or partially lost domain", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pin-open-refuse-"));
  const options = { decisionId: "D-test-pin", anchorMode: "permissive" };
  try {
    assert.throws(() => ProtectedPinStore.open(root, options), { key: "ERR_PIN_STATE_CORRUPT" });
    assert.deepEqual(fs.readdirSync(root), []);
    const old = legacyStore().open(root, options);
    old.commitRevocation({ sequence: 1, revokedFingerprints: ["retained"], permitSequence: 9 });
    const before = fs.readFileSync(path.join(root, "pin-state.json"));
    assert.throws(() => ProtectedPinStore.open(root, options), { key: "ERR_PIN_STATE_CORRUPT" });
    assert.throws(() => ProtectedPinStore.initialize(root, options), { key: "ERR_PIN_STATE_CORRUPT" });
    assert.equal(fs.existsSync(path.join(root, coordination.FILE)), false);
    assert.deepEqual(fs.readFileSync(path.join(root, "pin-state.json")), before);
    fs.unlinkSync(path.join(root, "pin-state.json"));
    assert.throws(() => ProtectedPinStore.migrateOffline(root, { ...options, offline: true }), { key: "ERR_PIN_STATE_CORRUPT" });
    assert.equal(fs.existsSync(path.join(root, coordination.FILE)), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("explicit offline format-2 migration retains pins, revocations, replay and clock baselines", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pin-migrate-"));
  const options = { decisionId: "D-test-pin", anchorMode: "permissive" };
  try {
    const old = legacyStore().open(root, options), key = keyPair();
    old.registerPin({ ...carried(), batchIdentity: batchIdentityFor(key), publicKeyPem: key.publicKeyPem,
      nowMs: 1000, write: () => true });
    old.commitRevocation({ sequence: 1, revokedFingerprints: [key.fingerprint], permitSequence: 19 });
    old.noteRevocationSeen(7); old.observePermitClock(12345); old.setClockPoisoned(true);
    const before = JSON.parse(fs.readFileSync(path.join(root, "pin-state.json")));
    assert.throws(() => ProtectedPinStore.migrateOffline(root, options), { key: "ERR_PERMIT_INPUT_INVALID" });
    const migrated = ProtectedPinStore.migrateOffline(root, { ...options, offline: true });
    const after = JSON.parse(fs.readFileSync(path.join(root, "pin-state.json")));
    assert.deepEqual(after, { ...before, schema_version: 3 });
    assert.equal(migrated.assertPermitReplayState(), 19);
    assert.equal(migrated.isClockPoisoned(), true);
    assert.equal(migrated.listPins().length, 1);
    assert.throws(() => old.listPins(), { key: "ERR_PIN_STATE_CORRUPT" });
    assert.throws(() => old.commitRevocation({ sequence: 2, revokedFingerprints: [] }), { key: "ERR_LEASE_CONFLICT" });
    assert.throws(() => ProtectedPinStore.migrateOffline(root, { ...options, offline: true }), { key: "ERR_PIN_STATE_CORRUPT" });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("a live legacy holder prevents migration without touching state or either lock", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pin-live-legacy-"));
  const options = { decisionId: "D-test-pin", anchorMode: "permissive" };
  try {
    const old = legacyStore().open(root, options);
    old.commitRevocation({ sequence: 1, revokedFingerprints: ["retained"] });
    const before = fs.readFileSync(path.join(root, "pin-state.json"));
    old.criticalSection(() => {
      const lock = fs.readFileSync(path.join(root, ".pin-critical-section.lock"));
      assert.throws(() => ProtectedPinStore.migrateOffline(root, { ...options, offline: true }), { code: "EEXIST" });
      assert.deepEqual(fs.readFileSync(path.join(root, ".pin-critical-section.lock")), lock);
      assert.equal(fs.existsSync(path.join(root, coordination.FILE)), false);
    });
    assert.deepEqual(fs.readFileSync(path.join(root, "pin-state.json")), before);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

for (const version of ["1", "2"]) test(`real legacy format-${version} process refuses new state before writing`, async t => {
  const f = processFixture(t), before = fs.readFileSync(path.join(f.pinDir, "pin-state.json"));
  const reader = f.child("read", version);
  assert.deepEqual(await reader.wait("result"), { event: "result", ok: false, code: "ERR_PIN_STATE_CORRUPT" });
  const writer = f.child("write", version), result = await writer.wait("result");
  assert.equal(result.ok, false);
  assert.ok(["ERR_LEASE_CONFLICT", "ERR_PIN_STATE_CORRUPT"].includes(result.code));
  assert.deepEqual(fs.readFileSync(path.join(f.pinDir, "pin-state.json")), before);
});

test("legacy format 1 cannot migrate by guessing missing replay and clock history", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pin-v1-blocked-"));
  const options = { decisionId: "D-test-pin", anchorMode: "permissive" };
  try {
    legacyStore(1).open(root, options).commitRevocation({ sequence: 1, revokedFingerprints: ["retained"] });
    const before = fs.readFileSync(path.join(root, "pin-state.json"));
    assert.throws(() => ProtectedPinStore.migrateOffline(root, { ...options, offline: true }), { key: "ERR_PIN_STATE_CORRUPT" });
    assert.deepEqual(fs.readFileSync(path.join(root, "pin-state.json")), before);
    assert.equal(fs.existsSync(path.join(root, coordination.FILE)), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

for (const point of ["marker", "state"]) test(`failed ${point} provisioning stays closed and is never silently reset`, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pin-init-fault-"));
  const options = { decisionId: "D-test-pin", anchorMode: "permissive" }, rename = fs.renameSync;
  const target = path.join(root, point === "marker" ? "pin-domain.json" : "pin-state.json");
  try {
    fs.renameSync = function(from, to) {
      if (to === target) throw Object.assign(new Error("injected"), { code: "EIO" });
      return rename.call(this, from, to);
    };
    assert.throws(() => ProtectedPinStore.initialize(root, options), { code: "EIO" });
  } finally { fs.renameSync = rename; }
  try {
    const inode = fs.statSync(path.join(root, coordination.FILE)).ino;
    assert.throws(() => ProtectedPinStore.open(root, options));
    assert.throws(() => ProtectedPinStore.initialize(root, options), { key: "ERR_PIN_STATE_CORRUPT" });
    assert.equal(fs.statSync(path.join(root, coordination.FILE)).ino, inode);
    assert.equal(fs.existsSync(path.join(root, ".pin-critical-section.lock")), true);
    assert.equal(fs.readdirSync(root).some(name => name.includes(".tmp-")), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
