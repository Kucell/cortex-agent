"use strict";

// Coverage for runtime-continuity (Phase 1 of the agent-runtime-continuity
// proposal §3.1).  Mirrors the protocol declared in
// .agent/sub-agents/session-manager.md without redefining it.

const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const ROOT = path.resolve(__dirname, "..");
const SKILL = path.join(ROOT, "templates", "_shared", ".agent", "skills", "runtime-continuity", "scripts", "index.js");

function fixture() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-rt-"));
  fs.mkdirSync(path.join(cwd, ".agent", "runs"), { recursive: true });
  fs.writeFileSync(
    path.join(cwd, ".agent", "runs", "R-rt-test-001.json"),
    JSON.stringify({ run_id: "R-rt-test-001", status: "running", events: [] }),
    "utf8",
  );
  return cwd;
}

function run(cwd, args) {
  return spawnSync(process.execPath, [SKILL, ...args], { cwd, encoding: "utf8" });
}

function readRunEvents(cwd) {
  return JSON.parse(fs.readFileSync(path.join(cwd, ".agent", "runs", "R-rt-test-001.json"), "utf8")).events;
}

function rmContexts(projectName) {
  fs.rmSync(path.join(os.homedir(), ".agent", "contexts", projectName), { recursive: true, force: true });
}

function rmRuntime(cwd) {
  fs.rmSync(path.join(cwd, ".agent", "runtime-continuity"), { recursive: true, force: true });
}

// ─── mode 0: assess ──────────────────────────────────────────────────────────

test("assess: short task description produces low risk", () => {
  const cwd = fixture();
  const r = run(cwd, ["assess", "--task-description", "small fix", "--gate", "user"]);
  assert.equal(r.status, 0, r.stderr);
  const body = JSON.parse(r.stdout);
  assert.equal(body.risk, "low");
});

test("assess: aggressive long description produces high risk", () => {
  // >200 words per helper table → high risk
  const cwd = fixture();
  const big = "implement integration with all the necessary pieces and details ".repeat(40); // ~2500 chars / ~400 words
  const r = run(cwd, ["assess", "--task-description", big, "--gate", "user"]);
  const body = JSON.parse(r.stdout);
  assert.equal(body.risk, "high", `expected high, got ${body.risk}`);
  assert.ok(body.phases >= 2, `expected phases >= 2, got ${body.phases}`);
});

test("assess without --gate fails", () => {
  const cwd = fixture();
  const r = run(cwd, ["assess", "--task-description", "x"]);
  assert.equal(JSON.parse(r.stdout).error, "workflow_gate_required");
});

// ─── mode 4: warm ─────────────────────────────────────────────────────────────

test("warm: emits the 5-hour-start prompt and zero side effects", () => {
  const cwd = fixture();
  const r = run(cwd, ["warm"]);
  assert.equal(r.status, 0);
  const body = JSON.parse(r.stdout);
  assert.equal(body.duration_hours, 5);
  assert.ok(body.prompt_for_host_paste.includes("5 小时计时窗口"));
  // No event appended.
  assert.equal(readRunEvents(cwd).length, 0);
});

test("warm --auto: writes session_started event when --project is given", () => {
  const cwd = fixture();
  const r = run(cwd, ["warm", "--auto", "--project", "rt-warm-auto"]);
  assert.equal(r.status, 0);
  const body = JSON.parse(r.stdout);
  assert.equal(body.duration_hours, 5);
  assert.equal(body.auto_init, true, "expected auto_init:true when project is given");
  // session_started event appended
  const evs = readRunEvents(cwd);
  assert.ok(evs.length >= 1, "expected at least 1 run event");
  const last = evs[evs.length - 1];
  assert.equal(last.type, "session_started");
  assert.equal(last.via, "warm_auto_init");
  assert.equal(last.project, "rt-warm-auto");
});

test("warm --auto without --project: no side effects (graceful no-op)", () => {
  const cwd = fixture();
  const r = run(cwd, ["warm", "--auto"]);
  assert.equal(r.status, 0);
  const body = JSON.parse(r.stdout);
  assert.equal(body.duration_hours, 5);
  assert.equal(body.auto_init, undefined, "auto_init absent when --project missing");
  // No event appended (graceful no-op)
  assert.equal(readRunEvents(cwd).length, 0);
});

// ─── mode 2: archive ──────────────────────────────────────────────────────────

test("archive writes ctx_<ts>.md and symlinks latest.md", () => {
  const cwd = fixture();
  rmContexts("rt-arch");
  rmRuntime(cwd);
  try {
    const r = run(cwd, ["archive", "--project", "rt-arch", "--gate", "user",
      "--note-json", JSON.stringify({ done: "M1", blocked: "", next: "M2", pitfalls: "" })]);
    assert.equal(r.status, 0, r.stderr);
    const body = JSON.parse(r.stdout);
    assert.ok(body.archivePath.includes("/rt-arch/"));
    assert.ok(fs.existsSync(body.archivePath));
    assert.ok(fs.existsSync(body.archiveJsonPath), "expected project-local structured archive");
    assert.ok(body.latestPath.endsWith("latest.md"));
    assert.ok(fs.lstatSync(body.latestPath).isSymbolicLink());
    const body2 = fs.readFileSync(body.archivePath, "utf8");
    assert.ok(body2.includes("M1"));
    const archive = JSON.parse(fs.readFileSync(body.archiveJsonPath, "utf8"));
    assert.equal(archive.project, "rt-arch");
    assert.deepEqual(archive.state.done, ["M1"]);
    assert.equal(archive.restore.commands[0], "node .agent/skills/runtime-continuity/scripts/index.js resume-bundle --project rt-arch");
  } finally {
    rmContexts("rt-arch");
  }
});

test("archive appends session_archived event to active run", () => {
  const cwd = fixture();
  rmContexts("rt-arch-evt");
  try {
    run(cwd, ["archive", "--project", "rt-arch-evt", "--gate", "user"]);
    const evs = readRunEvents(cwd);
    const last = evs[evs.length - 1];
    assert.equal(last.type, "session_archived");
    assert.equal(last.project, "rt-arch-evt");
    assert.ok(last.archive_path.includes("/rt-arch-evt/"));
  } finally {
    rmContexts("rt-arch-evt");
  }
});

test("archive without --gate fails", () => {
  const cwd = fixture();
  rmContexts("rt-arch-gate");
  try {
    const r = run(cwd, ["archive", "--project", "rt-arch-gate"]);
    assert.equal(JSON.parse(r.stdout).error, "workflow_gate_required");
  } finally {
    rmContexts("rt-arch-gate");
  }
});

// ─── mode 3: restore ─────────────────────────────────────────────────────────

test("restore --list enumerates archived contexts", () => {
  const cwd = fixture();
  rmContexts("rt-res-list");
  try {
    run(cwd, ["archive", "--project", "rt-res-list", "--gate", "user"]);
    run(cwd, ["archive", "--project", "rt-res-list", "--gate", "user"]);
    const r = run(cwd, ["restore", "--project", "rt-res-list", "--list"]);
    const body = JSON.parse(r.stdout);
    assert.ok(Array.isArray(body.contexts));
    assert.ok(body.contexts.length >= 2, `expected ≥ 2 archives, got ${body.contexts.length}`);
  } finally {
    rmContexts("rt-res-list");
  }
});

test("restore returns body containing note marker", () => {
  const cwd = fixture();
  rmContexts("rt-res-load");
  rmRuntime(cwd);
  try {
    run(cwd, ["archive", "--project", "rt-res-load", "--gate", "user",
      "--note-json", JSON.stringify({ done: "DONE-MARKER", blocked: "", next: "", pitfalls: "" })]);
    const r = run(cwd, ["restore", "--project", "rt-res-load", "--gate", "user"]);
    const body = JSON.parse(r.stdout);
    assert.ok(body.path.endsWith("latest.md"));
    assert.ok(body.body.includes("DONE-MARKER"));
  } finally {
    rmContexts("rt-res-load");
  }
});

// ─── Runtime Continuity v2 ───────────────────────────────────────────────────

test("log writes transferable runtime event and appends run event", () => {
  const cwd = fixture();
  rmRuntime(cwd);
  const r = run(cwd, [
    "log", "--project", "rt-v2-log", "--gate", "agent",
    "--host", "codex", "--message", "implemented v2 log",
    "--done", "schema", "--in-progress", "cli", "--next", "tests",
    "--files", "a.js,b.js",
  ]);
  assert.equal(r.status, 0, r.stderr);
  const body = JSON.parse(r.stdout);
  assert.equal(body.action, "log");
  assert.equal(body.event.host, "codex");
  assert.equal(body.event.summary.done[0], "schema");
  assert.deepEqual(body.event.refs.files, ["a.js", "b.js"]);
  assert.ok(fs.existsSync(body.event_path));
  const last = readRunEvents(cwd).at(-1);
  assert.equal(last.type, "runtime_log");
});

test("checkpoint records command evidence", () => {
  const cwd = fixture();
  rmRuntime(cwd);
  const r = run(cwd, [
    "checkpoint", "--project", "rt-v2-cp", "--gate", "agent",
    "--host", "codex", "--phase", "validating", "--message", "tests passed",
    "--command", "node tests/runtime-continuity.test.js", "--exit-code", "0",
    "--command-summary", "passed",
  ]);
  assert.equal(r.status, 0, r.stderr);
  const body = JSON.parse(r.stdout);
  assert.equal(body.event.type, "checkpoint");
  assert.equal(body.event.refs.commands[0].exit_code, 0);
  const last = readRunEvents(cwd).at(-1);
  assert.equal(last.type, "runtime_checkpoint");
});

test("restore --auto returns latest structured archive without gate", () => {
  const cwd = fixture();
  rmContexts("rt-v2-auto");
  rmRuntime(cwd);
  try {
    run(cwd, ["archive", "--project", "rt-v2-auto", "--gate", "user", "--full",
      "--note-json", JSON.stringify({ done: ["D1"], in_progress: "I1", next: ["N1"] })]);
    const r = run(cwd, ["restore", "--project", "rt-v2-auto", "--auto"]);
    assert.equal(r.status, 0, r.stderr);
    const body = JSON.parse(r.stdout);
    assert.equal(body.mode, "auto");
    assert.equal(body.archive.project, "rt-v2-auto");
    assert.equal(body.archive.state.next[0], "N1");
  } finally {
    rmContexts("rt-v2-auto");
  }
});

test("resume-bundle summarizes archive, runs, sessions, events, and git", () => {
  const cwd = fixture();
  rmContexts("rt-v2-bundle");
  rmRuntime(cwd);
  try {
    run(cwd, ["log", "--project", "rt-v2-bundle", "--gate", "agent", "--message", "log1"]);
    run(cwd, ["archive", "--project", "rt-v2-bundle", "--gate", "user", "--full",
      "--note-json", JSON.stringify({ done: ["D1"], in_progress: "I1", next: ["N1"] })]);
    const r = run(cwd, ["resume-bundle", "--project", "rt-v2-bundle"]);
    assert.equal(r.status, 0, r.stderr);
    const body = JSON.parse(r.stdout);
    assert.equal(body.action, "resume-bundle");
    assert.ok(body.latest_archive.endsWith("latest.json") || body.latest_archive.includes("RC-"));
    assert.ok(body.runtime_events.length >= 1);
    assert.ok(body.runs.some((file) => file.includes("R-rt-test-001.json")));
    assert.equal(body.next_action, "N1");
  } finally {
    rmContexts("rt-v2-bundle");
  }
});

// ─── mode 3: status ──────────────────────────────────────────────────────────

test("status returns age_hours after an archive", () => {
  const cwd = fixture();
  rmContexts("rt-stat");
  try {
    run(cwd, ["archive", "--project", "rt-stat", "--gate", "user"]);
    const r = run(cwd, ["status", "--project", "rt-stat"]);
    const body = JSON.parse(r.stdout);
    assert.equal(body.action, "status");
    assert.ok(body.age_hours != null);
    assert.ok(["archive_now", "ok"].includes(body.stale_recommendation));
  } finally {
    rmContexts("rt-stat");
  }
});

test("status on missing project is ok + exists:false", () => {
  const cwd = fixture();
  rmContexts("rt-stat-missing");
  const r = run(cwd, ["status", "--project", "rt-stat-missing"]);
  const body = JSON.parse(r.stdout);
  assert.equal(body.exists, false);
});

// ─── dispatch errors ─────────────────────────────────────────────────────────

test("unknown mode fails with unknown_command when project is present", () => {
  const cwd = fixture();
  const r = run(cwd, ["definitely-not-a-real-mode", "--project", "x", "--gate", "user"]);
  assert.equal(JSON.parse(r.stdout).error, "unknown_command");
});

test("archive without --project fails with missing_project", () => {
  const cwd = fixture();
  const r = run(cwd, ["archive", "--gate", "user"]);
  assert.equal(JSON.parse(r.stdout).error, "missing_project");
});

// ─── mode 6: host-switch (Phase 2) ──────────────────────────────────────────

test("host-switch: archives + writes session last_host + run event", () => {
  const cwd = fixture();
  rmContexts("hs");
  try {
    const r = run(cwd, [
      "host-switch", "--project", "hs",
      "--from-host", "claude-code", "--to-host", "codex",
      "--reason", "user wants codex", "--gate", "user",
      "--note-json", JSON.stringify({ done: "M-1", blocked: "", next: "M-2", pitfalls: "" }),
    ]);
    assert.equal(r.status, 0, r.stderr);
    const body = JSON.parse(r.stdout);
    assert.equal(body.action, "host-switch");
    assert.equal(body.from_host, "claude-code");
    assert.equal(body.to_host, "codex");
    assert.ok(body.archive.archivePath.includes("/hs/"));
    assert.ok(Array.isArray(body.next_steps_for_new_host));
    assert.equal(body.next_steps_for_new_host.length, 4);
    // session JSON was written
    const sessionsDir = path.join(cwd, ".agent", "sessions");
    const files = fs.readdirSync(sessionsDir);
    const sFile = files.find((n) => n.startsWith("S-hs-") && n.endsWith(".json"));
    assert.ok(sFile, "expected S-hs-*.json in sessions/");
    const session = JSON.parse(fs.readFileSync(path.join(sessionsDir, sFile), "utf8"));
    assert.equal(session.last_host, "codex");
    // run event appended
    const evs = readRunEvents(cwd);
    const last = evs[evs.length - 1];
    assert.equal(last.type, "host_switch_initiated");
    assert.equal(last.from_host, "claude-code");
    assert.equal(last.to_host, "codex");
  } finally {
    rmContexts("hs");
  }
});

test("host-switch without --gate fails", () => {
  const cwd = fixture();
  rmContexts("hs2");
  try {
    const r = run(cwd, ["host-switch", "--project", "hs2", "--from-host", "a", "--to-host", "b"]);
    assert.equal(JSON.parse(r.stdout).error, "workflow_gate_required");
  } finally {
    rmContexts("hs2");
  }
});

// ─── mode 7: list-contexts (Phase 2 / 3 prep) ───────────────────────────

test("list-contexts: empty home dir returns count:0", () => {
  const cwd = fixture();
  // ensure no contexts leak from prior runs
  // (cannot easily clean all of ~/.agent/contexts, so just count)
  const r = run(cwd, ["list-contexts"]);
  assert.equal(r.status, 0);
  const body = JSON.parse(r.stdout);
  assert.equal(body.action, "list-contexts");
  assert.ok(body.count >= 0);
  assert.ok(Array.isArray(body.projects));
});

test("list-contexts: includes the project we just archived", () => {
  const cwd = fixture();
  rmContexts("lc");
  try {
    run(cwd, ["archive", "--project", "lc", "--gate", "user", "--note-json", JSON.stringify({ done: "x", blocked: "", next: "", pitfalls: "" })]);
    const r = run(cwd, ["list-contexts"]);
    const body = JSON.parse(r.stdout);
    const found = body.projects.find((p) => p.project === "lc");
    assert.ok(found, "expected lc project in list-contexts");
    assert.ok(found.total_archives >= 1);
  } finally {
    rmContexts("lc");
  }
});

test("list-contexts --format=table: includes the table string", () => {
  const cwd = fixture();
  rmContexts("lct");
  try {
    run(cwd, ["archive", "--project", "lct", "--gate", "user", "--note-json", JSON.stringify({ done: "x", blocked: "", next: "", pitfalls: "" })]);
    const r = run(cwd, ["list-contexts", "--format", "table"]);
    const body = JSON.parse(r.stdout);
    assert.equal(body.format, "table");
    assert.ok(body.table.includes("lct"));
    assert.ok(body.table.startsWith("project\tarchives"));
  } finally {
    rmContexts("lct");
  }
});

test("list-contexts --since filters by mtime", () => {
  const cwd = fixture();
  rmContexts("lcs");
  try {
    // An archive "from 1 day ago" via setting mtime
    const dir = path.join(os.homedir(), ".agent", "contexts", "lcs");
    fs.mkdirSync(dir, { recursive: true });
    const f = path.join(dir, "ctx_old.md");
    fs.writeFileSync(f, "old");
    const past = Date.now() - 48 * 60 * 60 * 1000;
    fs.utimesSync(f, past / 1000, past / 1000);
    // New archive "now"
    run(cwd, ["archive", "--project", "lcs", "--gate", "user", "--note-json", JSON.stringify({ done: "", blocked: "", next: "", pitfalls: "" })]);
    const r = run(cwd, ["list-contexts", "--since", new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()]);
    const body = JSON.parse(r.stdout);
    const found = body.projects.find((p) => p.project === "lcs");
    assert.ok(found, "lcs should be in list-contexts");
    assert.equal(found.recent_archives, 1, "only the new archive should match the --since filter");
    assert.equal(found.total_archives, 2, "but total_archives still counts both");
  } finally {
    rmContexts("lcs");
  }
});
