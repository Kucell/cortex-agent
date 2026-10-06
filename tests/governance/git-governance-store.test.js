"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const { createGitGovernanceStore } = require("../../lib/governance/git-store");

function tmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function initRepo({ bare = false } = {}) {
  const repo = tmp(bare ? "cortex-git-store-bare-" : "cortex-git-store-");
  const args = ["init", "-q"];
  if (bare) args.push("--bare");
  const result = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return repo;
}

test("git store exposes provider-neutral capabilities", (t) => {
  const repo = initRepo();
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  const store = createGitGovernanceStore(repo);
  assert.deepEqual(store.capabilities(), {
    read: true,
    write: true,
    compare_and_write: true,
    append: true,
    history: true,
    watch: false,
  });
});

test("git store creates unborn governance ref with expected null revision", (t) => {
  const repo = initRepo();
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  const store = createGitGovernanceStore(repo);

  assert.equal(store.getRevision(), null);
  const result = store.writeJson(
    "tasks/T-1.json",
    { task_id: "T-1", stage: "plan" },
    { expected_revision: null },
  );

  assert.equal(result.ok, true);
  assert.equal(result.revision.store_kind, "git");
  assert.match(result.revision.value, /^[0-9a-f]{40,64}$/);
  assert.deepEqual(store.readJson("tasks/T-1.json").value, {
    task_id: "T-1",
    stage: "plan",
  });
});

test("git store works against a bare repository without checkout", (t) => {
  const repo = initRepo({ bare: true });
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  const store = createGitGovernanceStore(repo);

  const first = store.writeJson(
    "missions/M-1.json",
    { mission_id: "M-1", status: "active" },
    { expected_revision: null },
  );
  const second = store.writeJson(
    "missions/M-1.json",
    { mission_id: "M-1", status: "done" },
    { expected_revision: first.revision },
  );

  assert.notEqual(second.revision.value, first.revision.value);
  assert.equal(store.readJson("missions/M-1.json").value.status, "done");
});

test("git store compare-and-write rejects a stale writer", (t) => {
  const repo = initRepo();
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  const writerA = createGitGovernanceStore(repo);
  const writerB = createGitGovernanceStore(repo);

  const initial = writerA.writeJson(
    "queues/Q-1.json",
    { queue_id: "Q-1", status: "active" },
    { expected_revision: null },
  );
  const staleRevision = writerB.getRevision();
  assert.equal(staleRevision.value, initial.revision.value);

  writerA.writeJson(
    "queues/Q-1.json",
    { queue_id: "Q-1", status: "paused" },
    { expected_revision: initial.revision },
  );

  assert.throws(
    () => writerB.writeJson(
      "queues/Q-1.json",
      { queue_id: "Q-1", status: "drained" },
      { expected_revision: staleRevision },
    ),
    (error) => error.code === "ERR_GOVERNANCE_REVISION_CONFLICT"
      && error.expected === staleRevision.value
      && error.actual !== staleRevision.value,
  );

  assert.equal(writerA.readJson("queues/Q-1.json").value.status, "paused");
});

test("git store create-if-absent fails once the ref exists", (t) => {
  const repo = initRepo();
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  const store = createGitGovernanceStore(repo);

  store.writeJson("decisions/D-1.json", { decision_id: "D-1" }, { expected_revision: null });
  assert.throws(
    () => store.writeJson(
      "decisions/D-2.json",
      { decision_id: "D-2" },
      { expected_revision: null },
    ),
    (error) => error.code === "ERR_GOVERNANCE_REVISION_CONFLICT",
  );
});

test("git store append produces immutable history commits", (t) => {
  const repo = initRepo();
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  const store = createGitGovernanceStore(repo);

  const first = store.appendText("journal/events.ndjson", "{\"event\":1}\n");
  const second = store.appendText(
    "journal/events.ndjson",
    "{\"event\":2}\n",
    { expected_revision: first.revision },
  );

  assert.notEqual(first.revision.value, second.revision.value);
  assert.equal(
    store.readText("journal/events.ndjson").content,
    "{\"event\":1}\n{\"event\":2}\n",
  );

  const history = store.history({ limit: 10 });
  assert.equal(history.length, 2);
  assert.equal(history[0].commit, second.revision.value);
  assert.equal(history[1].commit, first.revision.value);
});

test("git store missing key does not mutate history", (t) => {
  const repo = initRepo();
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  const store = createGitGovernanceStore(repo);
  const result = store.readText("waitpoints/WP-404.json", { required: false });
  assert.equal(result.exists, false);
  assert.equal(result.content, null);
  assert.equal(store.getRevision(), null);
});

test("git store rejects path traversal before invoking tree mutation", (t) => {
  const repo = initRepo();
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  const store = createGitGovernanceStore(repo);
  assert.throws(
    () => store.writeText("../secret", "nope", { expected_revision: null }),
    (error) => error.code === "ERR_GOVERNANCE_STORE_KEY_ESCAPE",
  );
  assert.equal(store.getRevision(), null);
});
