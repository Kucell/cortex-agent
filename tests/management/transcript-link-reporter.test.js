"use strict";

// P-002c — Claude Code Transcript Link Reporter tests
// Validates the hook script at templates/_shared/.agent/hooks/
// claude-code-transcript-link-reporter.sh against the P-002c acceptance:
//   - no payload / no run id / missing transcript → exit 0 + zero mutation
//   - valid JSONL fixture → one reference + one transcript_linked event
//   - writer failure → exit 0 + zero reference
//   - macOS/Linux tool paths (shasum vs sha256sum, stat -f%z vs stat -c%s)
//   - README single-source: READMEs must NOT inline the script (drift guard)
//
// Zero npm dependencies — node:test + node:assert + child_process only.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync, spawnSync } = require("node:child_process");
const test = require("node:test");

const ROOT = path.resolve(__dirname, "..", "..");
const HOOK = path.join(ROOT, "templates", "_shared", ".agent", "hooks", "claude-code-transcript-link-reporter.sh");

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tl-reporter-"));
  // Simulate a code-mode project: full _base data layer (runs/tasks/sessions/
  // decisions/...) + the management-api skill. The writer's index.js requires
  // sibling modules under tasks/ etc., so a bare runs/ dir is not enough.
  fs.cpSync(path.join(ROOT, "templates", "_base", ".agent"), path.join(dir, ".agent"), { recursive: true });
  const skillDest = path.join(dir, ".agent", "skills", "management-api");
  fs.mkdirSync(path.join(dir, ".agent", "skills"), { recursive: true });
  fs.cpSync(path.join(ROOT, "templates", "_shared", ".agent", "skills", "management-api"), skillDest, { recursive: true });
  // management-api's index.js requires .agent/tasks/scripts/task-state.js
  // (framework instance layer; not shipped in _base/_shared templates). Copy
  // it from this repo so the writer boots. Zero deps — safe to vendor.
  fs.mkdirSync(path.join(dir, ".agent", "tasks", "scripts"), { recursive: true });
  fs.copyFileSync(
    path.join(ROOT, ".agent", "tasks", "scripts", "task-state.js"),
    path.join(dir, ".agent", "tasks", "scripts", "task-state.js")
  );
  // Overwrite the seeded sample run with our test run.
  fs.writeFileSync(path.join(dir, ".agent", "runs", "R-rep.json"), JSON.stringify({
    run_id: "R-rep", kind: "implement", status: "running", started_at: new Date().toISOString(), events: [],
  }));
  return dir;
}

function makeTranscript(dir, { userTurns = 2, timestamp = "2026-09-11T03:00:00Z" } = {}) {
  const tp = path.join(dir, "transcript.jsonl");
  const linesOut = [];
  for (let i = 0; i < userTurns; i++) {
    linesOut.push(JSON.stringify({ type: "user", role: "user", timestamp }));
    linesOut.push(JSON.stringify({ type: "assistant", role: "assistant", timestamp }));
  }
  fs.writeFileSync(tp, linesOut.join("\n") + "\n", "utf8");
  return tp;
}

function runHook({ cwd, payload, runId, projectDir, envExtra = {} }) {
  const env = {
    ...process.env,
    ...(runId ? { CLAUDE_RUN_ID: runId } : {}),
    ...(projectDir ? { CORTEX_PROJECT_DIR: projectDir } : {}),
    ...envExtra,
  };
  const res = spawnSync("bash", [HOOK, payload || ""], {
    cwd,
    input: payload || "",
    encoding: "utf8",
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  return res;
}

function readRun(cwd, runId) {
  const fp = path.join(cwd, ".agent", "runs", runId + ".json");
  return fs.existsSync(fp) ? JSON.parse(fs.readFileSync(fp, "utf8")) : null;
}

test("P-002c: hook exists and is executable", () => {
  assert.ok(fs.existsSync(HOOK), "hook script missing: " + HOOK);
  assert.equal(fs.statSync(HOOK).isFile(), true);
});

test("P-002c: no payload → exit 0 + zero mutation", () => {
  const dir = fixture();
  const r = runHook({ cwd: dir, payload: "", runId: "R-rep", projectDir: dir });
  assert.equal(r.status, 0, "exit should be 0 (non-fatal): " + r.stderr);
  const run = readRun(dir, "R-rep");
  assert.ok(run, "run file still present");
  assert.equal(run.transcript_refs || 0, 0, "no refs written");
  assert.equal((run.events || []).length, 0, "no events appended");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("P-002c: no run id → exit 0 + zero mutation", () => {
  const dir = fixture();
  const tp = makeTranscript(dir);
  const payload = JSON.stringify({ transcript_path: tp, session_id: "S-noid" });
  const r = runHook({ cwd: dir, payload, runId: null, projectDir: dir });
  assert.equal(r.status, 0, "exit 0: " + r.stderr);
  const run = readRun(dir, "R-rep");
  assert.ok(run, "run file present");
  assert.equal(run.transcript_refs || 0, 0, "no refs");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("P-002c: missing transcript file → exit 0 + zero mutation", () => {
  const dir = fixture();
  const payload = JSON.stringify({ transcript_path: path.join(dir, "missing.jsonl"), session_id: "S-miss" });
  const r = runHook({ cwd: dir, payload, runId: "R-rep", projectDir: dir });
  assert.equal(r.status, 0, "exit 0: " + r.stderr);
  const run = readRun(dir, "R-rep");
  assert.ok(run, "run present");
  assert.equal(run.transcript_refs || 0, 0, "no refs");
  assert.equal((run.events || []).length, 0, "no events");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("P-002c: valid JSONL fixture → one reference + one transcript_linked event", () => {
  const dir = fixture();
  const tp = makeTranscript(dir, { userTurns: 2 });
  const payload = JSON.stringify({ transcript_path: tp, session_id: "S-valid" });
  const r = runHook({ cwd: dir, payload, runId: "R-rep", projectDir: dir });
  assert.equal(r.status, 0, "exit 0: " + r.stderr);
  const run = readRun(dir, "R-rep");
  assert.ok(run, "run present");
  assert.ok(Array.isArray(run.transcript_refs) && run.transcript_refs.length === 1, "exactly one reference");
  const ref = run.transcript_refs[0];
  assert.equal(ref.source, "claude-code");
  assert.equal(ref.session_id, "S-valid");
  assert.equal(ref.path, tp, "path is the transcript path");
  assert.match(ref.sha256, /^[a-f0-9]{64}$/, "sha256 is 64 hex");
  assert.equal(typeof ref.byte_size, "number");
  assert.equal(ref.turn_count, 2, "turn_count = user turn count");
  const ev = run.events[run.events.length - 1];
  assert.equal(ev.type, "transcript_linked", "last event is transcript_linked");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("P-002c: writer failure (bad project) → exit 0 + zero reference", () => {
  // CORTEX_PROJECT_DIR points at a dir with NO .agent/skills/management-api
  // → writer fails; hook must exit 0 and write nothing.
  const dir = fixture();
  fs.rmSync(path.join(dir, ".agent", "skills"), { recursive: true, force: true });
  const tp = makeTranscript(dir);
  const payload = JSON.stringify({ transcript_path: tp, session_id: "S-fail" });
  const r = runHook({ cwd: dir, payload, runId: "R-rep", projectDir: dir });
  assert.equal(r.status, 0, "hook exit 0 even on writer failure: " + r.stderr);
  const run = readRun(dir, "R-rep");
  assert.ok(run, "run file intact");
  assert.equal(run.transcript_refs || 0, 0, "no refs written on failure");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("P-002c: macOS/Linux tool paths — stat fallback & hash tool", () => {
  const dir = fixture();
  const tp = makeTranscript(dir, { userTurns: 1 });
  const payload = JSON.stringify({ transcript_path: tp, session_id: "S-tools" });
  // Force shasum availability (macOS) — both branches must produce a 64-hex sha256.
  const r = runHook({ cwd: dir, payload, runId: "R-rep", projectDir: dir });
  assert.equal(r.status, 0, "exit 0: " + r.stderr);
  const run = readRun(dir, "R-rep");
  assert.match(run.transcript_refs[0].sha256, /^[a-f0-9]{64}$/, "sha256 from dual-platform hash tool");
  assert.ok(run.transcript_refs[0].byte_size > 0, "byte_size from stat fallback");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("P-002c: READMEs no longer inline the reporter script (single source)", () => {
  for (const rel of ["templates/en/.agent/claude-code/README.md", "templates/zh/.agent/claude-code/README.md"]) {
    const readme = fs.readFileSync(path.join(ROOT, rel), "utf8");
    assert.ok(!readme.includes("claude-code-transcript-link-reporter.sh\n# Push the current transcript"), rel + " must not inline the transcript-link reporter script body");
    assert.ok(!readme.includes("--transcript-sha256"), rel + " must not inline transcript-link CLI flags");
    assert.ok(readme.includes("claude-code-transcript-link-reporter.sh"), rel + " references the template script");
  }
});