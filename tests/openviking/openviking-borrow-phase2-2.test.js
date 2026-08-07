"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const test = require("node:test");

const ROOT = path.resolve(__dirname, "..", "..");
const EVOLVE = path.join(ROOT, ".agent", "skills", "evolution-pipeline", "scripts", "evolve.js");
const TASKS_DIR = path.join(ROOT, ".agent", "tasks", "evolution");
const DEAD_DIR = path.join(TASKS_DIR, "_dead");
const MEMORY_DIR = path.join(ROOT, ".agent", "memory");

function run(script, args = []) {
  return JSON.parse(execFileSync(process.execPath, [script, ...args], { encoding: "utf8", cwd: ROOT }));
}

function cleanup() {
  for (const dir of [TASKS_DIR, DEAD_DIR]) {
    if (fs.existsSync(dir)) {
      for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".json"))) {
        fs.unlinkSync(path.join(dir, f));
      }
    }
  }
  for (const scope of ["feedback", "project"]) {
    const d = path.join(MEMORY_DIR, scope);
    if (fs.existsSync(d)) {
      for (const f of fs.readdirSync(d).filter((x) => x.includes("rc-") || x.includes("EVO"))) {
        fs.unlinkSync(path.join(d, f));
      }
    }
  }
}

test.beforeEach(() => cleanup());
test.afterEach(() => cleanup());

test("schema file exists and is valid JSON", () => {
  const schema = path.join(ROOT, ".agent", "skills", "evolution-pipeline", "evolution-task.schema.json");
  assert.ok(fs.existsSync(schema));
  const parsed = JSON.parse(fs.readFileSync(schema, "utf8"));
  assert.equal(parsed.title, "Evolution Task");
});

test("--status reports empty queue on first run", () => {
  const r = run(EVOLVE, ["--status"]);
  assert.equal(r.ok, true);
  assert.equal(r.total, 0);
  assert.equal(r.dead_letter, 0);
});

test("--enqueue-from-latest creates EVO task", () => {
  const r = run(EVOLVE, ["--enqueue-from-latest"]);
  assert.equal(r.ok, true);
  assert.equal(r.enqueued, 1);
  assert.ok(r.tasks[0].startsWith("EVO-"));
  const taskFile = path.join(TASKS_DIR, `${r.tasks[0]}.json`);
  assert.ok(fs.existsSync(taskFile));
  const task = JSON.parse(fs.readFileSync(taskFile, "utf8"));
  assert.equal(task.status, "pending");
  assert.ok(task.source_archive.archive_id.startsWith("RC-"));
});

test("--worker --once processes pending task and writes memory files", () => {
  const enq = run(EVOLVE, ["--enqueue-from-latest"]);
  assert.equal(enq.ok, true);
  const taskId = enq.tasks[0];

  const result = run(EVOLVE, ["--worker", "--once"]);
  assert.equal(result.ok, true);
  assert.equal(result.processed, 1);

  const taskFile = path.join(TASKS_DIR, `${taskId}.json`);
  const task = JSON.parse(fs.readFileSync(taskFile, "utf8"));
  assert.equal(task.status, "completed");
  assert.ok(task.started_at);
  assert.ok(task.completed_at);

  // Should have extracted some items
  const total = Object.values(task.extracted).reduce((a, b) => a + b.length, 0);
  assert.ok(total > 0, "expected some extracted items");

  // Verify files were actually written
  for (const items of Object.values(task.extracted)) {
    for (const f of items) {
      if (!f) continue;
      const full = path.join(ROOT, f);
      assert.ok(fs.existsSync(full), `expected file to exist: ${f}`);
      const content = fs.readFileSync(full, "utf8");
      assert.match(content, /^---\nname: /m);
      assert.match(content, /^type: /m);
      assert.match(content, /^created: /m);
      assert.match(content, /\*\*Observation|\*\*Fact|\*\*Lesson/);
    }
  }

  // MEMORY.md should have updates
  const memoryIndex = fs.readFileSync(path.join(MEMORY_DIR, "MEMORY.md"), "utf8");
  assert.ok(memoryIndex.includes(task.source_archive.archive_id.toLowerCase().slice(0, 12)));
});

test("--list shows all tasks in correct status", () => {
  run(EVOLVE, ["--enqueue-from-latest"]);
  const pending = run(EVOLVE, ["--list", "--status", "pending"]);
  assert.equal(pending.count, 1);
  assert.equal(pending.tasks[0].status, "pending");
  run(EVOLVE, ["--worker", "--once"]);
  const completed = run(EVOLVE, ["--list", "--status", "completed"]);
  assert.equal(completed.count, 1);
  assert.equal(completed.tasks[0].status, "completed");
});

test("--replay resets status back to pending", () => {
  run(EVOLVE, ["--enqueue-from-latest"]);
  const enq = run(EVOLVE, ["--list"]);
  const taskId = enq.tasks[0].task_id;
  run(EVOLVE, ["--worker", "--once"]);
  const after = JSON.parse(fs.readFileSync(path.join(TASKS_DIR, `${taskId}.json`), "utf8"));
  assert.equal(after.status, "completed");
  const replay = run(EVOLVE, ["--replay", taskId]);
  assert.equal(replay.ok, true);
  const reread = JSON.parse(fs.readFileSync(path.join(TASKS_DIR, `${taskId}.json`), "utf8"));
  assert.equal(reread.status, "pending");
  assert.equal(reread.retry_count, 0);
  assert.deepEqual(reread.errors, []);
});

test("--dead-letter reports dead tasks after max_retries", () => {
  // To get a dead letter quickly, create a task pointing to a non-existent archive
  const taskId = "EVO-TEST-001";
  const fakeTask = {
    task_id: taskId,
    source_archive: { archive_id: "RC-NOT-EXIST", archive_path: "does/not/exist.json", created_at: new Date().toISOString() },
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    status: "pending",
    retry_count: 0,
    max_retries: 2,
    extracted: { user: [], feedback: [], project: [], experiences: [] },
    classification: { user: 0, feedback: 0, project: 0, experiences: 0, dropped: 0 },
    errors: [],
  };
  fs.mkdirSync(TASKS_DIR, { recursive: true });
  fs.writeFileSync(path.join(TASKS_DIR, `${taskId}.json`), JSON.stringify(fakeTask, null, 2));

  // Run twice to exhaust retries
  run(EVOLVE, ["--worker", "--once"]);
  run(EVOLVE, ["--worker", "--once"]);
  run(EVOLVE, ["--worker", "--once"]); // final: retry_count -> 2 -> dead

  const dead = run(EVOLVE, ["--dead-letter"]);
  assert.equal(dead.ok, true);
  assert.equal(dead.dead_count, 1);
  assert.equal(dead.tasks[0].task_id, taskId);
  assert.equal(dead.tasks[0].status, "dead");
});

test("SKILL.md files exist in both zh and en", () => {
  const zh = fs.readFileSync(path.join(ROOT, "templates", "zh", ".agent", "skills", "evolution-pipeline", "SKILL.md"), "utf8");
  const en = fs.readFileSync(path.join(ROOT, "templates", "en", ".agent", "skills", "evolution-pipeline", "SKILL.md"), "utf8");
  assert.ok(zh.includes("Self-Evolution Pipeline"));
  assert.ok(en.includes("Self-Evolution Pipeline"));
  assert.ok(zh.includes("入队") || zh.includes("enqueue"));
  assert.ok(en.includes("enqueue"));
});

test("worker --loop option is accepted (no hang)", () => {
  // We can't test infinite loop, but at least test argument parsing
  const { spawnSync } = require("child_process");
  // Start and immediately kill it via a short timeout
  const result = spawnSync(process.execPath, [EVOLVE, "--worker", "--loop", "--interval", "0.001"], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 100,
  });
  assert.ok(result.stdout.includes("polling every") || result.signal || result.status === 0);
});

test("classifyArchive() returns deterministic structure", () => {
  const { classifyArchive } = require(path.join(ROOT, ".agent", "skills", "evolution-pipeline", "scripts", "evolve.js"));
  const sample = {
    archive_id: "RC-TEST-001",
    created_at: new Date().toISOString(),
    state: {
      current_goal: "M-001",
      done: ["added foo", "bar lesson"],
      in_progress: "working on baz",
      blockers: ["network down"],
      next: ["refactor baz", "finish tests"],
    },
  };
  const routes = classifyArchive(sample);
  assert.ok(Array.isArray(routes.feedback));
  assert.ok(Array.isArray(routes.project));
  assert.ok(Array.isArray(routes.experiences));
  assert.ok(Array.isArray(routes.dropped));
  assert.ok(routes.feedback.length >= 2); // blockers + in_progress
  assert.ok(routes.project.length >= 3); // done[0], done[1], next[0], next[1]
});
