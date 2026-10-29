"use strict";

// ─── `runtime-continuity status` must not mutate ─────────────────────────────
//
// `status` is documented and used as a *query*: it reports how stale the
// latest archive is so a caller can decide whether to archive. It used to
// append a `session_status_queried` run event unconditionally, which meant
// every read rewrote `runs/<active-run>.json`:
//
//   * the run record's mtime moved, so any staleness check that looks at the
//     run file saw a mutation it never asked for;
//   * `last_event` became the status query, so the audit trail attributed a
//     read to the run as if it were an action.
//
// A query that rewrites state is not a query. The read is now pure, and a
// caller that genuinely wants the read audited asks for it explicitly with
// `--audit`.
//
// HOME is redirected into a tmpdir for every spawn so the suite never writes
// to the developer's real ~/.agent/contexts/.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { test, before, after } = require("node:test");

const repoRoot = path.resolve(__dirname, "..", "..");
const skillScript = path.join(
  repoRoot,
  "templates",
  "_shared",
  ".agent",
  "skills",
  "runtime-continuity",
  "scripts",
  "index.js",
);

let home;

function makeProject(name) {
  const root = path.join(home, name);
  fs.mkdirSync(root, { recursive: true });
  spawnSync("git", ["init", "-q"], { cwd: root });
  spawnSync("git", ["config", "user.email", "rc-status@test"], { cwd: root });
  spawnSync("git", ["config", "user.name", "rc-status"], { cwd: root });
  fs.writeFileSync(path.join(root, "README.md"), "# rc-status fixture\n");
  spawnSync("git", ["add", "."], { cwd: root });
  spawnSync("git", ["commit", "-q", "-m", "init"], { cwd: root });

  // A stub active run gives appendRunEvent() a target. Without one the
  // append is a silent no-op and the test would pass for the wrong reason.
  const runsDir = path.join(root, ".agent", "runs");
  fs.mkdirSync(runsDir, { recursive: true });
  fs.writeFileSync(
    path.join(runsDir, "R-status-1.json"),
    JSON.stringify({
      run_id: "R-status-1",
      status: "running",
      events: [],
      updated_at: "2026-10-29T00:00:00.000Z",
    }, null, 2) + "\n",
  );

  // An archive for the project, so `status` has something to report.
  const ctxDir = path.join(root, ".fakehome", ".agent", "contexts", name);
  fs.mkdirSync(ctxDir, { recursive: true });
  fs.writeFileSync(path.join(ctxDir, "ctx_20260101_000000.md"), "# ctx\n");
  return root;
}

function runScript(project, args) {
  return spawnSync(process.execPath, [skillScript, ...args], {
    cwd: project,
    env: { ...process.env, HOME: path.join(project, ".fakehome") },
    encoding: "utf8",
  });
}

function runFile(project) {
  const file = path.join(project, ".agent", "runs", "R-status-1.json");
  return { file, raw: fs.readFileSync(file, "utf8"), stat: fs.statSync(file) };
}

before(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-rc-status-"));
});

after(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

test("status does not mutate the active run record", () => {
  const project = makeProject("ro-project");
  const before = runFile(project);

  const result = runScript(project, ["status", "--project", "ro-project"]);
  assert.strictEqual(result.status, 0, result.stderr);
  const out = JSON.parse(result.stdout);
  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.action, "status");
  assert.strictEqual(out.exists, true);

  const after = runFile(project);
  assert.strictEqual(after.raw, before.raw, "status rewrote the run record");
  assert.strictEqual(
    after.stat.mtimeMs,
    before.stat.mtimeMs,
    "status changed the run record mtime",
  );
});

test("status --audit records the query in the run event trail", () => {
  const project = makeProject("audit-project");
  const before = runFile(project);

  const result = runScript(project, ["status", "--project", "audit-project", "--audit"]);
  assert.strictEqual(result.status, 0, result.stderr);
  const out = JSON.parse(result.stdout);
  assert.strictEqual(out.ok, true);

  const after = runFile(project);
  assert.notStrictEqual(after.raw, before.raw, "status --audit wrote nothing");
  const run = JSON.parse(after.raw);
  const queried = run.events.filter((e) => e && e.type === "session_status_queried");
  assert.strictEqual(queried.length, 1, "expected exactly one session_status_queried event");
  assert.strictEqual(queried[0].project, "audit-project");
  assert.strictEqual(run.last_event.type, "session_status_queried");
});

test("repeated status calls leave the run record byte-identical", () => {
  const project = makeProject("repeat-project");
  runScript(project, ["status", "--project", "repeat-project"]);
  const first = runFile(project).raw;
  runScript(project, ["status", "--project", "repeat-project"]);
  const second = runFile(project).raw;
  assert.strictEqual(second, first, "a second status call changed the run record");
});
