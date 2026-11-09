"use strict";

// ─── Batch Dispatch Tests (multi-task / multi-session fan-out) ───────────────
//
// Coverage: lib/agents/batch-dispatch.js + the `agent dispatch-batch`
// CLI surface (lib/agents/m003-cli.js).
//
// The tests use a fake DSH binary that mirrors the real headless CLI shape
// (dsh 0.2.1-rc.5):
//   dsh --profile headless [--json] [--session-id <id>] -
// The task arrives on stdin; the run stream is newline-delimited JSON whose
// first event is a `session` event carrying the session id.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { spawnSync } = require("node:child_process");

const adapters = require("../../lib/agents/adapters");
const {
  dispatchBatch,
  parseTasksPayload,
  loadTasksFile,
  BatchDispatchError,
  DEFAULT_CONCURRENCY,
  MAX_CONCURRENCY,
} = require("../../lib/agents/batch-dispatch");

const binCli = path.join(__dirname, "..", "..", "bin", "cli.js");
const NL = String.fromCharCode(10);

// ─── fake DSH binary ─────────────────────────────────────────────────────────

const FAKE_DSH_BODY = `#!/usr/bin/env node
'use strict';
const fs = require("fs");
const argv = process.argv.slice(2);
const mode = process.env.FAKE_DSH_MODE || "success";
if (argv.includes("--version")) { process.stdout.write("0.2.1-rc.5" + String.fromCharCode(10)); process.exit(0); }
if (argv.includes("--profile") && argv.includes("--help")) {
  process.stdout.write("Usage: dsh --profile headless [options] [task...]" + String.fromCharCode(10));
  process.exit(0);
}
if (argv.includes("--help")) {
  process.stdout.write(["Usage: dsh [--profile <name>] <name> [options]", "  dsh headless run-the-tests", "  dsh web"].join(String.fromCharCode(10)) + String.fromCharCode(10));
  process.exit(0);
}
// Real dsh echoes the session id it was asked to resume. Mirror that.
const sessionArgIndex = argv.indexOf("--session-id");
const requestedSessionId = sessionArgIndex >= 0 ? argv[sessionArgIndex + 1] : null;
let body = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { body += chunk; });
process.stdin.on("end", () => {
  const emit = (obj) => process.stdout.write(JSON.stringify(obj) + String.fromCharCode(10));
  if (mode === "fail") {
    emit({ type: "error", code: "rate_limited", message: "rate limited" });
    process.exit(1);
  }
  let sessionId = requestedSessionId;
  if (!sessionId) {
    const counterFile = process.env.FAKE_DSH_COUNTER_FILE;
    if (counterFile) {
      let n = 0;
      try { n = parseInt(fs.readFileSync(counterFile, "utf8").trim(), 10) || 0; } catch (_) { n = 0; }
      n += 1;
      fs.writeFileSync(counterFile, String(n));
      sessionId = "session-fake-" + String(n).padStart(4, "0");
    } else {
      sessionId = process.env.FAKE_DSH_SESSION_ID || "session-fake-0001";
    }
  }
  emit({ type: "session", sessionId, cwd: process.cwd() });
  emit({ type: "status", phase: "turn_start", turn: 1 });
  emit({ type: "text", text: "answer for " + sessionId });
  emit({ type: "final", text: "answer for " + sessionId });
  process.exit(0);
});
`;

let _fakeDsh = null;
function fakeDshPath() {
  if (_fakeDsh) return _fakeDsh;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "batch-dsh-fake-"));
  const file = path.join(dir, "fake-dsh.js");
  fs.writeFileSync(file, FAKE_DSH_BODY, "utf8");
  fs.chmodSync(file, 0o755);
  _fakeDsh = file;
  return _fakeDsh;
}

// ─── fixtures ────────────────────────────────────────────────────────────────

function mkProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "batch-dispatch-"));
  fs.mkdirSync(path.join(root, ".agent", "agents"), { recursive: true });
  return root;
}

function seedAgent(root, agentId, overrides = {}) {
  fs.writeFileSync(
    path.join(root, ".agent", "agents", `${agentId}.json`),
    JSON.stringify({
      schema_version: 1,
      agent_id: agentId,
      role: overrides.role || "implementer",
      model: overrides.model || "deepseek-flash",
      started_at: "2026-11-09T00:00:00.000Z",
      last_heartbeat: "2026-11-09T00:00:00.000Z",
      status: overrides.status || "running",
      capabilities: overrides.capabilities || ["text_generation"],
      external: {
        adapter_type: overrides.adapterType || "dsh",
        config_ref: "cfg",
        credential_ref: "sec",
      },
    }),
  );
}

function withFakeDshEnv(fn) {
  const prevBin = process.env.DSH_BIN;
  const prevMode = process.env.FAKE_DSH_MODE;
  const prevSession = process.env.FAKE_DSH_SESSION_ID;
  process.env.DSH_BIN = fakeDshPath();
  adapters.reset();
  try {
    return fn();
  } finally {
    adapters.reset();
    if (prevBin === undefined) delete process.env.DSH_BIN;
    else process.env.DSH_BIN = prevBin;
    if (prevMode === undefined) delete process.env.FAKE_DSH_MODE;
    else process.env.FAKE_DSH_MODE = prevMode;
    if (prevSession === undefined) delete process.env.FAKE_DSH_SESSION_ID;
    else process.env.FAKE_DSH_SESSION_ID = prevSession;
  }
}

async function withFakeDshEnvAsync(fn) {
  const prevBin = process.env.DSH_BIN;
  const prevMode = process.env.FAKE_DSH_MODE;
  const prevSession = process.env.FAKE_DSH_SESSION_ID;
  process.env.DSH_BIN = fakeDshPath();
  adapters.reset();
  try {
    return await fn();
  } finally {
    adapters.reset();
    if (prevBin === undefined) delete process.env.DSH_BIN;
    else process.env.DSH_BIN = prevBin;
    if (prevMode === undefined) delete process.env.FAKE_DSH_MODE;
    else process.env.FAKE_DSH_MODE = prevMode;
    if (prevSession === undefined) delete process.env.FAKE_DSH_SESSION_ID;
    else process.env.FAKE_DSH_SESSION_ID = prevSession;
  }
}

// ─── task file parsing ───────────────────────────────────────────────────────

test("batch-dispatch: parseTasksPayload accepts a bare array and a {tasks:[...]} object", () => {
  const arrayForm = parseTasksPayload(JSON.stringify([
    { agent_id: "dsh:a", task: "one" },
    { agent_id: "dsh:b", task: "two", label: "second" },
  ]), "inline");
  assert.equal(arrayForm.length, 2);
  assert.equal(arrayForm[0].label, "task-01");
  assert.equal(arrayForm[1].label, "second");

  const objectForm = parseTasksPayload(JSON.stringify({
    tasks: [{ agent_id: "dsh:a", task: "one" }],
  }), "inline");
  assert.equal(objectForm.length, 1);
  assert.equal(objectForm[0].agent_id, "dsh:a");
});

test("batch-dispatch: parseTasksPayload keeps session_id / timeout / input", () => {
  const [item] = parseTasksPayload(JSON.stringify([
    {
      agent_id: "dsh:a",
      task: "continue",
      session_id: "session-abc",
      timeout: 42,
      input: { patch: "diff" },
    },
  ]), "inline");
  assert.equal(item.session_id, "session-abc");
  assert.equal(item.timeout, 42);
  assert.deepEqual(item.input, { patch: "diff" });
});

test("batch-dispatch: parseTasksPayload rejects malformed payloads with coded errors", () => {
  const cases = [
    ["{not json", "ERR_BATCH_TASK_FILE_PARSE"],
    [JSON.stringify({ nope: 1 }), "ERR_BATCH_TASK_FILE_SHAPE"],
    [JSON.stringify([]), "ERR_BATCH_NO_TASKS"],
    [JSON.stringify([{ task: "x" }]), "ERR_BATCH_TASK_AGENT_MISSING"],
    [JSON.stringify([{ agent_id: "dsh:a" }]), "ERR_BATCH_TASK_TEXT_MISSING"],
    [JSON.stringify([{ agent_id: "dsh:a", task: "x", label: "same" },
      { agent_id: "dsh:b", task: "y", label: "same" }]), "ERR_BATCH_DUPLICATE_LABEL"],
  ];
  for (const [payload, expectedCode] of cases) {
    assert.throws(
      () => parseTasksPayload(payload, "inline"),
      (err) => {
        assert.ok(err instanceof BatchDispatchError, `expected BatchDispatchError for ${expectedCode}`);
        assert.equal(err.code, expectedCode);
        return true;
      },
      `payload ${payload} must fail with ${expectedCode}`,
    );
  }
});

test("batch-dispatch: loadTasksFile reports a missing file", () => {
  assert.throws(
    () => loadTasksFile(path.join(os.tmpdir(), "does-not-exist-tasks.json")),
    (err) => err.code === "ERR_BATCH_TASK_FILE_MISSING",
  );
});

test("batch-dispatch: concurrency defaults are 1 and capped at 16", () => {
  assert.equal(DEFAULT_CONCURRENCY, 1);
  assert.equal(MAX_CONCURRENCY, 16);
});

// ─── dispatchBatch ───────────────────────────────────────────────────────────

test("batch-dispatch: dispatchBatch runs two tasks and reports an ok summary", async () => {
  const root = mkProject();
  seedAgent(root, "dsher");
  const summary = await withFakeDshEnvAsync(() => dispatchBatch({
    projectRoot: root,
    tasks: [
      { label: "first", agent_id: "dsh:dsher", task: "one" },
      { label: "second", agent_id: "dsh:dsher", task: "two" },
    ],
  }));

  assert.equal(summary.schema, "dispatch-batch/v1");
  assert.equal(summary.status, "ok");
  assert.deepEqual(summary.counts, { total: 2, ok: 2, blocked: 0, timeout: 0, failed: 0 });
  assert.equal(summary.concurrency, 1);
  assert.equal(summary.items.length, 2);
  assert.equal(summary.items[0].status, "ok");
  assert.equal(summary.items[0].adapter_type, "dsh");
  assert.equal(summary.items[0].agent_id, "dsh:dsher");
  assert.ok(summary.items[0].run_id.startsWith(`R-${summary.batch_id}-`));
  // The DSH session id is captured from the run stream and reported back, so
  // a caller can resume that session later.
  assert.equal(summary.items[0].session_id, "session-fake-0001");
  assert.ok(summary.items[0].text_bytes > 0);
  assert.equal(summary.items[1].status, "ok");
});

test("batch-dispatch: dispatchBatch writes the aggregate artifact", async () => {
  const root = mkProject();
  seedAgent(root, "dsher");
  const summary = await withFakeDshEnvAsync(() => dispatchBatch({
    projectRoot: root,
    tasks: [{ agent_id: "dsh:dsher", task: "one" }],
  }));
  const artifact = path.join(
    root, ".agent", "runtime", "dispatch", summary.batch_id, "batch.json",
  );
  assert.ok(fs.existsSync(artifact), "batch.json must be written");
  const written = JSON.parse(fs.readFileSync(artifact, "utf8"));
  assert.equal(written.batch_id, summary.batch_id);
  assert.equal(written.items.length, 1);
});

test("batch-dispatch: a per-task resolution failure does not abort the batch", async () => {
  const root = mkProject();
  seedAgent(root, "dsher");
  const summary = await withFakeDshEnvAsync(() => dispatchBatch({
    projectRoot: root,
    tasks: [
      { label: "ghost", agent_id: "dsh:ghost", task: "nobody" },
      { label: "real", agent_id: "dsh:dsher", task: "one" },
    ],
  }));

  assert.equal(summary.status, "failed");
  assert.equal(summary.counts.failed, 1);
  assert.equal(summary.counts.ok, 1);
  assert.equal(summary.items[0].error.code, "ERR_AGENT_NOT_FOUND");
  assert.equal(summary.items[1].status, "ok");
});

test("batch-dispatch: an adapter error is reported per item, not swallowed", async () => {
  const root = mkProject();
  seedAgent(root, "dsher");
  const prevMode = process.env.FAKE_DSH_MODE;
  process.env.FAKE_DSH_MODE = "fail";
  let summary;
  try {
    summary = await withFakeDshEnvAsync(() => dispatchBatch({
      projectRoot: root,
      tasks: [{ agent_id: "dsh:dsher", task: "one" }],
    }));
  } finally {
    if (prevMode === undefined) delete process.env.FAKE_DSH_MODE;
    else process.env.FAKE_DSH_MODE = prevMode;
  }
  assert.equal(summary.status, "failed");
  assert.equal(summary.counts.failed, 1);
  assert.equal(summary.items[0].error.code, "ERR_DSH_RATE_LIMITED");
});

test("batch-dispatch: concurrency > 1 keeps every task independent", async () => {
  const root = mkProject();
  seedAgent(root, "dsher");
  const summary = await withFakeDshEnvAsync(() => dispatchBatch({
    projectRoot: root,
    concurrency: 2,
    tasks: [
      { label: "a", agent_id: "dsh:dsher", task: "one" },
      { label: "b", agent_id: "dsh:dsher", task: "two" },
      { label: "c", agent_id: "dsh:dsher", task: "three" },
    ],
  }));
  assert.equal(summary.concurrency, 2);
  assert.equal(summary.status, "ok");
  assert.equal(summary.counts.ok, 3);
  const runIds = new Set(summary.items.map((i) => i.run_id));
  assert.equal(runIds.size, 3, "each task needs its own run id");
});

test("batch-dispatch: dispatchBatch requires a non-empty task list", async () => {
  await assert.rejects(
    () => dispatchBatch({ projectRoot: mkProject(), tasks: [] }),
    (err) => err.code === "ERR_BATCH_NO_TASKS",
  );
});

test("batch-dispatch: every task opens its own session", async () => {
  const root = mkProject();
  seedAgent(root, "dsher");
  const counterFile = path.join(root, "session-counter.txt");
  fs.writeFileSync(counterFile, "0");
  const prevCounter = process.env.FAKE_DSH_COUNTER_FILE;
  process.env.FAKE_DSH_COUNTER_FILE = counterFile;
  let summary;
  try {
    summary = await withFakeDshEnvAsync(() => dispatchBatch({
      projectRoot: root,
      tasks: [
        { label: "first", agent_id: "dsh:dsher", task: "one" },
        { label: "second", agent_id: "dsh:dsher", task: "two" },
      ],
    }));
  } finally {
    if (prevCounter === undefined) delete process.env.FAKE_DSH_COUNTER_FILE;
    else process.env.FAKE_DSH_COUNTER_FILE = prevCounter;
  }
  assert.equal(summary.status, "ok");
  const ids = summary.items.map((i) => i.session_id);
  assert.equal(ids.length, 2);
  assert.ok(ids[0] && ids[1], "each task must report an observed session id");
  assert.notEqual(ids[0], ids[1], "tasks must not share one session id");
  assert.match(ids[0], /^session-fake-\d{4}$/);
});

test("batch-dispatch: a task with session_id resumes it and reports requested vs observed", async () => {
  const root = mkProject();
  seedAgent(root, "dsher");
  const summary = await withFakeDshEnvAsync(() => dispatchBatch({
    projectRoot: root,
    tasks: [{ label: "resume", agent_id: "dsh:dsher", task: "continue", session_id: "session-abc" }],
  }));
  assert.equal(summary.status, "ok");
  assert.equal(summary.items[0].session_id, "session-abc", "the observed session id must be the resumed one");
  assert.equal(summary.items[0].requested_session_id, "session-abc");
});

test("batch-dispatch: an item without a session reports no observed session id", async () => {
  const root = mkProject();
  seedAgent(root, "dsher");
  const summary = await withFakeDshEnvAsync(() => dispatchBatch({
    projectRoot: root,
    tasks: [{ label: "ghost", agent_id: "dsh:ghost", task: "nobody" }],
  }));
  assert.equal(summary.items[0].status, "failed");
  assert.equal(summary.items[0].session_id, null, "a failed item must not claim a session id");
  assert.equal(summary.items[0].requested_session_id, null);
});

// ─── CLI surface ─────────────────────────────────────────────────────────────

test("cli: agent dispatch-batch without --tasks exits 2", () => {
  const r = spawnSync("node", [binCli, "agent", "dispatch-batch"], { encoding: "utf8" });
  assert.equal(r.status, 2);
  assert.ok(/--tasks/.test(r.stderr), r.stderr);
});

test("cli: agent dispatch-batch --tasks <file> prints the summary and exits 0", () => {
  const root = mkProject();
  seedAgent(root, "dsher");
  const tasksFile = path.join(root, "tasks.json");
  fs.writeFileSync(tasksFile, JSON.stringify({
    tasks: [{ label: "first", agent_id: "dsh:dsher", task: "one" }],
  }));
  const env = { ...process.env, DSH_BIN: fakeDshPath() };
  delete env.FAKE_DSH_MODE;
  const r = spawnSync("node", [
    binCli, "agent", "dispatch-batch",
    "--tasks", tasksFile, "--project", root, "--output", "json",
  ], { encoding: "utf8", env });
  assert.equal(r.status, 0, `stderr: ${r.stderr}\nstdout: ${r.stdout}`);
  const json = JSON.parse(r.stdout);
  assert.equal(json.status, "ok");
  assert.equal(json.counts.ok, 1);
  assert.equal(json.items[0].session_id, "session-fake-0001");
});

test("cli: agent dispatch-batch accepts the task file positionally", () => {
  const root = mkProject();
  seedAgent(root, "dsher");
  const tasksFile = path.join(root, "tasks.json");
  fs.writeFileSync(tasksFile, JSON.stringify([
    { agent_id: "dsh:dsher", task: "one" },
  ]));
  const env = { ...process.env, DSH_BIN: fakeDshPath() };
  delete env.FAKE_DSH_MODE;
  const r = spawnSync("node", [
    binCli, "agent", "dispatch-batch", tasksFile, "--project", root, "--output", "json",
  ], { encoding: "utf8", env });
  assert.equal(r.status, 0, `stderr: ${r.stderr}\nstdout: ${r.stdout}`);
  assert.equal(JSON.parse(r.stdout).counts.ok, 1);
});

test("cli: agent dispatch-batch reports a broken task file with exit code 2", () => {
  const root = mkProject();
  const tasksFile = path.join(root, "tasks.json");
  fs.writeFileSync(tasksFile, "{ broken");
  const r = spawnSync("node", [
    binCli, "agent", "dispatch-batch", "--tasks", tasksFile, "--project", root, "--output", "json",
  ], { encoding: "utf8" });
  assert.equal(r.status, 2);
  const json = JSON.parse(r.stdout);
  assert.equal(json.error.code, "ERR_BATCH_TASK_FILE_PARSE");
});

test("cli: agent dispatch-batch rejects a non-numeric --concurrency instead of running serially", () => {
  const root = mkProject();
  seedAgent(root, "dsher");
  const tasksFile = path.join(root, "tasks.json");
  fs.writeFileSync(tasksFile, JSON.stringify([{ agent_id: "dsh:dsher", task: "one" }]));
  const env = { ...process.env, DSH_BIN: fakeDshPath() };
  delete env.FAKE_DSH_MODE;
  const r = spawnSync("node", [
    binCli, "agent", "dispatch-batch", "--tasks", tasksFile, "--project", root,
    "--concurrency", "four", "--output", "json",
  ], { encoding: "utf8", env });
  assert.equal(r.status, 2, `stderr: ${r.stderr}\nstdout: ${r.stdout}`);
  assert.ok(/--concurrency/.test(r.stderr), r.stderr);
  assert.equal(r.stdout.trim(), "", "a rejected flag must not start any task");
});
