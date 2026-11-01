"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const util = require("node:util");
const { spawnSync } = require("node:child_process");
const { createPermitWitnessAdmissionHost: createHost, createPermitWitnessAdmissionDiagnostics: createDiagnostics } = require("../../lib/coordination/permit-witness-admission-host");
const { ProtectedPermitStore: Store } = require("../../lib/coordination/protected-permit-store");
const witness = require("../../lib/coordination/permit-witness-contract");
const anchor = require("../../lib/coordination/protected-anchor");
const helper = require("./fixtures/permit-witness-admission-host");
const childFile = require.resolve("./fixtures/permit-witness-admission-host");
const supported = { skip: Number(process.versions.node.split(".")[0]) < 24 || !["darwin", "linux"].includes(process.platform) };

// Real schema4 SQLite + local anchors, synthetic local identity only. No schema
// counterexample probes, Docker, N-API, production keys, network or effects.
// Files and subprocess/compiler scratch are confined to .agent/runtime.
function fixture(t, initialize = true) {
  const base = path.resolve(__dirname, "../../.agent/runtime/test-tmp");
  fs.mkdirSync(base, { recursive: true });
  const root = fs.mkdtempSync(path.join(base, "permit-witness-admission-host-"));
  const dbDir = path.join(root, "db"), anchorDir = path.join(root, "anchor");
  fs.mkdirSync(dbDir); fs.mkdirSync(anchorDir, { mode: 0o700 });
  const file = path.join(dbDir, "state.sqlite"), config = helper.config(file, anchorDir), hosts = [];
  const start = (patch = {}) => {
    const host = createHost({ ...config, ...patch }); hosts.push(host); return host;
  };
  const f = { root, dbDir, anchorDir, file, config, start };
  if (initialize) f.host = start();
  f.read = () => {
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      assert.equal(db.prepare("PRAGMA user_version").get().user_version, 4);
      const row = db.prepare("SELECT body, sha256 FROM protected_state WHERE id=1").get();
      assert.equal(crypto.createHash("sha256").update(row.body).digest("hex"), row.sha256);
      return JSON.parse(row.body);
    } finally { db.close(); }
  };
  f.child = (extra = {}) => spawnSync(process.execPath, [childFile, JSON.stringify({ file, anchorDir, ...extra })],
    { encoding: "utf8", timeout: 15000, env: { ...process.env, TMPDIR: root, TMP: root, TEMP: root } });
  t.after(() => { hosts.forEach(host => host.close()); fs.rmSync(root, { recursive: true, force: true }); });
  return f;
}
function rejected(result) { assert.equal(result.status, "rejected"); assert.equal(result.commit, "not-attempted"); assert.equal(result.result, undefined); }
function unknown(result) {
  assert.equal(result.status, "unknown"); assert.equal(result.commit, "unknown"); assert.equal(result.result, undefined);
  assert.equal(result.code, "ERR_WITNESS_ADMISSION_OUTCOME_UNKNOWN"); safe(result);
}
function safe(result, localObject = true) {
  assert.equal(result.mode, "development-only");
  for (const key of ["remoteAuthenticated", "productionReady", "publishable", "executionAuthorized", "resumeAllowed", "autoRetryAllowed"]) assert.equal(result[key], false);
  assert.equal(result.originalRequestOutcome, "unknown");
  if (localObject) assert.ok(Object.isFrozen(result));
}
function recorded(result) { assert.equal(result.status, "recorded"); assert.equal(result.commit, "confirmed"); assert.equal(result.result.status, "admitted"); safe(result); return result.result; }

test("local lifecycle records full canonical bytes/principal/grant in schema4 and the real anchor domain", supported, t => {
  const f = fixture(t), input = helper.assignment(), context = f.host.createContext(input);
  assert.deepEqual(Reflect.ownKeys(context), []); assert.ok(Object.isFrozen(context));
  const before = f.read(), first = recorded(f.host.admit(context, helper.request()));
  assert.deepEqual(recorded(f.host.admit(context, helper.request())), first);
  const lookup = f.host.lookup(context, helper.request()); safe(lookup);
  assert.equal(lookup.status, "observed"); assert.deepEqual(lookup.result, first);
  const state = f.read(), admission = state.witness_authority.request_admission;
  assert.equal(state.schema_version, 4); assert.equal(admission.sequence, 1);
  assert.equal(state.anchor_sequence, before.anchor_sequence + 3);
  const entry = admission.attempts[first.attemptId];
  assert.deepEqual(entry.principal, input.principal); assert.deepEqual(entry.grant, input.grant);
  assert.equal(entry.request_bytes, witness.canonicalBytes(helper.request()).toString("utf8"));
  assert.equal(entry.request_digest, first.requestDigest);
  const journal = anchor.readJournal(path.join(f.anchorDir, `${state.store_id}.journal`));
  assert.equal(journal.committed, state.anchor_sequence);
  assert.equal(anchor.readHighWater(f.anchorDir).mark, state.anchor_sequence);
  assert.equal(state.lease, null); assert.deepEqual(state.permits, {});
  assert.deepEqual(state.witness_authority.targets, {}); assert.deepEqual(state.witness_authority.issuance_bindings, {});
});

test("lookup is separately authorized and not-found neither admits nor permits continuation", supported, t => {
  const f = fixture(t), writer = f.host.createContext(helper.assignment({ permissions: ["request.admit"] }));
  rejected(f.host.lookup(writer, helper.request()));
  const reader = f.host.createContext(helper.assignment({ permissions: ["request.lookup"] }));
  rejected(f.host.admit(reader, helper.request()));
  const absent = f.host.lookup(reader, helper.request()); safe(absent);
  assert.equal(absent.status, "observed"); assert.equal(absent.result.status, "not-found");
  assert.equal(f.read().witness_authority.request_admission.sequence, 0);
  const first = recorded(f.host.admit(writer, helper.request()));
  assert.deepEqual(f.host.lookup(reader, helper.request()).result, first);
});

test("request/peer properties, serialized/copied tokens and cross-host contexts cannot authenticate", supported, t => {
  const f = fixture(t), input = helper.assignment(), context = f.host.createContext(input);
  for (const fake of [null, undefined, {}, input.identity, input.grant, input, JSON.parse(JSON.stringify(context)),
    Object.create(context), { principal: input.principal, grant: input.grant }]) {
    rejected(f.host.admit(fake, helper.request())); rejected(f.host.lookup(fake, helper.request()));
  }
  const other = fixture(t), elsewhere = other.host.createContext(helper.assignment());
  rejected(f.host.admit(elsewhere, helper.request()));
  assert.equal(f.read().witness_authority.request_admission.sequence, 0);
  recorded(f.host.admit(context, helper.request()));
  f.host.revokeContext(context); rejected(f.host.admit(context, helper.request()));
  f.host.close(); rejected(f.host.lookup(context, helper.request()));
});

for (const field of ["requestKey", "action", "resourceScope", "businessKey", "request"]) {
  test(`both surfaces compare the full envelope, including ${field}, even at an existing association`, supported, t => {
    const f = fixture(t), context = f.host.createContext(helper.assignment());
    recorded(f.host.admit(context, helper.request()));
    const before = f.read();
    const changed = helper.request({ [field]: field === "request" ? { ...helper.request().request, checkpoint: { revision: 99 } } : "forged-alias" });
    rejected(f.host.admit(context, changed)); rejected(f.host.lookup(context, changed));
    assert.deepEqual(f.read(), before);
  });
}

test("canonical validation rejects accessors, symbols, hidden fields, toJSON, omitted fields and oversized nested data", supported, t => {
  const f = fixture(t), context = f.host.createContext(helper.assignment());
  let getters = 0;
  const accessor = helper.request(); Object.defineProperty(accessor.request.params, "value", { enumerable: true, get() { getters++; return 1; } });
  const symbol = helper.request(); symbol.request[Symbol("extra")] = true;
  const hidden = helper.request(); Object.defineProperty(hidden.request, "hidden", { value: 1 });
  const omitted = helper.request(); delete omitted.businessKey;
  const noncanonical = [accessor, symbol, hidden, omitted, helper.request({ principal: "self" }),
    helper.request({ request: { toJSON() { getters++; return {}; } } }), helper.request({ request: { x: undefined } }),
    helper.request({ request: { x: -0 } }), helper.request({ request: { x: "x".repeat(witness.LIMITS.stringBytes + 1) } })];
  for (const request of noncanonical) {
    rejected(f.host.admit(context, request)); rejected(f.host.lookup(context, request));
    assert.throws(() => f.host.createContext(helper.assignment({ resources: request })));
  }
  assert.equal(getters, 0); assert.equal(f.read().witness_authority.request_admission.sequence, 0);
});

test("assignment is detached; mutable shared grants and implicit/legacy permissions are refused", supported, t => {
  const f = fixture(t), input = helper.assignment(), context = f.host.createContext(input);
  input.principal.subjectId = "attacker"; input.permissions.push("issue"); input.resources.request.params.value = 99;
  input.resources.resourceScope = "replacement"; input.grant = Object.freeze({ id: "other", version: 2 });
  rejected(f.host.admit(context, input.resources));
  const first = recorded(f.host.admit(context, helper.request()));
  const persisted = f.read().witness_authority.request_admission.attempts[first.attemptId];
  assert.equal(persisted.principal.subjectId, "subject-a"); assert.deepEqual(persisted.grant, { id: "grant-a", version: 1 });
  for (const patch of [{ grant: { id: "shared", version: 1 } }, { grant: Object.freeze({ id: "g", version: 0 }) },
    { permissions: [] }, { permissions: ["issue"] }, { permissions: ["request.admit", "request.admit"] },
    { principal: "self-asserted" }, { incarnation: "" }]) assert.throws(() => f.host.createContext(helper.assignment(patch)));
});

test("same subject on a new incarnation and new current grant can independently query the original association", supported, t => {
  const f = fixture(t), old = f.host.createContext(helper.assignment()), first = recorded(f.host.admit(old, helper.request()));
  f.host.revokeContext(old);
  let alive = true;
  const identity = Object.freeze({}), grant = Object.freeze({ id: "grant-a", version: 2 });
  const fresh = f.host.createContext(helper.assignment({ identity, incarnation: "incarnation-2", grant, permissions: ["request.lookup"],
    isCurrent: (actual, binding) => alive && actual === identity && binding.incarnation === "incarnation-2" && binding.grant.version === 2 }));
  assert.deepEqual(f.host.lookup(fresh, helper.request()).result, first);
  assert.equal(f.read().witness_authority.request_admission.attempts[first.attemptId].grant.version, 1);
  alive = false; rejected(f.host.lookup(fresh, helper.request()));
  alive = true; rejected(f.host.lookup(fresh, helper.request()));
});

for (const field of ["subjectId", "issuer", "tenant"]) test(`another authenticated ${field} cannot read the old requestKey`, supported, t => {
  const f = fixture(t), first = recorded(f.host.admit(f.host.createContext(helper.assignment()), helper.request()));
  const principal = { ...helper.assignment().principal, [field]: "different" };
  const other = f.host.createContext(helper.assignment({ principal, permissions: ["request.lookup"] }));
  const result = f.host.lookup(other, helper.request()); safe(result);
  assert.equal(result.result.status, "not-found"); assert.equal(result.result.attemptId, undefined);
  assert.deepEqual(Object.keys(f.read().witness_authority.request_admission.attempts), [first.attemptId]);
});

for (const field of ["resourceScope", "businessKey"]) test(`trusted fresh contexts cannot bypass unresolved ${field} reservations with a new key/session`, supported, t => {
  const f = fixture(t), old = f.host.createContext(helper.assignment());
  recorded(f.host.admit(old, helper.request()));
  const request = helper.request({ requestKey: "new-key", resourceScope: "new-resource", businessKey: "new-business", [field]: helper.request()[field] });
  const fresh = f.host.createContext(helper.assignment({ resources: request }));
  unknown(f.host.admit(fresh, request));
  rejected(f.host.admit(old, helper.request()));
  assert.equal(f.read().witness_authority.request_admission.sequence, 1);
});

test("same association with a newly granted changed business payload remains a core conflict and never retries", supported, t => {
  const f = fixture(t), original = f.host.createContext(helper.assignment()); recorded(f.host.admit(original, helper.request()));
  const changed = helper.request({ request: { ...helper.request().request, params: { value: 2 } } });
  const context = f.host.createContext(helper.assignment({ resources: changed }));
  unknown(f.host.lookup(context, changed)); rejected(f.host.admit(context, changed));
  assert.equal(f.read().witness_authority.request_admission.sequence, 1);
});

for (const step of [1, 2, 3, 4]) test(`identity/grant/incarnation loss at check ${step} withholds results without resurrection`, supported, t => {
  const f = fixture(t); let checks = 0, lose = false;
  const context = f.host.createContext(helper.assignment({ isCurrent: (_identity, binding) => {
    assert.ok(Object.isFrozen(binding)); assert.ok(Object.isFrozen(binding.grant)); assert.ok(Object.isFrozen(binding.resources.request));
    return !lose || ++checks !== step;
  } }));
  lose = true;
  const result = f.host.admit(context, helper.request());
  if (step === 1) rejected(result); else unknown(result);
  const count = f.read().witness_authority.request_admission.sequence;
  assert.equal(count, step === 4 ? 1 : 0);
  lose = false; rejected(f.host.admit(context, helper.request()));
});

for (const behavior of ["promise", "rejected-promise", "throws", "truthy"]) test(`isCurrent ${behavior} cannot authenticate, including after assignment`, supported, async t => {
  const f = fixture(t); let bad = false;
  const predicate = () => {
    if (!bad) return true;
    if (behavior === "promise") return Promise.resolve(true);
    if (behavior === "rejected-promise") return Promise.reject(Error("private error"));
    if (behavior === "throws") throw Error("private error");
    return { authenticated: true };
  };
  const context = f.host.createContext(helper.assignment({ isCurrent: predicate })); bad = true;
  assert.throws(() => f.host.createContext(helper.assignment({ isCurrent: predicate })));
  rejected(f.host.admit(context, helper.request())); bad = false; rejected(f.host.admit(context, helper.request()));
  await new Promise(resolve => setImmediate(resolve));
});

test("assignment and all dispatch identity checks guard reentry, close and factory callbacks", supported, t => {
  const f = fixture(t); let enabled = false, calls = 0, context;
  const input = helper.assignment({ isCurrent: () => {
    if (!enabled) return true;
    calls++;
    rejected(f.host.admit(context, helper.request())); rejected(f.host.lookup(context, helper.request()));
    assert.throws(() => f.host.createContext(helper.assignment()), { code: "ERR_WITNESS_ADMISSION_HOST_UNAVAILABLE" });
    assert.throws(() => f.host.close(), { code: "ERR_WITNESS_ADMISSION_HOST_UNAVAILABLE" });
    return true;
  } });
  context = f.host.createContext(input); enabled = true;
  f.host.createContext(input); recorded(f.host.admit(context, helper.request()));
  assert.equal(calls, 5); assert.equal(f.read().witness_authority.request_admission.sequence, 1);
});

for (const step of [1, 2, 4]) test(`reentrant revocation at check ${step} cannot release the record`, supported, t => {
  const f = fixture(t); let context, checks = 0, enabled = false;
  context = f.host.createContext(helper.assignment({ isCurrent: () => {
    if (enabled && ++checks === step) f.host.revokeContext(context);
    return true;
  } })); enabled = true;
  const result = f.host.admit(context, helper.request());
  if (step === 1) rejected(result); else unknown(result);
  assert.equal(f.read().witness_authority.request_admission.sequence, step === 4 ? 1 : 0);
});

test("resource incarnation replacement revokes a context even if the same identity object is reused", supported, t => {
  const f = fixture(t); let incarnation = "incarnation-1";
  const context = f.host.createContext(helper.assignment({ isCurrent: (_identity, binding) => binding.incarnation === incarnation }));
  incarnation = "incarnation-2"; rejected(f.host.admit(context, helper.request()));
  incarnation = "incarnation-1"; rejected(f.host.admit(context, helper.request()));
  assert.equal(f.read().witness_authority.request_admission.sequence, 0);
});

for (const target of ["db", "anchor"]) test(`replaced ${target} path is refused before transaction entry`, supported, t => {
  const f = fixture(t), context = f.host.createContext(helper.assignment());
  if (target === "db") { fs.renameSync(f.file, f.file + ".saved"); fs.copyFileSync(f.file + ".saved", f.file); }
  else { fs.renameSync(f.anchorDir, f.anchorDir + ".saved"); fs.mkdirSync(f.anchorDir, { mode: 0o700 }); }
  rejected(f.host.admit(context, helper.request())); rejected(f.host.lookup(context, helper.request()));
});

for (const point of ["precommit-audit", "postcommit-anchor"]) test(`${point} failure is unknown and latches all operations, without code-based rollback guesses`, supported, t => {
  const f = fixture(t), context = f.host.createContext(helper.assignment());
  let result;
  if (point === "precommit-audit") {
    const original = fs.writeSync;
    fs.writeSync = (fd, data, ...rest) => {
      if (Buffer.isBuffer(data) && data.toString("utf8").includes('"event":"transaction"')) throw Object.assign(Error("secret"), { code: "ERR_INVALID_INPUT" });
      return original(fd, data, ...rest);
    };
    try { result = f.host.admit(context, helper.request()); } finally { fs.writeSync = original; }
  } else {
    const original = anchor.appendEntry;
    anchor.appendEntry = (...args) => {
      if (args[1].type === "commit") throw Object.assign(Error("secret"), { code: "ERR_INVALID_INPUT" });
      return original(...args);
    };
    try { result = f.host.admit(context, helper.request()); } finally { anchor.appendEntry = original; }
  }
  unknown(result); assert.ok(!JSON.stringify(result).includes("secret"));
  rejected(f.host.admit(context, helper.request())); rejected(f.host.lookup(context, helper.request()));
  assert.throws(() => f.host.createContext(helper.assignment()));
  assert.equal(f.read().witness_authority.request_admission.sequence, point === "postcommit-anchor" ? 1 : 0);
});

test("ACK loss across process exit/restart locates the same attempt under fresh independent lookup authorization", supported, t => {
  const f = fixture(t); f.host.close();
  const lost = f.child({ fault: "ack-lost" }); assert.equal(lost.error, undefined); assert.equal(lost.status, 74); assert.equal(lost.stdout, "");
  const before = f.read(), attempt = Object.keys(before.witness_authority.request_admission.attempts)[0];
  assert.equal(before.witness_authority.request_admission.sequence, 1);
  const found = f.child({ lookup: true }); assert.equal(found.status, 0, found.stderr);
  const result = JSON.parse(found.stdout); safe(result, false); assert.equal(result.status, "observed"); assert.equal(result.result.attemptId, attempt);
  const again = f.child(); assert.equal(again.status, 0, again.stderr); assert.equal(JSON.parse(again.stdout).result.attemptId, attempt);
  assert.equal(f.read().witness_authority.request_admission.sequence, 1);
});

test("crash after DB COMMIT keeps the reservation; reopen refuses incomplete anchors and never auto-recovers", supported, t => {
  const f = fixture(t); f.host.close();
  const crash = f.child({ fault: "crash-after-db-commit" }); assert.equal(crash.error, undefined); assert.equal(crash.status, 73);
  const before = f.read(); assert.equal(before.witness_authority.request_admission.sequence, 1);
  assert.throws(() => f.start({ access: "open" }), { code: "ERR_CRASH_WINDOW_RECOVERABLE" });
  assert.deepEqual(f.read(), before);
});

test("explicit reopen never reuses old contexts and does not reassign an existing attempt", supported, t => {
  const f = fixture(t), old = f.host.createContext(helper.assignment());
  const first = recorded(f.host.admit(old, helper.request())); f.host.close();
  const host = f.start({ access: "open" }); rejected(host.lookup(old, helper.request()));
  const fresh = host.createContext(helper.assignment({ permissions: ["request.lookup"] }));
  assert.deepEqual(host.lookup(fresh, helper.request()).result, first);
  assert.equal(f.read().witness_authority.request_admission.sequence, 1);
});

test("host exposes only admission/lookup and never calls legacy business, history, recovery or signature APIs", supported, t => {
  const f = fixture(t), context = f.host.createContext(helper.assignment()), saved = new Map(); let calls = 0;
  assert.deepEqual(Object.keys(f.host).sort(), ["admit", "close", "createContext", "lookup", "revokeContext"]);
  for (const name of ["registerWitnessTarget", "issueWitnessPermit", "consumeWithCheckpoint", "queryWitnessHistory", "acquire",
    "acquireAndReserveBoundToBatch", "reserve", "reserveBoundToBatch", "renew", "consume", "finish", "revoke", "release", "expire", "restartService", "recover"]) {
    saved.set(name, Store.prototype[name]); Store.prototype[name] = () => { calls++; throw Error("old API called"); };
  }
  try {
    recorded(f.host.admit(context, helper.request())); assert.equal(f.host.lookup(context, helper.request()).status, "observed");
  } finally { for (const [name, original] of saved) Store.prototype[name] = original; }
  assert.equal(calls, 0);
});

test("schema4 itself fences old witness APIs and legacy writers even through an independently opened handle", supported, t => {
  const f = fixture(t), disabled = () => { throw Error("provider must not run"); };
  const store = Store.open(f.file, { ...f.config.storeOptions, expectedDecisionId: f.config.storeOptions.decisionId, clock: () => 1000,
    witnessAuthority: { mode: "development-only", admissionMode: "development-only", authorityId: f.config.authorityId,
      authorize: () => { throw Error("old authorization must not run"); }, observeTarget: disabled, signPermit: disabled, pullRevocation: disabled } });
  try {
    for (const name of ["registerWitnessTarget", "issueWitnessPermit", "consumeWithCheckpoint", "queryWitnessHistory"]) {
      assert.throws(() => store[name]({}, {}), { code: "ERR_WITNESS_ADMISSION_ONLY" });
    }
    for (const name of ["expire", "restartService"]) assert.throws(() => store[name](), { code: "ERR_WITNESS_LEGACY_ENTRY_DISABLED" });
  } finally { store.close(); }
  assert.equal(f.read().witness_authority.request_admission.sequence, 0);
});

test("factory refuses production, injectable dependencies, implicit provisioning and legacy adoption", supported, t => {
  const f = fixture(t, false);
  for (const patch of [{ mode: "production" }, { backend: "sqlite" }, { access: "auto" }, { providers: {} }, { store: {} },
    { authorize: () => true }, { signPermit: () => ({}) }, { storeOptions: { ...f.config.storeOptions, witnessAuthority: {} } }]) {
    assert.throws(() => f.start(patch)); assert.equal(fs.existsSync(f.file), false);
  }
  assert.throws(() => f.start({ access: "open" })); assert.equal(fs.existsSync(f.file), false);
  const legacy = Store.initialize(f.file, { ...f.config.storeOptions, clock: () => 1000 }); legacy.close();
  assert.throws(() => f.start({ access: "open" }));
});

test("schema3 cannot be adopted or silently migrated by an admission host", supported, t => {
  const f = fixture(t, false), disabled = () => { throw Error("provider must not run"); };
  const legacy = Store.initialize(f.file, { ...f.config.storeOptions, clock: () => 1000,
    witnessAuthority: { mode: "development-only", authorityId: f.config.authorityId, authorize: () => false,
      observeTarget: disabled, signPermit: disabled, pullRevocation: disabled } });
  legacy.close();
  assert.throws(() => f.start({ access: "open" }), { code: "ERR_WITNESS_AUTHORITY_DISABLED" });
  const { DatabaseSync } = require("node:sqlite"), db = new DatabaseSync(f.file, { readOnly: true });
  try { assert.equal(db.prepare("PRAGMA user_version").get().user_version, 3); } finally { db.close(); }
});

for (const step of [1, 2, 3, 4]) test(`lookup independently rechecks liveness at boundary ${step} and withholds historical data on loss`, supported, t => {
  const f = fixture(t), writer = f.host.createContext(helper.assignment());
  recorded(f.host.admit(writer, helper.request()));
  let enabled = false, checks = 0;
  const context = f.host.createContext(helper.assignment({ permissions: ["request.lookup"],
    isCurrent: () => !enabled || ++checks !== step }));
  enabled = true;
  const result = f.host.lookup(context, helper.request());
  if (step === 1) rejected(result); else unknown(result);
  enabled = false; rejected(f.host.lookup(context, helper.request()));
  assert.equal(f.read().witness_authority.request_admission.sequence, 1);
});

test("grant revocation/version change between transaction authorizations cannot reuse frozen grant metadata", supported, t => {
  const f = fixture(t); let version = 1, checks = 0, enabled = false;
  const context = f.host.createContext(helper.assignment({ isCurrent: (_identity, binding) => {
    if (enabled && ++checks === 3) version = 2;
    return binding.grant.version === version;
  } })); enabled = true;
  unknown(f.host.admit(context, helper.request()));
  assert.equal(f.read().witness_authority.request_admission.sequence, 0);
  version = 1; rejected(f.host.admit(context, helper.request()));
});

test("replacement during final liveness check withholds a committed admission and never treats new resources as old", supported, t => {
  const f = fixture(t); let enabled = false, checks = 0;
  const context = f.host.createContext(helper.assignment({ isCurrent: () => {
    if (enabled && ++checks === 4) {
      fs.renameSync(f.anchorDir, f.anchorDir + ".original");
      fs.mkdirSync(f.anchorDir, { mode: 0o700 });
    }
    return true;
  } })); enabled = true;
  unknown(f.host.admit(context, helper.request()));
  assert.equal(f.read().witness_authority.request_admission.sequence, 1);
  rejected(f.host.lookup(context, helper.request()));
});

test("clock safety poison may commit while admission returns unknown; host cannot clear it or release reservations", supported, t => {
  const f = fixture(t, false); let now = 1000;
  const host = f.start({ clock: () => now }), context = host.createContext(helper.assignment());
  recorded(host.admit(context, helper.request()));
  now = 999; unknown(host.lookup(context, helper.request()));
  const state = f.read(); assert.equal(state.witness_authority.clock_poisoned, true);
  assert.equal(state.witness_authority.request_admission.sequence, 1);
  now = 1000; rejected(host.admit(context, helper.request()));
});

test("canonical key order cannot change association, while any nested resource/business semantics change is rejected", supported, t => {
  const f = fixture(t), context = f.host.createContext(helper.assignment());
  const r = helper.request(), reordered = { request: { generation: r.request.generation, params: { value: 1 },
    targetId: r.request.targetId, checkpoint: null }, businessKey: r.businessKey, resourceScope: r.resourceScope,
    action: r.action, requestKey: r.requestKey };
  const first = recorded(f.host.admit(context, reordered));
  assert.deepEqual(f.host.lookup(context, r).result, first);
  for (const request of [{ ...r.request, targetId: "target-replacement" }, { ...r.request, generation: "run-2" },
    { ...r.request, params: { value: 2 } }, { ...r.request, checkpoint: { revision: 1 } },
    { ...r.request, principal: "self" }, { ...r.request, params: { value: 1, extra: true } }]) {
    rejected(f.host.admit(context, { ...r, request })); rejected(f.host.lookup(context, { ...r, request }));
  }
  assert.equal(f.read().witness_authority.request_admission.sequence, 1);
});

test("isCurrent receives frozen permissions and authority binding independently of caller identity fields", supported, t => {
  const f = fixture(t); let checks = 0;
  const identity = { subjectId: "forged-subject", issuer: "forged-issuer", tenant: "forged-tenant", grant: { version: 999 } };
  const context = f.host.createContext(helper.assignment({ identity, isCurrent: (actual, binding) => {
    checks++;
    assert.equal(actual, identity); assert.ok(Object.isFrozen(binding.permissions));
    assert.equal(binding.authorityId, f.config.authorityId); assert.equal(binding.decisionId, f.config.storeOptions.decisionId);
    assert.equal(binding.principal.subjectId, "subject-a"); assert.equal(binding.grant.version, 1);
    return true;
  } }));
  const first = recorded(f.host.admit(context, helper.request())); assert.equal(checks, 5);
  assert.equal(f.read().witness_authority.request_admission.attempts[first.attemptId].principal.subjectId, "subject-a");
});

function caught(run) {
  try { run(); } catch (error) { return error; }
  assert.fail("expected a public error");
}
function redacted(error, code, ...secrets) {
  assert.equal(error.code, code); assert.equal(error.message, code);
  assert.equal(Object.hasOwn(error, "cause"), false); assert.equal(Object.hasOwn(error, "cleanupError"), false);
  assert.deepEqual(Reflect.ownKeys(error).sort(), ["code", "message", "stack"]);
  const surfaces = [error.message, error.stack, String(error), JSON.stringify(error),
    util.inspect(error), util.inspect(error, { showHidden: true, depth: null }), util.format("%o", error), util.format("%j", error)];
  for (const surface of surfaces) for (const secret of secrets) assert.ok(!surface.includes(secret), "public error leaked fault data");
}

for (const source of ["isCurrent", "storage"]) for (const optIn of [false, true]) {
  test(`createContext ${source} exceptions have fixed public surfaces with diagnostics ${optIn ? "opted in" : "off"}`, supported, t => {
    const f = fixture(t, false), diagnostics = optIn ? createDiagnostics() : undefined;
    const host = f.start(optIn ? { diagnostics } : {});
    const secret = "PRIVATE-CONTEXT-FAULT", primary = new Error(secret, { cause: new Error("PRIVATE-NESTED-CAUSE") });
    let inspected = 0, codeReads = 0;
    Object.defineProperty(primary, "code", { get() { codeReads++; throw Error("PRIVATE-CODE-GETTER"); } });
    primary[util.inspect.custom] = () => { inspected++; return secret; };
    let error;
    if (source === "isCurrent") {
      error = caught(() => host.createContext(helper.assignment({ isCurrent: () => { throw primary; } })));
    } else {
      const lstat = fs.lstatSync;
      fs.lstatSync = (file, ...args) => { if (file === f.file) throw primary; return lstat(file, ...args); };
      try { error = caught(() => host.createContext(helper.assignment())); } finally { fs.lstatSync = lstat; }
    }
    redacted(error, "ERR_WITNESS_NOT_AUTHORIZED", secret, "PRIVATE-NESTED-CAUSE", "PRIVATE-CODE-GETTER");
    assert.equal(inspected, 0); assert.equal(codeReads, 0);
    assert.equal(createDiagnostics().read(error), undefined);
    if (optIn) {
      const fault = diagnostics.read(error);
      assert.equal(fault.primary, primary); assert.equal(fault.cleanupFailed, false); assert.equal(fault.cleanup, undefined);
      assert.ok(Object.isFrozen(fault));
      for (const surface of [util.inspect(diagnostics, { showHidden: true, depth: null }), JSON.stringify(diagnostics)]) assert.ok(!surface.includes(secret));
    }
    // Assignment failure releases only the reentry guard; no transaction ran.
    recorded(host.admit(host.createContext(helper.assignment()), helper.request()));
  });
}

test("createContext retains known refusal, async, storage-replacement and reentry error semantics", supported, async t => {
  const f = fixture(t), input = helper.assignment();
  redacted(caught(() => f.host.createContext({ ...input, grant: { id: "g", version: 1 } })), "ERR_WITNESS_ADMISSION_HOST_INPUT");
  redacted(caught(() => f.host.createContext({ ...input, isCurrent: () => false })), "ERR_WITNESS_NOT_AUTHORIZED");
  redacted(caught(() => f.host.createContext({ ...input, isCurrent: () => Promise.reject(Error("PRIVATE-ASYNC")) })),
    "ERR_WITNESS_ADMISSION_HOST_ASYNC", "PRIVATE-ASYNC");
  let checks = 0;
  f.host.createContext({ ...input, isCurrent: () => {
    checks++;
    redacted(caught(() => f.host.createContext(input)), "ERR_WITNESS_ADMISSION_HOST_UNAVAILABLE");
    redacted(caught(() => f.host.close()), "ERR_WITNESS_ADMISSION_HOST_UNAVAILABLE");
    rejected(f.host.admit({}, helper.request())); return true;
  } });
  assert.equal(checks, 1);
  fs.renameSync(f.anchorDir, f.anchorDir + ".saved"); fs.mkdirSync(f.anchorDir, { mode: 0o700 });
  redacted(caught(() => f.host.createContext(input)), "ERR_WITNESS_ADMISSION_HOST_STORAGE_CHANGED");
  await new Promise(resolve => setImmediate(resolve));
});

for (const access of ["initialize", "open"]) for (const optIn of [false, true]) {
  test(`${access} identity collection failure preserves primary and separate cleanup, diagnostics ${optIn ? "on" : "off"}`, supported, t => {
    const f = fixture(t, access === "open");
    if (f.host) f.host.close();
    const diagnostics = optIn ? createDiagnostics() : undefined;
    const primary = new Error("PRIVATE-INITIAL-IDENTITY", { cause: new Error("PRIVATE-INITIAL-CAUSE") });
    const cleanup = new Error("PRIVATE-CLOSE-FAULT", { cause: new Error("PRIVATE-CLOSE-CAUSE") });
    let closeCalls = 0, initialized = false, inspections = 0;
    for (const error of [primary, cleanup]) error[util.inspect.custom] = () => { inspections++; throw Error("PRIVATE-INSPECT"); };
    const original = Store[access], lstat = fs.lstatSync;
    Store[access] = function (...args) {
      const store = original.apply(this, args), close = store.close.bind(store);
      initialized = true;
      store.close = () => { closeCalls++; close(); throw cleanup; };
      fs.lstatSync = (file, ...rest) => { if (file === f.file) throw primary; return lstat(file, ...rest); };
      return store;
    };
    let error;
    try { error = caught(() => f.start({ access, ...(optIn ? { diagnostics } : {}) })); }
    finally { Store[access] = original; fs.lstatSync = lstat; }
    assert.equal(initialized, true); assert.equal(closeCalls, 1);
    redacted(error, "ERR_WITNESS_ADMISSION_HOST_STORAGE_CHANGED", "PRIVATE-INITIAL-IDENTITY", "PRIVATE-INITIAL-CAUSE", "PRIVATE-CLOSE-FAULT", "PRIVATE-CLOSE-CAUSE");
    assert.equal(inspections, 0); assert.equal(createDiagnostics().read(error), undefined);
    if (optIn) {
      const fault = diagnostics.read(error);
      assert.equal(fault.primary, primary); assert.equal(fault.cleanup, cleanup); assert.equal(fault.cleanupFailed, true);
      assert.equal(diagnostics.read(cleanup), undefined); assert.ok(Object.isFrozen(fault));
    }
  });
}

test("identity collection failure closes once without inventing a cleanup failure when close succeeds", supported, t => {
  const f = fixture(t, false), diagnostics = createDiagnostics(), primary = Error("PRIVATE-PRIMARY-ONLY");
  const initialize = Store.initialize, lstat = fs.lstatSync; let closes = 0, error;
  Store.initialize = function (...args) {
    const store = initialize.apply(this, args), close = store.close.bind(store);
    store.close = () => { closes++; close(); };
    fs.lstatSync = (file, ...rest) => { if (file === f.file) throw primary; return lstat(file, ...rest); };
    return store;
  };
  try { error = caught(() => f.start({ diagnostics })); } finally { Store.initialize = initialize; fs.lstatSync = lstat; }
  assert.equal(closes, 1);
  redacted(error, "ERR_WITNESS_ADMISSION_HOST_STORAGE_CHANGED", "PRIVATE-PRIMARY-ONLY");
  assert.equal(diagnostics.read(error).primary, primary); assert.equal(diagnostics.read(error).cleanupFailed, false);
  assert.equal(diagnostics.read(error).cleanup, undefined);
});

test("public close failures are redacted, cannot reenter, and never retry the uncertain close", supported, t => {
  const f = fixture(t, false), diagnostics = createDiagnostics(), original = Store.prototype.close;
  const primary = Error("PRIVATE-HOST-CLOSE"); let enabled = false, calls = 0, host;
  Store.prototype.close = function () {
    if (!enabled) return original.call(this);
    calls++;
    host.close(); rejected(host.lookup({}, helper.request()));
    redacted(caught(() => host.createContext(helper.assignment())), "ERR_WITNESS_ADMISSION_HOST_UNAVAILABLE");
    original.call(this); throw primary;
  };
  try {
    host = f.start({ diagnostics }); enabled = true;
    const error = caught(() => host.close()); redacted(error, "ERR_WITNESS_ADMISSION_HOST_CLOSE", "PRIVATE-HOST-CLOSE");
    assert.equal(diagnostics.read(error).primary, primary);
    host.close(); host.close(); assert.equal(calls, 1);
  } finally { enabled = false; Store.prototype.close = original; }
});

test("diagnostics are opt-in private capabilities, not injectable hooks or callback-based failure handling", supported, t => {
  const f = fixture(t, false); let callbacks = 0;
  for (const diagnostics of [{ read() { callbacks++; } }, () => { callbacks++; }, { cause: "PRIVATE-DIAGNOSTIC" }]) {
    redacted(caught(() => f.start({ diagnostics })), "ERR_WITNESS_ADMISSION_HOST_INPUT", "PRIVATE-DIAGNOSTIC");
    assert.equal(fs.existsSync(f.file), false);
  }
  assert.equal(callbacks, 0);
});

test("provider-thrown code lookalikes and non-Error faults cannot select public semantics or disclose values", supported, t => {
  const f = fixture(t, false), diagnostics = createDiagnostics(), host = f.start({ diagnostics });
  for (const primary of [Object.assign(Error("PRIVATE-CODE-LOOKALIKE"), { code: "ERR_WITNESS_ADMISSION_HOST_UNAVAILABLE" }),
    "PRIVATE-THROWN-STRING", undefined, null, 0]) {
    const error = caught(() => host.createContext(helper.assignment({ isCurrent: () => { throw primary; } })));
    redacted(error, "ERR_WITNESS_NOT_AUTHORIZED", "PRIVATE-CODE-LOOKALIKE", "PRIVATE-THROWN-STRING");
    assert.equal(diagnostics.read(error).primary, primary);
    assert.equal(diagnostics.read(error).cleanupFailed, false);
  }
});

for (const phase of ["prototype", "keys", "descriptor", "property", "frozen-grant", "principal", "permissions", "resources"]) {
  for (const optIn of [false, true]) test(`whole createContext boundary redacts ${phase} input faults, diagnostics ${optIn ? "on" : "off"}`, supported, t => {
    const f = fixture(t, false), diagnostics = optIn ? createDiagnostics() : undefined;
    const host = f.start(optIn ? { diagnostics } : {});
    let errorTraps = 0, faultCalls = 0, currentCalls = 0;
    // The thrown value is itself hostile to reflection. The error boundary and
    // default presentation must not access even its code/prototype/own keys.
    const primary = new Proxy({ secret: "PRIVATE-INPUT-PROXY" }, {
      get() { errorTraps++; throw Error("PRIVATE-ERROR-GET"); },
      getPrototypeOf() { errorTraps++; throw Error("PRIVATE-ERROR-PROTOTYPE"); },
      ownKeys() { errorTraps++; throw Error("PRIVATE-ERROR-KEYS"); },
      getOwnPropertyDescriptor() { errorTraps++; throw Error("PRIVATE-ERROR-DESCRIPTOR"); }
    });
    const fault = () => { faultCalls++; throw primary; };
    let input = helper.assignment({ isCurrent: () => { currentCalls++; return true; } });
    if (phase === "prototype") input = new Proxy(input, { getPrototypeOf: fault });
    if (phase === "keys") input = new Proxy(input, { ownKeys: fault });
    if (phase === "descriptor") input = new Proxy(input, { getOwnPropertyDescriptor: fault });
    if (phase === "property") input = new Proxy(input, { get: fault });
    if (phase === "frozen-grant") input.grant = new Proxy(input.grant, { isExtensible: fault });
    if (phase === "principal") input.principal = new Proxy(input.principal, { ownKeys: fault });
    if (phase === "permissions") input.permissions = new Proxy(input.permissions, { getPrototypeOf: fault });
    if (phase === "resources") input.resources = new Proxy(input.resources, { ownKeys: fault });
    const error = caught(() => host.createContext(input));
    redacted(error, "ERR_WITNESS_ADMISSION_HOST_INPUT", "PRIVATE-INPUT-PROXY", "PRIVATE-ERROR-");
    assert.equal(faultCalls, 1); assert.equal(currentCalls, 0); assert.equal(errorTraps, 0);
    assert.equal(createDiagnostics().read(error), undefined);
    if (optIn) {
      const record = diagnostics.read(error);
      assert.equal(record.primary, primary); assert.equal(record.cleanupFailed, false); assert.equal(record.cleanup, undefined);
    }
    assert.equal(errorTraps, 0);
    recorded(host.admit(host.createContext(helper.assignment()), helper.request()));
  });
}

test("input accessors are rejected without evaluating getters or losing local INPUT semantics", supported, t => {
  const f = fixture(t, false), diagnostics = createDiagnostics(), host = f.start({ diagnostics }); let getters = 0;
  for (const field of ["identity", "principal", "resources", "isCurrent"]) {
    const input = helper.assignment();
    Object.defineProperty(input, field, { enumerable: true, get() { getters++; throw Error("PRIVATE-ACCESSOR"); } });
    const error = caught(() => host.createContext(input));
    redacted(error, "ERR_WITNESS_ADMISSION_HOST_INPUT", "PRIVATE-ACCESSOR");
    assert.equal(diagnostics.read(error).primary.code, "ERR_WITNESS_ADMISSION_HOST_INPUT");
  }
  assert.equal(getters, 0);
});

test("normalization reentry refusal cannot release the outer guard, even when nested exceptions are caught", supported, t => {
  const f = fixture(t, false), diagnostics = createDiagnostics(), host = f.start({ diagnostics });
  const context = host.createContext(helper.assignment()); let traps = 0;
  const primary = Error("PRIVATE-NORMALIZATION-FAULT");
  const input = helper.assignment({ resources: new Proxy(helper.request(), { ownKeys() {
    traps++;
    for (let i = 0; i < 2; i++) {
      redacted(caught(() => host.createContext(helper.assignment())), "ERR_WITNESS_ADMISSION_HOST_UNAVAILABLE");
      rejected(host.admit(context, helper.request())); rejected(host.lookup(context, helper.request()));
      redacted(caught(() => host.close()), "ERR_WITNESS_ADMISSION_HOST_UNAVAILABLE");
    }
    throw primary;
  } }) });
  const error = caught(() => host.createContext(input));
  redacted(error, "ERR_WITNESS_ADMISSION_HOST_INPUT", "PRIVATE-NORMALIZATION-FAULT");
  assert.equal(diagnostics.read(error).primary, primary); assert.equal(traps, 1);
  recorded(host.admit(context, helper.request()));
});

test("failed/closed hosts refuse context input before reflecting on it and retain unavailable semantics", supported, t => {
  const f = fixture(t), context = f.host.createContext(helper.assignment());
  let traps = 0;
  const input = new Proxy({}, { getPrototypeOf() { traps++; throw Error("PRIVATE-UNAVAILABLE-INPUT"); } });
  const changed = helper.request({ request: { changed: true } });
  const changedContext = f.host.createContext(helper.assignment({ resources: changed }));
  recorded(f.host.admit(context, helper.request()));
  unknown(f.host.lookup(changedContext, changed));
  redacted(caught(() => f.host.createContext(input)), "ERR_WITNESS_ADMISSION_HOST_UNAVAILABLE", "PRIVATE-UNAVAILABLE-INPUT");
  f.host.close();
  redacted(caught(() => f.host.createContext(input)), "ERR_WITNESS_ADMISSION_HOST_UNAVAILABLE", "PRIVATE-UNAVAILABLE-INPUT");
  assert.equal(traps, 0);
});
