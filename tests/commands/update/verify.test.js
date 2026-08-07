"use strict";

// ─── lib/commands/update/verify.js unit tests ─────────────────────────────────
//
// Coverage:
//   - verificationCheck: shape + exit_code derivation per status
//   - withoutProjectArgs: filters both --project <value> and --project=<value>
//     forms; preserves everything else
//   - parseJsonCheck: skipped when file missing, passed on valid JSON,
//     failed on invalid JSON with error.message
//   - runNodeJsonCheck: passed on ok payload, failed on non-ok payload,
//     failed on spawn error, failed on invalid JSON stdout
//   - managementQueryCheck: passed when ok, failed on hard error,
//     skipped on MANAGEMENT_API_UNAVAILABLE / MANAGEMENT_API_QUERY_FAILED /
//     CAPABILITY_UNAVAILABLE
//   - runUpdateVerification: full mock — stub queryManagementProject +
//     resolveManagementProject via require-cache override (installed BEFORE
//     verify.js is loaded, since verify.js destructures these names at
//     require-time)
//   - printUpdateVerification: JSON mode prints to stdout, text mode prints
//     summary to stdout
//
// Stubbing strategy:
//   1. Delete any cached copy of management-client and the verify module
//      from require.cache.
//   2. Patch require.cache[management-client].exports with our stub
//      functions.
//   3. Require verify.js — its top-level `const { ... } = require("...")`
//      captures the stub references.
//   4. Swap stubs between tests by overwriting the same export properties.
//
// We intentionally do NOT call runNodeJsonCheck against the real
// runtime-continuity script (which may not exist in the test env) — we
// rely on the real spawn against `node -e "<inline script>"`.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const MANAGEMENT_CLIENT_PATH = require.resolve("../../../lib/management-client");
const VERIFY_PATH = require.resolve("../../../lib/commands/update/verify");

// Save original exports BEFORE we patch.
const originalManagementClient = require(MANAGEMENT_CLIENT_PATH);
const ORIGINAL_QUERY = originalManagementClient.queryManagementProject;
const ORIGINAL_RESOLVE = originalManagementClient.resolveManagementProject;

// Force-reload verify.js so it picks up the (possibly stubbed) exports.
// We delete the verify entry from require.cache, then patch the
// management-client export properties, then require verify.js (which
// re-executes its module body, including the destructure).
delete require.cache[VERIFY_PATH];

// Install default stubs. Tests can override via setStubs() before running.
let currentQueryStub = () => ({ ok: true, payload: { ok: true }, project: { root: "/x", agent_root: "/x/.agent" } });
let currentResolveStub = () => ({ ok: true, project: { root: "/x", agent_root: "/x/.agent" } });
originalManagementClient.queryManagementProject = function queryStub() {
  return currentQueryStub.apply(null, arguments);
};
originalManagementClient.resolveManagementProject = function resolveStub() {
  return currentResolveStub.apply(null, arguments);
};

// Now require verify.js — its destructure picks up the stub functions.
const verifyModule = require(VERIFY_PATH);
const {
  collectSemanticMergeCandidates,
  verificationCheck,
  parseJsonCheck,
  runNodeJsonCheck,
  managementQueryCheck,
  withoutProjectArgs,
  runUpdateVerification,
  printUpdateVerification,
} = verifyModule;

function setStubs({ queryManagementProject, resolveManagementProject }) {
  if (queryManagementProject) currentQueryStub = queryManagementProject;
  if (resolveManagementProject) currentResolveStub = resolveManagementProject;
}

function resetStubs() {
  currentQueryStub = () => ({ ok: true, payload: { ok: true }, project: { root: "/x", agent_root: "/x/.agent" } });
  currentResolveStub = () => ({ ok: true, project: { root: "/x", agent_root: "/x/.agent" } });
}

function mkRoot() {
  // Resolve symlinks so we can compare paths against the realpath'd result
  // that updateProjectDescriptor / resolveManagementProject return.
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cortex-update-verify-test-")));
}

test("verificationCheck: passed status → exit_code 0", () => {
  const c = verificationCheck("x", "passed", "node -e 1");
  assert.equal(c.name, "x");
  assert.equal(c.status, "passed");
  assert.equal(c.command, "node -e 1");
  assert.equal(c.exit_code, 0);
});

test("verificationCheck: skipped status → exit_code 0", () => {
  const c = verificationCheck("x", "skipped", "node -e 1");
  assert.equal(c.exit_code, 0);
});

test("verificationCheck: failed status → exit_code 1", () => {
  const c = verificationCheck("x", "failed", "node -e 1");
  assert.equal(c.exit_code, 1);
});

test("verificationCheck: spreads custom details (message + extra)", () => {
  const c = verificationCheck("x", "passed", "cmd", { message: "ok", extra: 1 });
  assert.equal(c.message, "ok");
  assert.equal(c.extra, 1);
});

test("withoutProjectArgs: empty input → empty output", () => {
  assert.deepEqual(withoutProjectArgs(), []);
  assert.deepEqual(withoutProjectArgs([]), []);
});

test("withoutProjectArgs: filters --project <value> pair", () => {
  assert.deepEqual(
    withoutProjectArgs(["--project", "/x", "remaining"]),
    ["remaining"],
  );
  // Only consumes one arg after --project, leaves the rest alone.
  assert.deepEqual(
    withoutProjectArgs(["a", "--project", "/x", "b"]),
    ["a", "b"],
  );
});

test("withoutProjectArgs: filters --project=<value> form", () => {
  assert.deepEqual(
    withoutProjectArgs(["--project=/x", "remaining"]),
    ["remaining"],
  );
});

test("withoutProjectArgs: preserves --proj and --projects and other -project-*", () => {
  // Defensive: only the exact --project and --project= forms are removed.
  assert.deepEqual(
    withoutProjectArgs(["--proj", "/x", "--projects", "/y", "--project-file", "/z", "keep"]),
    ["--proj", "/x", "--projects", "/y", "--project-file", "/z", "keep"],
  );
});

test("withoutProjectArgs: default empty array when no args", () => {
  // The function signature uses args = [], so undefined falls back to [].
  assert.deepEqual(withoutProjectArgs(undefined), []);
});

test("parseJsonCheck: missing file → skipped with message=file_missing", () => {
  const root = mkRoot();
  const missing = path.join(root, "nope.json");
  const c = parseJsonCheck(missing);
  assert.equal(c.status, "skipped");
  assert.equal(c.exit_code, 0);
  assert.equal(c.message, "file_missing");
  assert.match(c.name, /parse .*nope\.json/);
  assert.match(c.command, /JSON\.parse/);
});

test("parseJsonCheck: valid JSON → passed", () => {
  const root = mkRoot();
  const file = path.join(root, "good.json");
  fs.writeFileSync(file, JSON.stringify({ ok: true }));
  const c = parseJsonCheck(file);
  assert.equal(c.status, "passed");
  assert.equal(c.exit_code, 0);
});

test("parseJsonCheck: invalid JSON → failed with error.message", () => {
  const root = mkRoot();
  const file = path.join(root, "bad.json");
  fs.writeFileSync(file, "{ not json");
  const c = parseJsonCheck(file);
  assert.equal(c.status, "failed");
  assert.equal(c.exit_code, 1);
  assert.match(c.message, /JSON|Unexpected|invalid/i);
});

test("runNodeJsonCheck: passed when stdout JSON is { ok: true } and exit 0", () => {
  // Spawn a real node that prints { ok: true } and exits 0.
  const root = mkRoot();
  const c = runNodeJsonCheck(root, ["-e", "process.stdout.write(JSON.stringify({ok:true}))"], "ok-check");
  assert.equal(c.status, "passed");
  assert.equal(c.exit_code, 0);
  assert.match(c.command, /^node -e /);
});

test("runNodeJsonCheck: failed when payload is { ok: false }", () => {
  const root = mkRoot();
  const c = runNodeJsonCheck(root, ["-e", "process.stdout.write(JSON.stringify({ok:false,error:'bad'}))"], "okfalse-check");
  assert.equal(c.status, "failed");
  assert.equal(c.exit_code, 1);
  assert.match(c.message, /bad/);
});

test("runNodeJsonCheck: failed when stdout is not JSON", () => {
  const root = mkRoot();
  const c = runNodeJsonCheck(root, ["-e", "process.stdout.write('not-json')"], "notjson-check");
  assert.equal(c.status, "failed");
  assert.match(c.message, /invalid_json/);
});

test("runNodeJsonCheck: failed when spawned process exits non-zero", () => {
  const root = mkRoot();
  const c = runNodeJsonCheck(root, ["-e", "process.exit(2)"], "exit2-check");
  assert.equal(c.status, "failed");
  // exit_code is reported from the spawn result (2) or 1 fallback.
  assert.ok(c.exit_code === 2 || c.exit_code === 1);
});

test("managementQueryCheck: passed on ok result", () => {
  setStubs({
    queryManagementProject: () => ({ ok: true, payload: { ok: true }, project: { root: "/x", agent_root: "/x/.agent" } }),
    resolveManagementProject: () => ({ ok: true, project: { root: "/x", agent_root: "/x/.agent" } }),
  });
  const c = managementQueryCheck({ args: [] }, "capabilities");
  assert.equal(c.status, "passed");
  assert.equal(c.name, "query capabilities");
  assert.match(c.command, /cortex-agent query capabilities/);
});

test("managementQueryCheck: failed on hard error (non-availability code)", () => {
  setStubs({
    queryManagementProject: () => ({ ok: false, error: { code: "PROJECT_NOT_FOUND", message: "missing", details: { x: 1 } } }),
    resolveManagementProject: () => ({ ok: false, error: { code: "PROJECT_NOT_FOUND", message: "missing" } }),
  });
  const c = managementQueryCheck({ args: [] }, "activity");
  assert.equal(c.status, "failed");
  assert.equal(c.exit_code, 1);
  assert.equal(c.message, "missing");
  assert.deepEqual(c.details, { x: 1 });
});

test("managementQueryCheck: skipped on MANAGEMENT_API_UNAVAILABLE", () => {
  setStubs({
    queryManagementProject: () => ({ ok: false, error: { code: "MANAGEMENT_API_UNAVAILABLE", message: "down", details: {} } }),
    resolveManagementProject: () => ({ ok: true, project: { root: "/x", agent_root: "/x/.agent" } }),
  });
  const c = managementQueryCheck({ args: [] }, "capabilities");
  assert.equal(c.status, "skipped");
  assert.equal(c.exit_code, 0);
  assert.equal(c.message, "down");
});

test("managementQueryCheck: skipped on MANAGEMENT_API_QUERY_FAILED", () => {
  setStubs({
    queryManagementProject: () => ({ ok: false, error: { code: "MANAGEMENT_API_QUERY_FAILED", message: "x", details: {} } }),
    resolveManagementProject: () => ({ ok: true, project: { root: "/x", agent_root: "/x/.agent" } }),
  });
  const c = managementQueryCheck({ args: [] }, "capabilities");
  assert.equal(c.status, "skipped");
});

test("managementQueryCheck: skipped on CAPABILITY_UNAVAILABLE", () => {
  setStubs({
    queryManagementProject: () => ({ ok: false, error: { code: "CAPABILITY_UNAVAILABLE", message: "x", details: {} } }),
    resolveManagementProject: () => ({ ok: true, project: { root: "/x", agent_root: "/x/.agent" } }),
  });
  const c = managementQueryCheck({ args: [] }, "capabilities");
  assert.equal(c.status, "skipped");
});

test("managementQueryCheck: command string includes extra args when provided", () => {
  setStubs({
    queryManagementProject: () => ({ ok: true, payload: { ok: true }, project: { root: "/x", agent_root: "/x/.agent" } }),
    resolveManagementProject: () => ({ ok: true, project: { root: "/x", agent_root: "/x/.agent" } }),
  });
  const c = managementQueryCheck({ args: [] }, "activity", ["--since", "2025-01-01"]);
  assert.match(c.command, /cortex-agent query activity --since 2025-01-01/);
});

test("managementQueryCheck: returns a check with details={} when error has no details", () => {
  setStubs({
    queryManagementProject: () => ({ ok: false, error: { code: "OTHER", message: "x" } }),
    resolveManagementProject: () => ({ ok: true, project: { root: "/x", agent_root: "/x/.agent" } }),
  });
  const c = managementQueryCheck({ args: [] }, "x");
  // error.details is undefined → spread yields no `details` key on the check.
  assert.equal(c.details, undefined);
});

test("collectSemanticMergeCandidates: returns an array, each entry has the expected shape", () => {
  const root = mkRoot();
  fs.mkdirSync(path.join(root, ".agent", "hooks"), { recursive: true });
  fs.mkdirSync(path.join(root, ".agent", "skills", "management-api", "scripts"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "AGENTS.md"),
    [
      "# AGENTS",
      "",
      "## Cortex Session Bootstrap",
      "",
      "<!-- cortex-agent:compatibility-adapter-bootstrap:start -->",
      "some content",
      "<!-- cortex-agent:compatibility-adapter-bootstrap:end -->",
      "",
    ].join("\n"),
  );
  fs.writeFileSync(
    path.join(root, ".agent", "hooks", "hooks.json"),
    JSON.stringify({ hooks: {} }),
  );
  fs.writeFileSync(
    path.join(root, ".agent", "skills", "management-api", "scripts", "projection-registry.json"),
    JSON.stringify({}),
  );
  const ctx = {
    cwd: root,
    lang: "en",
    command: "update",
    templateDir: path.join(root, "no-template"),
    options: {},
    args: [],
  };
  const candidates = collectSemanticMergeCandidates(ctx);
  assert.ok(Array.isArray(candidates));
  for (const c of candidates) {
    assert.ok(typeof c.path === "string");
    assert.ok(typeof c.layer === "string");
    assert.ok(["add", "merge"].includes(c.action), `action must be add|merge, got ${c.action}`);
    assert.ok(typeof c.reason === "string");
    assert.ok(["low", "medium", "high"].includes(c.risk), `risk must be low|medium|high, got ${c.risk}`);
  }
});

test("runUpdateVerification: full mock — 3 parse + 1 runtime-skipped + 3 query = 7 checks (full=false)", () => {
  const root = mkRoot();
  fs.mkdirSync(path.join(root, ".agent", "hooks"), { recursive: true });
  fs.mkdirSync(path.join(root, ".claude"), { recursive: true });
  fs.mkdirSync(path.join(root, ".agent", "skills", "management-api", "scripts"), { recursive: true });
  fs.writeFileSync(path.join(root, ".agent", "hooks", "hooks.json"), "{}");
  fs.writeFileSync(path.join(root, ".claude", "settings.json"), "{}");
  fs.writeFileSync(
    path.join(root, ".agent", "skills", "management-api", "scripts", "projection-registry.json"),
    "{}",
  );
  // No runtime-continuity script → that check is "skipped" with
  // "runtime_continuity_unavailable".

  setStubs({
    queryManagementProject: () => ({ ok: true, payload: { ok: true }, project: { root, agent_root: path.join(root, ".agent") } }),
    resolveManagementProject: () => ({ ok: true, project: { root, agent_root: path.join(root, ".agent") } }),
  });
  const ctx = {
    cwd: root,
    lang: "en",
    command: "update",
    templateDir: "/no/template",
    options: {},
    args: ["update", "--project", root, "--extra", "value"],
  };
  const report = runUpdateVerification(ctx);
  assert.equal(report.ok, true);
  assert.equal(report.schema_version, 1);
  assert.equal(report.command, "update");
  assert.equal(report.mode, "verify");
  assert.equal(typeof report.generated_at, "string");
  assert.equal(report.project.root, root);
  // 3 json parse + 1 runtime (skipped) + 3 management query = 7
  assert.equal(report.summary.total, 7);
  assert.equal(report.summary.passed, 6, "3 parse + 3 query = 6 passed");
  assert.equal(report.summary.skipped, 1, "runtime-continuity skipped");
  assert.equal(report.summary.failed, 0);
  // The 3 query checks pass ctx with --project stripped.
  const queryChecks = report.verification.filter((v) => v.name.startsWith("query "));
  assert.equal(queryChecks.length, 3);
  for (const q of queryChecks) {
    assert.doesNotMatch(q.command, /--project/, "--project must be stripped from query command");
  }
  // runtime check is skipped
  const runtimeCheck = report.verification.find((v) => v.name === "runtime resume-bundle");
  assert.equal(runtimeCheck.status, "skipped");
  assert.equal(runtimeCheck.message, "runtime_continuity_unavailable");
});

test("runUpdateVerification: full=true adds a 4th management query (activity without --since)", () => {
  const root = mkRoot();
  fs.mkdirSync(path.join(root, ".agent", "hooks"), { recursive: true });
  fs.mkdirSync(path.join(root, ".claude"), { recursive: true });
  fs.mkdirSync(path.join(root, ".agent", "skills", "management-api", "scripts"), { recursive: true });
  fs.writeFileSync(path.join(root, ".agent", "hooks", "hooks.json"), "{}");
  fs.writeFileSync(path.join(root, ".claude", "settings.json"), "{}");
  fs.writeFileSync(
    path.join(root, ".agent", "skills", "management-api", "scripts", "projection-registry.json"),
    "{}",
  );
  setStubs({
    queryManagementProject: () => ({ ok: true, payload: { ok: true }, project: { root, agent_root: path.join(root, ".agent") } }),
    resolveManagementProject: () => ({ ok: true, project: { root, agent_root: path.join(root, ".agent") } }),
  });
  const ctx = {
    cwd: root,
    lang: "en",
    command: "update",
    templateDir: "/no/template",
    options: {},
    args: ["update"],
  };
  const report = runUpdateVerification(ctx, { full: true });
  assert.equal(report.mode, "verify-full");
  // 3 json + 1 runtime + 3 query + 1 full-query = 8
  assert.equal(report.summary.total, 8);
  const queryChecks = report.verification.filter((v) => v.name === "query activity");
  assert.equal(queryChecks.length, 2, "full mode adds an extra activity query");
});

test("runUpdateVerification: failed checks set ok=false", () => {
  const root = mkRoot();
  fs.mkdirSync(path.join(root, ".agent", "hooks"), { recursive: true });
  fs.mkdirSync(path.join(root, ".claude"), { recursive: true });
  fs.mkdirSync(path.join(root, ".agent", "skills", "management-api", "scripts"), { recursive: true });
  // Make hooks.json INVALID so parseJsonCheck returns failed.
  fs.writeFileSync(path.join(root, ".agent", "hooks", "hooks.json"), "{ broken json");
  fs.writeFileSync(path.join(root, ".claude", "settings.json"), "{}");
  fs.writeFileSync(
    path.join(root, ".agent", "skills", "management-api", "scripts", "projection-registry.json"),
    "{}",
  );
  setStubs({
    queryManagementProject: () => ({ ok: true, payload: { ok: true }, project: { root, agent_root: path.join(root, ".agent") } }),
    resolveManagementProject: () => ({ ok: true, project: { root, agent_root: path.join(root, ".agent") } }),
  });
  const ctx = {
    cwd: root,
    lang: "en",
    command: "update",
    templateDir: "/no/template",
    options: {},
    args: ["update"],
  };
  const report = runUpdateVerification(ctx);
  assert.equal(report.ok, false);
  assert.ok(report.summary.failed >= 1);
});

test("runUpdateVerification: resolveManagementProject failure falls back to updateProjectDescriptor", () => {
  // resolveManagementProject returns ok=false → runUpdateVerification
  // must fall back to updateProjectDescriptor(ctx.cwd, <cwd>/.agent).
  const root = mkRoot();
  fs.mkdirSync(path.join(root, ".agent", "hooks"), { recursive: true });
  fs.mkdirSync(path.join(root, ".claude"), { recursive: true });
  fs.mkdirSync(path.join(root, ".agent", "skills", "management-api", "scripts"), { recursive: true });
  fs.writeFileSync(path.join(root, ".agent", "hooks", "hooks.json"), "{}");
  fs.writeFileSync(path.join(root, ".claude", "settings.json"), "{}");
  fs.writeFileSync(
    path.join(root, ".agent", "skills", "management-api", "scripts", "projection-registry.json"),
    "{}",
  );
  setStubs({
    queryManagementProject: () => ({ ok: true, payload: { ok: true }, project: { root, agent_root: path.join(root, ".agent") } }),
    resolveManagementProject: () => ({ ok: false, error: { code: "PROJECT_NOT_FOUND", message: "x" } }),
  });
  const ctx = {
    cwd: root,
    lang: "en",
    command: "update",
    templateDir: "/no/template",
    options: {},
    args: ["update"],
  };
  const report = runUpdateVerification(ctx);
  // Project descriptor built from ctx.cwd (realpath'd) + <cwd>/.agent.
  assert.equal(report.project.root, root);
  assert.equal(report.project.agent_root, path.join(root, ".agent"));
});

test("printUpdateVerification: JSON mode → emits JSON to stdout via printManagementPayload", () => {
  resetStubs();
  const ctx = { lang: "en", options: { report: "json" }, args: [] };
  const report = { verification: [], summary: { passed: 0, skipped: 0, failed: 0 } };
  const origWrite = process.stdout.write.bind(process.stdout);
  let captured = "";
  process.stdout.write = (chunk) => { captured += String(chunk); return true; };
  try {
    printUpdateVerification(ctx, report);
  } finally {
    process.stdout.write = origWrite;
  }
  // printManagementPayload writes pretty JSON + newline
  const parsed = JSON.parse(captured);
  assert.deepEqual(parsed, report);
});

test("printUpdateVerification: text mode (en) → human-readable lines to stdout", () => {
  resetStubs();
  const ctx = { lang: "en", options: {}, args: [] };
  const report = {
    verification: [
      { name: "a", status: "passed" },
      { name: "b", status: "skipped", message: "down" },
      { name: "c", status: "failed", message: "bad" },
    ],
    summary: { passed: 1, skipped: 1, failed: 1 },
  };
  const origWrite = process.stdout.write.bind(process.stdout);
  let captured = "";
  process.stdout.write = (chunk) => { captured += String(chunk); return true; };
  try {
    printUpdateVerification(ctx, report);
  } finally {
    process.stdout.write = origWrite;
  }
  assert.match(captured, /Update verification/);
  assert.match(captured, /✓ a: passed/);
  assert.match(captured, /- b: skipped \(down\)/);
  assert.match(captured, /! c: failed \(bad\)/);
  assert.match(captured, /summary: 1 passed, 1 skipped, 1 failed/);
});

test("printUpdateVerification: text mode (zh) → 中文 banner", () => {
  resetStubs();
  const ctx = { lang: "zh", options: {}, args: [] };
  const report = {
    verification: [{ name: "a", status: "passed" }],
    summary: { passed: 1, skipped: 0, failed: 0 },
  };
  const origWrite = process.stdout.write.bind(process.stdout);
  let captured = "";
  process.stdout.write = (chunk) => { captured += String(chunk); return true; };
  try {
    printUpdateVerification(ctx, report);
  } finally {
    process.stdout.write = origWrite;
  }
  assert.match(captured, /Update 验证结果/);
});
