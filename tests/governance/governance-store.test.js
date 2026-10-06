"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  createFilesystemGovernanceStore,
  normalizeRelativeKey,
} = require("../../lib/governance/store");

function root() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cortex-governance-store-"));
}

test("filesystem store reports explicit local capabilities", () => {
  const store = createFilesystemGovernanceStore(root());
  assert.deepEqual(store.capabilities(), {
    read: true,
    write: true,
    compare_and_write: true,
    append: false,
    history: false,
    watch: false,
  });
});

test("relative governance keys are normalized and traversal fails closed", () => {
  assert.equal(normalizeRelativeKey("tasks/T-1.json"), "tasks/T-1.json");
  assert.equal(normalizeRelativeKey("tasks\\T-1.json"), "tasks/T-1.json");
  assert.throws(
    () => normalizeRelativeKey("../secret"),
    (error) => error.code === "ERR_GOVERNANCE_STORE_KEY_ESCAPE",
  );
  assert.throws(
    () => normalizeRelativeKey("/absolute/path"),
    (error) => error.code === "ERR_GOVERNANCE_STORE_KEY_ESCAPE",
  );
});

test("writeJson is atomic from the caller perspective and round-trips JSON", () => {
  const dir = root();
  const store = createFilesystemGovernanceStore(dir);
  const write = store.writeJson("tasks/T-1.json", { task_id: "T-1", stage: "plan" });
  assert.equal(write.ok, true);
  assert.ok(write.revision.value.startsWith("sha256:"));
  assert.deepEqual(store.readJson("tasks/T-1.json").value, {
    task_id: "T-1",
    stage: "plan",
  });
  const leftovers = fs.readdirSync(path.join(dir, "tasks")).filter((name) => name.includes(".tmp-"));
  assert.deepEqual(leftovers, []);
});

test("readText can return a missing object without creating it", () => {
  const store = createFilesystemGovernanceStore(root());
  const result = store.readText("decisions/D-1.json", { required: false });
  assert.equal(result.exists, false);
  assert.equal(result.content, null);
  assert.equal(result.revision, null);
});

test("compare-and-write succeeds against the current revision", () => {
  const store = createFilesystemGovernanceStore(root());
  const first = store.writeJson("queues/Q-1.json", { queue_id: "Q-1", status: "active" });
  const second = store.writeJson(
    "queues/Q-1.json",
    { queue_id: "Q-1", status: "paused" },
    { expected_revision: first.revision },
  );
  assert.notEqual(second.revision.value, first.revision.value);
  assert.equal(store.readJson("queues/Q-1.json").value.status, "paused");
});

test("compare-and-write rejects stale revisions without overwriting", () => {
  const store = createFilesystemGovernanceStore(root());
  const first = store.writeJson("locks/L-1.json", { lock_id: "L-1", owner: "A" });
  store.writeJson(
    "locks/L-1.json",
    { lock_id: "L-1", owner: "B" },
    { expected_revision: first.revision },
  );

  assert.throws(
    () => store.writeJson(
      "locks/L-1.json",
      { lock_id: "L-1", owner: "C" },
      { expected_revision: first.revision },
    ),
    (error) => error.code === "ERR_GOVERNANCE_REVISION_CONFLICT"
      && error.expected === first.revision.value
      && typeof error.actual === "string",
  );
  assert.equal(store.readJson("locks/L-1.json").value.owner, "B");
});

test("expected null revision supports create-if-absent semantics", () => {
  const store = createFilesystemGovernanceStore(root());
  store.writeJson(
    "waitpoints/WP-1.json",
    { waitpoint_id: "WP-1" },
    { expected_revision: null },
  );
  assert.throws(
    () => store.writeJson(
      "waitpoints/WP-1.json",
      { waitpoint_id: "WP-1", status: "released" },
      { expected_revision: null },
    ),
    (error) => error.code === "ERR_GOVERNANCE_REVISION_CONFLICT",
  );
});
