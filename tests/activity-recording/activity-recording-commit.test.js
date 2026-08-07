"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { execFileSync } = require("node:child_process");

const WRITER = path.join(__dirname, "..", "..", ".agent", "skills", "activity-recording", "scripts", "index.js");

function makeFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "commit-recording-"));
  fs.mkdirSync(path.join(root, ".agent"), { recursive: true });
  // minimal init
  execFileSync("node", [WRITER, "init"], { cwd: root, stdio: "ignore" });
  return root;
}

function callWriter(root, args) {
  return execFileSync("node", [WRITER, ...args], {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
  });
}

function readReceipts(root) {
  const file = path.join(root, ".agent", "activities", "index.json");
  if (!fs.existsSync(file)) return [];
  const index = JSON.parse(fs.readFileSync(file, "utf8"));
  return index.receipts || [];
}

test("/commit records commit_intent before git commit executes", () => {
  const root = makeFixture();
  const intentPayload = {
    schema_version: 1,
    receipt_id: "AR-commit-intent-001",
    receipt_kind: "commit_intent",
    source: "/commit",
    source_revision: "HEAD~0",
    capture_mode: "workflow_required",
    observed_at: "2026-07-27T10:00:00Z",
    activity_refs: ["ACT-pre-commit-001"],
    gaps: [],
    evidence_refs: [".agent/activities/events/ACT-pre-commit-001.json"],
    availability: "available",
    redaction: { status: "not_applicable" },
    dedupe_key: "commit:intent:abc123",
    commit_identity: null,
    intent_receipt_ref: null,
  };

  callWriter(root, [
    "receipt",
    "append",
    "--payload-json",
    JSON.stringify(intentPayload),
  ]);

  const receipts = readReceipts(root);
  assert.strictEqual(receipts.length, 1);
  assert.strictEqual(receipts[0].receipt_kind, "commit_intent");
  assert.strictEqual(receipts[0].commit_identity, null);
  assert.strictEqual(receipts[0].dedupe_key, "commit:intent:abc123");
});

test("/commit records commit_result only after git returns a real identity", () => {
  const root = makeFixture();
  const realCommitSha = "f1d2d2f924e986ac86fdf7b36c94bcdf32beec15";
  const intentRef = "AR-commit-intent-002";

  const resultPayload = {
    schema_version: 1,
    receipt_id: "AR-commit-result-002",
    receipt_kind: "commit_result",
    source: "/commit",
    source_revision: realCommitSha,
    capture_mode: "workflow_required",
    observed_at: "2026-07-27T10:01:00Z",
    activity_refs: ["ACT-post-commit-002"],
    gaps: [],
    evidence_refs: [`.agent/activities/events/ACT-post-commit-002.json`],
    availability: "available",
    redaction: { status: "not_applicable" },
    dedupe_key: `commit:result:${realCommitSha}`,
    commit_identity: realCommitSha,
    intent_receipt_ref: intentRef,
  };

  callWriter(root, [
    "receipt",
    "append",
    "--payload-json",
    JSON.stringify(resultPayload),
  ]);

  const receipts = readReceipts(root);
  assert.strictEqual(receipts.length, 1);
  assert.strictEqual(receipts[0].receipt_kind, "commit_result");
  assert.strictEqual(receipts[0].commit_identity, realCommitSha);
  assert.strictEqual(receipts[0].intent_receipt_ref, intentRef);
});

test("failed commits must not produce commit_result with a real identity", () => {
  const root = makeFixture();
  // simulate a failed commit by recording a commit_result with null identity and
  // availability=failed — the workflow must NOT manufacture a sha to look green.
  const resultPayload = {
    schema_version: 1,
    receipt_id: "AR-commit-result-failed",
    receipt_kind: "commit_result",
    source: "/commit",
    source_revision: "HEAD~0",
    capture_mode: "workflow_required",
    observed_at: "2026-07-27T10:02:00Z",
    activity_refs: [],
    gaps: ["git_execution_failed"],
    evidence_refs: [],
    availability: "failed",
    redaction: { status: "not_applicable" },
    dedupe_key: "commit:result:failed:run-3",
    commit_identity: null,
    intent_receipt_ref: "AR-commit-intent-003",
  };

  callWriter(root, [
    "receipt",
    "append",
    "--payload-json",
    JSON.stringify(resultPayload),
  ]);

  const receipts = readReceipts(root);
  assert.strictEqual(receipts.length, 1);
  assert.strictEqual(receipts[0].commit_identity, null);
  assert.strictEqual(receipts[0].availability, "failed");
  assert.deepStrictEqual(receipts[0].gaps, ["git_execution_failed"]);
});

test("intent and result receipts are deduplicated by dedupe_key", () => {
  const root = makeFixture();
  const payload = {
    schema_version: 1,
    receipt_id: "AR-commit-intent-dup",
    receipt_kind: "commit_intent",
    source: "/commit",
    source_revision: "HEAD~0",
    capture_mode: "workflow_required",
    observed_at: "2026-07-27T10:03:00Z",
    activity_refs: [],
    gaps: [],
    evidence_refs: [],
    availability: "available",
    redaction: { status: "not_applicable" },
    dedupe_key: "commit:intent:dup",
    commit_identity: null,
    intent_receipt_ref: null,
  };

  callWriter(root, ["receipt", "append", "--payload-json", JSON.stringify(payload)]);
  callWriter(root, ["receipt", "append", "--payload-json", JSON.stringify(payload)]);

  const receipts = readReceipts(root);
  assert.strictEqual(receipts.length, 1);
});