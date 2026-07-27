"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { execFileSync } = require("node:child_process");

const WRITER = path.join(__dirname, "..", ".agent", "skills", "activity-recording", "scripts", "index.js");

function makeRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "record-helper-"));
  fs.mkdirSync(path.join(root, ".agent"), { recursive: true });
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

function callWriterAllowFailure(root, args) {
  try {
    return { ok: true, stdout: callWriter(root, args) };
  } catch (error) {
    return { ok: false, stderr: String(error.stderr || ""), stdout: String(error.stdout || "") };
  }
}

function readIndex(root) {
  const file = path.join(root, ".agent", "activities", "index.json");
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function readEvents(root) {
  const dir = path.join(root, ".agent", "activities", "events");
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")));
}

function readReceipts(root) {
  const dir = path.join(root, ".agent", "activities", "receipts");
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")));
}

test("record-event writes a workflow-required event from CLI flags", () => {
  const root = makeRoot();
  callWriter(root, [
    "record-event",
    "--kind", "intent",
    "--source", "/start-task",
    "--summary", "Plan task T-005 quick start demo",
    "--actor-type", "workflow",
    "--actor-id", "/start-task",
    "--dedupe-key", "task:T-005:plan",
  ]);

  const events = readEvents(root);
  assert.strictEqual(events.length, 1);
  const event = events[0];
  assert.strictEqual(event.activity_kind, "intent");
  assert.strictEqual(event.source, "/start-task");
  assert.strictEqual(event.capture_mode, "workflow_required");
  assert.strictEqual(event.completeness, "complete");
  assert.strictEqual(event.availability, "available");
  assert.strictEqual(event.confidence, "observed");
});

test("record-event auto-derives observed_at and project_id from cwd", () => {
  const root = makeRoot();
  callWriter(root, [
    "record-event",
    "--kind", "execution",
    "--source", "/ship",
    "--summary", "Code review passed",
    "--actor-type", "workflow",
    "--actor-id", "/ship",
    "--dedupe-key", "task:T-005:review:1",
  ]);
  const events = readEvents(root);
  const event = events[0];
  assert.match(event.observed_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  assert.strictEqual(event.project_id, path.basename(root));
  assert.strictEqual(event.occurred_at, event.observed_at);
});

test("record-event rejects unknown kind without writing", () => {
  const root = makeRoot();
  const result = callWriterAllowFailure(root, [
    "record-event",
    "--kind", "bogus",
    "--source", "/x",
    "--summary", "should fail",
    "--actor-type", "workflow",
    "--actor-id", "/x",
    "--dedupe-key", "x:1",
  ]);
  assert.strictEqual(result.ok, false);
  assert.match(result.stderr, /activity_kind is invalid/);
  assert.strictEqual(readEvents(root).length, 0);
});

test("record-receipt writes a workflow_required receipt from CLI flags", () => {
  const root = makeRoot();
  callWriter(root, [
    "record-event",
    "--kind", "validation",
    "--source", "/mission",
    "--summary", "Mission M-006 validation contract executed",
    "--actor-type", "workflow",
    "--actor-id", "/mission",
    "--dedupe-key", "mission:M-006:validate:1",
  ]);

  callWriter(root, [
    "record-receipt",
    "--kind", "delivery",
    "--source", "/mission",
    "--activity-refs", "ACT-mission-M-006-validate-1",
    "--availability", "available",
    "--redaction", "not_applicable",
    "--dedupe-key", "mission:M-006:validate:1:receipt",
  ]);

  const events = readEvents(root);
  const receipts = readReceipts(root);
  assert.strictEqual(events.length, 1);
  assert.strictEqual(receipts.length, 1);
  const receipt = receipts[0];
  assert.strictEqual(receipt.receipt_kind, "delivery");
  assert.strictEqual(receipt.availability, "available");
  assert.deepStrictEqual(receipt.activity_refs, ["ACT-mission-M-006-validate-1"]);
  assert.deepStrictEqual(receipt.redaction, { status: "not_applicable" });
});

test("record-receipt allows null commit_identity and intent_receipt_ref for non-commit receipts", () => {
  const root = makeRoot();
  callWriter(root, [
    "record-receipt",
    "--kind", "capture",
    "--source", "/handoff",
    "--activity-refs", "ACT-handoff-publish-1",
    "--availability", "available",
    "--redaction", "not_applicable",
    "--dedupe-key", "handoff:H-001:capture",
  ]);

  const receipts = readReceipts(root);
  const receipt = receipts[0];
  assert.strictEqual(receipt.commit_identity, null);
  assert.strictEqual(receipt.intent_receipt_ref, null);
});

test("record-receipt requires --activity-refs at least one reference", () => {
  const root = makeRoot();
  const result = callWriterAllowFailure(root, [
    "record-receipt",
    "--kind", "delivery",
    "--source", "/ship",
    "--availability", "available",
    "--redaction", "not_applicable",
    "--dedupe-key", "ship:1",
  ]);
  assert.strictEqual(result.ok, false);
  assert.match(result.stderr, /activity_refs/);
});