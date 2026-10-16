"use strict";

// Source-level temporary-file fixtures only. No child process, AI Host,
// authority write, lease, production project, or L3 canary is exercised.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const childProcess = require("node:child_process");
const { prepareStrictDispatch } = require("../../lib/dispatch/strict-approval");
const { createFilesystemRevision } = require("../../lib/governance/store");
const { resolveRuntimePaths } = require("../../lib/runtime-layout");
const sha = (value) => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-strict-preflight-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const dir of ["decisions", "waitpoints"]) fs.mkdirSync(path.join(root, ".agent", dir), { recursive: true });
  const date = (offset) => new Date(Date.now() + offset).toISOString();
  const relations = { task_ids: ["T-FIXTURE"], mission_ids: [], run_ids: [], queue_ids: [], session_ids: [], artifact_refs: [], worktree_paths: [] };
  const gate = { action: "external_side_effect", resource_ref: "task:T-FIXTURE" };
  const d = { schema_version: 1, decision_id: "D-FIXTURE", type: "approval", status: "approved",
    requested_by: "fixture-owner", prompt: "Synthetic test record, not a user approval.",
    options: ["approve", "reject"], selected_option: "approve", resolved_by: "fixture-user",
    resolved_at: date(-60000), rationale: "Synthetic fixture", gate, relations,
    created_at: date(-120000), updated_at: date(-60000) };
  const w = { schema_version: 1, waitpoint_id: "WP-FIXTURE", status: "released", owner_workflow: "/mission",
    reason: "Synthetic test record", gate: { ...gate }, decision_id: d.decision_id,
    evidence_refs: [".agent/decisions/D-FIXTURE.json"], relations: { ...relations },
    released_by: "fixture-owner", released_at: date(-30000), release_note: "Synthetic fixture",
    expires_at: date(3600000), created_at: date(-120000), updated_at: date(-30000) };
  const input = { enabled: true, projectRoot: root, taskId: "T-FIXTURE", decisionId: d.decision_id,
    waitpointId: w.waitpoint_id, ownerWorkflow: "/mission", hostRef: "host:fixture", idempotencyKey: "strict-fixture" };
  const decisionPath = path.join(root, ".agent/decisions/D-FIXTURE.json");
  const waitpointPath = path.join(root, ".agent/waitpoints/WP-FIXTURE.json");
  const save = () => { fs.writeFileSync(decisionPath, JSON.stringify(d)); fs.writeFileSync(waitpointPath, JSON.stringify(w)); };
  save();
  return { root, d, w, input, save, decisionPath, waitpointPath };
}
function snapshot(root) {
  const out = [];
  function walk(dir) {
    for (const name of fs.readdirSync(dir).sort()) {
      const file = path.join(dir, name);
      const stat = fs.lstatSync(file, { bigint: true });
      out.push([path.relative(root, file), String(stat.mode), String(stat.mtimeNs),
        stat.isSymbolicLink() ? fs.readlinkSync(file) : stat.isFile() ? fs.readFileSync(file).toString("base64") : null]);
      if (stat.isDirectory()) walk(file);
    }
  }
  walk(root);
  return out;
}
function noEffects(fn) {
  const attempts = [];
  const restore = [];
  function guard(target, method, replace) {
    const original = target[method];
    if (typeof original !== "function") return;
    target[method] = replace || (() => { attempts.push(method); throw new Error("Forbidden test effect: " + method); });
    restore.push(() => { target[method] = original; });
  }
  const originalOpen = fs.openSync;
  guard(fs, "openSync", (file, flags, ...rest) => {
    const writing = typeof flags === "string" ? flags !== "r" : (flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_APPEND)) !== 0;
    if (writing) { attempts.push("openSync(write)"); throw new Error("Forbidden write open"); }
    return originalOpen(file, flags, ...rest);
  });
  for (const name of ["writeFileSync", "appendFileSync", "mkdirSync", "renameSync", "unlinkSync", "rmSync",
    "rmdirSync", "truncateSync", "ftruncateSync", "writeSync", "linkSync", "symlinkSync", "chmodSync", "chownSync", "utimesSync"]) guard(fs, name);
  for (const name of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"]) guard(childProcess, name);
  for (const name of ["node:http", "node:https", "node:net", "node:tls"]) {
    const module_ = require(name);
    for (const method of ["request", "get", "connect", "createConnection", "createServer"]) guard(module_, method);
  }
  guard(globalThis, "fetch");
  try { return fn(); } finally { for (const undo of restore.reverse()) undo(); assert.deepEqual(attempts, []); }
}
function checked(f) {
  const before = snapshot(f.root);
  const value = noEffects(() => prepareStrictDispatch(f.input));
  assert.equal(value.execution_authorized, false);
  assert.equal(value.effect_permitted, false);
  assert.deepEqual(snapshot(f.root), before);
  return value;
}

test("disabled by default and explicitly false: no reads or effects", () => {
  const oldOpen = fs.openSync;
  fs.openSync = () => { assert.fail("disabled preflight must not open a file"); };
  try {
    assert.equal(prepareStrictDispatch().status, "DISABLED");
    assert.equal(prepareStrictDispatch({ enabled: false, projectRoot: "/not-a-project" }).status, "DISABLED");
  } finally { fs.openSync = oldOpen; }
});
test("valid schema-compatible bound files are read but never authorize execution", (t) => {
  const f = fixture(t);
  const value = checked(f);
  assert.equal(value.status, "DEFERRED");
  assert.equal(value.preflight_matched, true);
  assert.equal(value.source.kind, "bound_local_filesystem");
  assert.equal(value.source.decision_revision.store_kind, "filesystem");
  assert.ok(value.pending_gates.includes("atomic_authority_fence_at_sink"));
  assert.equal(value.cache_state, "absent");
});

const denials = [
  ["missing Decision", (f) => fs.unlinkSync(f.decisionPath), "ERR_STRICT_PAIR_MISSING"],
  ["missing Waitpoint", (f) => fs.unlinkSync(f.waitpointPath), "ERR_STRICT_PAIR_MISSING"],
  ["unknown request field cannot inject a snapshot", (f) => { f.input.snapshot = { approved: true }; }, "ERR_STRICT_INPUT_UNKNOWN"],
  ["missing owner workflow", (f) => { delete f.input.ownerWorkflow; }, "ERR_STRICT_OWNER_WORKFLOW_REQUIRED"],
  ["wrong owner workflow", (f) => { f.input.ownerWorkflow = "/plan"; }, "ERR_STRICT_OWNER_WORKFLOW_MISMATCH"],
  ["Task traversal", (f) => { f.input.taskId = "../T-FIXTURE"; }, "ERR_STRICT_ID_INVALID"],
  ["idempotency traversal", (f) => { f.input.idempotencyKey = "../key"; }, "ERR_STRICT_IDEMPOTENCY_KEY"],
  ["unapproved Decision", (f) => { f.d.status = "rejected"; f.save(); }, "ERR_STRICT_DECISION_NOT_APPROVED"],
  ["wrong selected option", (f) => { f.d.selected_option = "reject"; f.save(); }, "ERR_STRICT_DECISION_NOT_APPROVED"],
  ["blocked Waitpoint", (f) => { f.w.status = "blocked"; f.save(); }, "ERR_STRICT_WAITPOINT_NOT_RELEASED"],
  ["canceled Waitpoint", (f) => { f.w.status = "canceled"; f.save(); }, "ERR_STRICT_WAITPOINT_NOT_RELEASED"],
  ["different Decision link", (f) => { f.w.decision_id = "D-OTHER"; f.save(); }, "ERR_STRICT_WAITPOINT_NOT_RELEASED"],
  ["wrong resource", (f) => { f.w.gate.resource_ref = "task:T-OTHER"; f.save(); }, "ERR_STRICT_SCOPE_MISMATCH"],
  ["architecture approval is not strict execution scope", (f) => { f.d.gate.action = "architecture"; f.w.gate.action = "architecture"; f.save(); }, "ERR_STRICT_SCOPE_MISMATCH"],
  ["Task missing from Waitpoint", (f) => { f.w.relations = { ...f.w.relations, task_ids: [] }; f.save(); }, "ERR_STRICT_SCOPE_MISMATCH"],
  ["malformed expiry", (f) => { f.w.expires_at = "tomorrow"; f.save(); }, "ERR_STRICT_SCHEMA_INVALID"],
  ["missing finite expiry", (f) => { f.w.expires_at = null; f.save(); }, "ERR_STRICT_WAITPOINT_EXPIRED"],
  ["expired Waitpoint", (f) => { f.w.expires_at = "2000-01-01T00:00:00.000Z"; f.save(); }, "ERR_STRICT_WAITPOINT_EXPIRED"],
  ["release before resolution", (f) => { f.w.released_at = f.d.created_at; f.save(); }, "ERR_STRICT_RELEASE_PROVENANCE"],
  ["missing required schema field", (f) => { delete f.d.prompt; f.save(); }, "ERR_STRICT_SCHEMA_INVALID"],
  ["unknown nested schema field", (f) => { f.w.gate.admin = true; f.save(); }, "ERR_STRICT_SCHEMA_INVALID"],
  ["fixture approved_scope rejected by canonical schema", (f) => { f.d.approved_scope = {}; f.save(); }, "ERR_STRICT_SCHEMA_INVALID"],
  ["invalid workflow gate label is rejected", (f) => { f.d.workflow_gate = "admin"; f.save(); }, "ERR_STRICT_SCHEMA_INVALID"],
  ["filename and record ID disagree", (f) => { f.d.decision_id = "D-OTHER"; f.save(); }, "ERR_STRICT_RECORD_ID"],
  ["malformed JSON", (f) => fs.writeFileSync(f.waitpointPath, "{"), "ERR_STRICT_SOURCE_JSON"],
  ["leaf symlink rejected", (f) => { const target = path.join(f.root, "fixture-copy.json"); fs.copyFileSync(f.waitpointPath, target); fs.unlinkSync(f.waitpointPath); fs.symlinkSync(target, f.waitpointPath); }, "ERR_STRICT_SOURCE_UNSAFE"],
];
for (const [name, mutate, code] of denials) test(name + ": zero effect", (t) => {
  const f = fixture(t); mutate(f);
  const value = checked(f);
  assert.equal(value.status, "BLOCKED");
  assert.equal(value.code, code);
});

function seedCache(f) {
  const layout = resolveRuntimePaths(f.root);
  const dispatchRoot = layout.legacyExists && !layout.activated ? layout.dispatch.legacy : layout.dispatch.new;
  const file = path.join(dispatchRoot, "idempotency", f.input.idempotencyKey + ".json");
  const dRev = createFilesystemRevision(fs.readFileSync(f.decisionPath, "utf8"));
  const wRev = createFilesystemRevision(fs.readFileSync(f.waitpointPath, "utf8"));
  const record = { schema_version: 1, idempotency_key: f.input.idempotencyKey, task_id: f.input.taskId,
    request_digest: sha([fs.realpathSync(f.root), fs.realpathSync(path.join(f.root, ".agent")),
      f.input.taskId, f.input.hostRef, f.input.ownerWorkflow, f.input.decisionId, f.input.waitpointId]),
    status: "accepted", execution: { decision_id: f.input.decisionId, waitpoint_id: f.input.waitpointId,
      approval_digest: sha([fs.realpathSync(f.root), fs.realpathSync(path.join(f.root, ".agent")), dRev, wRev]) }, expires_at: new Date(Date.now() + 3600000).toISOString() };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const save = () => fs.writeFileSync(file, JSON.stringify(record));
  save(); return { record, file, save };
}
test("cache match still cannot return execution success", (t) => {
  const f = fixture(t); seedCache(f);
  const value = checked(f);
  assert.equal(value.status, "DEFERRED");
  assert.equal(value.cache_state, "matched_non_authoritative_record");
});
test("revocation/status change blocks before an accepted cache is returned", (t) => {
  const f = fixture(t); seedCache(f);
  f.d.status = "rejected"; f.save();
  assert.equal(checked(f).code, "ERR_STRICT_DECISION_NOT_APPROVED");
});
test("cache cannot move to a different Host", (t) => {
  const f = fixture(t); seedCache(f); f.input.hostRef = "host:other";
  assert.equal(checked(f).code, "ERR_STRICT_CACHE_UNUSABLE");
});
test("same record IDs but changed bytes invalidate cached acceptance", (t) => {
  const f = fixture(t); seedCache(f); f.d.rationale = "Changed after earlier cache"; f.save();
  assert.equal(checked(f).code, "ERR_STRICT_CACHE_UNUSABLE");
});
test("malformed cache does not fall through to re-execution", (t) => {
  const f = fixture(t); const cache = seedCache(f); fs.writeFileSync(cache.file, "{");
  assert.equal(checked(f).code, "ERR_STRICT_SOURCE_JSON");
});
test("legacy cached acceptance lacking the strict binding is unusable", (t) => {
  const f = fixture(t); const cache = seedCache(f); delete cache.record.execution.waitpoint_id; cache.save();
  assert.equal(checked(f).code, "ERR_STRICT_CACHE_UNUSABLE");
});
test("expired cache is not retried automatically", (t) => {
  const f = fixture(t); const cache = seedCache(f); cache.record.expires_at = "2000-01-01T00:00:00.000Z"; cache.save();
  assert.equal(checked(f).code, "ERR_STRICT_CACHE_UNUSABLE");
});

test("future unsupported schema keyword fails closed", (t) => {
  const f = fixture(t);
  const schema = require("../../templates/_shared/.agent/decisions/decision.schema.json");
  schema.properties.prompt.not = { const: "forbidden" };
  try { assert.equal(checked(f).code, "ERR_STRICT_SCHEMA_UNSUPPORTED"); }
  finally { delete schema.properties.prompt.not; }
});
test("future unsupported schema format fails closed", (t) => {
  const f = fixture(t);
  const schema = require("../../templates/_shared/.agent/decisions/decision.schema.json");
  schema.properties.prompt.format = "email";
  try { assert.equal(checked(f).code, "ERR_STRICT_SCHEMA_UNSUPPORTED"); }
  finally { delete schema.properties.prompt.format; }
});

test("mock nonregular leaf is rejected before open", (t) => {
  const f = fixture(t), before = snapshot(f.root);
  const originalStat = fs.lstatSync, originalOpen = fs.openSync;
  let unsafeOpens = 0;
  fs.lstatSync = (file, ...args) => file === f.waitpointPath
    ? { isFile: () => false, isSymbolicLink: () => false } : originalStat(file, ...args);
  fs.openSync = (file, ...args) => {
    if (file === f.waitpointPath) unsafeOpens++;
    return originalOpen(file, ...args);
  };
  let value;
  try { value = noEffects(() => prepareStrictDispatch(f.input)); }
  finally { fs.lstatSync = originalStat; fs.openSync = originalOpen; }
  assert.equal(value.code, "ERR_STRICT_SOURCE_UNSAFE");
  assert.equal(unsafeOpens, 0);
  assert.deepEqual(snapshot(f.root), before);
});

test("copied pair and cache cannot match a different canonical root", (t) => {
  const first = fixture(t), second = fixture(t), cached = seedCache(first);
  fs.copyFileSync(first.decisionPath, second.decisionPath);
  fs.copyFileSync(first.waitpointPath, second.waitpointPath);
  const secondCache = seedCache(second);
  fs.copyFileSync(cached.file, secondCache.file);
  assert.equal(checked(second).code, "ERR_STRICT_CACHE_UNUSABLE");
});
test("Waitpoint expiry during cache read is revalidated on the latest pair", (t) => {
  const f = fixture(t), base = Date.now();
  f.w.expires_at = new Date(base + 1000).toISOString(); f.save();
  const cache = seedCache(f), before = snapshot(f.root), originalOpen = fs.openSync, originalRead = fs.readSync, originalNow = Date.now;
  let cacheFd = null, clock = base, value;
  fs.openSync = (file, ...args) => { const fd = originalOpen(file, ...args); if (file === cache.file) cacheFd = fd; return fd; };
  fs.readSync = (fd, ...args) => { const count = originalRead(fd, ...args); if (fd === cacheFd) clock = base + 2000; return count; };
  Date.now = () => clock;
  try { value = noEffects(() => prepareStrictDispatch(f.input)); }
  finally { fs.openSync = originalOpen; fs.readSync = originalRead; Date.now = originalNow; }
  assert.equal(value.code, "ERR_STRICT_WAITPOINT_EXPIRED");
  assert.equal(value.effect_permitted, false);
  assert.deepEqual(snapshot(f.root), before);
});
test("invalid UTF-8 authority bytes are rejected without replacement normalization", (t) => {
  const f = fixture(t), source = JSON.stringify(f.d).replace("Synthetic fixture", "bad-byte-MARKER");
  const parts = source.split("MARKER");
  assert.equal(parts.length, 2);
  fs.writeFileSync(f.decisionPath, Buffer.concat([Buffer.from(parts[0]), Buffer.from([0xff]), Buffer.from(parts[1])]));
  assert.equal(checked(f).code, "ERR_STRICT_SOURCE_UTF8");
});
test("authority with multiple hard links is rejected", (t) => {
  const f = fixture(t);
  fs.linkSync(f.decisionPath, path.join(f.root, "extra-authority-link"));
  assert.equal(checked(f).code, "ERR_STRICT_SOURCE_UNSAFE");
});
test("same-fd read is bounded when a source grows after the size check (mock read)", (t) => {
  const f = fixture(t), before = snapshot(f.root), originalOpen = fs.openSync, originalRead = fs.readSync;
  let targetFd = null, supplied = 0, maximumRequest = 0, value;
  fs.openSync = (file, ...args) => { const fd = originalOpen(file, ...args); if (file === f.decisionPath) targetFd = fd; return fd; };
  fs.readSync = (fd, buffer, offset, length, position) => {
    if (fd !== targetFd) return originalRead(fd, buffer, offset, length, position);
    maximumRequest = Math.max(maximumRequest, length); supplied += length;
    buffer.fill(32, offset, offset + length); return length;
  };
  try { value = noEffects(() => prepareStrictDispatch(f.input)); }
  finally { fs.openSync = originalOpen; fs.readSync = originalRead; }
  assert.equal(value.code, "ERR_STRICT_SOURCE_CHANGED");
  assert.equal(value.effect_permitted, false);
  assert.equal(supplied, 1024 * 1024 + 1);
  assert.equal(maximumRequest, 1024 * 1024 + 1);
  assert.deepEqual(snapshot(f.root), before);
});
test("lstat and opened fd identity mismatch is rejected before reading (mock stat)", (t) => {
  const f = fixture(t), before = snapshot(f.root), originalOpen = fs.openSync, originalStat = fs.fstatSync, originalRead = fs.readSync;
  let targetFd = null, targetReads = 0, value;
  fs.openSync = (file, ...args) => { const fd = originalOpen(file, ...args); if (file === f.decisionPath) targetFd = fd; return fd; };
  fs.fstatSync = (fd, ...args) => { const stat = originalStat(fd, ...args); if (fd === targetFd) stat.ino += 1; return stat; };
  fs.readSync = (fd, ...args) => { if (fd === targetFd) targetReads++; return originalRead(fd, ...args); };
  try { value = noEffects(() => prepareStrictDispatch(f.input)); }
  finally { fs.openSync = originalOpen; fs.fstatSync = originalStat; fs.readSync = originalRead; }
  assert.equal(value.code, "ERR_STRICT_SOURCE_CHANGED");
  assert.equal(value.effect_permitted, false);
  assert.equal(targetReads, 0);
  assert.deepEqual(snapshot(f.root), before);
});
test("an optional cache observed before open cannot disappear into absent (mock open)", (t) => {
  const f = fixture(t), cached = seedCache(f), before = snapshot(f.root), originalOpen = fs.openSync;
  let value;
  fs.openSync = (file, ...args) => {
    if (file === cached.file) throw Object.assign(new Error("simulated disappearance"), { code: "ENOENT" });
    return originalOpen(file, ...args);
  };
  try { value = noEffects(() => prepareStrictDispatch(f.input)); }
  finally { fs.openSync = originalOpen; }
  assert.equal(value.code, "ERR_STRICT_SOURCE_CHANGED");
  assert.equal(value.effect_permitted, false);
  assert.deepEqual(snapshot(f.root), before);
});
