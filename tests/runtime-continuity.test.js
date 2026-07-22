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
const SKILL = path.join(ROOT, "templates", "en", ".agent", "skills", "runtime-continuity", "scripts", "index.js");

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

// ─── mode 2: archive ──────────────────────────────────────────────────────────

test("archive writes ctx_<ts>.md and symlinks latest.md", () => {
  const cwd = fixture();
  rmContexts("rt-arch");
  try {
    const r = run(cwd, ["archive", "--project", "rt-arch", "--gate", "user",
      "--note-json", JSON.stringify({ done: "M1", blocked: "", next: "M2", pitfalls: "" })]);
    assert.equal(r.status, 0, r.stderr);
    const body = JSON.parse(r.stdout);
    assert.ok(body.archivePath.includes("/rt-arch/"));
    assert.ok(fs.existsSync(body.archivePath));
    assert.ok(body.latestPath.endsWith("latest.md"));
    assert.ok(fs.lstatSync(body.latestPath).isSymbolicLink());
    const body2 = fs.readFileSync(body.archivePath, "utf8");
    assert.ok(body2.includes("M1"));
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
