"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const { readCanonicalTaskSource } = require("../../lib/next-action/canonical-task-source");
const { createGitGovernanceStore } = require("../../lib/governance/git-store");
const { buildNextActionProjection } = require("../../lib/next-action");

const NOW = "2026-10-16T04:00:00.000Z";
const REV = { domain: "governance_store", store_kind: "git", value: "a".repeat(40) };
const record = () => ({
  task_id: "T-001", title: "Canonical fixture", status: "active", priority: "P1",
  owner: "owner:fixture", dependencies: [], validation_commands: ["node --test fixture.test.js"],
  execution_authorized: true, plan_digest: "model:pretend-approved",
});
function options(store, extra = {}) {
  return {
    store, project_ref: "project:fixture", governance_binding_ref: "governance:fixture",
    observed_at: NOW, expected_revision: REV, task_ids: ["T-001"], ...extra,
  };
}
function stub(overrides = {}) {
  const calls = [];
  const store = {
    kind: "git",
    getRevision() { calls.push("getRevision"); return { ...REV }; },
    readText(key) {
      calls.push(key);
      const value = key === "tasks/index.json"
        ? { tasks: [{ task_id: "T-001", path: ".agent/tasks/T-001.json" }] } : record();
      return { ok: true, exists: true, content: JSON.stringify(value), revision: { ...REV } };
    },
    writeText() { throw new Error("write forbidden"); },
    recoverSnapshot() { throw new Error("repair forbidden"); },
    ...overrides,
  };
  return { store, calls };
}
function snapshot(root) {
  const files = [];
  function walk(dir) {
    for (const name of fs.readdirSync(dir).sort()) {
      const file = path.join(dir, name), stat = fs.lstatSync(file, { bigint: true });
      assert.equal(stat.isSymbolicLink(), false);
      if (stat.isDirectory()) walk(file);
      else files.push({
        path: path.relative(root, file), mode: String(stat.mode), mtimeNs: String(stat.mtimeNs),
        sha256: crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex"),
      });
    }
  }
  walk(root);
  return files;
}
test("actual GitGovernanceStore reads canonical Tasks without changing fixture bytes or metadata", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-advisor-source-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const emptyConfig = path.join(root, "empty-git-config");
  const emptyHooks = path.join(root, "empty-hooks");
  fs.writeFileSync(emptyConfig, ""); fs.mkdirSync(emptyHooks);
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("GIT_")) delete env[key];
  env.GIT_CONFIG_NOSYSTEM = "1"; env.GIT_CONFIG_GLOBAL = emptyConfig;
  function git(args) {
    const result = spawnSync("git", ["-C", root, ...args], { env, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr || result.error?.message);
  }
  git(["init", "--quiet", "--initial-branch=advisor-fixture"]);
  fs.mkdirSync(path.join(root, "tasks"));
  fs.writeFileSync(path.join(root, "tasks", "T-001.json"), JSON.stringify(record()));
  fs.writeFileSync(path.join(root, "tasks", "index.json"),
    JSON.stringify({ tasks: [{ task_id: "T-001", path: ".agent/tasks/T-001.json" }] }));
  git(["add", "--", "tasks"]);
  git(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test",
    "-c", "core.hooksPath=" + emptyHooks, "commit", "--no-gpg-sign", "-qm", "fixture"]);
  const store = createGitGovernanceStore(root, { ref: "refs/heads/advisor-fixture" });
  const revision = { domain: "governance_store", ...store.getRevision() };
  const before = snapshot(root);
  const source = readCanonicalTaskSource(options(store, { expected_revision: revision, task_ids: null }));
  assert.equal(source.status, "observed");
  assert.equal(source.records.length, 1);
  assert.equal(source.records[0].task_ref, "T-001");
  assert.equal(source.records[0].plan_digest, undefined);
  assert.equal(source.records[0].execution_authorized, undefined);
  assert.equal(source.execution_authorized, false);
  assert.deepEqual(source.revision, revision);
  assert.equal(source.read_receipts.length, 2);
  assert.ok(source.read_receipts.every((r) => /^[0-9a-f]{40}$/.test(r.blob)));
  assert.deepEqual(snapshot(root), before);
});
test("filesystem per-file digests are not promoted into a global snapshot", () => {
  let read = 0;
  const source = readCanonicalTaskSource(options({
    kind: "filesystem", readText() { read++; }, getRevision() { read++; },
  }));
  assert.equal(source.status, "unavailable");
  assert.deepEqual(source.records, []);
  assert.equal(read, 0);
});
test("head change during reads discards all candidate records", () => {
  let count = 0;
  const { store } = stub({
    getRevision() { return { ...REV, value: ++count < 3 ? REV.value : "b".repeat(40) }; },
  });
  const source = readCanonicalTaskSource(options(store));
  assert.equal(source.status, "conflict");
  assert.deepEqual(source.records, []);
});
test("a mixed-revision read cannot borrow the expected envelope revision", () => {
  const { store } = stub({
    readText() {
      return { ok: true, exists: true, content: JSON.stringify(record()),
        revision: { ...REV, value: "b".repeat(40) } };
    },
  });
  assert.equal(readCanonicalTaskSource(options(store)).status, "conflict");
});
test("index paths cannot cause arbitrary reads", () => {
  const { store, calls } = stub({
    readText(key) {
      calls.push(key);
      return { ok: true, exists: true, revision: REV,
        content: JSON.stringify({ tasks: [{ task_id: "T-001", path: "../../private.json" }] }) };
    },
  });
  const source = readCanonicalTaskSource(options(store, { task_ids: null }));
  assert.equal(source.status, "unavailable");
  assert.deepEqual(calls.filter((x) => x.includes("/")), ["tasks/index.json"]);
});
test("duplicate and traversal Task IDs fail without reading Task content", () => {
  for (const ids of [["T-001", "T-001"], ["T-../outside"]]) {
    const { store, calls } = stub();
    assert.equal(readCanonicalTaskSource(options(store, { task_ids: ids })).status, "unavailable");
    assert.equal(calls.some((x) => x.startsWith("tasks/")), false);
  }
});
test("malformed JSON returns unavailable with no partial recommendation", () => {
  const { store } = stub({
    readText() { return { ok: true, exists: true, revision: REV, content: "{broken" }; },
  });
  const source = readCanonicalTaskSource(options(store));
  assert.equal(source.status, "unavailable");
  assert.deepEqual(source.records, []);
});
test("legacy canonical source stays insufficient until real scope and gate mappings exist", () => {
  const { store } = stub();
  const tasks = readCanonicalTaskSource(options(store));
  const projection = buildNextActionProjection({
    project_ref: "project:fixture", observed_at: NOW, governance_revision: REV,
    sources: { tasks },
  });
  assert.equal(projection.recommendations.length, 1);
  assert.equal(projection.recommendations[0].advice_status, "INSUFFICIENT_EVIDENCE");
  assert.equal(projection.execution_authorized, false);
  assert.ok(Object.isFrozen(tasks.records[0]));
});

test("kindless Git store uses its standard typed snapshot token without inventing a domain", () => {
  const token = { store_kind: "git", value: REV.value };
  const { store } = stub({
    kind: undefined,
    getRevision() { return token; },
    readText() { return { ok: true, exists: true, revision: token, content: JSON.stringify(record()) }; },
  });
  assert.equal(readCanonicalTaskSource(options(store)).status, "observed");
});
test("an explicit foreign revision domain is rejected on the head and each read", () => {
  for (const at of ["head", "read"]) {
    const token = { ...REV, domain: "execution_workspace" };
    const { store } = stub(at === "head"
      ? { getRevision() { return token; } }
      : { readText() { return { ok: true, exists: true, revision: token, content: JSON.stringify(record()) }; } });
    const source = readCanonicalTaskSource(options(store));
    assert.equal(source.status, "conflict");
    assert.deepEqual(source.records, []);
  }
});

test("missing, malformed, duplicate and self dependencies fail closed", () => {
  for (const dependencies of [undefined, null, {}, ["T-002", "T-002"], ["T-001"]]) {
    const value = { ...record(), dependencies };
    const { store } = stub({
      readText() { return { ok: true, exists: true, revision: REV, content: JSON.stringify(value) }; },
    });
    const source = readCanonicalTaskSource(options(store));
    assert.equal(source.status, "unavailable");
    assert.deepEqual(source.records, []);
  }
});
test("malformed declared validation commands are not silently dropped", () => {
  for (const validation_commands of [null, "node --test", [""], [17], ["valid", "bad\ncommand"]]) {
    const value = { ...record(), validation_commands };
    const { store } = stub({
      readText() { return { ok: true, exists: true, revision: REV, content: JSON.stringify(value) }; },
    });
    assert.equal(readCanonicalTaskSource(options(store)).status, "unavailable");
  }
});
