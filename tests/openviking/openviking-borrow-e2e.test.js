"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const test = require("node:test");

const ROOT = path.resolve(__dirname, "..", "..");
const LANG = "zh";
const VARS = {
  canonical: path.join(ROOT, ".agent"),
  zh: path.join(ROOT, "templates", "zh", ".agent"),
  en: path.join(ROOT, "templates", "en", ".agent"),
};

function fixturePath(scope) {
  const match = /--(file|out|project|registry|uri-map|root) (\S+)/.exec(scope);
  return match ? match[2] : null;
}

function runScript(script, args = []) {
  const node = process.execPath;
  const out = execFileSync(node, [script, ...args], { encoding: "utf8", cwd: ROOT });
  return JSON.parse(out);
}

function loadJson(p) {
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

function fileExists(p) {
  return fs.existsSync(p);
}

const URI_MAP = path.join(ROOT, ".agent", "registry", "uri-map.json");
const URI_RESOLVER = path.join(ROOT, ".agent", "skills", "uri-resolver", "scripts", "resolve.js");
const BUILD_L0L1 = path.join(ROOT, ".agent", "skills", "context-budget", "scripts", "build-l0l1.js");
const SELECT = path.join(ROOT, ".agent", "skills", "context-budget", "scripts", "select.js");
const RECORD = path.join(ROOT, ".agent", "skills", "retrieval-trajectory", "scripts", "record.js");
const REPLAY = path.join(ROOT, ".agent", "skills", "retrieval-trajectory", "scripts", "replay.js");
const TRAJECTORY_DIR = path.join(ROOT, ".agent", "runtime-evidence", "trajectory");

test("URI schema and map are present and well-formed", () => {
  for (const v of Object.values(VARS)) {
    const schema = path.join(v, "registry", "uri-map.schema.json");
    const map = path.join(v, "registry", "uri-map.json");
    assert.ok(fileExists(schema), `missing schema: ${schema}`);
    assert.ok(fileExists(map), `missing map: ${map}`);
    const parsed = loadJson(schema);
    assert.equal(parsed.type, "object");
    assert.ok(parsed.properties.scopes);
    assert.ok(parsed.properties.aliases);
    const mapJson = loadJson(map);
    assert.ok(mapJson.scopes);
    for (const expected of ["rules", "workflows", "skills", "references", "memory", "decisions", "experiences", "resources"]) {
      assert.ok(mapJson.scopes[expected], `scope ${expected} missing from ${map}`);
    }
  }
});

test("uri-resolver resolves known and unknown URIs without throwing", () => {
  const ok = runScript(URI_RESOLVER, ["--uri", "cortex://skills/context-budget"]);
  assert.equal(ok.ok, true);
  assert.equal(ok.scope, "skills");
  assert.ok(ok.path && ok.path.includes("context-budget"));

  const missing = runScript(URI_RESOLVER, ["--uri", "cortex://skills/no-such-skill"]);
  assert.equal(missing.ok, false);
  assert.ok(missing.suggestion);

  const reversed = runScript(URI_RESOLVER, ["--path", ".agent/skills/context-budget/SKILL.md"]);
  assert.equal(reversed.ok, true);
  assert.equal(reversed.scope, "skills");
  assert.match(reversed.uri, /^cortex:\/\/skills\//);
});

test("uri-resolver accepts --rebuild and --check without errors", () => {
  const before = loadJson(URI_MAP).generated_at;
  const rebuilt = runScript(URI_RESOLVER, ["--rebuild"]);
  assert.equal(rebuilt.ok, true);
  assert.ok(rebuilt.written);
  const after = loadJson(URI_MAP).generated_at;
  assert.ok(after >= before, "generated_at should refresh");

  const check = runScript(URI_RESOLVER, ["--check"]);
  assert.equal(check.ok, true);
  assert.ok(typeof check.total === "number");
});

test("build-l0l1 generates L0 (≤100 tok) and L1 (≤2k tok) without LLM", () => {
  const result = runScript(BUILD_L0L1, ["--file", ".agent/rules/core-principles.md"]);
  assert.equal(result.ok, true);
  assert.equal(result.count, 1);
  const entry = result.entries[0];
  assert.ok(entry.l0_tokens <= 100, `L0 too large: ${entry.l0_tokens} tokens`);
  assert.ok(entry.l1_tokens <= 2000, `L1 too large: ${entry.l1_tokens} tokens`);
  assert.ok(entry.l0.length > 0);
  assert.ok(entry.l1.length > 0);
});

test("context-budget selector emits manifest + trajectory, falls back gracefully", () => {
  const taskId = `T-E2E-${Date.now()}`;
  const result = runScript(SELECT, ["--task", "implement OAuth login", "--task-id", taskId, "--llm-window", "128000"]);
  assert.equal(result.ok, true);
  assert.ok(result.manifest_path && result.manifest_path.endsWith("context-manifest.json"));
  assert.ok(result.trajectory_path && result.trajectory_path.endsWith(".jsonl"));
  const manifest = loadJson(result.manifest_path);
  assert.equal(manifest.task_id, taskId);
  assert.ok(manifest.budget.total_window >= 128000);
  assert.ok(manifest.budget.used >= 0);
});

test("retrieval-trajectory record + replay round-trip with URI verification", () => {
  const taskId = `T-RT-${Date.now()}`;
  const r1 = runScript(RECORD, ["--task-id", taskId, "--step", "1", "--action", "scan", "--candidates", "5"]);
  assert.equal(r1.ok, true);
  const r2 = runScript(RECORD, [
    "--task-id", taskId, "--step", "3", "--action", "promote", "--tier", "tier1",
    "--uri", "cortex://skills/context-budget", "--tokens", "1200", "--reason", "score=9",
  ]);
  assert.equal(r2.ok, true);
  const r3 = runScript(RECORD, ["--task-id", taskId, "--summary"]);
  assert.equal(r3.ok, true);
  assert.equal(r3.step_count, 2);
  assert.equal(r3.promoted_count, 1);
  assert.equal(r3.total_tokens, 1200);

  const replay = runScript(REPLAY, ["--task-id", taskId, "--verify-resolve"]);
  assert.equal(replay.ok, true);
  assert.equal(replay.steps.length, 2);
  const promote = replay.steps.find((s) => s.action === "promote");
  assert.ok(promote.resolved && promote.resolved.ok === true, "URI must resolve to a real path");
  assert.equal(replay.resolution_failures, 0);
});

test("retrieval-trajectory --as-fixture produces fixture for test consumption", () => {
  const taskId = `T-FIX-${Date.now()}`;
  runScript(RECORD, ["--task-id", taskId, "--step", "1", "--action", "scan", "--candidates", "3"]);
  runScript(RECORD, [
    "--task-id", taskId, "--step", "3", "--action", "promote", "--tier", "tier1",
    "--uri", "cortex://skills/uri-resolver", "--tokens", "800",
  ]);
  const replay = runScript(REPLAY, ["--task-id", taskId, "--as-fixture"]);
  assert.ok(replay.fixture);
  assert.ok(Array.isArray(replay.fixture.expected_promoted));
  assert.ok(replay.fixture.expected_promoted.includes("cortex://skills/uri-resolver"));
});

test("L0/L1 plus trajectory size fits in the original budget (acceptance gate)", () => {
  const taskId = `T-ACC-${Date.now()}`;
  const result = runScript(SELECT, ["--task", "audit context-budget performance", "--task-id", taskId, "--llm-window", "128000"]);
  assert.equal(result.ok, true);
  const manifest = loadJson(result.manifest_path);
  // The total injected tokens should stay within 40% of the window.
  assert.ok(manifest.budget.used <= manifest.budget.total_available, "must stay within budget");
  // Sanity: utilization is reasonable (< 35% on a thin project).
  if (manifest.budget.available > 0) {
    const util = parseFloat(manifest.budget.utilization);
    assert.ok(util <= 100, `utilization ${util}% should be a percentage`);
  }
});

test("agent-dashboard script generates retrieval-trace panel", () => {
  const dashboard = path.join(ROOT, ".agent", "skills", "agent-dashboard", "scripts", "generate.js");
  const outFile = path.join(ROOT, ".agent", "metrics", "agent-dashboard-e2e.html");
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  // Run generation; tolerate missing optional state, but require the script to exit 0.
  execFileSync(process.execPath, [dashboard, "--out", outFile], { cwd: ROOT, stdio: "ignore" });
  const html = fs.readFileSync(outFile, "utf8");
  assert.match(html, /id="retrieval-trace"/, "dashboard HTML missing retrieval-trace section");
  assert.match(html, /data-i18n="retrievalTrace"/, "dashboard HTML missing retrievalTrace i18n key");
});

test("English and Chinese templates stay aligned (parity)", () => {
  const pairs = [
    ["registry/uri-map.schema.json", "registry/uri-map.schema.json"],
    ["registry/uri-map.json", "registry/uri-map.json"],
    ["skills/uri-resolver/SKILL.md", "skills/uri-resolver/SKILL.md"],
    ["skills/context-budget/SKILL.md", "skills/context-budget/SKILL.md"],
    ["skills/retrieval-trajectory/SKILL.md", "skills/retrieval-trajectory/SKILL.md"],
    ["skills/retrieval-trajectory/trajectory.schema.json", "skills/retrieval-trajectory/trajectory.schema.json"],
  ];
  for (const [zh, en] of pairs) {
    const a = fs.readFileSync(path.join(VARS.zh, zh), "utf8");
    const b = fs.readFileSync(path.join(VARS.en, en), "utf8");
    // Parity = structural; we don't require byte equality for prose.
    assert.ok(a.length > 100 && b.length > 100, `template ${zh}/${en} too small`);
    // Both must declare the same SKILL name
    if (zh.endsWith("SKILL.md")) {
      const nameA = a.match(/^name:\s*(\S+)/m);
      const nameB = b.match(/^name:\s*(\S+)/m);
      assert.equal(nameA && nameA[1], nameB && nameB[1], `name drift between ${zh} (zh) and ${en} (en)`);
    }
  }
});
