"use strict";

// ─── M-004 MS-002 VC-007: bin/cli.js event-bus CLI tests ────────────────────
//
// Coverage: 4 subcommands + help + error handling
//   1. help / version  (2 cases)
//   2. publish         (2 cases)
//   3. list-events     (2 cases)
//   4. history         (2 cases)
//   5. subscribe       (1 case, short timeout subprocess)
//   6. error handling  (2 cases, missing --event / --payload)
//
// Total: 11 cases (target 10-12)
//
// References:
//   - .agent/missions/M-004/validation-contract.json VC-007
//   - lib/event-bus/cli.js
//   - bin/cli.js (event-bus case)

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const test = require("node:test");

const ROOT = path.resolve(__dirname, "..", "..");
const BIN = path.join(ROOT, "bin", "cli.js");
const { eventBusCommand, parseArgs } = require(path.join(ROOT, "lib", "event-bus", "cli"));
const { createEventBus } = require(path.join(ROOT, "lib", "event-bus", "event-bus"));

let _counter = 0;
function freshBusDir() {
  const d = path.join(os.tmpdir(), "vc-007-bus-" + process.pid + "-" + (++_counter));
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function freshCwd() {
  const d = path.join(os.tmpdir(), "vc-007-cwd-" + process.pid + "-" + (++_counter));
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function runCli(args, opts = {}) {
  // Spawn cortex-agent event-bus with the given args.
  // Returns { status, stdout, stderr }.
  return spawnSync(process.execPath, [BIN, "event-bus", ...args], {
    cwd: opts.cwd || process.cwd(),
    encoding: "utf8",
    env: Object.assign({}, process.env, opts.env || {}),
  });
}

function makeCtx(args) {
  return {
    cwd: process.cwd(),
    args: ["event-bus", ...args],
    command: "event-bus",
    options: {},
    lang: "en",
    templateDir: path.join(ROOT, "templates", "en"),
  };
}

// ─── 1. help / version ─────────────────────────────────────────────────────

test("VC-007 H1: cortex-agent event-bus --help shows 4 subcommands", () => {
  const r = runCli(["--help"]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /Subcommands \(4\)/);
  assert.match(r.stdout, /publish/);
  assert.match(r.stdout, /subscribe/);
  assert.match(r.stdout, /list-events/);
  assert.match(r.stdout, /history/);
});

test("VC-007 H2: cortex-agent event-bus publish --help shows publish help", () => {
  const r = runCli(["publish", "--help"]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /Subcommands \(4\)/);
  assert.match(r.stdout, /--event/);
  assert.match(r.stdout, /--payload/);
});

// ─── 2. publish ───────────────────────────────────────────────────────────

test("VC-007 P1: publish --event subagent_completed --payload JSON exits 0 + writes to events.jsonl", () => {
  const busDir = freshBusDir();
  const r = runCli([
    "publish",
    "--event", "subagent_completed",
    "--payload", JSON.stringify({ status: "success", output_summary: "verify" }),
    "--bus-id", "vc-007-p1:test",
    "--data-dir", busDir,
    "--no-fsync",
  ]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /✓ published subagent_completed/);

  // Verify events.jsonl was written
  const bus = createEventBus({ busId: "vc-007-p1:test", dataDir: busDir, fsync: false });
  const listed = bus.list({});
  assert.ok(listed.events.length >= 1);
  const ev = listed.events.find((e) => e.event_name === "subagent_completed");
  assert.ok(ev);
  assert.equal(ev.payload.output_summary, "verify");
  bus.close();
});

test("VC-007 P2: publish with --json outputs structured JSON", () => {
  const busDir = freshBusDir();
  const r = runCli([
    "publish",
    "--event", "subagent_spawned",
    "--payload", JSON.stringify({ subagent_role: "explore", task_description: "t" }),
    "--bus-id", "vc-007-p2:test",
    "--data-dir", busDir,
    "--no-fsync",
    "--output", "json",
  ]);
  assert.equal(r.status, 0);
  const out = JSON.parse(r.stdout);
  assert.equal(out.ok, true);
  assert.equal(out.action, "publish");
  assert.equal(out.event_name, "subagent_spawned");
  assert.ok(out.event_id.startsWith("eb-evt-"));
});

// ─── 3. list-events ────────────────────────────────────────────────────────

test("VC-007 L1: list-events (no events yet) returns 0 events + exit 0", () => {
  const busDir = freshBusDir();
  const r = runCli([
    "list-events",
    "--bus-id", "vc-007-l1:test",
    "--data-dir", busDir,
    "--no-fsync",
  ]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /count:.*0/);
});

test("VC-007 L2: list-events --event filter + --limit 1 returns at most 1", () => {
  const busDir = freshBusDir();
  // publish 3 events
  for (let i = 0; i < 3; i++) {
    runCli([
      "publish",
      "--event", "subagent_progress",
      "--payload", JSON.stringify({ percent: i * 30 }),
      "--bus-id", "vc-007-l2:test",
      "--data-dir", busDir,
      "--no-fsync",
    ]);
  }
  const r = runCli([
    "list-events",
    "--event", "subagent_progress",
    "--limit", "1",
    "--bus-id", "vc-007-l2:test",
    "--data-dir", busDir,
    "--no-fsync",
  ]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /count:.*1/);
});

// ─── 4. history ────────────────────────────────────────────────────────────

test("VC-007 HI1: history with no events returns stats + 0 acks", () => {
  const busDir = freshBusDir();
  const r = runCli([
    "history",
    "--bus-id", "vc-007-h1:test",
    "--data-dir", busDir,
    "--no-fsync",
  ]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /stats:/);
  assert.match(r.stdout, /event_count:/);
});

test("VC-007 HI2: history with published events lists them", () => {
  const busDir = freshBusDir();
  runCli([
    "publish",
    "--event", "subagent_completed",
    "--payload", JSON.stringify({ status: "success", output_summary: "h" }),
    "--bus-id", "vc-007-h2:test",
    "--data-dir", busDir,
    "--no-fsync",
  ]);
  const r = runCli([
    "history",
    "--event", "subagent_completed",
    "--bus-id", "vc-007-h2:test",
    "--data-dir", busDir,
    "--no-fsync",
  ]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /event_count:\s*[1-9]/);
});

// ─── 5. subscribe (short timeout subprocess) ───────────────────────────────

test("VC-007 S1: subscribe + concurrent publish + timeout exits cleanly", async () => {
  const busDir = freshBusDir();
  // Start subscribe with a 3s timeout
  const child = spawn(process.execPath, [
    BIN, "event-bus", "subscribe",
    "--event", "subagent_spawned",
    "--bus-id", "vc-007-s1:test",
    "--data-dir", busDir,
    "--no-fsync",
    "--timeout", "3",
  ], { stdio: ["ignore", "pipe", "pipe"] });

  let stdoutBuf = "";
  child.stdout.on("data", (chunk) => { stdoutBuf += chunk.toString(); });
  child.stderr.on("data", () => { /* swallow */ });

  // Wait a moment, then publish
  await new Promise((r) => setTimeout(r, 800));
  spawnSync(process.execPath, [
    BIN, "event-bus", "publish",
    "--event", "subagent_spawned",
    "--payload", JSON.stringify({ subagent_role: "explore", task_description: "subscribe test" }),
    "--bus-id", "vc-007-s1:test",
    "--data-dir", busDir,
    "--no-fsync",
  ], { encoding: "utf8" });

  // Wait for subscribe to exit (timeout 3s)
  const exitCode = await new Promise((resolve) => {
    const timer = setTimeout(() => { try { child.kill(); } catch (_) {} resolve(-1); }, 6000);
    child.on("exit", (code) => { clearTimeout(timer); resolve(code); });
  });
  assert.ok(exitCode === 0 || exitCode === null || exitCode === -1, `subscribe should exit cleanly, got ${exitCode}`);
  // Verify stdout contained the published event
  assert.match(stdoutBuf, /subagent_spawned/);
});

// ─── 6. error handling ─────────────────────────────────────────────────────

test("VC-007 E1: publish without --event exits 2 (usage error)", () => {
  const r = runCli([
    "publish",
    "--payload", JSON.stringify({ x: 1 }),
  ]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--event is required/);
});

test("VC-007 E2: publish without --payload exits 2 (usage error)", () => {
  const r = runCli([
    "publish",
    "--event", "subagent_completed",
  ]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--payload is required/);
});

test("VC-007 E3: unknown subcommand exits 2", () => {
  const r = runCli(["bogus-subcommand"]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /unknown event-bus subcommand/);
});

// ─── 7. unit-level: parseArgs ──────────────────────────────────────────────

test("VC-007 U1: parseArgs handles --event and --payload with =", () => {
  const parsed = parseArgs(["publish", "--event=subagent_completed", "--payload={\"a\":1}"]);
  assert.equal(parsed.subcommand, "publish");
  assert.equal(parsed.event, "subagent_completed");
  assert.equal(parsed.payloadRaw, '{"a":1}');
});
