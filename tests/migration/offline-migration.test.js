"use strict";
const nodeTest = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path"), crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const test = process.platform === "linux" ? nodeTest : (name, fn) => nodeTest(name, { skip: "Linux fd-anchored filesystem reader" }, fn);
const { inspect, plan } = require("../../lib/offline-migration");
const fixtures = path.join(__dirname, "fixtures");
const provenance = require("./fixtures/provenance.json");
const sha = data => crypto.createHash("sha256").update(data).digest("hex");
function setup(t, version = "1.15.6") {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "offline-migration-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  function write(rel, value) { const f = path.join(root, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, value); }
  write(".agent/.cortex-version", version + "\n");
  return { root, write };
}
function snapshot(root) {
  const result = {};
  function visit(p) { for (const n of fs.readdirSync(p).sort()) { const f = path.join(p, n), s = fs.lstatSync(f); if (s.isDirectory()) visit(f); else result[path.relative(root, f)] = { hash: sha(fs.readFileSync(f)), mode: s.mode, mtime: s.mtimeMs }; } }
  visit(root); return result;
}
for (const version of ["1.15.4", "1.15.6"]) {
  test(`real published ${version} source example bytes recognized and never rewritten`, t => {
    const { root, write } = setup(t, version);
    for (const entry of provenance.files.filter(f => f.version === version)) {
      const bytes = fs.readFileSync(path.join(fixtures, entry.fixture)); assert.equal(sha(bytes), entry.sha256);
      const value = JSON.parse(bytes), kind = entry.source.split("/").at(-2), id = value[kind.slice(0, -1) + "_id"];
      write(`.agent/${kind}/${id}.json`, bytes);
    }
    const before = snapshot(root), result = inspect(root);
    assert.equal(result.records.length, 4, JSON.stringify(result.unresolved));
    assert.equal(result.records.every(r => r.disposition === "preserve"), true);
    assert.deepEqual(snapshot(root), before);
    assert.deepEqual(plan(root), plan(root));
  });
  test(`${version} empty data scope needs no format migration`, t => {
    const { root } = setup(t, version);
    assert.equal(inspect(root).status, "no_migration_needed");
    assert.equal(plan(root).next_action, "none");
    assert.equal(plan(root).executable, false);
  });
}
test("43 legacy directories and 26 rows all unresolved; no invented state", t => {
  const { root, write } = setup(t);
  const ids = Array.from({ length: 43 }, (_, i) => `M-${String(i + 1).padStart(3, "0")}`);
  for (const id of ids) write(`.agent/missions/${id}/mission-plan.md`, `# ${id}\nLegacy content without structured truth.\n`);
  write(".agent/plans/task-progress.md", ids.slice(0, 26).map(id => `| ${id} | 100% |`).join("\n"));
  const before = snapshot(root), result = plan(root);
  assert.equal(result.mission_count, 43); assert.equal(result.unresolved.length, 43);
  assert.equal(result.needs_migration, null); assert.deepEqual(result.operations, []);
  assert.equal(result.executable, false); assert.deepEqual(snapshot(root), before);
});
test("unknown product does not become supported from a familiar record", t => {
  const { root } = setup(t, "1.14.0");
  assert.equal(inspect(root).unresolved[0].code, "UNSUPPORTED_PRODUCT_PROVENANCE");
});
test("product update alone does not force a data format migration", t => {
  const { root } = setup(t, "1.16.0"); assert.equal(inspect(root).needs_migration, false);
});
test("unknown fields are not silently dropped", t => {
  const { root, write } = setup(t), value = JSON.parse(fs.readFileSync(path.join(fixtures, "1.15.6-missions.json")));
  value.unreviewed = true; write(`.agent/missions/${value.mission_id}.json`, JSON.stringify(value));
  assert.equal(inspect(root).status, "unresolved");
});
test("invalid JSON and duplicate flat/nested Mission identity fail closed", t => {
  const { root, write } = setup(t), bytes = fs.readFileSync(path.join(fixtures, "1.15.6-missions.json")), value = JSON.parse(bytes);
  write(`.agent/missions/${value.mission_id}.json`, bytes); write(`.agent/missions/${value.mission_id}/mission.json`, bytes);
  write(".agent/tasks/T-bad.json", "{");
  const codes = inspect(root).unresolved.map(r => r.code);
  assert.ok(codes.includes("DUPLICATE_ID")); assert.ok(codes.includes("INVALID_JSON"));
});
test("database presence requests separate validation, never assumes v1 or opens it", t => {
  const { root, write } = setup(t); write(".agent/runtime/protected-permit.sqlite", Buffer.from("not a sqlite database"));
  const before = snapshot(root), result = inspect(root);
  assert.equal(result.permit_store, "unresolved"); assert.equal(result.quiescence_verified, false);
  assert.deepEqual(snapshot(root), before);
});
for (const type of ["symlink", "hardlink"]) test(`${type} rejected without following`, t => {
  const { root, write } = setup(t); write("outside.txt", "private");
  fs[type === "symlink" ? "symlinkSync" : "linkSync"](path.join(root, "outside.txt"), path.join(root, ".agent", "unsafe"));
  assert.throws(() => inspect(root), { code: "MIGRATION_UNSAFE_PATH" });
});
test("oversized file is bounded", t => {
  const { root, write } = setup(t); write(".agent/large", Buffer.alloc(8 * 1024 * 1024 + 1));
  assert.throws(() => inspect(root), { code: "MIGRATION_INVENTORY_LIMIT" });
});
test("CLI refuses mutation stages and returns deterministic read-only plan", t => {
  const { root } = setup(t), before = snapshot(root), cli = path.resolve(__dirname, "../../bin/cli.js");
  function run(action) { return spawnSync(process.execPath, [cli, "migration", action, "--project", root], { encoding: "utf8", timeout: 15000, env: { PATH: process.env.PATH, HOME: root, CORTEX_STATE_SYNC: "off" } }); }
  const a = run("plan"), b = run("plan"); assert.equal(a.status, 0, a.stderr); assert.equal(a.stdout, b.stdout);
  for (const action of ["backup", "rehearse", "verify", "apply", "switch", "activate"]) { const r = run(action); assert.equal(r.status, 2, r.stderr); assert.equal(JSON.parse(r.stdout).code, "MIGRATION_STAGE_NOT_IMPLEMENTED"); }
  assert.deepEqual(snapshot(root), before);
});
test("duplicate JSON key cannot overwrite historical status", t => {
  const { root, write } = setup(t);
  write(".agent/tasks/T-ambiguous.json", '{"task_id":"T-ambiguous","status":"draft","status":"completed"}');
  assert.equal(inspect(root).unresolved[0].code, "INVALID_JSON");
});
test("unrecognized record filename is not silently treated as no migration", t => {
  const { root, write } = setup(t); write(".agent/tasks/legacy.json", '{"approved":true}');
  assert.equal(inspect(root).unresolved[0].code, "UNCLASSIFIED_RECORD");
});
test("unknown source code is never executed during inspection", t => {
  const { root, write } = setup(t);
  write(".agent/tasks/scripts/task-state.js", 'require("fs").writeFileSync("EXECUTED", "bad"); throw Error("bad");');
  const before = snapshot(root); inspect(root); assert.deepEqual(snapshot(root), before);
});
test("nested and nonstandard record locations stay unresolved", t => {
  const { root, write } = setup(t);
  write(".agent/tasks/archive/T-old.json", '{}'); write(".agent/missions/Legacy/notes.md", '# old');
  const codes = inspect(root).unresolved.map(x => x.code);
  assert.ok(codes.includes("UNCLASSIFIED_RECORD")); assert.ok(codes.includes("UNCLASSIFIED_MISSION_DIRECTORY"));
});
test("invalid calendar date and nested duplicate keys refused", t => {
  const { root, write } = setup(t), v = JSON.parse(fs.readFileSync(path.join(fixtures, "1.15.6-missions.json")));
  v.created_at = "2026-02-30T12:00:00Z"; write(`.agent/missions/${v.mission_id}.json`, JSON.stringify(v));
  assert.ok(inspect(root).unresolved.some(x => x.code === "UNKNOWN_OR_INVALID_DATA_FORMAT"));
  write(".agent/tasks/T-duplicate.json", '{"gate":{"action":"x","action":"y"}}');
  assert.ok(inspect(root).unresolved.some(x => x.code === "INVALID_JSON"));
});
test("missing milestone and task dependency cannot pass", t => {
  const { root, write } = setup(t), m = JSON.parse(fs.readFileSync(path.join(fixtures, "1.15.6-missions.json"))), task = JSON.parse(fs.readFileSync(path.join(fixtures, "1.15.6-tasks.json")));
  m.current_milestone_id = "MS-999"; m.milestones[0].depends_on = ["MS-998"];
  task.dependencies = ["T-missing"];
  write(`.agent/missions/${m.mission_id}.json`, JSON.stringify(m)); write(`.agent/tasks/${task.task_id}.json`, JSON.stringify(task));
  const codes = inspect(root).unresolved.map(x => x.code);
  for (const code of ["MISSING_CURRENT_MILESTONE", "MISSING_MILESTONE_DEPENDENCY", "MISSING_TASK_REFERENCE"]) assert.ok(codes.includes(code), codes.join(","));
});
test("parent directory replacement never reads outside the opened directory", t => {
  const { root, write } = setup(t); write(".agent/tasks/T-old.json", "{}"); write("outside/T-private.json", "private");
  const original = fs.readdirSync; let replaced = false;
  fs.readdirSync = function(p, ...args) {
    const names = original.call(fs, p, ...args);
    if (!replaced && names.includes("T-old.json")) {
      replaced = true;
      fs.renameSync(path.join(root, ".agent/tasks"), path.join(root, ".agent/saved"));
      fs.symlinkSync(path.join(root, "outside"), path.join(root, ".agent/tasks"));
    }
    return names;
  };
  try { assert.throws(() => inspect(root)); assert.equal(replaced, true); }
  finally { fs.readdirSync = original; }
});
test("reserved filenames do not exempt unknown nested data or broken indexes", t => {
  const { root, write } = setup(t);
  for (const name of ["index.json", "sample.json", "x.schema.json"]) write(".agent/tasks/archive/" + name, '{"status":"completed"}');
  write(".agent/tasks/index.json", '{"tasks":[{"task_id":"T-missing","path":".agent/tasks/T-missing.json","status":"active","stage":"implement","updated_at":"2026-10-29T00:00:00Z"}]}');
  const codes = inspect(root).unresolved.map(x => x.code);
  assert.equal(codes.filter(x => x === "UNCLASSIFIED_RECORD").length, 3); assert.ok(codes.includes("INDEX_RECORD_MISMATCH"));
});
test("relative and array references remain unresolved, not ignored", t => {
  const { root, write } = setup(t), m = JSON.parse(fs.readFileSync(path.join(fixtures, "1.15.6-missions.json")));
  m.validation_contract_ref = "validation-contract.json";
  write(`.agent/missions/${m.mission_id}.json`, JSON.stringify(m));
  assert.ok(inspect(root).unresolved.some(x => x.code === "UNSUPPORTED_REFERENCE"));
});
test("midnight rollover spelling is invalid rather than normalized", () => {
  const { validate } = require("../../lib/offline-migration/schema");
  assert.equal(validate("2026-10-29T24:00:00Z", { type: "string", format: "date-time" }), false);
  assert.equal(validate("2024-02-29T23:59:59Z", { type: "string", format: "date-time" }), true);
});
test("concurrent growth is read at most initial size plus one", t => {
  const { root, write } = setup(t); write(".agent/growing", "x");
  const original = fs.readSync; let injected = false, readBytes = 0;
  fs.readSync = function(fd, buffer, offset, length, position) {
    if (fs.readlinkSync(`/proc/self/fd/${fd}`).endsWith("/growing")) {
      if (!injected) { fs.appendFileSync(path.join(root, ".agent/growing"), Buffer.alloc(1024 * 1024)); injected = true; }
      const n = original.call(fs, fd, buffer, offset, length, position); readBytes += n; return n;
    }
    return original.call(fs, fd, buffer, offset, length, position);
  };
  try { assert.throws(() => inspect(root), { code: "MIGRATION_SOURCE_CHANGED" }); assert.equal(readBytes, 2); }
  finally { fs.readSync = original; }
});

if (process.platform !== "linux") nodeTest("unsupported reader platform fails closed", t => { const { root } = setup(t); assert.throws(() => inspect(root), { code: "MIGRATION_SAFE_READER_UNSUPPORTED" }); });
test("index identity and timestamps cannot hide mismatched governance projection", t => {
  const { root, write } = setup(t);
  for (const kind of ["decisions", "waitpoints"]) {
    const value = JSON.parse(fs.readFileSync(path.join(fixtures, `1.15.6-${kind}.json`)));
    const idKey = kind.slice(0, -1) + "_id", rel = `.agent/${kind}/${value[idKey]}.json`;
    write(rel, JSON.stringify(value));
    const row = { [idKey]: value[idKey], path: rel, status: value.status, updated_at: value.updated_at, gate_action: value.gate.action, resource_ref: value.gate.resource_ref };
    if (kind === "decisions") row.type = value.type;
    else { row.owner_workflow = value.owner_workflow; row.decision_id = value.decision_id; }
    row.resource_ref = "different-resource";
    write(`.agent/${kind}/index.json`, JSON.stringify({ [kind]: [row] }));
    assert.ok(inspect(root).unresolved.some(x => x.path === `.agent/${kind}/index.json` && x.code === "INDEX_RECORD_MISMATCH"));
  }
});
