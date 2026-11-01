"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawnSync, fork } = require("node:child_process");
const sqlite = Number(process.versions.node.split(".")[0]) >= 24 ? require("node:sqlite") : {};
const anchor = require("../../lib/coordination/protected-anchor");
const witness = require("../../lib/coordination/permit-witness-contract");
const { ProtectedPermitStore: Store } = require("../../lib/coordination/protected-permit-store");
const helper = require("./fixtures/permit-authority-admission");
const childFile = require.resolve("./fixtures/permit-authority-admission");
const supported = { skip: Number(process.versions.node.split(".")[0]) < 24 || !["darwin", "linux"].includes(process.platform) };
function fixture(t, { initialize = true, ...override } = {}) {
  const root = path.resolve(__dirname, "../../.agent/runtime/test-tmp"); fs.mkdirSync(root, { recursive: true });
  const dir = fs.mkdtempSync(path.join(root, "permit-authority-admission-"));
  const dbDir = path.join(dir, "db"), anchorDir = path.join(dir, "anchor");
  fs.mkdirSync(dbDir); fs.mkdirSync(anchorDir, { mode: 0o700 });
  const a = helper.authority(override), file = path.join(dbDir, "state.sqlite");
  const options = helper.options(anchorDir, a.providers), stores = [];
  const f = { ...a, file, dir, anchorDir, options };
  f.track = store => { stores.push(store); return store; };
  f.open = (extra = {}) => f.track(Store.open(file, { ...options, ...extra }));
  if (initialize) f.store = f.track(Store.initialize(file, options));
  t.after(() => { for (const store of stores) store.close(); });
  return f;
}
function raw(f) {
  const db = new sqlite.DatabaseSync(f.file, { readOnly: true });
  try { return JSON.parse(db.prepare("SELECT body FROM protected_state WHERE id=1").get().body); }
  finally { db.close(); }
}
function child(f, input = helper.request(), extra = {}) {
  const payload = { file: f.file, anchorDir: f.anchorDir, input, ...extra };
  if (f.options.expectedDecisionId !== "D-admission") {
    payload.decisionIdFile = path.join(f.dir, "child-decision-id.txt");
    fs.writeFileSync(payload.decisionIdFile, f.options.expectedDecisionId);
  }
  if (Buffer.byteLength(JSON.stringify(input)) > 60000) {
    payload.inputFile = path.join(f.dir, `child-input-${crypto.randomBytes(8).toString("hex")}.json`);
    fs.writeFileSync(payload.inputFile, JSON.stringify(input)); delete payload.input;
  }
  const result = spawnSync(process.execPath, [childFile, JSON.stringify(payload)],
    { encoding: "utf8", timeout: 15000 });
  assert.equal(result.status, extra.fault === "ack-lost" ? 74 : extra.fault === "crash-after-db-commit" ? 73 : 0, result.stderr);
  return result.stdout ? JSON.parse(result.stdout) : null;
}
function patch(object, key, value, action) {
  const before = object[key]; object[key] = value;
  try { return action(before); } finally { object[key] = before; }
}
function admit(f, input = helper.request(), peer = f.peer) { return f.store.admitAuthorityRequest(peer, input); }
function admission(f) { return raw(f).witness_authority.request_admission; }

// This is an admission-only slice; it never claims a working issuance path.
test("admission occupies original SQLite state/anchor domain; canonical retries locate one immutable attempt", supported, t => {
  const f = fixture(t), input = helper.request(), initial = f.store.snapshot();
  const result = admit(f, input);
  assert.equal(result.status, "admitted"); assert.equal(result.executionAuthorized, false);
  assert.equal(result.resumeAllowed, false); assert.equal(result.originalRequestOutcome, "unknown");
  const snapshot = f.store.snapshot(), a = snapshot.witness_authority.request_admission;
  assert.equal(snapshot.schema_version, 4); assert.equal(a.sequence, 1);
  assert.equal(snapshot.anchor_sequence, initial.anchor_sequence + 1);
  assert.equal(anchor.readHighWater(f.anchorDir).mark, snapshot.anchor_sequence);
  const record = a.attempts[result.attemptId], bytes = witness.canonicalBytes(input).toString("utf8");
  assert.equal(record.request_bytes, bytes);
  assert.equal(record.request_digest, crypto.createHash("sha256").update(bytes).digest("hex"));
  assert.deepEqual(record.principal, helper.principal);
  assert.deepEqual(record.grant, { id: "fixture-grant", version: 1 });
  assert.deepEqual(Object.values(a.associations), [result.attemptId]);
  assert.deepEqual(Object.values(a.business_keys), [result.attemptId]);
  assert.deepEqual(Object.values(a.resources), [result.attemptId]);
  assert.deepEqual(admit(f, { ...input, request: { params: { value: 1 }, targetId: "synthetic-target", checkpoint: null } }), result);
  input.request.params.value = 2;
  assert.throws(() => admit(f, input), { code: "ERR_WITNESS_REQUEST_CONFLICT" });
  assert.deepEqual(admission(f), a);
  const db = new sqlite.DatabaseSync(f.file, { readOnly: true });
  try {
    assert.deepEqual(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name), ["protected_state"]);
    assert.equal(db.prepare("PRAGMA user_version").get().user_version, 4);
  } finally { db.close(); }
});

test("real process restart and lost ACK preserve original association and reservations", supported, t => {
  const f = fixture(t); f.store.close();
  child(f, helper.request(), { fault: "ack-lost" });
  const record = Object.values(admission(f).attempts)[0];
  const retried = child(f).result;
  assert.equal(retried.attemptId, record.attempt_id);
  assert.deepEqual(child(f, helper.request(), { lookup: true }).result, retried);
  assert.equal(child(f, helper.request({ request: { different: true } })).error, "ERR_WITNESS_REQUEST_CONFLICT");
  assert.equal(child(f, helper.request({ requestKey: "new-key" })).error, "ERR_WITNESS_REQUEST_BLOCKED");
  assert.equal(child(f, helper.request({ requestKey: "new-key", resourceScope: "different-resource" })).error, "ERR_WITNESS_REQUEST_BLOCKED");
  assert.equal(child(f, helper.request({ requestKey: "new-key", businessKey: "different-business" })).error, "ERR_WITNESS_REQUEST_BLOCKED");
  assert.equal(admission(f).sequence, 1);
});

test("cross subject/action/grant/time changes do not release unknown business or resource reservations", supported, t => {
  const f = fixture(t); admit(f);
  assert.throws(() => admit(f, helper.request({ requestKey: "other", action: "renew" }), f.other), { code: "ERR_WITNESS_REQUEST_BLOCKED" });
  const notFound = f.store.lookupAuthorityRequest(f.other, helper.request());
  assert.equal(notFound.status, "not-found"); assert.equal(notFound.attemptId, undefined);
  assert.equal(notFound.originalRequestOutcome, "unknown");
  f.store.close(); f.store = f.open({ clock: () => 999999 });
  assert.throws(() => admit(f, helper.request({ requestKey: "late" })), { code: "ERR_WITNESS_REQUEST_BLOCKED" });
  const independent = admit(f, helper.request({ requestKey: "independent", resourceScope: "resource-b", businessKey: "business-b" }));
  assert.notEqual(independent.attemptId, Object.keys(admission(f).attempts)[0]);
});

for (const value of [true, false, null, Promise.resolve(true)]) {
  test(`boolean/missing/async authorization is insufficient (${String(value)})`, supported, t => {
    const f = fixture(t, { authorize: () => value }), before = raw(f);
    assert.throws(() => admit(f), { code: "ERR_WITNESS_NOT_AUTHORIZED" });
    assert.deepEqual(raw(f), before);
  });
}

test("caller principal, forged peer, accessors and incomplete resource grants cannot authenticate", supported, t => {
  const f = fixture(t), before = raw(f);
  assert.throws(() => admit(f, helper.request(), { ...helper.principal, principal: helper.principal }), { code: "ERR_WITNESS_NOT_AUTHORIZED" });
  assert.throws(() => admit(f, { ...helper.request(), principal: helper.principal }));
  let getter = 0;
  assert.throws(() => admit(f, { ...helper.request(), get requestKey() { getter++; return "forged"; } }));
  assert.equal(getter, 0);
  const g = fixture(t, { authorize: () => ({ principal: helper.principal, grant: { id: "g", version: 1 }, resources: {} }) });
  assert.throws(() => admit(g), { code: "ERR_WITNESS_NOT_AUTHORIZED" });
  assert.deepEqual(raw(f), before);
});

test("provider facts are detached and must remain stable during authorization; nested admission is refused", supported, t => {
  const principal = { ...helper.principal }; let calls = 0, f;
  const authorize = (peer, operation, request) => {
    assert.equal(Object.isFrozen(request.request), true);
    assert.throws(() => f.store.admitAuthorityRequest(peer, request), { code: "ERR_WITNESS_ADMISSION_ACTIVE" });
    return { principal, grant: { id: "g", version: ++calls }, resources: request };
  };
  f = fixture(t, { authorize });
  assert.throws(() => admit(f), { code: "ERR_WITNESS_NOT_AUTHORIZED" });
  assert.equal(admission(f).sequence, 0);
  const g = fixture(t, { authorize: (peer, operation, request) => ({ principal, grant: { id: "g", version: 1 }, resources: request }) });
  const result = admit(g); principal.subjectId = "mutated-after-return";
  assert.equal(admission(g).attempts[result.attemptId].principal.subjectId, "subject-a");
});

async function contend(t, f, inputs) {
  const children = inputs.map(input => fork(childFile, [JSON.stringify({ file: f.file, anchorDir: f.anchorDir, input })],
    { silent: true }));
  t.after(() => { for (const child of children) if (child.exitCode === null) child.kill(); });
  const completions = children.map(child => new Promise((resolve, reject) => {
    let output = "", errorOutput = "";
    child.stdout.on("data", data => { output += data; }); child.stderr.on("data", data => { errorOutput += data; });
    child.on("error", reject);
    child.on("exit", code => code === 0 ? resolve(JSON.parse(output)) : reject(Error(errorOutput || `exit ${code}`)));
  }));
  await Promise.all(children.map(child => new Promise(resolve => child.once("message", resolve))));
  for (const child of children) child.send("go");
  return Promise.all(completions);
}
for (const same of [true, false]) {
  test(`independent SQLite processes contend on ${same ? "same" : "different"} request keys`, { ...supported, timeout: 20000 }, async t => {
    const f = fixture(t); f.store.close();
    const outputs = await contend(t, f, [helper.request(), helper.request({ requestKey: same ? "request-1" : "request-2" })]);
    if (same) assert.deepEqual(outputs[0].result, outputs[1].result);
    else {
      assert.equal(outputs.filter(output => output.result).length, 1);
      assert.equal(outputs.find(output => output.error).error, "ERR_WITNESS_REQUEST_BLOCKED");
    }
    assert.equal(admission(f).sequence, 1);
  });
}

test("audit failure before COMMIT has no admission, returns no capability, and poisons handle", supported, t => {
  const f = fixture(t), before = raw(f), sync = fs.fsyncSync;
  patch(fs, "fsyncSync", fd => {
    if (new Error().stack.includes("#writeAudit") && fs.fstatSync(fd).isFile()) throw Error("audit fixture");
    return sync(fd);
  }, () => assert.throws(() => admit(f), { code: "ERR_AUDIT_WRITE_FAILED" }));
  assert.deepEqual(raw(f), before);
  assert.throws(() => admit(f), { code: "ERR_COMMIT_OUTCOME_UNKNOWN" });
  f.store.close(); assert.equal(child(f).result.status, "admitted");
});

for (const point of ["before-commit", "commit-return", "anchor-commit", "highwater"]) {
  test(`admission ${point} failure cannot return an attempt or business capability`, supported, t => {
    const f = fixture(t), before = raw(f);
    const action = () => assert.throws(() => admit(f), /fixture fault/);
    if (point === "before-commit" || point === "commit-return") {
      const exec = sqlite.DatabaseSync.prototype.exec;
      patch(sqlite.DatabaseSync.prototype, "exec", function(sql) {
        if (sql === "COMMIT" && new Error().stack.includes("#transactionUnlocked")) {
          if (point === "commit-return") exec.call(this, sql);
          throw Error("fixture fault");
        }
        return exec.call(this, sql);
      }, action);
    } else if (point === "anchor-commit") {
      const append = anchor.appendEntry;
      patch(anchor, "appendEntry", (...args) => {
        if (args[1].type === "commit") throw Error("fixture fault");
        return append(...args);
      }, action);
    } else patch(anchor, "appendHighWater", () => { throw Error("fixture fault"); }, action);
    assert.throws(() => admit(f), { code: "ERR_COMMIT_OUTCOME_UNKNOWN" });
    if (point === "before-commit") assert.deepEqual(raw(f), before);
    else assert.equal(admission(f).sequence, 1);
    f.store.close();
    if (point === "before-commit") assert.equal(child(f).result.status, "admitted");
    else {
      assert.equal(child(f).error, "ERR_CRASH_WINDOW_RECOVERABLE");
      assert.equal(child(f, helper.request({ requestKey: "replacement" })).error, "ERR_CRASH_WINDOW_RECOVERABLE");
    }
  });
}

test("actual process death after DB commit leaves persistent reservation and blocks reopen", supported, t => {
  const f = fixture(t); f.store.close();
  child(f, helper.request(), { fault: "crash-after-db-commit" });
  assert.equal(admission(f).sequence, 1);
  assert.equal(child(f).error, "ERR_CRASH_WINDOW_RECOVERABLE");
  assert.equal(child(f, helper.request({ requestKey: "replacement", businessKey: "new", resourceScope: "new" })).error,
    "ERR_CRASH_WINDOW_RECOVERABLE");
});

test("unknown reservation/index missing or corrupt freezes even with a rewritten DB digest", supported, t => {
  const f = fixture(t); admit(f); f.store.close();
  const db = new sqlite.DatabaseSync(f.file);
  const state = raw(f); state.witness_authority.request_admission.resources = {};
  const body = JSON.stringify(state);
  db.prepare("UPDATE protected_state SET body=?, sha256=? WHERE id=1").run(body, crypto.createHash("sha256").update(body).digest("hex"));
  db.close(); assert.equal(child(f).error, "ERR_STATE_INVALID");
});

test("clock rollback poison persists without releasing reservations", supported, t => {
  const f = fixture(t); admit(f); f.store.close();
  assert.throws(() => f.open({ clock: () => 999 }), { code: "ERR_CLOCK_ROLLBACK" });
  const state = raw(f); assert.equal(state.witness_authority.clock_poisoned, true);
  assert.equal(state.witness_authority.request_admission.sequence, 1);
  assert.equal(child(f).error, "ERR_WITNESS_CLOCK");
});

test("schema4 refuses legacy/dev writers, weaker open, history and every static recovery route", supported, t => {
  const f = fixture(t); admit(f); const before = raw(f);
  for (const method of ["registerWitnessTarget", "issueWitnessPermit", "consumeWithCheckpoint"]) {
    assert.throws(() => f.store[method](f.peer, {}), { code: "ERR_WITNESS_ADMISSION_ONLY" });
  }
  const lease = { owner: "o", sessionId: "s", hostId: "h", workerId: "w", runId: "r", generation: "g",
    desktopKey: "d", ownedAppId: "a", idempotencyKey: "l", ttlMs: 1000 };
  const permit = { idempotencyKey: "p", operation: "op", targetDigest: "a".repeat(64), paramsDigest: "b".repeat(64), ttlMs: 1000 };
  for (const [method, args] of [
    ["acquire", [lease]], ["acquireAndReserveBoundToBatch", [lease, permit, "c".repeat(64), () => { throw Error("must not sign"); }]],
    ["renew", [{ ttlMs: 1000 }]], ["reserve", [permit]], ["reserveBoundToBatch", [permit, "c".repeat(64)]],
    ["consume", [{}]], ["finish", [{ outcome: "unknown" }]], ["revoke", [{}]], ["release", [{}]], ["expire", []],
    ["restartService", []], ["recover", [{}]],
  ]) assert.throws(() => f.store[method](...args), { code: "ERR_WITNESS_LEGACY_ENTRY_DISABLED" }, method);
  assert.throws(() => f.store.queryWitnessHistory(f.peer, {}));
  assert.deepEqual(raw(f), before);
  f.store.close();
  for (const providers of [undefined, { ...f.providers, admissionMode: undefined }, { ...f.providers, admissionMode: "production" }]) {
    assert.throws(() => f.open({ witnessAuthority: providers }), { code: "ERR_WITNESS_AUTHORITY_DISABLED" });
  }
  for (const method of ["recoverFromAnchorCrash", "rebuildAnchor", "resetAfterAnchorLoss"]) {
    assert.throws(() => Store[method](f.file, { ...f.options, audit: { by: "fixture", reason: "no bypass" } }),
      { code: "ERR_WITNESS_RECOVERY_UNSUPPORTED" });
  }
});

for (const legacy of [true, false]) {
  test(`existing schema${legacy ? 2 : 3} opens unchanged; admission cannot silently upgrade it`, supported, t => {
    const f = fixture(t, { initialize: false });
    const providers = legacy ? undefined : { ...f.providers, admissionMode: undefined };
    f.store = f.track(Store.initialize(f.file, { ...f.options, witnessAuthority: providers }));
    assert.equal(raw(f).schema_version, legacy ? 2 : 3);
    assert.throws(() => admit(f), { code: "ERR_WITNESS_AUTHORITY_DISABLED" });
    f.store.close();
    assert.throws(() => f.open(), { code: "ERR_WITNESS_AUTHORITY_DISABLED" });
    const reopened = f.open({ witnessAuthority: providers });
    assert.equal(reopened.snapshot().schema_version, legacy ? 2 : 3);
    assert.equal(Object.hasOwn(reopened.snapshot().witness_authority || {}, "request_admission"), false);
  });
}

test("lookup authorization is independent, revocation cannot erase existing association, and grant rotation preserves it", supported, t => {
  let lookupAllowed = false, version = 1;
  const f = fixture(t, { authorize: (peer, operation, input) => {
    if (operation === "request.lookup" && !lookupAllowed) return false;
    return { principal: helper.principal, grant: { id: "rotating-grant", version }, resources: input };
  } });
  const original = admit(f), before = admission(f);
  assert.throws(() => f.store.lookupAuthorityRequest(f.peer, helper.request()), { code: "ERR_WITNESS_NOT_AUTHORIZED" });
  assert.deepEqual(admission(f), before);
  lookupAllowed = true; version = 2;
  assert.deepEqual(f.store.lookupAuthorityRequest(f.peer, helper.request()), original);
  assert.deepEqual(admit(f), original);
  assert.deepEqual(admission(f), before);
});

test("provider cannot reenter snapshot/close/history/legacy mutation during admission", supported, t => {
  let f;
  f = fixture(t, { authorize: (peer, operation, input) => {
    for (const action of [() => f.store.snapshot(), () => f.store.close(), () => f.store.restartService(),
      () => f.store.queryWitnessHistory(peer, {})]) {
      assert.throws(action, { code: "ERR_WITNESS_ADMISSION_ACTIVE" });
    }
    return { principal: helper.principal, grant: { id: "g", version: 1 }, resources: input };
  } });
  assert.equal(admit(f).status, "admitted");
});

for (const index of ["attempts", "associations", "business_keys", "resources"]) {
  test(`schema4 rejects ${index} replaced by an array even when empty`, supported, t => {
    const f = fixture(t); f.store.close();
    const state = raw(f); state.witness_authority.request_admission[index] = [];
    const body = JSON.stringify(state), db = new sqlite.DatabaseSync(f.file);
    db.prepare("UPDATE protected_state SET body=?, sha256=? WHERE id=1").run(body, crypto.createHash("sha256").update(body).digest("hex"));
    db.close(); assert.equal(child(f).error, "ERR_STATE_INVALID");
  });
}

test("request change at same key keeps clock safety state when refusing conflict", supported, t => {
  const f = fixture(t); admit(f); f.store.close();
  // Open at a valid clock, then observe rollback during the refusal itself.
  let clock = 1000;
  f.store = f.open({ clock: () => clock }); clock = 999;
  assert.throws(() => admit(f, helper.request({ request: { changed: true } })), { code: "ERR_WITNESS_CLOCK" });
  assert.equal(raw(f).witness_authority.clock_poisoned, true);
  assert.equal(admission(f).sequence, 1);
});

test("failure while locating an existing admission never releases the original unknown across restart", supported, t => {
  const f = fixture(t), original = admit(f), before = admission(f);
  const sync = fs.fsyncSync;
  patch(fs, "fsyncSync", fd => {
    if (new Error().stack.includes("#writeAudit") && fs.fstatSync(fd).isFile()) throw Error("lookup audit fixture");
    return sync(fd);
  }, () => assert.throws(() => f.store.lookupAuthorityRequest(f.peer, helper.request()), { code: "ERR_AUDIT_WRITE_FAILED" }));
  assert.deepEqual(admission(f), before);
  f.store.close();
  assert.deepEqual(child(f, helper.request(), { lookup: true }).result, original);
  assert.equal(child(f, helper.request({ requestKey: "try-another" })).error, "ERR_WITNESS_REQUEST_BLOCKED");
});

test("an aborted allocation does not reuse its attempt ID on a later committed admission", supported, t => {
  const f = fixture(t), append = anchor.appendEntry, randomBytes = crypto.randomBytes; let abandoned;
  patch(anchor, "appendEntry", (...args) => {
    const result = append(...args);
    if (args[1].type === "intent") throw Error("abort admission before DB update");
    return result;
  }, () => patch(crypto, "randomBytes", (size, ...args) => {
    if (size !== 16) return randomBytes(size, ...args);
    abandoned = `admission:${raw(f).store_id}:${"01".repeat(16)}`;
    return Buffer.alloc(16, 1);
  }, () => assert.throws(() => admit(f), /abort admission before DB update/)));
  assert.equal(admission(f).sequence, 0);
  const result = admit(f);
  assert.notEqual(result.attemptId, abandoned);
  assert.equal(admission(f).sequence, 1);
});

test("restoring a pre-admission SQLite body cannot discard the unknown behind the anchor high-water", supported, t => {
  const f = fixture(t), initial = raw(f); admit(f); f.store.close();
  const body = JSON.stringify(initial), db = new sqlite.DatabaseSync(f.file);
  db.prepare("UPDATE protected_state SET body=?, sha256=? WHERE id=1").run(body, crypto.createHash("sha256").update(body).digest("hex"));
  db.close(); assert.equal(child(f).error, "ERR_STATE_ROLLED_BACK");
});

test("production admission configuration refuses before provisioning any database", supported, t => {
  const f = fixture(t, { initialize: false, admissionMode: "production" });
  assert.throws(() => Store.initialize(f.file, f.options), { code: "ERR_WITNESS_AUTHORITY_DISABLED" });
  assert.equal(fs.existsSync(f.file), false);
  assert.deepEqual(fs.readdirSync(f.anchorDir), []);
});

function distinctRequest(index, request = { small: true }) {
  return helper.request({ requestKey: `capacity-request-${index}`, resourceScope: `capacity-resource-${index}`,
    businessKey: `capacity-business-${index}`, request });
}

test("legal 65,660-byte request and deeply escaped saved bytes survive actual SQLite restart", supported, t => {
  const f = fixture(t);
  const input = helper.request({ request: { payload: "x".repeat(65536) } });
  assert.equal(witness.canonicalBytes(input).length, 65660);
  const original = admit(f, input);
  const escaped = distinctRequest(1, { payload: "\u0000".repeat(65536) });
  assert.ok(witness.canonicalBytes(escaped).length > 390000);
  const escapedResult = admit(f, escaped);
  const state = admission(f);
  assert.equal(state.attempts[original.attemptId].request_bytes, witness.canonicalBytes(input).toString("utf8"));
  assert.equal(state.attempts[escapedResult.attemptId].request_bytes, witness.canonicalBytes(escaped).toString("utf8"));
  assert.deepEqual(admit(f, input), original);
  f.store.close();
  assert.deepEqual(child(f, input, { lookup: true }).result, original);
  assert.deepEqual(child(f, escaped).result, escapedResult);
  assert.equal(child(f, { ...input, requestKey: "unknown-cannot-release" }).error, "ERR_WITNESS_REQUEST_BLOCKED");
  assert.deepEqual(admission(f), state);
});

test("maximal online byte/depth/node boundaries are not charged again by authorization or storage wrappers", supported, t => {
  const f = fixture(t);
  const byteInput = distinctRequest(1, { payload: Array.from({ length: 16 }, () => "x".repeat(65520)) });
  const initialLength = witness.canonicalBytes(byteInput).length;
  byteInput.request.padding = "";
  byteInput.request.padding = "p".repeat(witness.LIMITS.bytes - witness.canonicalBytes(byteInput).length);
  assert.ok(initialLength < witness.LIMITS.bytes);
  assert.equal(witness.canonicalBytes(byteInput).length, witness.LIMITS.bytes);
  const byteResult = admit(f, byteInput);
  let deep = 1;
  for (let i = 0; i < witness.LIMITS.depth - 1; i++) deep = { child: deep };
  const depthInput = distinctRequest(2, deep);
  assert.doesNotThrow(() => witness.canonicalBytes(depthInput));
  assert.throws(() => witness.canonicalBytes({ wrap: depthInput }));
  const depthResult = admit(f, depthInput);
  // Envelope=6 nodes, payload property=1, array=1, 19*(array+1000)
  // plus one array+973 leaves. Total exactly the online 20,000-node budget.
  const nodeInput = distinctRequest(3, { payload: [...Array.from({ length: 19 }, () => Array(1000).fill(0)), Array(973).fill(0)] });
  assert.doesNotThrow(() => witness.canonicalBytes(nodeInput));
  assert.throws(() => witness.canonicalBytes({ wrap: nodeInput }));
  const nodeResult = admit(f, nodeInput);
  f.store.close();
  for (const [input, result] of [[byteInput, byteResult], [depthInput, depthResult], [nodeInput, nodeResult]]) {
    assert.deepEqual(child(f, input, { lookup: true }).result, result);
  }
});

test("34th legal 30KB request and aggregate history above 1MiB remain valid across restart", supported, t => {
  const f = fixture(t), originals = [];
  for (let i = 0; i < 40; i++) originals.push(admit(f, distinctRequest(i, { payload: "x".repeat(30000) })));
  const before = admission(f);
  assert.equal(before.sequence, 40);
  assert.ok(Buffer.byteLength(JSON.stringify(before)) > 1024 * 1024);
  for (const i of [0, 33, 39]) {
    assert.equal(before.attempts[originals[i].attemptId].request_bytes,
      witness.canonicalBytes(distinctRequest(i, { payload: "x".repeat(30000) })).toString("utf8"));
  }
  f.store.close();
  for (const i of [0, 33, 39]) assert.deepEqual(child(f, distinctRequest(i, { payload: "x".repeat(30000) }), { lookup: true }).result, originals[i]);
  assert.deepEqual(admission(f), before);
  f.store = f.open();
  assert.equal(admit(f, distinctRequest(40, { payload: "x".repeat(30000) })).status, "admitted");
});

test("exact escaped storage byte capacity refuses without changing history; original unknown and lookups survive restart", supported, t => {
  const f = fixture(t), large = { payload: Array.from({ length: 15 }, () => "\u0000".repeat(10000)) };
  const inputs = [], results = []; let refused, before;
  for (let i = 0; i < 16; i++) {
    const input = distinctRequest(i, large);
    assert.ok(witness.canonicalBytes(input).length < witness.LIMITS.bytes);
    before = f.store.snapshot();
    try { results.push(admit(f, input)); inputs.push(input); }
    catch (error) { assert.equal(error.code, "ERR_WITNESS_ADMISSION_CAPACITY"); refused = input; break; }
  }
  assert.ok(refused);
  assert.ok(inputs.length > 1 && inputs.length < 16);
  const stored = admission(f);
  assert.ok(Buffer.byteLength(JSON.stringify(stored)) <= 8 * 1024 * 1024);
  assert.ok(Buffer.byteLength(JSON.stringify(stored)) > 1024 * 1024);
  assert.deepEqual(f.store.snapshot(), before);
  assert.throws(() => admit(f, refused), { code: "ERR_WITNESS_ADMISSION_CAPACITY" });
  assert.deepEqual(f.store.snapshot(), before);
  assert.deepEqual(admit(f, inputs[0]), results[0]);
  assert.deepEqual(f.store.lookupAuthorityRequest(f.peer, inputs[0]), results[0]);
  assert.equal(f.store.lookupAuthorityRequest(f.peer, refused).status, "not-found");
  assert.throws(() => admit(f, { ...inputs[0], request: { changed: true } }), { code: "ERR_WITNESS_REQUEST_CONFLICT" });
  assert.throws(() => admit(f, { ...inputs[0], requestKey: "bypass-byte-capacity" }), { code: "ERR_WITNESS_REQUEST_BLOCKED" });
  f.store.close();
  assert.deepEqual(child(f, inputs[0], { lookup: true }).result, results[0]);
  assert.equal(child(f, refused).error, "ERR_WITNESS_ADMISSION_CAPACITY");
  assert.deepEqual(admission(f), stored);
  f.store = f.open();
  // A capacity refusal is neither state corruption nor a poisoned handle.
  assert.equal(admit(f, distinctRequest(99)).status, "admitted");
});

test("1024 durable attempts retain all reservations; count overflow is stable and old requests remain accessible", { ...supported, timeout: 240000 }, t => {
  const f = fixture(t); let first;
  for (let i = 0; i < 1024; i++) {
    const result = admit(f, distinctRequest(i));
    if (i === 0) first = result;
  }
  const before = f.store.snapshot(), input = distinctRequest(1024);
  assert.equal(before.witness_authority.request_admission.sequence, 1024);
  assert.ok(Buffer.byteLength(JSON.stringify(before.witness_authority.request_admission)) < 8 * 1024 * 1024);
  for (let i = 0; i < 2; i++) {
    assert.throws(() => admit(f, input), { code: "ERR_WITNESS_ADMISSION_CAPACITY" });
    assert.deepEqual(f.store.snapshot(), before);
  }
  assert.deepEqual(admit(f, distinctRequest(0)), first);
  assert.deepEqual(f.store.lookupAuthorityRequest(f.peer, distinctRequest(0)), first);
  assert.throws(() => admit(f, { ...distinctRequest(0), requestKey: "count-overflow-bypass" }), { code: "ERR_WITNESS_REQUEST_BLOCKED" });
  assert.equal(f.store.lookupAuthorityRequest(f.peer, input).status, "not-found");
  f.store.close();
  assert.equal(child(f, input).error, "ERR_WITNESS_ADMISSION_CAPACITY");
  assert.deepEqual(child(f, distinctRequest(0), { lookup: true }).result, first);
  assert.deepEqual(admission(f), before.witness_authority.request_admission);
});

for (const invalid of ["string", "bytes", "depth", "nodes", "prototype"]) {
  test(`online ${invalid} limit remains enforced before persistent mutation`, supported, t => {
    const f = fixture(t), before = raw(f); let input;
    if (invalid === "string") input = distinctRequest(1, { payload: "x".repeat(65537) });
    if (invalid === "bytes") input = distinctRequest(1, { payload: Array(17).fill("x".repeat(65536)) });
    if (invalid === "nodes") input = distinctRequest(1, { payload: Array.from({ length: 21 }, () => Array(1000).fill(0)) });
    if (invalid === "depth") {
      let value = 0; for (let i = 0; i < 17; i++) value = { child: value };
      input = distinctRequest(1, value);
    }
    if (invalid === "prototype") input = Object.assign(Object.create({ forged: true }), distinctRequest(1));
    assert.throws(() => admit(f, input));
    assert.deepEqual(raw(f), before);
  });
}

for (const invalid of ["depth", "oversize-string", "oversize-bytes", "record-field", "record-type", "digest", "index-type", "index-key", "count"]) {
  test(`persisted ${invalid} corruption fails closed with the independent storage validator`, supported, t => {
    const f = fixture(t), result = admit(f); f.store.close();
    const state = raw(f), a = state.witness_authority.request_admission, record = a.attempts[result.attemptId];
    if (invalid === "depth" || invalid === "oversize-string") {
      let request;
      if (invalid === "depth") {
        request = 1; for (let i = 0; i < 30; i++) request = { child: request };
      } else request = { payload: "x".repeat(65537) };
      record.request_bytes = JSON.stringify(helper.request({ request }));
      record.request_digest = crypto.createHash("sha256").update(record.request_bytes).digest("hex");
    }
    if (invalid === "oversize-bytes") {
      record.request_bytes = JSON.stringify(helper.request({ request: { payload: Array(17).fill("x".repeat(65536)) } }));
      record.request_digest = crypto.createHash("sha256").update(record.request_bytes).digest("hex");
    }
    if (invalid === "record-field") record.unexpected = true;
    if (invalid === "record-type") a.attempts[result.attemptId] = [];
    if (invalid === "digest") record.request_digest = "a".repeat(64);
    if (invalid === "index-type") a.resources[Object.keys(a.resources)[0]] = { attempt: result.attemptId };
    if (invalid === "index-key") a.resources = JSON.parse('{"__proto__":"forged"}');
    if (invalid === "count") a.sequence = 1025;
    const body = JSON.stringify(state), db = new sqlite.DatabaseSync(f.file);
    db.prepare("UPDATE protected_state SET body=?, sha256=? WHERE id=1").run(body, crypto.createHash("sha256").update(body).digest("hex"));
    db.close(); assert.equal(child(f).error, "ERR_STATE_INVALID");
  });
}

test("authorization envelope still rejects inherited/accessor properties without reading them", supported, t => {
  let accessors = 0;
  const f = fixture(t, { authorize: (peer, operation, input) => ({ principal: helper.principal,
    grant: { id: "g", version: 1 }, get resources() { accessors++; return input; } }) });
  const before = raw(f);
  assert.throws(() => admit(f)); assert.equal(accessors, 0); assert.deepEqual(raw(f), before);
  const g = fixture(t, { authorize: (peer, operation, input) => Object.assign(Object.create({ fake: true }), {
    principal: helper.principal, grant: { id: "g", version: 1 }, resources: input }) });
  assert.throws(() => admit(g)); assert.equal(admission(g).sequence, 0);
});

const READ_BODY_LIMIT = 9 * 1024 * 1024;
function replaceRawRow(f, { body, sha256, version } = {}) {
  const db = new sqlite.DatabaseSync(f.file);
  try {
    if (body !== undefined) db.prepare("UPDATE protected_state SET body=?, sha256=? WHERE id=1").run(body,
      sha256 === undefined ? crypto.createHash("sha256").update(body).digest("hex") : sha256);
    else if (sha256 !== undefined) db.prepare("UPDATE protected_state SET sha256=? WHERE id=1").run(sha256);
    if (version !== undefined) db.exec(`PRAGMA user_version=${version}`);
  } finally { db.close(); }
}
function guardedRows(action, afterRead = () => {}) {
  const rows = [], prepare = sqlite.DatabaseSync.prototype.prepare;
  patch(sqlite.DatabaseSync.prototype, "prepare", function(sql, ...args) {
    const stmt = prepare.call(this, sql, ...args);
    if (!sql.includes("CASE WHEN") || !sql.includes("protected_state")) return stmt;
    return { get(...params) {
      const row = stmt.get(...params);
      // Observe values crossing the actual node:sqlite -> JS boundary.
      rows.push(row);
      assert.ok(!row || row.body === null || typeof row.body !== "string" || Buffer.byteLength(row.body) <= READ_BODY_LIMIT);
      afterRead(row, rows.length);
      return row;
    } };
  }, action);
  assert.ok(rows.length > 0, "actual guarded SQLite projection was not exercised");
  return rows;
}
function anchorFiles(f) {
  const result = {};
  for (const name of fs.readdirSync(f.anchorDir)) {
    if (/protected-store-coordination.sqlite(?:-wal|-shm)?$/.test(name)) continue;
    const file = path.join(f.anchorDir, name);
    if (fs.statSync(file).isFile()) result[name] = crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  }
  return result;
}
for (const active of [false, true]) {
  for (const invalid of ["oversize-ascii", "oversize-unicode", "blob-body", "blob-sha", "oversize-sha", "lowered-version"]) {
    test(`${active ? "open handle" : "discovery open"} rejects ${invalid} before returning body to JS or writing witnesses`, supported, t => {
      const f = fixture(t); admit(f);
      if (!active) f.store.close();
      if (invalid === "oversize-ascii") replaceRawRow(f, { body: "x".repeat(READ_BODY_LIMIT + 1) });
      if (invalid === "oversize-unicode") {
        const body = "界".repeat(Math.floor(READ_BODY_LIMIT / 3) + 1);
        assert.ok(body.length < READ_BODY_LIMIT && Buffer.byteLength(body) > READ_BODY_LIMIT);
        replaceRawRow(f, { body });
      }
      if (invalid === "blob-body") replaceRawRow(f, { body: Buffer.from("{}") });
      if (invalid === "blob-sha") replaceRawRow(f, { sha256: Buffer.alloc(64, 97) });
      if (invalid === "oversize-sha") replaceRawRow(f, { sha256: "a".repeat(READ_BODY_LIMIT + 1) });
      if (invalid === "lowered-version") replaceRawRow(f, { body: "x".repeat(READ_BODY_LIMIT + 1), version: 3 });
      const before = anchorFiles(f), denied = () => { throw Error("must not write anchor or audit permissions"); };
      let calls = 0;
      const rows = guardedRows(() => patch(anchor, "appendEntry", denied, () => patch(anchor, "appendHighWater", denied, () =>
        patch(anchor, "assertAnchorPermissionsWithIdentity", denied, () => {
          const action = active ? () => f.store.snapshot() : () => f.open();
          assert.throws(action, { code: invalid === "lowered-version" ? "ERR_WITNESS_AUTHORITY_DISABLED" : "ERR_STATE_INVALID" });
          calls++;
        }))));
      assert.equal(calls, 1); assert.equal(rows.length, 1);
      assert.equal(rows[0].body, null); assert.equal(rows[0].sha256, null);
      assert.deepEqual(anchorFiles(f), before);
    });
  }
}

test("schema4 without trusted admission configuration never transfers a huge body, including recovery discovery", supported, t => {
  const f = fixture(t); f.store.close();
  replaceRawRow(f, { body: "x".repeat(READ_BODY_LIMIT + 1) });
  const before = anchorFiles(f);
  const rows = guardedRows(() => {
    for (const providers of [undefined, { ...f.providers, admissionMode: undefined }]) {
      assert.throws(() => f.open({ witnessAuthority: providers }), { code: "ERR_WITNESS_AUTHORITY_DISABLED" });
    }
    for (const method of ["recoverFromAnchorCrash", "rebuildAnchor", "resetAfterAnchorLoss"]) {
      assert.throws(() => Store[method](f.file, { ...f.options, audit: { by: "fixture", reason: "no bypass" } }),
        { code: "ERR_WITNESS_RECOVERY_UNSUPPORTED" });
    }
  });
  for (const row of rows) { assert.equal(row.body, null); assert.equal(row.sha256, null); }
  assert.deepEqual(anchorFiles(f), before);
});

for (const size of [READ_BODY_LIMIT - 1, READ_BODY_LIMIT, READ_BODY_LIMIT + 1]) {
  test(`UTF-8 SQL body boundary ${size - READ_BODY_LIMIT} projects only budgeted text`, supported, t => {
    const f = fixture(t); f.store.close();
    const body = "界".repeat(Math.floor(size / 3)) + "x".repeat(size % 3);
    assert.equal(Buffer.byteLength(body), size);
    replaceRawRow(f, { body });
    const rows = guardedRows(() => assert.throws(() => f.open()));
    assert.equal(rows.length, 1);
    // In-budget malformed JSON is rejected after bounded transfer. Oversize
    // text is suppressed inside SQLite, before JSON.parse/digest in JS.
    assert.equal(rows[0].body, size > READ_BODY_LIMIT ? null : body);
  });
}

for (const stage of ["discovery", "handle"]) {
  test(`concurrent replacement after ${stage} projection cannot switch a checked small body for an unchecked huge body`, supported, t => {
    const f = fixture(t); admit(f);
    const original = f.store.snapshot(); if (stage === "discovery") f.store.close();
    const before = anchorFiles(f);
    let replaced = false;
    const rows = guardedRows(() => {
      if (stage === "discovery") assert.throws(() => f.open(), { code: "ERR_STATE_INVALID" });
      else assert.deepEqual(f.store.snapshot(), original);
    }, (row, index) => {
      if (index === 1) {
        assert.equal(typeof row.body, "string");
        replaceRawRow(f, { body: "x".repeat(READ_BODY_LIMIT + 1) }); replaced = true;
      }
    });
    assert.equal(replaced, true);
    if (stage === "discovery") { assert.equal(rows.length, 2); assert.equal(rows[1].body, null); }
    else {
      const next = guardedRows(() => assert.throws(() => f.store.snapshot(), { code: "ERR_STATE_INVALID" }));
      assert.equal(next[0].body, null);
    }
    assert.deepEqual(anchorFiles(f), before);
  });
}

function metadataBytes(state) {
  return Buffer.byteLength(JSON.stringify({ ...state,
    witness_authority: { ...state.witness_authority, request_admission: null } }));
}
function projectedAdmissionBytes(state, input) {
  // Only constructs a sizing sample to find an exact test boundary. The real
  // admission below must independently allocate, validate and commit through B.
  const a = structuredClone(state.witness_authority.request_admission);
  const id = `admission:${state.store_id}:${"0".repeat(32)}`;
  const hash = value => crypto.createHash("sha256").update(witness.canonicalBytes(value)).digest("hex");
  const bytes = witness.canonicalBytes(input).toString("utf8");
  a.sequence++;
  a.attempts[id] = { attempt_id: id, sequence: a.sequence, encoding_version: 1, request_bytes: bytes,
    request_digest: crypto.createHash("sha256").update(bytes).digest("hex"), principal: helper.principal,
    grant: { id: "fixture-grant", version: 1 }, service_epoch: state.service_epoch, admitted_at_ms: 1000, status: "admitted" };
  a.associations[hash({ authorityId: state.witness_authority.authority_id, principal: helper.principal,
    action: input.action, resourceScope: input.resourceScope, requestKey: input.requestKey })] = id;
  a.business_keys[hash(input.businessKey)] = id;
  a.resources[hash(input.resourceScope)] = id;
  return Buffer.byteLength(JSON.stringify(a));
}
function asciiChunks(size) {
  const parts = [];
  for (let remaining = size; remaining > 0; remaining -= 65536) parts.push("x".repeat(Math.min(remaining, 65536)));
  return { payload: parts };
}

test("a genuinely committed full 8MiB admission plus near-1MiB Unicode metadata can reopen and lookup", { ...supported, timeout: 30000 }, t => {
  const model = fixture(t).store.snapshot(), empty = { ...model, decision_id: "" };
  const paddingBytes = 1024 * 1024 - 32 - metadataBytes(empty);
  const f = fixture(t, { initialize: false });
  f.options.decisionId = f.options.expectedDecisionId = "界".repeat(Math.floor(paddingBytes / 3)) + "x".repeat(paddingBytes % 3);
  f.store = f.track(Store.initialize(f.file, f.options));
  assert.equal(metadataBytes(f.store.snapshot()), 1024 * 1024 - 32);
  for (let i = 0; i < 10; i++) admit(f, distinctRequest(i, asciiChunks(780000)));
  const state = f.store.snapshot();
  let low = 0, high = 900000;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (projectedAdmissionBytes(state, distinctRequest(10, asciiChunks(mid))) <= 8 * 1024 * 1024) low = mid;
    else high = mid - 1;
  }
  const input = distinctRequest(10, asciiChunks(low));
  assert.equal(projectedAdmissionBytes(state, input), 8 * 1024 * 1024);
  const original = admit(f, input), final = f.store.snapshot();
  assert.equal(Buffer.byteLength(JSON.stringify(final.witness_authority.request_admission)), 8 * 1024 * 1024);
  assert.equal(metadataBytes(final), 1024 * 1024 - 31); // anchor sequence grew a digit
  assert.ok(Buffer.byteLength(JSON.stringify(final)) <= READ_BODY_LIMIT);
  assert.ok(Buffer.byteLength(JSON.stringify(final)) > 8 * 1024 * 1024);
  f.store.close();
  const reopened = child(f, input, { lookup: true, metrics: true });
  assert.deepEqual(reopened.result, original);
  assert.equal(admission(f).sequence, 11);
  t.diagnostic(JSON.stringify({ fullBudgetChild: reopened.metrics }));
  fs.writeFileSync(path.join(f.dir, "full-budget-rss.json"), JSON.stringify(reopened.metrics));
});

for (const invalid of ["metadata-overflow", "extra-top-level", "extra-authority", "nonempty-tombstones"]) {
  test(`schema4 explicitly bounded metadata rejects ${invalid}`, supported, t => {
    const f = fixture(t); admit(f); f.store.close();
    const state = raw(f);
    if (invalid === "metadata-overflow") state.decision_id = "界".repeat(350000);
    if (invalid === "extra-top-level") state.extension = "padding";
    if (invalid === "extra-authority") state.witness_authority.extension = "padding";
    if (invalid === "nonempty-tombstones") state.tombstones.arbitrary = {};
    const body = JSON.stringify(state); assert.ok(Buffer.byteLength(body) < READ_BODY_LIMIT);
    replaceRawRow(f, { body });
    const rows = guardedRows(() => assert.throws(() => f.open(), { code: "ERR_STATE_INVALID" }));
    assert.equal(rows.length, 1); assert.equal(rows[0].body, body);
  });
}

test("initialization cannot publish schema4 metadata above its finite budget", supported, t => {
  const f = fixture(t, { initialize: false });
  f.options.decisionId = "x".repeat(1024 * 1024);
  const before = anchorFiles(f);
  patch(anchor, "appendEntry", () => { throw Error("metadata must be rejected before publishing anchor"); }, () =>
    assert.throws(() => Store.initialize(f.file, f.options), { code: "ERR_STATE_INVALID" }));
  assert.deepEqual(anchorFiles(f), before);
});

for (const version of [2, 3, 4]) {
  test(`UTF-16 schema${version} ${version === 4 ? "refuses before transfer" : "retains legacy compatibility"}`, supported, t => {
    const f = fixture(t, { initialize: false });
    const providers = version === 2 ? undefined : version === 3 ? { ...f.providers, admissionMode: undefined } : f.providers;
    f.options.witnessAuthority = providers;
    f.store = f.track(Store.initialize(f.file, f.options));
    const state = f.store.snapshot(); f.store.close();
    const file = path.join(path.dirname(f.file), "utf16.sqlite"), db = new sqlite.DatabaseSync(file), body = JSON.stringify(state);
    db.exec("PRAGMA encoding='UTF-16le'; CREATE TABLE protected_state (id INTEGER PRIMARY KEY, body TEXT, sha256 TEXT)");
    db.prepare("INSERT INTO protected_state VALUES (1,?,?)").run(body, crypto.createHash("sha256").update(body).digest("hex"));
    db.exec(`PRAGMA user_version=${version}`); db.close();
    if (version === 4) {
      const rows = guardedRows(() => assert.throws(() => Store.open(file, f.options), { code: "ERR_STATE_INVALID" }));
      assert.equal(rows[0].body, null);
    } else {
      const reopened = f.track(Store.open(file, f.options));
      assert.deepEqual(reopened.snapshot(), state);
    }
  });
}

for (const version of [2, 3]) {
  test(`schema${version} metadata larger than the admission reader budget remains compatible`, supported, t => {
    const f = fixture(t, { initialize: false });
    f.options.witnessAuthority = version === 2 ? undefined : { ...f.providers, admissionMode: undefined };
    f.options.decisionId = f.options.expectedDecisionId = "x".repeat(READ_BODY_LIMIT + 1);
    f.store = f.track(Store.initialize(f.file, f.options));
    assert.equal(f.store.snapshot().schema_version, version); f.store.close();
    const reopened = f.open();
    assert.equal(reopened.snapshot().decision_id, f.options.decisionId);
  });
}

for (const method of ["lookupAuthorityRequest", "admitAuthorityRequest"]) {
  test(`active ${method} never transfers an oversized replaced body or mutates witnesses`, supported, t => {
    const f = fixture(t); const original = admit(f);
    replaceRawRow(f, { body: "界".repeat(4 * 1024 * 1024) });
    const before = anchorFiles(f);
    const rows = guardedRows(() => assert.throws(() => f.store[method](f.peer, helper.request()), { code: "ERR_STATE_INVALID" }));
    assert.equal(rows.length, 1); assert.equal(rows[0].body, null);
    assert.deepEqual(anchorFiles(f), before);
    assert.ok(original.attemptId); // No retry is claimed safe after DB corruption.
  });
}
for (const [column, value] of [["body", null], ["body", 42], ["body", 1.5], ["sha256", null], ["sha256", 42]]) {
  test(`schema4 SQLite ${column} of ${value === null ? "null" : typeof value + ":" + value} is refused before JS transfer`, supported, t => {
    const f = fixture(t); f.store.close();
    const db = new sqlite.DatabaseSync(f.file);
    db.exec("ALTER TABLE protected_state RENAME TO saved_state; CREATE TABLE protected_state (id INTEGER PRIMARY KEY, body, sha256)");
    db.exec("INSERT INTO protected_state SELECT * FROM saved_state");
    db.prepare(`UPDATE protected_state SET ${column}=? WHERE id=1`).run(value);
    db.close();
    const rows = guardedRows(() => assert.throws(() => f.open(), { code: "ERR_STATE_INVALID" }));
    assert.equal(rows[0].body, null); assert.equal(rows[0].sha256, null);
  });
}

test("admission authorization rechecks use one immutable detached snapshot without changing live state", supported, t => {
  const seen = [];
  const f = fixture(t, { authorize(peer, operation, input, snapshot) {
    assert.equal(Object.isFrozen(snapshot), true);
    assert.equal(Object.isFrozen(snapshot.witness_authority.request_admission), true);
    assert.throws(() => { snapshot.witness_authority.request_admission.sequence++; }, TypeError);
    seen.push(snapshot);
    return { principal: helper.principal, grant: { id: "g", version: 1 }, resources: input };
  } });
  admit(f);
  assert.equal(seen.length, 2); assert.equal(seen[0], seen[1]);
  assert.equal(seen[0].witness_authority.request_admission.sequence, 0);
  assert.equal(admission(f).sequence, 1);
});
