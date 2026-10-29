"use strict";

// ─── Distributed evolution-pipeline: the proposal-only path writes nothing ───
//
// The distributed `evolution-pipeline` skill carries logic that the older
// language-layer copies did not have: an `archive_learning_proposal` intake
// that never touches memory, an index, a Task, or any execution permission,
// and a `--dry-run` mode that previews without writing.
//
// That logic is what the runtime-continuity guard calls when it is asked to
// queue a learning proposal, so it has to hold on the *distributed* copy —
// the file a downstream project actually runs. The governance-repo copy has
// its own test suite; this one pins the shipped surface.
//
// Both behaviours are pinned by asserting on the filesystem, not on a
// mocked spy: the point of the feature is that nothing is written.

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const SCRIPT = path.join(
  REPO_ROOT,
  "templates",
  "_shared",
  ".agent",
  "skills",
  "evolution-pipeline",
  "scripts",
  "evolve.js",
);

const ARCHIVE_ID = "RC-20261029_DIST_ACCEPT";
const PROJECT = "dist-acceptance";

// A snapshot of every file below a directory: path, kind, mode, mtime and
// content hash. Any write — a new file, a rewritten file, a touched mtime —
// shows up as a difference.
function snapshot(root) {
  const rows = [];
  function visit(file, rel) {
    const stat = fs.lstatSync(file, { bigint: true });
    const row = {
      path: rel || ".",
      kind: stat.isDirectory() ? "dir" : stat.isFile() ? "file" : "other",
      mode: String(stat.mode),
      mtimeNs: String(stat.mtimeNs),
    };
    if (stat.isFile()) {
      const data = fs.readFileSync(file);
      row.sha256 = crypto.createHash("sha256").update(data).digest("hex");
      row.size = data.length;
    }
    rows.push(row);
    if (stat.isDirectory()) {
      for (const child of fs.readdirSync(file).sort()) {
        visit(path.join(file, child), path.join(rel, child));
      }
    }
  }
  visit(root, "");
  return rows;
}

function fixture(t) {
  // The script derives its root from the working directory and resolves that
  // root through realpathSync() when it computes the workspace identity. On
  // macOS the temp directory sits behind a symlink (/var → /private/var), so
  // the fixture root has to be the resolved path or the workspace identity
  // and the archive-path check disagree about where the project is.
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "cortex-evolve-dist-")),
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const archives = path.join(root, ".agent", "runtime-continuity", "archives");
  const tasks = path.join(root, ".agent", "tasks", "evolution");
  fs.mkdirSync(archives, { recursive: true });
  fs.mkdirSync(tasks, { recursive: true });
  const archive = path.join(archives, `${ARCHIVE_ID}.json`);
  fs.writeFileSync(archive, JSON.stringify({
    archive_id: ARCHIVE_ID,
    project: PROJECT,
    created_at: "2026-10-29T06:00:00.000Z",
    state: {
      done: ["Completed fixture"],
      next: ["Next action"],
      blockers: ["Fixture blocker"],
    },
  }, null, 2) + "\n");
  fs.writeFileSync(
    path.join(archives, "latest.json"),
    JSON.stringify({ archive_id: ARCHIVE_ID }, null, 2) + "\n",
  );
  return { root, archives, tasks, archive };
}

function run(root, ...args) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: root,
    encoding: "utf8",
    timeout: 10000,
  });
}

test("the distributed evolve.js is present and is the governance copy", () => {
  assert.ok(fs.existsSync(SCRIPT), "the distributed evolve.js must exist");
  const shipped = fs.readFileSync(SCRIPT);
  const governance = fs.readFileSync(path.join(
    REPO_ROOT, ".agent", "skills", "evolution-pipeline", "scripts", "evolve.js",
  ));
  assert.ok(shipped.equals(governance),
    "the distributed evolve.js must be byte-identical to the governance copy");
});

test("a proposal-only enqueue writes no task, no memory and no index", (t) => {
  const { root, archives, archive } = fixture(t);
  const before = snapshot(root);

  const result = run(root, "--enqueue", "--proposal-only", "--project", PROJECT,
    "--archive", archive);
  assert.strictEqual(result.status, 0, result.stderr);

  const out = JSON.parse(result.stdout);
  assert.strictEqual(out.enqueued, 1);
  assert.strictEqual(out.tasks.length, 1);
  assert.match(out.tasks[0], /^EVO-P-[0-9a-f]{64}$/);

  // The proposal task itself is the one thing this command is allowed to
  // create. Nothing else may appear.
  const after = snapshot(root);
  const added = after.filter((row) => !before.some((old) => old.path === row.path));
  const proposals = added.filter((row) =>
    row.path.includes(path.join("tasks", "evolution"))
    && row.kind === "file"
    && row.path.endsWith(".json"));
  assert.strictEqual(proposals.length, 1,
    `exactly one proposal task may be created, got ${JSON.stringify(added.map((r) => r.path))}`);
  // No memory, no index, no run record.
  const forbidden = added.filter((row) =>
    row.path.includes(path.join(".agent", "memory"))
    || row.path.includes(path.join(".agent", "index"))
    || row.path.includes(path.join(".agent", "runs")));
  assert.deepStrictEqual(forbidden, [],
    `a proposal-only enqueue may not write memory, an index or a run: ${JSON.stringify(forbidden)}`);
});

test("a proposal-only enqueue is idempotent", (t) => {
  const { root, archive } = fixture(t);
  const first = run(root, "--enqueue", "--proposal-only", "--project", PROJECT,
    "--archive", archive);
  assert.strictEqual(first.status, 0, first.stderr);
  const afterFirst = snapshot(root);

  const second = run(root, "--enqueue", "--proposal-only", "--project", PROJECT,
    "--archive", archive);
  assert.strictEqual(second.status, 0, second.stderr);
  const secondOut = JSON.parse(second.stdout);
  const firstOut = JSON.parse(first.stdout);
  assert.deepStrictEqual(secondOut.tasks, firstOut.tasks);
  assert.strictEqual(secondOut.enqueued, 0);
  assert.strictEqual(secondOut.deduplicated, 1);
  assert.deepStrictEqual(snapshot(root), afterFirst,
    "a duplicate proposal enqueue must not change any file");
});

test("a dry-run enqueue writes nothing at all", (t) => {
  const { root, archive } = fixture(t);
  const before = snapshot(root);

  const result = run(root, "--enqueue", "--dry-run", "--proposal-only",
    "--project", PROJECT,
    "--archive", archive);
  assert.strictEqual(result.status, 0, result.stderr);
  const out = JSON.parse(result.stdout);
  assert.strictEqual(out.dry_run, true);
  assert.strictEqual(out.enqueued, 0);
  assert.strictEqual(out.previews.length, 1);
  assert.strictEqual(out.previews[0].task_id, null);
  assert.strictEqual(out.previews[0].would_enqueue, true);
  // A proposal preview declares its own lack of authority, exactly like the
  // proposal it would have become.
  assert.strictEqual(out.previews[0].execution_authorized, false);
  assert.deepStrictEqual(out.previews[0].allowed_effects, []);

  assert.deepStrictEqual(snapshot(root), before,
    "a dry-run must not change a single file");
});

test("a proposal-only enqueue refuses an archive from another project", (t) => {
  const { root, archive } = fixture(t);
  const before = snapshot(root);

  const result = run(root, "--enqueue", "--proposal-only", "--project", "other-project",
    "--archive", archive);
  assert.notStrictEqual(result.status, 0, "a mismatched project must be refused");
  assert.match(result.stdout + result.stderr, /ERR_PROPOSAL_PROJECT_MISMATCH/);
  assert.deepStrictEqual(snapshot(root), before,
    "a refused enqueue must not change a single file");
});

test("a proposal-only enqueue refuses an archive outside the archive directory", (t) => {
  const { root } = fixture(t);
  const before = snapshot(root);
  const outside = path.join(root, "elsewhere.json");
  fs.writeFileSync(outside, JSON.stringify({
    archive_id: ARCHIVE_ID,
    project: PROJECT,
    created_at: "2026-10-29T06:00:00.000Z",
    state: {},
  }));
  const baseline = snapshot(root);

  const result = run(root, "--enqueue", "--proposal-only", "--project", PROJECT,
    "--archive", outside);
  assert.notStrictEqual(result.status, 0, "an archive outside the directory must be refused");
  assert.match(result.stdout + result.stderr, /ERR_PROPOSAL_ARCHIVE_PATH/);
  assert.deepStrictEqual(snapshot(root), baseline,
    "a refused enqueue must not change a single file");
});

test("processing a proposal produces a proposal record and nothing else", (t) => {
  const { root, archive } = fixture(t);
  const enqueue = run(root, "--enqueue", "--proposal-only", "--project", PROJECT,
    "--archive", archive);
  assert.strictEqual(enqueue.status, 0, enqueue.stderr);
  const taskId = JSON.parse(enqueue.stdout).tasks[0];

  const before = snapshot(root);
  const result = run(root, "--worker", "--once", "--proposal-only", "--project", PROJECT);
  assert.strictEqual(result.status, 0, result.stderr);

  const after = snapshot(root);
  const added = after.filter((row) => !before.some((old) => old.path === row.path));
  const addedFiles = added.filter((row) => row.kind === "file");
  assert.strictEqual(addedFiles.length, 1,
    `processing a proposal may add exactly the proposal record, got ${JSON.stringify(addedFiles.map((r) => r.path))}`);
  assert.ok(addedFiles[0].path.includes("_proposals"));
  assert.ok(addedFiles[0].path.endsWith(`${taskId}.json`));
  // The proposal directory itself is the only other addition — a proposal
  // may not create a task, a memory file, an index or a run record.
  const addedDirs = added.filter((row) => row.kind === "dir");
  assert.deepStrictEqual(addedDirs.map((row) => row.path), [
    path.join(".agent", "tasks", "evolution", "_proposals"),
  ]);
});

test("the proposal record grants no execution permission", (t) => {
  const { root, archive } = fixture(t);
  const enqueue = run(root, "--enqueue", "--proposal-only", "--project", PROJECT,
    "--archive", archive);
  assert.strictEqual(enqueue.status, 0, enqueue.stderr);
  const taskId = JSON.parse(enqueue.stdout).tasks[0];
  run(root, "--worker", "--once", "--proposal-only", "--project", PROJECT);

  const file = path.join(root, ".agent", "tasks", "evolution", "_proposals", `${taskId}.json`);
  const proposal = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.strictEqual(proposal.execution_authorized, false);
  assert.deepStrictEqual(proposal.allowed_effects, []);
  assert.strictEqual(proposal.status, "proposal_only");
  assert.strictEqual(proposal.verification_status, "not_run");
  assert.ok(Array.isArray(proposal.limitations) && proposal.limitations.length > 0);
});
