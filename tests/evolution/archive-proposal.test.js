"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn, spawnSync } = require("node:child_process");
const ROOT = path.resolve(__dirname, "../..");
const EVOLVE = process.env.EVOLUTION_TEST_SCRIPT || path.join(ROOT, "templates/en/.agent/skills/evolution-pipeline/scripts/evolve.js");
const CONTINUITY = process.env.CONTINUITY_TEST_SCRIPT || path.join(ROOT, "templates/en/.agent/skills/runtime-continuity/scripts/index.js");
const ARCHIVE_ID = "RC-20261016_PROPOSAL";
const PRIVATE_MARKER = "PRIVATE_ARCHIVE_TEXT_MUST_NOT_BE_COPIED";
const preload = "\n\"use strict\";\nglobal.__cortexFixtureNetworkAttempts = 0;\nconst stopNetwork = () => { global.__cortexFixtureNetworkAttempts++; process.exit(87); };\nfor (const [module, names] of [\n  [\"node:http\", [\"request\", \"get\", \"createServer\"]],\n  [\"node:https\", [\"request\", \"get\", \"createServer\"]],\n  [\"node:http2\", [\"connect\", \"createServer\", \"createSecureServer\"]],\n  [\"node:net\", [\"connect\", \"createConnection\", \"createServer\"]],\n  [\"node:tls\", [\"connect\", \"createServer\"]],\n  [\"node:dgram\", [\"createSocket\"]],\n]) {\n  const object = require(module);\n  for (const name of names) if (typeof object[name] === \"function\") object[name] = stopNetwork;\n}\nrequire(\"node:net\").Socket.prototype.connect = stopNetwork;\nconst dns = require(\"node:dns\");\nfor (const object of [dns, dns.promises]) {\n  for (const name of Object.keys(object)) {\n    if (/^(lookup|resolve|reverse)/.test(name) && typeof object[name] === \"function\") object[name] = stopNetwork;\n  }\n}\nglobal.fetch = stopNetwork;\nglobal.WebSocket = class { constructor() { stopNetwork(); } };\nglobal.EventSource = class { constructor() { stopNetwork(); } };\nconst cp = require(\"node:child_process\");\nconst path = require(\"node:path\");\nconst nodeScripts = JSON.parse(process.env.CORTEX_FIXTURE_NODE_SCRIPTS || \"[]\");\nconst readGit = new Set([\n  '[\"rev-parse\",\"--abbrev-ref\",\"HEAD\"]', '[\"rev-parse\",\"--short\",\"HEAD\"]',\n  '[\"status\",\"--short\"]', '[\"log\",\"--oneline\",\"-3\"]', '[\"diff\",\"--name-only\",\"HEAD\"]',\n]);\nfunction allowed(command, args, options) {\n  const cwd = path.resolve(options && options.cwd || process.cwd());\n  if (cwd !== process.env.CORTEX_FIXTURE_ROOT) return false;\n  if (command === \"git\") return readGit.has(JSON.stringify(args));\n  if (command !== process.execPath || !Array.isArray(args) || !nodeScripts.includes(path.resolve(args[0] || \"\"))) return false;\n  const env = options && options.env || process.env;\n  return env.NODE_OPTIONS === process.env.NODE_OPTIONS\n    && env.CORTEX_FIXTURE_NODE_SCRIPTS === process.env.CORTEX_FIXTURE_NODE_SCRIPTS\n    && env.CORTEX_FIXTURE_ROOT === process.env.CORTEX_FIXTURE_ROOT;\n}\nfor (const name of [\"spawn\", \"spawnSync\"]) {\n  const original = cp[name];\n  cp[name] = function(command, args, options) {\n    if (!allowed(command, args, options)) process.exit(88);\n    return original.call(this, command, args, options);\n  };\n}\nfor (const name of [\"exec\", \"execSync\", \"execFile\", \"execFileSync\", \"fork\"]) cp[name] = () => process.exit(88);\nrequire(\"node:worker_threads\").Worker = class { constructor() { process.exit(88); } };\n";
const runner = String.raw`
  process.chdir(process.argv[1]);
  const input = JSON.parse(process.argv[3]);
  const fs = require("node:fs");
  const api = require(process.argv[2]);
  let writes = 0, network = 0, readBytes = 0;
  const originalRead = fs.readSync;
  fs.readSync = function(...args) { const count = originalRead.apply(this, args); readBytes += count; return count; };
  if (input.redirectOpen) {
    const originalOpen = fs.openSync;
    fs.openSync = function(file, ...args) {
      return originalOpen.call(this, file === input.redirectFrom ? input.redirectOpen : file, ...args);
    };
  }
  for (const name of ["writeFileSync", "appendFileSync", "mkdirSync", "renameSync", "unlinkSync", "linkSync", "copyFileSync", "rmSync", "chmodSync", "utimesSync"]) {
    const original = fs[name];
    fs[name] = function(...args) { writes++; return original.apply(this, args); };
  }
  network = global.__cortexFixtureNetworkAttempts || 0;
  if (input.fault) {
    const link = fs.linkSync;
    fs.linkSync = function(...args) {
      if (input.fault === "before_link") process.exit(83);
      link.apply(this, args);
      process.exit(84);
    };
  }
  try {
    let result;
    if (input.op === "enqueue") result = api.enqueueFromArchive(input.archive, {
      proposalOnly: true, expectedProject: input.project === undefined ? "fixture" : input.project,
      dryRun: input.dryRun === true,
    });
    else if (input.op === "process") result = api.processTask(input.taskId, { dryRun: input.dryRun === true });
    else if (input.op === "list") result = api.listTasks({ proposalOnly: input.proposalOnly !== false });
    else if (input.op === "archive") result = api.archiveProject("fixture", {
      done: ["reported " + input.marker], next: ["verify " + input.marker], blockers: [],
    }, { stamp: "20261016_OPT_IN", queueLearningProposal: input.optIn === true });
    else throw Error("unknown fixture operation");
    process.stdout.write(JSON.stringify({ ok: true, result, writes, network, readBytes }));
  } catch (error) {
    process.stdout.write(JSON.stringify({ ok: false, error: error.code || error.message, writes, network, readBytes }));
  }
`;
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-archive-proposal-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const evolve = path.join(root, ".agent/skills/evolution-pipeline/scripts/evolve.js");
  const continuity = path.join(root, ".agent/skills/runtime-continuity/scripts/index.js");
  for (const [source, target] of [[EVOLVE, evolve], [CONTINUITY, continuity]]) {
    fs.mkdirSync(path.dirname(target), { recursive: true }); fs.copyFileSync(source, target);
  }
  const archives = path.join(root, ".agent/runtime-continuity/archives");
  fs.mkdirSync(archives, { recursive: true });
  const archive = path.join(archives, ARCHIVE_ID + ".json");
  fs.writeFileSync(archive, JSON.stringify({
    archive_id: ARCHIVE_ID, project: "fixture", created_at: "2026-10-16T04:00:00.000Z",
    state: { done: [PRIVATE_MARKER], next: ["review " + PRIVATE_MARKER], blockers: [], in_progress: null },
  }));
  const home = path.join(root, "home"); fs.mkdirSync(home);
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  for (const name of Object.keys(env)) if (name.startsWith("GIT_")) delete env[name];
  env.GIT_CONFIG_NOSYSTEM = "1"; env.GIT_CONFIG_GLOBAL = path.join(home, "empty-git-config");
  fs.writeFileSync(env.GIT_CONFIG_GLOBAL, "");
  const guard = path.join(root, "fixture-preload.cjs"); fs.writeFileSync(guard, preload);
  env.NODE_OPTIONS = "--require=" + guard;
  env.CORTEX_FIXTURE_ROOT = root;
  env.CORTEX_FIXTURE_NODE_SCRIPTS = JSON.stringify([evolve, continuity,
    path.join(ROOT, "templates/_shared/.agent/skills/runtime-continuity/scripts/index.js")]);
  const tasks = path.join(root, ".agent/tasks/evolution");
  return { root, evolve, continuity, archive, archives, tasks, env };
}
function direct(f, input) {
  const script = input.op === "archive" ? f.continuity : f.evolve;
  return spawnSync(process.execPath, ["-e", runner, f.root, script, JSON.stringify({ archive: f.archive, ...input })],
    { cwd: f.root, env: f.env, encoding: "utf8", timeout: 10000 });
}
function result(f, input) {
  const child = direct(f, input); assert.equal(child.status, 0, child.stderr);
  const value = JSON.parse(child.stdout); assert.equal(value.network, 0); return value;
}
function cli(f, ...args) {
  return spawnSync(process.execPath, [f.evolve, ...args], { cwd: f.root, env: f.env, encoding: "utf8", timeout: 10000 });
}
function enqueue(f) {
  const value = result(f, { op: "enqueue" }); assert.equal(value.ok, true, value.error); return value.result;
}
function snapshot(root) {
  const rows = [];
  function walk(file) {
    const stat = fs.lstatSync(file, { bigint: true });
    const row = { path: path.relative(root, file), mode: String(stat.mode), mtime: String(stat.mtimeNs) };
    if (stat.isFile()) row.sha256 = crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
    if (stat.isSymbolicLink()) row.link = fs.readlinkSync(file);
    rows.push(row);
    if (stat.isDirectory()) for (const child of fs.readdirSync(file).sort()) walk(path.join(file, child));
  }
  walk(root); return rows;
}
function noMemory(f) {
  assert.equal(fs.existsSync(path.join(f.root, ".agent/memory")), false);
}
function proposalPath(f, task) { return path.join(f.tasks, "_proposals", task.task_id + ".json"); }
function queueFiles(f) { return fs.existsSync(f.tasks) ? fs.readdirSync(f.tasks).filter((x) => x.endsWith(".json")) : []; }

test("proposal enqueue preview has zero writes and creates no queue directory", (t) => {
  const f = fixture(t), before = snapshot(f.root);
  const value = result(f, { op: "enqueue", dryRun: true });
  assert.equal(value.ok, true); assert.equal(value.result.task_id, null); assert.equal(value.writes, 0);
  assert.deepEqual(snapshot(f.root), before); assert.equal(fs.existsSync(f.tasks), false);
});
test("proposal processing preview has zero writes", (t) => {
  const f = fixture(t), task = enqueue(f), before = snapshot(f.root);
  const value = result(f, { op: "process", taskId: task.task_id, dryRun: true });
  assert.equal(value.ok, true); assert.equal(value.result.status, "proposal_only"); assert.equal(value.writes, 0);
  assert.deepEqual(snapshot(f.root), before); assert.equal(fs.existsSync(proposalPath(f, task)), false);
});
test("actual archive API defaults to no learning queue", (t) => {
  const f = fixture(t), value = result(f, { op: "archive", marker: PRIVATE_MARKER });
  assert.equal(value.ok, true, value.error); assert.ok(fs.existsSync(value.result.archiveJsonPath));
  assert.equal(value.result.learning_proposal, undefined); assert.equal(fs.existsSync(f.tasks), false); noMemory(f);
});
test("actual archive opt-in reaches the existing worker and produces only scoped proposal metadata", (t) => {
  const f = fixture(t), value = result(f, { op: "archive", optIn: true, marker: PRIVATE_MARKER });
  assert.equal(value.ok, true, value.error); assert.equal(value.result.learning_proposal.status, "queued");
  const taskId = value.result.learning_proposal.task_id;
  const taskFile = path.join(f.tasks, taskId + ".json"), original = fs.readFileSync(taskFile, "utf8");
  const child = cli(f, "--worker", "--once", "--proposal-only");
  assert.equal(child.status, 0, child.stderr);
  const receipt = JSON.parse(child.stdout); assert.equal(receipt.processed, 1); assert.equal(receipt.task.status, "proposal_only");
  assert.equal(receipt.task.execution_authorized, false); assert.deepEqual(receipt.task.allowed_effects, []);
  const proposal = fs.readFileSync(proposalPath(f, receipt.task), "utf8");
  assert.equal((original + proposal).includes(PRIVATE_MARKER), false);
  assert.equal(fs.readFileSync(taskFile, "utf8"), original); noMemory(f);
  assert.equal(result(f, { op: "list" }).result[0].status, "proposal_only");
});
test("same archive is deduplicated without any filesystem mutation", (t) => {
  const f = fixture(t), first = enqueue(f), before = snapshot(f.root), again = result(f, { op: "enqueue" });
  assert.equal(again.ok, true); assert.equal(again.result.task_id, first.task_id); assert.equal(again.result.deduplicated, true);
  assert.equal(again.writes, 0); assert.deepEqual(snapshot(f.root), before); assert.equal(queueFiles(f).length, 1);
});
test("completed proposal replay verifies immutable bytes and writes nothing", (t) => {
  const f = fixture(t), task = enqueue(f);
  assert.equal(result(f, { op: "process", taskId: task.task_id }).ok, true);
  const before = snapshot(f.root), again = result(f, { op: "process", taskId: task.task_id });
  assert.equal(again.ok, true); assert.equal(again.result.deduplicated, true); assert.equal(again.writes, 0);
  assert.deepEqual(snapshot(f.root), before); noMemory(f);
});
test("changed archive bytes block an old queued task with zero writes", (t) => {
  const f = fixture(t), task = enqueue(f); fs.appendFileSync(f.archive, "\n");
  const before = snapshot(f.root), value = result(f, { op: "process", taskId: task.task_id });
  assert.equal(value.ok, false); assert.equal(value.error, "ERR_PROPOSAL_SOURCE_CHANGED"); assert.equal(value.writes, 0);
  assert.deepEqual(snapshot(f.root), before); assert.equal(result(f, { op: "list" }).result[0].status, "blocked");
});
test("explicit project mismatch cannot enqueue", (t) => {
  const f = fixture(t), before = snapshot(f.root), value = result(f, { op: "enqueue", project: "other" });
  assert.equal(value.ok, false); assert.equal(value.error, "ERR_PROPOSAL_PROJECT_MISMATCH");
  assert.equal(value.writes, 0); assert.deepEqual(snapshot(f.root), before);
});
test("copying a queue record to a different workspace cannot reuse its digest identity", (t) => {
  const first = fixture(t), task = enqueue(first), second = fixture(t);
  fs.mkdirSync(second.tasks, { recursive: true });
  fs.copyFileSync(path.join(first.tasks, task.task_id + ".json"), path.join(second.tasks, task.task_id + ".json"));
  const before = snapshot(second.root), value = result(second, { op: "process", taskId: task.task_id });
  assert.equal(value.ok, false); assert.equal(value.error, "ERR_PROPOSAL_SOURCE_CHANGED"); assert.equal(value.writes, 0);
  assert.deepEqual(snapshot(second.root), before); noMemory(second);
});
test("archive symlinks and symlinked queue directories are refused", (t) => {
  const f = fixture(t), original = f.archive + ".saved"; fs.renameSync(f.archive, original); fs.symlinkSync(original, f.archive);
  let before = snapshot(f.root), value = result(f, { op: "enqueue" });
  assert.equal(value.ok, false); assert.equal(value.writes, 0); assert.deepEqual(snapshot(f.root), before);
  fs.unlinkSync(f.archive); fs.renameSync(original, f.archive);
  fs.mkdirSync(path.dirname(f.tasks), { recursive: true });
  const outside = path.join(f.root, "other-project"); fs.mkdirSync(outside); fs.symlinkSync(outside, f.tasks);
  before = snapshot(f.root); value = result(f, { op: "enqueue" });
  assert.equal(value.ok, false); assert.equal(value.writes, 0); assert.deepEqual(snapshot(f.root), before);
});
test("malformed, oversized and non-UTF8 archives fail before queue writes", (t) => {
  for (const bytes of ["{broken", "x".repeat(1024 * 1024 + 1), Buffer.from([0xff, 0xfe])]) {
    const f = fixture(t); fs.writeFileSync(f.archive, bytes); const before = snapshot(f.root);
    const value = result(f, { op: "enqueue" }); assert.equal(value.ok, false); assert.equal(value.writes, 0);
    assert.deepEqual(snapshot(f.root), before);
  }
});
test("an existing conflicting queue file is never overwritten", (t) => {
  const f = fixture(t), task = enqueue(f), file = path.join(f.tasks, task.task_id + ".json");
  fs.appendFileSync(file, "\n"); const before = snapshot(f.root), value = result(f, { op: "enqueue" });
  assert.equal(value.ok, false); assert.equal(value.error, "ERR_PROPOSAL_RECORD_CONFLICT"); assert.equal(value.writes, 0);
  assert.deepEqual(snapshot(f.root), before);
});
test("an existing conflicting proposal is never overwritten", (t) => {
  const f = fixture(t), task = enqueue(f); result(f, { op: "process", taskId: task.task_id });
  fs.appendFileSync(proposalPath(f, task), "\n"); const before = snapshot(f.root);
  const value = result(f, { op: "process", taskId: task.task_id });
  assert.equal(value.ok, false); assert.equal(value.error, "ERR_PROPOSAL_RECORD_CONFLICT"); assert.equal(value.writes, 0);
  assert.deepEqual(snapshot(f.root), before);
});
test("independent processes publish a single immutable queue record", { timeout: 15000 }, async (t) => {
  const f = fixture(t), children = [];
  try {
    const values = await Promise.all(Array.from({ length: 4 }, () => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ["-e", runner, f.root, f.evolve, JSON.stringify({ op: "enqueue", archive: f.archive })],
        { cwd: f.root, env: f.env, stdio: ["ignore", "pipe", "pipe"] });
      children.push(child);
      const timer = setTimeout(() => { child.kill("SIGKILL"); reject(Error("fixture child timeout")); }, 5000);
      let stdout = "", stderr = "";
      child.stdout.on("data", (x) => stdout += x); child.stderr.on("data", (x) => stderr += x);
      child.on("error", (error) => { clearTimeout(timer); reject(error); });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (code !== 0) reject(Error(stderr || "fixture child failed"));
        else { try { resolve(JSON.parse(stdout)); } catch (error) { reject(error); } }
      });
    })));
    assert.ok(values.every((v) => v.ok), JSON.stringify(values));
    assert.equal(values.filter((v) => !v.result.deduplicated).length, 1);
    assert.equal(new Set(values.map((v) => v.result.task_id)).size, 1); assert.equal(queueFiles(f).length, 1); noMemory(f);
  } finally {
    await Promise.all(children.map((child) => {
      if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
      return new Promise((resolve) => {
        const timer = setTimeout(resolve, 1000);
        child.once("close", () => { clearTimeout(timer); resolve(); }); child.kill("SIGKILL");
      });
    }));
  }
});
test("process exit before queue publication leaves no consumable partial task", (t) => {
  const f = fixture(t), child = direct(f, { op: "enqueue", fault: "before_link" });
  assert.equal(child.status, 83); assert.equal(queueFiles(f).length, 0);
  enqueue(f); assert.equal(queueFiles(f).length, 1); noMemory(f);
});
test("exit between queue link and unlink preserves a blocked multi-link record", (t) => {
  const f = fixture(t), child = direct(f, { op: "enqueue", fault: "after_link" });
  assert.equal(child.status, 84); assert.equal(queueFiles(f).length, 1);
  const before = snapshot(f.root), again = result(f, { op: "enqueue" });
  assert.equal(again.ok, false); assert.equal(again.error, "ERR_PROPOSAL_FILE_LINKS"); assert.equal(again.writes, 0);
  assert.deepEqual(snapshot(f.root), before);
  assert.equal(result(f, { op: "list" }).result[0].status, "blocked");
});
test("worker exit before publication retries, while multi-link publication remains blocked", (t) => {
  for (const fault of ["before_link", "after_link"]) {
    const f = fixture(t), task = enqueue(f), child = direct(f, { op: "process", taskId: task.task_id, fault });
    assert.equal(child.status, fault === "before_link" ? 83 : 84);
    const before = snapshot(f.root), value = result(f, { op: "process", taskId: task.task_id });
    if (fault === "before_link") {
      assert.equal(value.ok, true); assert.equal(value.result.status, "proposal_only");
    } else {
      assert.equal(value.ok, false); assert.equal(value.error, "ERR_PROPOSAL_FILE_LINKS");
      assert.equal(value.writes, 0); assert.deepEqual(snapshot(f.root), before);
      assert.equal(result(f, { op: "list" }).result[0].status, "blocked");
    }
    noMemory(f);
    assert.equal(JSON.parse(fs.readFileSync(path.join(f.tasks, task.task_id + ".json"))).status, "pending");
  }
});
test("proposal replay requires its explicit mode and cannot fall through to legacy task rewriting", (t) => {
  const f = fixture(t), task = enqueue(f), before = snapshot(f.root);
  const denied = cli(f, "--replay", task.task_id); assert.equal(denied.status, 1);
  assert.deepEqual(snapshot(f.root), before);
  const allowed = cli(f, "--replay", task.task_id, "--proposal-only"); assert.equal(allowed.status, 0, allowed.stderr);
  assert.equal(JSON.parse(allowed.stdout).replayed.status, "proposal_only"); noMemory(f);
});
test("proposal-only worker does not select legacy memory-writing tasks", (t) => {
  const f = fixture(t), task = enqueue(f), legacyFile = path.join(f.tasks, "EVO-LEGACY.json");
  const legacy = JSON.stringify({ task_id: "EVO-LEGACY", status: "pending", created_at: "2020-01-01T00:00:00.000Z" });
  fs.writeFileSync(legacyFile, legacy);
  const child = cli(f, "--worker", "--once", "--proposal-only"); assert.equal(child.status, 0, child.stderr);
  assert.equal(JSON.parse(child.stdout).task.task_id, task.task_id);
  assert.equal(fs.readFileSync(legacyFile, "utf8"), legacy); noMemory(f);
});
test("proposal intake failure preserves an otherwise successful actual archive", (t) => {
  const f = fixture(t); fs.mkdirSync(path.dirname(f.tasks), { recursive: true }); fs.writeFileSync(f.tasks, "blocked");
  const value = result(f, { op: "archive", optIn: true, marker: PRIVATE_MARKER });
  assert.equal(value.ok, true, value.error); assert.equal(value.result.learning_proposal.status, "unavailable");
  assert.ok(fs.existsSync(value.result.archiveJsonPath)); assert.equal(fs.readFileSync(f.tasks, "utf8"), "blocked"); noMemory(f);
});
test("changed source creates a distinct proposal key without modifying the old task", (t) => {
  const f = fixture(t), first = enqueue(f), oldFile = path.join(f.tasks, first.task_id + ".json"), old = fs.readFileSync(oldFile, "utf8");
  fs.appendFileSync(f.archive, "\n"); const second = enqueue(f);
  assert.notEqual(second.task_id, first.task_id); assert.equal(queueFiles(f).length, 2);
  assert.equal(fs.readFileSync(oldFile, "utf8"), old); noMemory(f);
});

test("a value-bearing proposal flag cannot silently fall back to the legacy writer", (t) => {
  const f = fixture(t), before = snapshot(f.root);
  const child = cli(f, "--enqueue", "--archive", f.archive, "--proposal-only", "yes", "--project", "fixture");
  assert.equal(child.status, 1); assert.equal(JSON.parse(child.stdout).error, "ERR_PROPOSAL_MODE_FLAG");
  assert.deepEqual(snapshot(f.root), before); noMemory(f);
});

test("the library session facade resolves its shared proposal helper", (t) => {
  const f = fixture(t);
  const entry = path.join(ROOT, "lib/commands/session.js");
  const call = 'require(process.argv[1]).runSession(["session", "archive", "--project", "fixture", "--gate", "user", "--queue-learning-proposal", "--note-json", JSON.stringify({done:["reported fixture"],next:[],blockers:[]})]);';
  const child = spawnSync(process.execPath, ["-e", call, entry],
    { cwd: f.root, env: f.env, encoding: "utf8", timeout: 10000 });
  assert.equal(child.status, 0, child.stderr);
  const value = JSON.parse(child.stdout); assert.equal(value.ok, true);
  assert.equal(value.learning_proposal.status, "queued");
  assert.equal(queueFiles(f).length, 1); noMemory(f);
});

test("a proposal task with its kind removed cannot reach the legacy memory writer", (t) => {
  const f = fixture(t), task = enqueue(f), file = path.join(f.tasks, task.task_id + ".json");
  const corrupt = JSON.parse(fs.readFileSync(file)); delete corrupt.kind;
  fs.writeFileSync(file, JSON.stringify(corrupt)); const before = snapshot(f.root);
  const value = result(f, { op: "process", taskId: task.task_id });
  assert.equal(value.ok, false); assert.equal(value.error, "ERR_PROPOSAL_TASK_SHAPE"); assert.equal(value.writes, 0);
  const replay = cli(f, "--replay", task.task_id); assert.equal(replay.status, 1);
  assert.deepEqual(snapshot(f.root), before); noMemory(f);
});

function fifo(f, file) {
  const child = spawnSync("mkfifo", ["--", file], { cwd: f.root, encoding: "utf8", timeout: 1000 });
  assert.equal(child.status, 0, child.stderr);
}
function assertBlockedEntrypoints(f, taskId) {
  const before = snapshot(f.root), value = result(f, { op: "process", taskId });
  assert.equal(value.ok, false); assert.equal(value.writes, 0); assert.equal(value.readBytes, 0);
  const listed = result(f, { op: "list" }); assert.equal(listed.ok, true);
  assert.equal(listed.result.find((x) => x.task_id === taskId).status, "blocked");
  assert.equal(listed.writes, 0); assert.equal(listed.readBytes, 0);
  const worker = cli(f, "--worker", "--once", "--proposal-only");
  assert.equal(worker.status, 0, worker.stderr); assert.equal(JSON.parse(worker.stdout).processed, 0);
  const list = cli(f, "--list", "--proposal-only");
  assert.equal(list.status, 0, list.stderr); assert.equal(JSON.parse(list.stdout).tasks[0].status, "blocked");
  const status = cli(f, "--status", "--proposal-only");
  assert.equal(status.status, 0, status.stderr); assert.equal(JSON.parse(status.stdout).by_status.blocked, 1);
  for (const flags of [[], ["--proposal-only"]]) {
    const replay = cli(f, "--replay", taskId, ...flags); assert.equal(replay.status, 1);
  }
  assert.deepEqual(snapshot(f.root), before); noMemory(f);
}
test("proposal leaf symlinks are blocked before process/list/worker/replay first reads", (t) => {
  const f = fixture(t), task = enqueue(f), file = path.join(f.tasks, task.task_id + ".json");
  const privateFile = path.join(f.root, "private.txt"); fs.writeFileSync(privateFile, PRIVATE_MARKER);
  fs.unlinkSync(file); fs.symlinkSync(privateFile, file); assertBlockedEntrypoints(f, task.task_id);
  assert.equal(fs.readFileSync(privateFile, "utf8"), PRIVATE_MARKER);
});
test("proposal FIFO nodes cannot block process/list/worker/replay", { timeout: 15000 }, (t) => {
  const f = fixture(t), task = enqueue(f), file = path.join(f.tasks, task.task_id + ".json");
  fs.unlinkSync(file); fifo(f, file); assertBlockedEntrypoints(f, task.task_id);
});
test("proposal hardlinks are blocked without reading their bytes", (t) => {
  const f = fixture(t), task = enqueue(f), file = path.join(f.tasks, task.task_id + ".json");
  fs.linkSync(file, path.join(f.root, "other-link")); assertBlockedEntrypoints(f, task.task_id);
});
test("the whole reserved prefix routes malformed IDs to blocked before reading content", (t) => {
  const f = fixture(t), taskId = "EVO-P-broken";
  fs.mkdirSync(f.tasks, { recursive: true }); fs.writeFileSync(path.join(f.tasks, taskId + ".json"), PRIVATE_MARKER);
  assertBlockedEntrypoints(f, taskId);
});
test("proposal-only modes never open unrelated legacy nodes or the unsafe latest pointer", { timeout: 15000 }, (t) => {
  const f = fixture(t); fs.mkdirSync(path.join(f.tasks, "_dead"), { recursive: true });
  fifo(f, path.join(f.tasks, "EVO-LEGACY.json")); fifo(f, path.join(f.tasks, "_dead", "EVO-LEGACY.json"));
  fifo(f, path.join(f.archives, "latest.json")); const before = snapshot(f.root);
  for (const flags of [["--worker", "--once"], ["--list"], ["--status"]]) {
    const child = cli(f, ...flags, "--proposal-only"); assert.equal(child.status, 0, child.stderr);
  }
  const latest = cli(f, "--enqueue-from-latest", "--project", "fixture", "--proposal-only");
  assert.equal(latest.status, 1); assert.equal(JSON.parse(latest.stdout).error, "ERR_PROPOSAL_UNSUPPORTED_MODE");
  assert.deepEqual(snapshot(f.root), before); noMemory(f);
});
test("same-fd validation rejects a replaced regular file or FIFO before reading bytes", { timeout: 15000 }, (t) => {
  for (const kind of ["regular", "fifo"]) {
    const f = fixture(t), task = enqueue(f), file = path.join(f.tasks, task.task_id + ".json");
    const replacement = path.join(f.root, "replacement");
    if (kind === "fifo") fifo(f, replacement); else fs.writeFileSync(replacement, PRIVATE_MARKER);
    const before = snapshot(f.root);
    const value = result(f, { op: "process", taskId: task.task_id, redirectFrom: file, redirectOpen: replacement });
    assert.equal(value.ok, false); assert.equal(value.readBytes, 0); assert.equal(value.writes, 0);
    assert.deepEqual(snapshot(f.root), before); noMemory(f);
  }
});
test("preload network and subprocess guards run before APIs and inherited facade children", (t) => {
  const f = fixture(t);
  for (const code of [
    'require("node:http").get()', 'require("node:tls").connect()', 'require("node:dns").promises.lookup("unused")',
    'fetch("unused")', 'new (require("node:net").Socket)().connect()',
  ]) {
    const child = spawnSync(process.execPath, ["-e", code], { cwd: f.root, env: f.env, encoding: "utf8", timeout: 1000 });
    assert.equal(child.status, 87);
  }
  const denied = spawnSync(process.execPath, ["-e", 'require("node:child_process").spawnSync("sh", ["-c", "exit 0"])'],
    { cwd: f.root, env: f.env, encoding: "utf8", timeout: 1000 });
  assert.equal(denied.status, 88);
});
