"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { createHash } = require("node:crypto");
const { register, setEnabled, planReconcile, reconcile } = require("../../lib/agents/registry-managed");
const { deriveAgentId } = require("../../lib/agents/registry-identity");
const { readAgentExt, validateEntryExt } = require("../../lib/agents/registry-ext");
const { discover } = require("../../lib/agents/discover");
const { invoke } = require("../../lib/agents/invoke");
const { resolveTarget } = require("../../lib/agents/batch-dispatch");

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "managed-registry-"));
  t.after(() => { fs.rmSync(root, { recursive: true, force: true }); assert.equal(fs.existsSync(root), false); });
  const auth = { actor_id: "maintainer", session_id: "native-maintainer-session" };
  const identity = { provider: "openai", adapter_type: "codex", subject: "native-implementer-session" };
  const grant = { identity, role: "implementer", model: "test-model",
    capabilities: ["code_generation", "test_writing"], projects: ["example"], owned_files: ["lib/example.js"] };
  const policy = { schema_version: 1, owner_id: "owner", local_user: os.userInfo().username,
    project_id: "example", maintainers: [{ ...auth, projects: ["example"] }], grants: [grant] };
  const policyFile = path.join(root, ".agent/config/agent-registry.json");
  fs.mkdirSync(path.dirname(policyFile), { recursive: true });
  const save = () => fs.writeFileSync(policyFile, JSON.stringify(policy), { mode: 0o600 });
  save();
  const id = deriveAgentId(identity);
  const file = path.join(root, ".agent/agents", `${id}.json`);
  return { root, auth, identity, grant, policy, policyFile, save, id, file };
}

function sha256(value) { return createHash("sha256").update(value).digest("hex"); }

test("reconcile plans from Owner policy and applies an audited disabled profile with CAS hashes", (t) => {
  const f = fixture(t);
  const original = register(f.root, f.identity, f.auth);
  f.grant.role = "reviewer";
  f.grant.model = "review-model";
  f.grant.capabilities = ["code_review"];
  f.grant.owned_files = ["lib/example.js", "tests/example.test.js"];
  f.save();

  const plan = planReconcile(f.root, f.id, f.auth);
  assert.equal(plan.changed, true);
  assert.equal(plan.agent_id, original.agent_id);
  assert.equal(plan.enabled, false);
  assert.equal(plan.profile_revision, 1);
  assert.equal(plan.next_profile_revision, 2);
  assert.equal(plan.policy_sha256, sha256(fs.readFileSync(f.policyFile)));
  assert.equal(plan.entry_sha256, sha256(fs.readFileSync(f.file)));
  assert.deepEqual(plan.target_profile, {
    role: "reviewer", model: "review-model", capabilities: ["code_review"],
    projects: ["example"], owned_files: ["lib/example.js", "tests/example.test.js"],
  });
  assert.equal(fs.readFileSync(f.file, "utf8"), `${JSON.stringify(original, null, 2)}\n`);

  const updated = reconcile(f.root, f.id, f.auth, {
    expectedEntrySha256: plan.entry_sha256,
    expectedPolicySha256: plan.policy_sha256,
  });
  assert.equal(updated.agent_id, original.agent_id);
  assert.deepEqual(updated.identity, original.identity);
  assert.equal(updated.enabled, false);
  assert.equal(updated.role, "reviewer");
  assert.equal(updated.model, "review-model");
  assert.deepEqual(updated.capabilities, ["code_review"]);
  assert.deepEqual(updated.projects, ["example"]);
  assert.deepEqual(updated.owned_files, ["lib/example.js", "tests/example.test.js"]);
  assert.equal(updated.profile_revision, 2);
  assert.deepEqual(updated.registration.events.map((event) => event.action), ["register", "reconcile"]);
  assert.equal(updated.registration.events[1].profile_revision, 2);
  assert.match(updated.registration.events[1].previous_profile_sha256, /^[a-f0-9]{64}$/);
  assert.match(updated.registration.events[1].profile_sha256, /^[a-f0-9]{64}$/);
  assert.notEqual(updated.registration.events[1].previous_profile_sha256, updated.registration.events[1].profile_sha256);
  assert.equal(fs.existsSync(path.join(f.root, ".agent/runtime")), false);
  assert.equal(fs.existsSync(path.join(f.root, ".agent-runtime/coordination")), false);
  assert.equal(setEnabled(f.root, f.id, true, f.auth).role, "reviewer");
});

test("reconcile with an already-matching profile is a read-only no-op", (t) => {
  const f = fixture(t);
  const original = register(f.root, f.identity, f.auth);
  const plan = planReconcile(f.root, f.id, f.auth);
  assert.equal(plan.changed, false);
  const result = reconcile(f.root, f.id, f.auth, {
    expectedEntrySha256: plan.entry_sha256,
    expectedPolicySha256: plan.policy_sha256,
  });
  assert.deepEqual(result, original);
  assert.equal(fs.readFileSync(f.file, "utf8"), `${JSON.stringify(original, null, 2)}\n`);
});

test("reconcile fails closed for enabled, unauthorized, and stale profile or policy snapshots", (t) => {
  const f = fixture(t);
  const original = register(f.root, f.identity, f.auth);
  f.grant.model = "changed-model";
  f.save();
  const plan = planReconcile(f.root, f.id, f.auth);
  const before = fs.readFileSync(f.file, "utf8");

  assert.throws(() => planReconcile(f.root, f.id, { ...f.auth, actor_id: "forged" }),
    { code: "ERR_REGISTRY_UNAUTHORIZED" });
  assert.throws(() => reconcile(f.root, f.id, f.auth, {
    expectedEntrySha256: "0".repeat(64), expectedPolicySha256: plan.policy_sha256,
  }), { code: "ERR_REGISTRY_STALE" });
  assert.equal(fs.readFileSync(f.file, "utf8"), before);

  f.grant.model = "newer-model";
  f.save();
  assert.throws(() => reconcile(f.root, f.id, f.auth, {
    expectedEntrySha256: plan.entry_sha256, expectedPolicySha256: plan.policy_sha256,
  }), { code: "ERR_REGISTRY_STALE" });
  assert.equal(fs.readFileSync(f.file, "utf8"), before);

  f.grant.model = "test-model";
  f.save();
  setEnabled(f.root, f.id, true, f.auth);
  f.grant.model = "enabled-profile-mismatch";
  f.save();
  const enabled = fs.readFileSync(f.file, "utf8");
  const enabledPlan = planReconcile(f.root, f.id, f.auth);
  assert.equal(enabledPlan.enabled, true);
  assert.throws(() => reconcile(f.root, f.id, f.auth, {
    expectedEntrySha256: enabledPlan.entry_sha256,
    expectedPolicySha256: enabledPlan.policy_sha256,
  }), { code: "ERR_REGISTRY_ENABLED" });
  assert.equal(fs.readFileSync(f.file, "utf8"), enabled);
  assert.equal(JSON.parse(enabled).agent_id, original.agent_id);
});

test("reconcile atomically preserves the old record on publication failure", (t) => {
  const f = fixture(t);
  register(f.root, f.identity, f.auth);
  f.grant.model = "changed-model";
  f.save();
  const plan = planReconcile(f.root, f.id, f.auth);
  const before = fs.readFileSync(f.file, "utf8");
  const rename = fs.renameSync;
  fs.renameSync = () => { throw new Error("injected reconcile IO failure"); };
  try {
    assert.throws(() => reconcile(f.root, f.id, f.auth, {
      expectedEntrySha256: plan.entry_sha256,
      expectedPolicySha256: plan.policy_sha256,
    }), /injected reconcile IO failure/);
  } finally { fs.renameSync = rename; }
  assert.equal(fs.readFileSync(f.file, "utf8"), before);
  assert.deepEqual(fs.readdirSync(path.dirname(f.file)), [`${f.id}.json`]);
});

test("reconcile upgrades pre-revision managed records without changing their identity or journal", (t) => {
  const f = fixture(t);
  register(f.root, f.identity, f.auth);
  const legacy = JSON.parse(fs.readFileSync(f.file, "utf8"));
  delete legacy.profile_revision;
  fs.writeFileSync(f.file, JSON.stringify(legacy, null, 2) + "\n");
  setEnabled(f.root, f.id, true, f.auth);
  setEnabled(f.root, f.id, false, f.auth);
  const before = JSON.parse(fs.readFileSync(f.file, "utf8"));

  f.grant.model = "migrated-model";
  f.save();
  const plan = planReconcile(f.root, f.id, f.auth);
  assert.equal(plan.profile_revision, 1);
  const updated = reconcile(f.root, f.id, f.auth, {
    expectedEntrySha256: plan.entry_sha256,
    expectedPolicySha256: plan.policy_sha256,
  });
  assert.equal(updated.profile_revision, 2);
  assert.equal(updated.agent_id, before.agent_id);
  assert.deepEqual(updated.identity, before.identity);
  assert.deepEqual(updated.registration.events.slice(0, 3), before.registration.events);
  assert.deepEqual(updated.registration.events.map((event) => event.action),
    ["register", "enable", "disable", "reconcile"]);
});

test("reconcile preserves audit capacity for an explicit re-enable and final disable", (t) => {
  const f = fixture(t);
  const entry = register(f.root, f.identity, f.auth);
  const first = entry.registration.events[0];
  entry.registration.events = Array.from({ length: 9998 }, (_, index) => ({ ...first,
    action: index === 0 ? "register" : index % 2 ? "enable" : "disable" }));
  entry.registration.events[9997].action = "disable";
  fs.writeFileSync(f.file, JSON.stringify(entry));
  f.grant.model = "changed-model";
  f.save();
  const plan = planReconcile(f.root, f.id, f.auth);
  const before = fs.readFileSync(f.file, "utf8");
  assert.throws(() => reconcile(f.root, f.id, f.auth, {
    expectedEntrySha256: plan.entry_sha256,
    expectedPolicySha256: plan.policy_sha256,
  }), { code: "ERR_REGISTRY_AUDIT_CAPACITY" });
  assert.equal(fs.readFileSync(f.file, "utf8"), before);
});

test("managed lifecycle has authoritative readback, idempotence and append-only audit", (t) => {
  const f = fixture(t);
  let entry = register(f.root, f.identity, f.auth);
  assert.equal(entry.enabled, false);
  assert.equal(discover({ projectRoot: f.root, managedOnly: true }).returned, 0);
  assert.equal(discover({ projectRoot: f.root, includeDisabled: true }).agents[0].agent_id, f.id);
  assert.throws(() => readAgentExt(f.root, f.id), { code: "ERR_AGENT_DISABLED" });
  const first = entry.registration.events[0];
  entry = setEnabled(f.root, f.id, true, f.auth);
  assert.deepEqual(entry.registration.events[0], first);
  assert.equal(setEnabled(f.root, f.id, true, f.auth).registration.events.length, 2);
  assert.equal(readAgentExt(f.root, f.id).enabled, true);
  const found = discover({ projectRoot: f.root, managedOnly: true }).agents[0];
  assert.equal(found.managed, true);
  assert.deepEqual(found.projects, ["example"]);
  assert.deepEqual(found.owned_files, ["lib/example.js"]);
  entry = setEnabled(f.root, f.id, false, f.auth);
  assert.deepEqual(entry.registration.events.map((e) => e.action), ["register", "enable", "disable"]);
  assert.equal(setEnabled(f.root, f.id, false, f.auth).registration.events.length, 3);
  assert.deepEqual(fs.readdirSync(path.dirname(f.file)), [`${f.id}.json`]);
  assert.equal(fs.existsSync(path.join(f.root, ".agent/runtime")), false);
  assert.equal(fs.existsSync(path.join(f.root, ".agent-runtime")), false);
  assert.equal(fs.existsSync(path.join(f.root, ".agent/sessions")), false);
});

test("duplicate identity and unauthorized registration leave no partial records", (t) => {
  const f = fixture(t);
  for (const auth of [{ ...f.auth, actor_id: "forged" }, { ...f.auth, session_id: "forged" }]) {
    assert.throws(() => register(f.root, f.identity, auth), { code: "ERR_REGISTRY_UNAUTHORIZED" });
  }
  assert.throws(() => register(f.root, { ...f.identity, subject: "unverified" }, f.auth), { code: "ERR_REGISTRY_UNAUTHORIZED" });
  f.policy.maintainers[0].projects = ["other"];
  f.save();
  assert.throws(() => register(f.root, f.identity, f.auth), { code: "ERR_REGISTRY_UNAUTHORIZED" });
  assert.equal(fs.existsSync(path.dirname(f.file)), false);
  f.policy.maintainers[0].projects = ["example"]; f.save();
  register(f.root, f.identity, f.auth);
  const before = fs.readFileSync(f.file, "utf8");
  assert.throws(() => register(f.root, f.identity, f.auth), { code: "ERR_REGISTRY_DUPLICATE" });
  assert.equal(fs.readFileSync(f.file, "utf8"), before);
  assert.deepEqual(fs.readdirSync(path.dirname(f.file)), [`${f.id}.json`]);
});

test("OS identity and owner policy are required; no first-writer owner fallback", (t) => {
  const f = fixture(t);
  f.policy.local_user = "another-os-user"; f.save();
  assert.throws(() => register(f.root, f.identity, f.auth), { code: "ERR_REGISTRY_UNAUTHORIZED" });
  fs.unlinkSync(f.policyFile);
  assert.throws(() => register(f.root, f.identity, f.auth), { code: "ERR_REGISTRY_POLICY" });
  fs.writeFileSync(f.policyFile, "{}");
  assert.throws(() => register(f.root, f.identity, f.auth), { code: "ERR_REGISTRY_INVALID" });
  assert.equal(fs.existsSync(path.dirname(f.file)), false);
});

test("symlink policy, registry directory and target record are rejected", (t) => {
  if (process.platform === "win32") return; // symlink privilege is not guaranteed on Windows
  const f = fixture(t);
  const outside = path.join(f.root, "outside.json");
  fs.renameSync(f.policyFile, outside); fs.symlinkSync(outside, f.policyFile);
  assert.throws(() => register(f.root, f.identity, f.auth), { code: "ERR_REGISTRY_UNSAFE_PATH" });
  fs.unlinkSync(f.policyFile); fs.renameSync(outside, f.policyFile);
  const other = path.join(f.root, "elsewhere"); fs.mkdirSync(other);
  fs.symlinkSync(other, path.dirname(f.file));
  assert.throws(() => register(f.root, f.identity, f.auth), { code: "ERR_REGISTRY_UNSAFE_PATH" });
  assert.deepEqual(fs.readdirSync(other), []);
  fs.unlinkSync(path.dirname(f.file));
  register(f.root, f.identity, f.auth);
  fs.renameSync(f.file, outside); fs.symlinkSync(outside, f.file);
  assert.throws(() => setEnabled(f.root, f.id, true, f.auth), { code: "ERR_REGISTRY_UNSAFE_PATH" });
  assert.equal(JSON.parse(fs.readFileSync(outside)).enabled, false);
});

test("enable checks the current owner grant, while disable supports revoked grants", (t) => {
  const f = fixture(t);
  register(f.root, f.identity, f.auth);
  f.grant.model = "changed-model"; f.save();
  assert.throws(() => setEnabled(f.root, f.id, true, f.auth), { code: "ERR_REGISTRY_UNAUTHORIZED" });
  f.grant.model = "test-model"; f.save();
  setEnabled(f.root, f.id, true, f.auth);
  f.policy.grants = []; f.save();
  assert.throws(() => setEnabled(f.root, f.id, true, f.auth), { code: "ERR_REGISTRY_UNAUTHORIZED" });
  assert.equal(setEnabled(f.root, f.id, false, f.auth).enabled, false);
});

test("disabled profiles fail before invocation or batch adapter selection", (t) => {
  const f = fixture(t);
  register(f.root, f.identity, f.auth);
  assert.equal(invoke({ projectRoot: f.root, agentId: f.id, taskDescription: "do work" }).error.code, "ERR_AGENT_DISABLED");
  assert.throws(() => resolveTarget(f.root, f.id), /disabled/);
});

test("extended adapters round-trip without modifying the frozen registry", (t) => {
  const f = fixture(t);
  for (const adapter_type of ["dsh", "minimax", "cursor"]) {
    f.grant.identity = { ...f.identity, adapter_type }; f.policy.grants = [f.grant]; f.save();
    const entry = register(f.root, f.grant.identity, f.auth);
    assert.equal(setEnabled(f.root, entry.agent_id, true, f.auth).external.adapter_type, adapter_type);
  }
});

test("corrupt managed records cannot bypass enabled/identity/journal validation", (t) => {
  const f = fixture(t);
  const good = register(f.root, f.identity, f.auth);
  for (const change of [{ enabled: true }, { agent_id: "sample" }, { unexpected: true },
    { identity: { ...f.identity, subject: "other-host" } }, { external: null },
    { registration: { ...good.registration, events: [] } }]) {
    assert.throws(() => validateEntryExt({ ...good, ...change }), { code: "ERR_REGISTRY_INVALID" });
  }
});

test("failed atomic writes preserve the old profile and clean lock/temp files", (t) => {
  const f = fixture(t);
  register(f.root, f.identity, f.auth);
  const before = fs.readFileSync(f.file, "utf8");
  const rename = fs.renameSync;
  fs.renameSync = () => { throw new Error("injected IO failure"); };
  try { assert.throws(() => setEnabled(f.root, f.id, true, f.auth), /injected IO/); }
  finally { fs.renameSync = rename; }
  assert.equal(fs.readFileSync(f.file, "utf8"), before);
  assert.deepEqual(fs.readdirSync(path.dirname(f.file)), [`${f.id}.json`]);
});

test("a conflicting writer fails closed without stealing or clearing its lock", (t) => {
  const f = fixture(t);
  fs.mkdirSync(path.dirname(f.file));
  const lock = path.join(path.dirname(f.file), ".registry-write.lock");
  fs.writeFileSync(lock, "other-live-writer");
  assert.throws(() => register(f.root, f.identity, f.auth), { code: "ERR_REGISTRY_BUSY" });
  assert.equal(fs.readFileSync(lock, "utf8"), "other-live-writer");
  assert.equal(fs.existsSync(f.file), false);
});

test("failed initial publication cleans temporary files and creates no profile", (t) => {
  const f = fixture(t);
  const link = fs.linkSync;
  fs.linkSync = () => { throw new Error("injected link failure"); };
  try { assert.throws(() => register(f.root, f.identity, f.auth), /injected link/); }
  finally { fs.linkSync = link; }
  assert.equal(fs.existsSync(f.file), false);
  assert.deepEqual(fs.readdirSync(path.dirname(f.file)), []);
});

test("post-publication readback failure reports committed state, never false success", (t) => {
  const f = fixture(t);
  const read = fs.readFileSync;
  fs.readFileSync = (file, ...args) => file === f.file ? "{corrupt-readback" : read(file, ...args);
  try {
    assert.throws(() => register(f.root, f.identity, f.auth),
      (error) => error.code === "ERR_REGISTRY_READBACK" && error.committed === true);
  } finally { fs.readFileSync = read; }
  assert.equal(JSON.parse(fs.readFileSync(f.file)).enabled, false);
  assert.deepEqual(fs.readdirSync(path.dirname(f.file)), [`${f.id}.json`]);
});

test("invalid capabilities and policy permissions fail before a profile is created", (t) => {
  const f = fixture(t);
  f.grant.capabilities = ["code_generation"]; f.save();
  assert.throws(() => register(f.root, f.identity, f.auth), { code: "ERR_REGISTRY_CAPABILITY" });
  f.grant.capabilities = ["code_generation", "test_writing"]; f.save();
  if (process.platform !== "win32") {
    fs.chmodSync(f.policyFile, 0o666);
    assert.throws(() => register(f.root, f.identity, f.auth), { code: "ERR_REGISTRY_UNAUTHORIZED" });
  }
  assert.equal(fs.existsSync(path.dirname(f.file)), false);
});

test("owner changes and malformed auth cannot silently mutate an existing grant", (t) => {
  const f = fixture(t);
  register(f.root, f.identity, f.auth);
  const before = fs.readFileSync(f.file, "utf8");
  f.policy.owner_id = "another-owner"; f.save();
  assert.throws(() => setEnabled(f.root, f.id, true, f.auth), { code: "ERR_REGISTRY_UNAUTHORIZED" });
  assert.throws(() => setEnabled(f.root, f.id, false, { ...f.auth, kind: "owner" }), { code: "ERR_REGISTRY_INVALID" });
  assert.throws(() => setEnabled(f.root, "../sample", true, f.auth), { code: "ERR_REGISTRY_INVALID" });
  assert.throws(() => setEnabled(f.root, f.id, "true", f.auth), { code: "ERR_REGISTRY_INVALID" });
  assert.equal(fs.readFileSync(f.file, "utf8"), before);
});

test("requesting A cannot enable B through a symlink or mismatched record, even on a no-op", (t) => {
  const f = fixture(t);
  register(f.root, f.identity, f.auth);
  const otherIdentity = { ...f.identity, subject: "native-independent-b" };
  f.policy.grants.push({ ...f.grant, identity: otherIdentity }); f.save();
  const other = register(f.root, otherIdentity, f.auth);
  const otherFile = path.join(path.dirname(f.file), `${other.agent_id}.json`);
  const before = fs.readFileSync(otherFile, "utf8");
  fs.unlinkSync(f.file);
  if (process.platform !== "win32") {
    fs.symlinkSync(otherFile, f.file);
    for (const enabled of [true, false]) assert.throws(() => setEnabled(f.root, f.id, enabled, f.auth),
      { code: "ERR_REGISTRY_UNSAFE_PATH" });
    fs.unlinkSync(f.file);
  }
  fs.copyFileSync(otherFile, f.file);
  assert.throws(() => setEnabled(f.root, f.id, true, f.auth), { code: "ERR_REGISTRY_UNSAFE_PATH" });
  assert.equal(fs.readFileSync(otherFile, "utf8"), before);
});

test("temp cleanup failure reports committed publication and its exact residual artifact", (t) => {
  const f = fixture(t), unlink = fs.unlinkSync;
  fs.unlinkSync = (file) => {
    if (file.endsWith(".tmp")) throw Object.assign(new Error("injected cleanup IO"), { code: "EIO" });
    return unlink(file);
  };
  let failure;
  try { register(f.root, f.identity, f.auth); } catch (error) { failure = error; }
  finally { fs.unlinkSync = unlink; }
  assert.equal(failure.code, "ERR_REGISTRY_CLEANUP");
  assert.equal(failure.committed, true);
  assert.equal(failure.cleanup[0].operation, "temp_unlink");
  assert.equal(fs.existsSync(failure.remaining_artifacts[0]), true);
  assert.equal(JSON.parse(fs.readFileSync(f.file)).enabled, false);
});

test("readback failure remains primary when cleanup also fails", (t) => {
  const f = fixture(t), read = fs.readFileSync, unlink = fs.unlinkSync;
  fs.readFileSync = (file, ...args) => file === f.file ? "{corrupt-readback" : read(file, ...args);
  fs.unlinkSync = (file) => {
    if (file.endsWith(".tmp")) throw Object.assign(new Error("injected cleanup IO"), { code: "EIO" });
    return unlink(file);
  };
  let failure;
  try { register(f.root, f.identity, f.auth); } catch (error) { failure = error; }
  finally { fs.readFileSync = read; fs.unlinkSync = unlink; }
  assert.equal(failure.code, "ERR_REGISTRY_READBACK");
  assert.equal(failure.committed, true);
  assert.equal(failure.cleanup[0].code, "EIO");
});

test("ambiguous lock close preserves committed state and retains the lock", (t) => {
  const f = fixture(t), close = fs.closeSync, open = fs.openSync;
  let lockFd;
  fs.openSync = (file, ...args) => {
    const fd = open(file, ...args);
    if (file.endsWith(".registry-write.lock")) lockFd = fd;
    return fd;
  };
  fs.closeSync = (fd) => {
    if (fd === lockFd) throw Object.assign(new Error("injected lock close IO"), { code: "EIO" });
    return close(fd);
  };
  let failure;
  try { register(f.root, f.identity, f.auth); } catch (error) { failure = error; }
  finally { fs.closeSync = close; fs.openSync = open; if (lockFd !== undefined) close(lockFd); }
  assert.equal(failure.code, "ERR_REGISTRY_CLEANUP");
  assert.equal(failure.committed, true);
  assert.equal(failure.cleanup[0].operation, "lock_close");
  assert.equal(fs.existsSync(path.join(path.dirname(f.file), ".registry-write.lock")), true);
});

test("lock unlink failure preserves publication and reports the remaining lock", (t) => {
  const f = fixture(t), unlink = fs.unlinkSync;
  fs.unlinkSync = (file) => {
    if (file.endsWith(".registry-write.lock")) throw Object.assign(new Error("injected lock unlink IO"), { code: "EIO" });
    return unlink(file);
  };
  let failure;
  try { register(f.root, f.identity, f.auth); } catch (error) { failure = error; }
  finally { fs.unlinkSync = unlink; }
  assert.equal(failure.committed, true);
  assert.equal(failure.cleanup[0].operation, "lock_unlink");
  assert.equal(fs.existsSync(failure.remaining_artifacts[0]), true);
});

test("audit capacity always allows final disable without truncating history", (t) => {
  const f = fixture(t);
  const entry = register(f.root, f.identity, f.auth);
  const first = entry.registration.events[0];
  const history = (length) => Array.from({ length }, (_, index) => ({ ...first,
    action: index === 0 ? "register" : index % 2 ? "enable" : "disable" }));
  entry.registration.events = history(9999); entry.enabled = false;
  fs.writeFileSync(f.file, JSON.stringify(entry));
  assert.throws(() => setEnabled(f.root, f.id, true, f.auth), { code: "ERR_REGISTRY_AUDIT_CAPACITY" });
  entry.registration.events = history(10000); entry.enabled = true;
  fs.writeFileSync(f.file, JSON.stringify(entry));
  const disabled = setEnabled(f.root, f.id, false, f.auth);
  assert.equal(disabled.enabled, false);
  assert.equal(disabled.registration.events.length, 10001);
  assert.deepEqual(disabled.registration.events.slice(0, 10000), entry.registration.events);
  assert.equal(setEnabled(f.root, f.id, false, f.auth).registration.events.length, 10001);
  assert.throws(() => setEnabled(f.root, f.id, true, f.auth), { code: "ERR_REGISTRY_AUDIT_CAPACITY" });
});
