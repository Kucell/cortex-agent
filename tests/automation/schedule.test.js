"use strict";

// ─── Schedule Tests (cortex-owned session scheduling) ────────────────────────
//
// Coverage: lib/automation/scheduler.js (cadence parsing, cron matching, due
// calculation, store, tick) + lib/commands/schedule-cli.js (add/list/remove/
// run/daemon) + the `cortex-agent schedule` binary surface.
//
// Runs go through the real dispatch path, so the tests install the same fake
// DSH binary shape used by tests/agent/agent-batch-dispatch.test.js.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { spawnSync } = require("node:child_process");

const adapters = require("../../lib/agents/adapters");
const scheduler = require("../../lib/automation/scheduler");

const ROOT = path.join(__dirname, "..", "..");
const CLI = path.join(ROOT, "bin", "cli.js");
const NL = String.fromCharCode(10);

// ─── fake DSH binary ─────────────────────────────────────────────────────────

const FAKE_DSH_BODY = [
  "#!/usr/bin/env node",
  "'use strict';",
  "const fs = require('node:fs');",
  "const argv = process.argv.slice(2);",
  "const mode = process.env.FAKE_DSH_MODE || 'success';",
  "const out = (line) => process.stdout.write(line + String.fromCharCode(10));",
  "if (argv.includes('--version')) { out('0.2.1-rc.5'); process.exit(0); }",
  "if (argv.includes('--profile') && argv.includes('--help')) { out('Usage: dsh --profile headless [options] [task...]'); process.exit(0); }",
  "if (argv.includes('--help')) { out('Usage: dsh [--profile <name>] <name> [options]'); out('  dsh headless run-the-tests'); process.exit(0); }",
  "const idx = argv.indexOf('--session-id');",
  "const requested = idx >= 0 ? argv[idx + 1] : null;",
  "let body = '';",
  "process.stdin.setEncoding('utf8');",
  "process.stdin.on('data', (chunk) => { body += chunk; });",
  "process.stdin.on('end', () => {",
  "  const emit = (obj) => out(JSON.stringify(obj));",
  "  if (mode === 'fail') { emit({ type: 'error', code: 'rate_limited', message: 'rate limited' }); process.exit(1); }",
  "  let sessionId = requested;",
  "  if (!sessionId) {",
  "    const counterFile = process.env.FAKE_DSH_COUNTER_FILE;",
  "    if (counterFile) {",
  "      let n = 0;",
  "      try { n = parseInt(fs.readFileSync(counterFile, 'utf8').trim(), 10) || 0; } catch (_) { n = 0; }",
  "      n += 1;",
  "      fs.writeFileSync(counterFile, String(n));",
  "      sessionId = 'session-fake-' + String(n).padStart(4, '0');",
  "    } else {",
  "      sessionId = process.env.FAKE_DSH_SESSION_ID || 'session-fake-0001';",
  "    }",
  "  }",
  "  emit({ type: 'session', sessionId, cwd: process.cwd() });",
  "  emit({ type: 'status', phase: 'turn_start', turn: 1 });",
  "  emit({ type: 'text', text: 'answer for ' + sessionId });",
  "  emit({ type: 'final', text: 'answer for ' + sessionId });",
  "});",
].join("\n");

let cachedFake = null;
function fakeDshPath() {
  if (cachedFake) return cachedFake;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sched-dsh-fake-"));
  const file = path.join(dir, "fake-dsh.js");
  fs.writeFileSync(file, FAKE_DSH_BODY, "utf8");
  fs.chmodSync(file, 0o755);
  cachedFake = file;
  return cachedFake;
}

// ─── fixtures ────────────────────────────────────────────────────────────────

function mkProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "schedule-project-"));
  fs.mkdirSync(path.join(root, ".agent", "agents"), { recursive: true });
  return root;
}

function seedAgent(root, agentId = "worker") {
  fs.writeFileSync(
    path.join(root, ".agent", "agents", `${agentId}.json`),
    JSON.stringify({
      schema_version: 1,
      agent_id: agentId,
      role: "implementer",
      model: "deepseek-flash",
      started_at: "2026-11-09T00:00:00.000Z",
      last_heartbeat: "2026-11-09T00:00:00.000Z",
      status: "running",
      capabilities: ["text_generation"],
      external: { adapter_type: "dsh", config_ref: "cfg", credential_ref: "sec" },
    }),
  );
}

function withEnv(overrides, fn) {
  const saved = {};
  for (const [key, value] of Object.entries(overrides)) {
    saved[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  adapters.reset();
  try {
    return fn();
  } finally {
    adapters.reset();
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

async function withEnvAsync(overrides, fn) {
  const saved = {};
  for (const [key, value] of Object.entries(overrides)) {
    saved[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  adapters.reset();
  try {
    return await fn();
  } finally {
    adapters.reset();
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function runCli(args, options = {}) {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, DSH_BIN: fakeDshPath(), ...(options.env || {}) },
  });
  return {
    status: result.status,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
    json: () => JSON.parse(result.stdout),
  };
}

// ─── cadence parsing ────────────────────────────────────────────────────────

test("parseDuration accepts s/m/h/d units and rejects malformed values", () => {
  assert.equal(scheduler.parseDuration("30s"), 30 * 1000);
  assert.equal(scheduler.parseDuration("15m"), 15 * 60 * 1000);
  assert.equal(scheduler.parseDuration("2h"), 2 * 60 * 60 * 1000);
  assert.equal(scheduler.parseDuration("1d"), 24 * 60 * 60 * 1000);
  assert.equal(scheduler.parseDuration(" 5 m "), 5 * 60 * 1000);
  for (const bad of ["", "0s", "-1m", "10", "5x", null]) {
    assert.throws(() => scheduler.parseDuration(bad), (error) => error.code === "ERR_SCHEDULE_EVERY");
  }
});

test("cron parsing expands wildcards, steps, ranges and lists", () => {
  const every15 = scheduler.parseCron("*/15 * * * *");
  assert.ok(every15.sets[0].has(0) && every15.sets[0].has(15) && every15.sets[0].has(45));
  assert.equal(every15.sets[0].has(7), false);
  const office = scheduler.parseCron("0 9-17 * * 1-5");
  assert.deepEqual([...office.sets[1]].sort((a, b) => a - b), [9, 10, 11, 12, 13, 14, 15, 16, 17]);
  assert.deepEqual([...office.sets[4]].sort((a, b) => a - b), [1, 2, 3, 4, 5]);
  const list = scheduler.parseCron("5,35 0,12 * * *");
  assert.deepEqual([...list.sets[0]].sort((a, b) => a - b), [5, 35]);
  const sunday7 = scheduler.parseCron("0 0 * * 7");
  assert.deepEqual([...sunday7.sets[4]], [0]);
});

test("cron parsing rejects a wrong field count and out-of-range values", () => {
  for (const bad of ["* * * *", "* * * * * *", "60 * * * *", "* 24 * * *", "* * * 13 *", "* * * * 8", "*/0 * * * *", "5-1 * * * *"]) {
    assert.throws(() => scheduler.parseCron(bad), (error) => error.code === "ERR_SCHEDULE_CRON", bad);
  }
});

test("cronMatches uses local time fields", () => {
  const at = new Date(2026, 10, 9, 10, 15, 0); // Monday 2026-11-09 10:15 local
  assert.equal(scheduler.cronMatches("*/15 * * * *", at), true);
  assert.equal(scheduler.cronMatches("*/15 * * * *", new Date(2026, 10, 9, 10, 16, 0)), false);
  assert.equal(scheduler.cronMatches("15 10 * * 1", at), true);
  assert.equal(scheduler.cronMatches("15 10 * * 2", at), false);
  assert.equal(scheduler.cronMatches("15 10 9 11 *", at), true);
});

// ─── definition validation ──────────────────────────────────────────────────

test("validateSchedule normalises defaults and enforces required fields", () => {
  const base = { id: "nightly", agent_id: "dsh:worker", task: "reply OK", every: "15m" };
  const definition = scheduler.validateSchedule(base);
  assert.equal(definition.id, "nightly");
  assert.equal(definition.every_ms, 15 * 60 * 1000);
  assert.equal(definition.cron, null);
  assert.equal(definition.enabled, true);
  assert.equal(definition.concurrency, 1);
  assert.equal(definition.session_id, null);

  const clamped = scheduler.validateSchedule({ ...base, concurrency: 99 });
  assert.equal(clamped.concurrency, 16);

  const cases = [
    [{ ...base, id: "" }, "ERR_SCHEDULE_ID"],
    [{ ...base, id: "***" }, "ERR_SCHEDULE_ID"],
    [{ ...base, agent_id: "" }, "ERR_SCHEDULE_AGENT"],
    [{ ...base, task: "", tasks_file: "" }, "ERR_SCHEDULE_TASK"],
    [{ ...base, tasks_file: "tasks.json" }, "ERR_SCHEDULE_TASK"],
    [{ ...base, every: undefined, cron: undefined }, "ERR_SCHEDULE_CADENCE"],
    [{ ...base, cron: "0 * * * *" }, "ERR_SCHEDULE_CADENCE"],
    [{ ...base, every: "soon" }, "ERR_SCHEDULE_EVERY"],
  ];
  for (const [input, code] of cases) {
    assert.throws(() => scheduler.validateSchedule(input), (error) => error.code === code, JSON.stringify(input));
  }
});

test("slug ids are normalised and duplicate ids are rejected by the CLI", () => {
  const root = mkProject();
  seedAgent(root);
  const first = runCli(["schedule", "add", "--project", root, "--json",
    "--id", "Nightly Audit", "--agent", "dsh:worker", "--task", "x", "--every", "10m"]);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(first.json().schedule.id, "nightly-audit");

  const duplicate = runCli(["schedule", "add", "--project", root, "--json",
    "--id", "nightly-audit", "--agent", "dsh:worker", "--task", "y", "--every", "1m"]);
  assert.equal(duplicate.status, 2);
  assert.match(duplicate.stderr, /ERR_SCHEDULE_EXISTS/);
});

// ─── due calculation ────────────────────────────────────────────────────────

test("isDue handles interval cadence, cron duplicate minutes and disabled entries", () => {
  const now = new Date(2026, 10, 9, 10, 15, 30);
  const every = scheduler.validateSchedule({ id: "i", agent_id: "dsh:worker", task: "x", every: "15m" });
  assert.equal(scheduler.isDue(every, now, null), true);
  assert.equal(scheduler.isDue(every, now, new Date(now.getTime() - 5 * 60 * 1000).toISOString()), false);
  assert.equal(scheduler.isDue(every, now, new Date(now.getTime() - 16 * 60 * 1000).toISOString()), true);

  const cron = scheduler.validateSchedule({ id: "c", agent_id: "dsh:worker", task: "x", cron: "*/15 * * * *" });
  assert.equal(scheduler.isDue(cron, now, null), true);
  assert.equal(scheduler.isDue(cron, now, new Date(2026, 10, 9, 10, 15, 5).toISOString()), false, "same minute must not re-fire");
  assert.equal(scheduler.isDue(cron, now, new Date(2026, 10, 9, 10, 0, 5).toISOString()), true);
  assert.equal(scheduler.isDue(cron, new Date(2026, 10, 9, 10, 16, 0), null), false);

  const disabled = scheduler.validateSchedule({ id: "d", agent_id: "dsh:worker", task: "x", every: "1m", enabled: false });
  assert.equal(scheduler.isDue(disabled, now, null), false);
});

// ─── store ──────────────────────────────────────────────────────────────────

test("store round-trips definitions, lists them sorted, and removes them", () => {
  const root = mkProject();
  const a = scheduler.validateSchedule({ id: "beta", agent_id: "dsh:worker", task: "b", every: "1m" });
  const b = scheduler.validateSchedule({ id: "alpha", agent_id: "dsh:worker", task: "a", every: "2m" });
  scheduler.writeSchedule(root, a);
  scheduler.writeSchedule(root, b);
  assert.deepEqual(scheduler.loadSchedules(root).map((entry) => entry.id), ["alpha", "beta"]);
  assert.equal(scheduler.readSchedule(root, "alpha").task, "a");
  assert.equal(scheduler.readSchedule(root, "missing"), null);

  scheduler.removeSchedule(root, "alpha");
  assert.deepEqual(scheduler.loadSchedules(root).map((entry) => entry.id), ["beta"]);
  assert.throws(() => scheduler.removeSchedule(root, "alpha"), (error) => error.code === "ERR_SCHEDULE_NOT_FOUND");
});

test("corrupt definitions surface as ERR_SCHEDULE_CORRUPT instead of crashing silently", () => {
  const root = mkProject();
  fs.mkdirSync(path.join(root, ".agent", "schedules"), { recursive: true });
  fs.writeFileSync(path.join(root, ".agent", "schedules", "broken.json"), "{not json");
  assert.throws(() => scheduler.loadSchedules(root), (error) => error.code === "ERR_SCHEDULE_CORRUPT");
});

// ─── tick ───────────────────────────────────────────────────────────────────

test("tick runs a due schedule, records evidence and advances last_run_at", async () => {
  const root = mkProject();
  seedAgent(root);
  const definition = scheduler.validateSchedule({ id: "nightly", agent_id: "dsh:worker", task: "reply OK", every: "15m" });
  scheduler.writeSchedule(root, definition);

  const result = await withEnvAsync({ DSH_BIN: fakeDshPath() }, () => scheduler.tick({ projectRoot: root }));

  assert.equal(result.counts.ran, 1);
  assert.equal(result.counts.ok, 1);
  assert.equal(result.results[0].id, "nightly");
  assert.equal(result.results[0].status, "ok");
  assert.match(result.results[0].batch_id, /^B-/);

  const updated = scheduler.readSchedule(root, "nightly");
  assert.ok(updated.last_run_at);
  assert.equal(updated.last_status, "ok");
  assert.equal(updated.last_batch_id, result.results[0].batch_id);

  const runs = fs.readdirSync(scheduler.runsDir(root, "nightly"));
  assert.equal(runs.length, 1);
  const record = JSON.parse(fs.readFileSync(path.join(scheduler.runsDir(root, "nightly"), runs[0]), "utf8"));
  assert.equal(record.schedule_id, "nightly");
  assert.equal(record.status, "ok");
  assert.equal(record.counts.total, 1);
});

test("a second immediate tick skips the schedule; --force re-runs it", async () => {
  const root = mkProject();
  seedAgent(root);
  scheduler.writeSchedule(root, scheduler.validateSchedule({ id: "every-15", agent_id: "dsh:worker", task: "x", every: "15m" }));

  await withEnvAsync({ DSH_BIN: fakeDshPath() }, async () => {
    const first = await scheduler.tick({ projectRoot: root });
    assert.equal(first.counts.ran, 1);
    const second = await scheduler.tick({ projectRoot: root });
    assert.equal(second.counts.ran, 0);
    assert.equal(second.counts.skipped, 1);
    assert.equal(second.results[0].reason, "not_due");
    const forced = await scheduler.tick({ projectRoot: root, force: true });
    assert.equal(forced.counts.ran, 1);
  });
  assert.equal(fs.readdirSync(scheduler.runsDir(root, "every-15")).length, 2);
});

test("cron schedules fire only inside a matching minute", async () => {
  const root = mkProject();
  seedAgent(root);
  scheduler.writeSchedule(root, scheduler.validateSchedule({
    id: "office-hours", agent_id: "dsh:worker", task: "x", cron: "0 9-17 * * 1-5",
  }));

  await withEnvAsync({ DSH_BIN: fakeDshPath() }, async () => {
    const outside = await scheduler.tick({ projectRoot: root, now: new Date(2026, 10, 9, 10, 30, 0) });
    assert.equal(outside.counts.ran, 0);
    assert.equal(outside.counts.skipped, 1);

    const inside = await scheduler.tick({ projectRoot: root, now: new Date(2026, 10, 9, 10, 0, 0) });
    assert.equal(inside.counts.ran, 1);
    assert.equal(inside.counts.ok, 1);
  });
});

test("failure is recorded honestly: failed status, error code, exit 3 via CLI", async () => {
  const root = mkProject();
  seedAgent(root);
  scheduler.writeSchedule(root, scheduler.validateSchedule({ id: "flaky", agent_id: "dsh:worker", task: "x", every: "1m" }));

  const result = await withEnvAsync({ DSH_BIN: fakeDshPath(), FAKE_DSH_MODE: "fail" }, () => scheduler.tick({ projectRoot: root }));
  assert.equal(result.counts.failed, 1);
  assert.equal(result.results[0].status, "failed");

  const updated = scheduler.readSchedule(root, "flaky");
  assert.equal(updated.last_status, "failed");

  const cli = runCli(["schedule", "run", "--project", root, "--json", "--force"], { env: { FAKE_DSH_MODE: "fail" } });
  assert.equal(cli.status, 3);
  assert.equal(cli.json().tick.counts.failed, 1);
});

test("tasks_file schedules fan out to the batch and reuse the requested session id", async () => {
  const root = mkProject();
  seedAgent(root);
  fs.writeFileSync(path.join(root, "tasks.json"), JSON.stringify({
    tasks: [
      { label: "one", agent_id: "dsh:worker", task: "first" },
      { label: "two", agent_id: "dsh:worker", task: "second" },
    ],
  }));
  scheduler.writeSchedule(root, scheduler.validateSchedule({
    id: "batch-run", agent_id: "dsh:worker", tasks_file: "tasks.json", every: "1m", concurrency: 2,
  }));

  const result = await withEnvAsync({ DSH_BIN: fakeDshPath() }, () => scheduler.tick({ projectRoot: root }));
  assert.equal(result.counts.ok, 1);
  const record = JSON.parse(fs.readFileSync(result.results[0].run_record, "utf8"));
  assert.equal(record.counts.total, 2);

  const resumeRoot = mkProject();
  seedAgent(resumeRoot);
  scheduler.writeSchedule(resumeRoot, scheduler.validateSchedule({
    id: "resume", agent_id: "dsh:worker", task: "continue", every: "1m", session_id: "session-fixed-1",
  }));
  const resumed = await withEnvAsync({ DSH_BIN: fakeDshPath() }, () => scheduler.tick({ projectRoot: resumeRoot }));
  const journal = path.join(resumeRoot, ".agent", "runtime", "dispatch", resumed.results[0].batch_id);
  assert.ok(fs.existsSync(path.join(journal, "batch.json")));
  assert.equal(resumed.results[0].status, "ok");
});

// ─── CLI surface ────────────────────────────────────────────────────────────

test("CLI add/list/remove round-trip and error handling", () => {
  const root = mkProject();
  seedAgent(root);

  const add = runCli(["schedule", "add", "--project", root, "--json",
    "--id", "hourly", "--agent", "dsh:worker", "--tasks", "tasks.json", "--cron", "0 * * * *"]);
  assert.equal(add.status, 0, add.stderr);
  const added = add.json();
  assert.equal(added.schedule.cron, "0 * * * *");
  assert.equal(added.schedule.tasks_file, "tasks.json");

  const list = runCli(["schedule", "list", "--project", root, "--json"]);
  assert.equal(list.status, 0);
  assert.deepEqual(list.json().schedules.map((entry) => entry.id), ["hourly"]);

  const human = runCli(["schedule", "list", "--project", root]);
  assert.equal(human.status, 0);
  assert.match(human.stdout, /hourly/);

  const remove = runCli(["schedule", "remove", "hourly", "--project", root, "--json"]);
  assert.equal(remove.status, 0);
  assert.equal(scheduler.loadSchedules(root).length, 0);

  const missing = runCli(["schedule", "remove", "hourly", "--project", root]);
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /ERR_SCHEDULE_NOT_FOUND/);

  const badFlag = runCli(["schedule", "add", "--project", root, "--id", "x", "--agent", "dsh:w", "--task", "t", "--every", "1m", "--concurency", "2"]);
  assert.equal(badFlag.status, 2);
  assert.match(badFlag.stderr, /unknown flag/);

  const noCadence = runCli(["schedule", "add", "--project", root, "--id", "x", "--agent", "dsh:w", "--task", "t"]);
  assert.equal(noCadence.status, 2);
  assert.match(noCadence.stderr, /ERR_SCHEDULE_CADENCE/);
});

test("CLI run --now drives due calculation and reports skipped schedules", () => {
  const root = mkProject();
  seedAgent(root);
  runCli(["schedule", "add", "--project", root, "--id", "office", "--agent", "dsh:worker", "--task", "x", "--cron", "0 9-17 * * 1-5"]);

  const outside = runCli(["schedule", "run", "--project", root, "--json", "--now", "2026-11-09T10:30:00"]);
  assert.equal(outside.status, 0);
  assert.equal(outside.json().tick.counts.skipped, 1);

  const inside = runCli(["schedule", "run", "--project", root, "--json", "--now", "2026-11-09T10:00:00"]);
  assert.equal(inside.status, 0, inside.stderr);
  assert.equal(inside.json().tick.counts.ok, 1);

  const invalid = runCli(["schedule", "run", "--project", root, "--now", "not-a-date"]);
  assert.equal(invalid.status, 2);
  assert.match(invalid.stderr, /ERR_SCHEDULE_NOW/);
});

test("CLI daemon --once performs exactly one tick and exits", () => {
  const root = mkProject();
  seedAgent(root);
  runCli(["schedule", "add", "--project", root, "--id", "once", "--agent", "dsh:worker", "--task", "x", "--every", "1m"]);

  const daemon = runCli(["schedule", "daemon", "--once", "--project", root, "--json"]);
  assert.equal(daemon.status, 0, daemon.stderr);
  assert.equal(daemon.json().tick.counts.ran, 1);
  assert.equal(fs.readdirSync(scheduler.runsDir(root, "once")).length, 1);
});

test("schedule --help / -h / bare schedule print usage instead of erroring", () => {
  for (const argv of [["schedule"], ["schedule", "--help"], ["schedule", "-h"]]) {
    const r = runCli(argv);
    assert.equal(r.status, 0, `${argv.join(" ")} should exit 0`);
    assert.match(r.stdout, /cortex-agent schedule add/);
    assert.equal(r.stderr, "");
  }
});

test("schedule help is side-effect free and lists every subcommand", () => {
  const root = mkProject();
  const help = runCli(["schedule", "help"]);
  assert.equal(help.status, 0);
  for (const word of ["schedule add", "schedule list", "schedule remove", "schedule run", "schedule daemon"]) {
    assert.ok(help.stdout.includes(word), `help is missing "${word}"`);
  }
  assert.equal(fs.existsSync(path.join(root, ".agent", "schedules")), false);

  const bare = runCli(["schedule"]);
  assert.equal(bare.status, 0);
  assert.ok(bare.stdout.includes("Usage:"));
});
