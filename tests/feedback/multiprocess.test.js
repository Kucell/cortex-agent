"use strict";

// --- M-024 MS-003 VC-018: multiprocess collision & crash recovery ---------
//
// Platform-agnostic (POSIX + Windows) validation that the feedback inbox
// write path is safe under concurrent processes:
//   1. N child processes append events to the same inbox concurrently;
//      every event.json must be complete, unique and non-overwritten.
//   2. Crash leftovers (event dir without event.json) and corrupt payloads
//      are diagnosed, never silently dropped or fabricated.
//
// Runs with plain "node --test tests/feedback/multiprocess.test.js" on any
// platform with Node >= 20.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");

const INBOX = path.resolve(__dirname, "..", "..", "lib", "feedback", "inbox.js");

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "feedback-mp-"));
}

// Worker: appends count events with unique titles. Runs as a child process
// so the claiming/writing path is exercised across real OS processes.
function workerSource(inboxRoot, workerIndex, count) {
  const lines = [
    "const crypto = require('node:crypto');",
    "const { appendEvent } = require(" + JSON.stringify(INBOX) + ");",
    "const inboxRoot = " + JSON.stringify(inboxRoot) + ";",
    "const prefix = 'mp-worker-" + workerIndex + "-';",
    "for (let i = 0; i < " + count + "; i++) {",
    "  const r = appendEvent({",
    "    inboxRoot,",
    "    event: {",
    "      schema_version: 1,",
    "      event_id: 'fev_' + crypto.randomUUID(),",
    "      occurred_at: new Date().toISOString(),",
    "      kind: 'observation',",
    "      severity: 'low',",
    "      title: prefix + i,",
    "      source: { adapter: 'manual', project_slug: 'm024-ms003-mp' },",
    "      fingerprint: 'pending',",
    "    },",
    "  });",
    "  if (!r.ok) { console.error(JSON.stringify(r)); process.exit(1); }",
    "}",
    "console.log('worker-done');",
  ];
  return lines.join("\n");
}

function runWorker(inboxRoot, workerIndex, count) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["-e", workerSource(inboxRoot, workerIndex, count)], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error("worker " + workerIndex + " exit " + code + ": " + stderr));
    });
  });
}

test("VC-018: concurrent processes never lose or overwrite events", async (t) => {
  const dir = tmpDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const { readInbox } = require(INBOX);
  const inboxRoot = path.join(dir, "inbox");

  const WORKERS = 6;
  const PER_WORKER = 4;
  await Promise.all(
    Array.from({ length: WORKERS }, (_, i) => runWorker(inboxRoot, i, PER_WORKER)),
  );

  const read = readInbox({ inboxRoot });
  assert.equal(read.events.length, WORKERS * PER_WORKER, "every appended event must be present");
  const ids = new Set(read.events.map((row) => row.event.event_id));
  assert.equal(ids.size, WORKERS * PER_WORKER, "event ids must be unique");
  const titles = new Set(read.events.map((row) => row.event.title));
  assert.equal(titles.size, WORKERS * PER_WORKER, "event titles must be unique (no overwrite)");
  assert.equal(read.diagnostics.incomplete.length, 0);
  assert.equal(read.diagnostics.corrupt.length, 0);
});

test("VC-018: crash leftover and corrupt payload are diagnosed, never dropped silently", (t) => {
  const dir = tmpDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const { appendEvent, readInbox } = require(INBOX);
  const inboxRoot = path.join(dir, "inbox");

  const ok = appendEvent({
    inboxRoot,
    event: {
      schema_version: 1,
      event_id: "fev_" + crypto.randomUUID(),
      occurred_at: new Date().toISOString(),
      kind: "observation",
      severity: "low",
      title: "good-event",
      source: { adapter: "manual", project_slug: "m024-ms003-mp" },
      fingerprint: "pending",
    },
  });
  assert.equal(ok.ok, true);

  // Crash between mkdir and rename: event dir exists, no event.json.
  const dayDir = path.dirname(path.dirname(ok.path));
  fs.mkdirSync(path.join(dayDir, "fev_00000000-0000-0000-0000-0000000000aa"), { recursive: false });
  // Corrupt payload: event.json with invalid JSON.
  const corruptDir = path.join(dayDir, "fev_00000000-0000-0000-0000-0000000000bb");
  fs.mkdirSync(corruptDir, { recursive: false });
  fs.writeFileSync(path.join(corruptDir, "event.json"), "{not-json", "utf8");

  const read = readInbox({ inboxRoot });
  assert.equal(read.events.length, 1, "good event still readable");
  assert.equal(read.events[0].event.title, "good-event");
  assert.equal(read.diagnostics.incomplete.length, 1);
  assert.equal(read.diagnostics.corrupt.length, 1);
});
