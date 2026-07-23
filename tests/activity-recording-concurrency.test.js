"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const source = path.join(root, "templates", "_shared", ".agent", "skills", "activity-recording", "scripts", "index.js");

function event(id) {
  return {
    schema_version: 1,
    activity_id: id,
    activity_kind: "change",
    capture_mode: "reconciled",
    project_id: "fixture",
    source: "git",
    source_revision: "HEAD:abc",
    observed_at: "2026-07-23T00:00:00.000Z",
    occurred_at: null,
    actor: { type: "system", id: "git" },
    summary: "Observed change",
    evidence_refs: [],
    log_cursor_refs: [],
    completeness: "partial",
    confidence: "observed",
    availability: "available",
    dedupe_key: "git:HEAD:abc"
  };
}

test("concurrent writers cannot create two identities for one dedupe key", async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-activity-concurrency-"));
  const script = path.join(cwd, ".agent", "skills", "activity-recording", "scripts", "index.js");
  fs.mkdirSync(path.dirname(script), { recursive: true });
  fs.copyFileSync(source, script);
  assert.strictEqual(spawnSync(process.execPath, [script, "init"], { cwd }).status, 0);

  const results = await Promise.all(["ACT-concurrent-001", "ACT-concurrent-002"].map((id) => new Promise((resolve) => {
    const child = spawn(process.execPath, [script, "event", "append", "--payload-json", JSON.stringify(event(id))], { cwd, stdio: "ignore" });
    child.on("exit", (code) => resolve(code));
  })));

  assert.deepStrictEqual(results.sort(), [0, 1]);
  const files = fs.readdirSync(path.join(cwd, ".agent", "activities", "events"));
  assert.strictEqual(files.length, 1);
  const index = JSON.parse(fs.readFileSync(path.join(cwd, ".agent", "activities", "index.json"), "utf8"));
  assert.strictEqual(index.events.length, 1);
});
