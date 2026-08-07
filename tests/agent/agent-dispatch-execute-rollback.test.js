"use strict";

// ─── Rollback Tests (M-003 MS-004 / F-009) ───────────────────────────────────
//
// Coverage: lib/agents/dispatch-execute.js unified rollback semantics across
// the 3 protocols (HTTP / CLI / file). Per D-FAE-002-4 + validation contract
// `VC-M-003-MS-004-dispatch.json` AC #4 + risk #3:
//
//   - Success path writes result.json + rollback.json (status: completed)
//   - Failure path writes error.json + rollback.json (status: rolled_back)
//   - If rollback.json write itself fails → rollback-failed.json with
//     notify_parent: true (parent agent watcher pickup)
//   - All 3 protocols share the same journal layout
//     (.agent-runtime/dispatch/<run_id>/{request,result|error,rollback}.json)
//
// Hard constraints honored:
//   - Zero npm deps. node:fs / node:path / node:child_process / node:assert.
//   - Subprocess isolation via fake Node script binaries (no real CLI).
//   - Each test gets its own mkdtemp project root for journal isolation.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  dispatchExecuteProtocol,
  PROTOCOLS,
} = require("../../lib/agents/dispatch-execute");

// ─── helpers ──────────────────────────────────────────────────────────────

function mkProject() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "m003-ms004-rb-"));
}
function rmProject(root) {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) { /* ignore */ }
}
function journalDir(root, runId) {
  return path.join(root, ".agent-runtime", "dispatch", runId);
}
function journalFile(root, runId, name) {
  return path.join(journalDir(root, runId), name);
}
function readJournal(root, runId, name) {
  const file = journalFile(root, runId, name);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, "utf8"));
}
function listJournal(root, runId) {
  const dir = journalDir(root, runId);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).sort();
}
function makeFakeCli(body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "m003-ms004-rb-fake-"));
  const file = path.join(dir, "fake.js");
  fs.writeFileSync(file, body, "utf8");
  fs.chmodSync(file, 0o755);
  return { dir, file };
}

// ─── AC #4: 3 protocol unified rollback on success ──────────────────────

test("rollback: HTTP success writes result.json + rollback.json (completed)", async () => {
  const root = mkProject();
  try {
    const r = await dispatchExecuteProtocol({
      protocol: PROTOCOLS.HTTP,
      projectRoot: root,
      runId: "R-rb-http-ok",
      url: "http://stub",
      transport: async () => ({ statusCode: 200, headers: {}, body: JSON.stringify({ ok: true }), latency_ms: 1 }),
      backoffMs: 10,
    });
    assert.equal(r.status, "ok");
    assert.ok(readJournal(root, "R-rb-http-ok", "request.json"));
    const res = readJournal(root, "R-rb-http-ok", "result.json");
    const rb = readJournal(root, "R-rb-http-ok", "rollback.json");
    assert.equal(res.status, "ok");
    assert.equal(rb.status, "completed");
    assert.equal(rb.reason, "real dispatch completed successfully; no rollback needed");
  } finally { rmProject(root); }
});

test("rollback: CLI success writes result.json + rollback.json (completed)", async () => {
  const { dir, file } = makeFakeCli(
    `'use strict';
process.stdin.on("data", () => {});
process.stdin.on("end", () => {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { ok: true } }));
  process.exit(0);
});`,
  );
  const root = mkProject();
  try {
    const r = await dispatchExecuteProtocol({
      protocol: PROTOCOLS.CLI,
      projectRoot: root,
      runId: "R-rb-cli-ok",
      bin: process.execPath,
      args: [file],
      shell: false,
      payload: {},
      timeout: 5,
      backoffMs: 10,
    });
    assert.equal(r.status, "ok");
    const res = readJournal(root, "R-rb-cli-ok", "result.json");
    const rb = readJournal(root, "R-rb-cli-ok", "rollback.json");
    assert.equal(res.status, "ok");
    assert.equal(res.protocol, "cli");
    assert.equal(rb.status, "completed");
    assert.equal(rb.protocol, "cli");
  } finally { rmProject(root); rmProject(dir); }
});

test("rollback: file success writes result.json + rollback.json (completed)", async () => {
  const root = mkProject();
  const configPath = path.join(root, "cfg.json");
  const outputPath = path.join(root, "out.json");
  fs.writeFileSync(configPath, "{}", "utf8");
  try {
    const r = await dispatchExecuteProtocol({
      protocol: PROTOCOLS.FILE,
      projectRoot: root,
      runId: "R-rb-file-ok",
      configPath,
      outputPath,
      timeout: 5,
      backoffMs: 10,
    });
    assert.equal(r.status, "ok");
    const res = readJournal(root, "R-rb-file-ok", "result.json");
    const rb = readJournal(root, "R-rb-file-ok", "rollback.json");
    assert.equal(res.status, "ok");
    assert.equal(res.protocol, "file");
    assert.equal(rb.status, "completed");
    assert.equal(rb.protocol, "file");
  } finally { rmProject(root); }
});

// ─── AC #4: 3 protocol unified rollback on failure ──────────────────────

test("rollback: HTTP failure → error.json + rollback.json (rolled_back)", async () => {
  const root = mkProject();
  try {
    const r = await dispatchExecuteProtocol({
      protocol: PROTOCOLS.HTTP,
      projectRoot: root,
      runId: "R-rb-http-fail",
      url: "http://stub",
      transport: async () => {
        const e = new Error("server gone");
        e.statusCode = 503;
        throw e;
      },
      maxRetries: 2,
      backoffMs: 10,
    });
    assert.equal(r.status, "failed");
    const err = readJournal(root, "R-rb-http-fail", "error.json");
    const rb = readJournal(root, "R-rb-http-fail", "rollback.json");
    assert.equal(err.status, "failed");
    assert.equal(err.error.status_code, 503);
    assert.equal(rb.status, "rolled_back");
    assert.equal(rb.protocol, "http");
  } finally { rmProject(root); }
});

test("rollback: CLI failure → error.json + rollback.json (rolled_back)", async () => {
  const { dir, file } = makeFakeCli(
    `'use strict';
process.stdin.on("data", () => {});
process.stdin.on("end", () => {
  process.stderr.write("nope\\n");
  process.exit(7);
});`,
  );
  const root = mkProject();
  try {
    const r = await dispatchExecuteProtocol({
      protocol: PROTOCOLS.CLI,
      projectRoot: root,
      runId: "R-rb-cli-fail",
      bin: process.execPath,
      args: [file],
      shell: false,
      payload: {},
      timeout: 5,
      maxRetries: 2,
      backoffMs: 10,
    });
    assert.equal(r.status, "failed");
    const err = readJournal(root, "R-rb-cli-fail", "error.json");
    const rb = readJournal(root, "R-rb-cli-fail", "rollback.json");
    assert.equal(err.status, "failed");
    assert.equal(err.error.code, "ERR_CLI_EXIT_NONZERO");
    assert.equal(err.error.exit_code, 7);
    assert.equal(rb.status, "rolled_back");
    assert.match(rb.reason, /rollback journal written/);
  } finally { rmProject(root); rmProject(dir); }
});

test("rollback: file failure → error.json + rollback.json (rolled_back)", async () => {
  const root = mkProject();
  try {
    const r = await dispatchExecuteProtocol({
      protocol: PROTOCOLS.FILE,
      projectRoot: root,
      runId: "R-rb-file-fail",
      configPath: path.join(root, "missing.json"), // not present
      outputPath: path.join(root, "out.json"),
      timeout: 5,
      maxRetries: 1, // ERR_FILE_CONFIG_NOT_FOUND → rollback immediately
      backoffMs: 10,
    });
    assert.equal(r.status, "failed");
    const err = readJournal(root, "R-rb-file-fail", "error.json");
    const rb = readJournal(root, "R-rb-file-fail", "rollback.json");
    assert.equal(err.status, "failed");
    assert.equal(err.error.code, "ERR_FILE_CONFIG_NOT_FOUND");
    assert.equal(rb.status, "rolled_back");
  } finally { rmProject(root); }
});

// ─── AC #4: 3 protocol unified rollback-failed (secondary failure) ───────

test("rollback: HTTP rollback write fails → rollback-failed.json + notify_parent", async () => {
  const root = mkProject();
  try {
    // Pre-create the dispatch dir as a FILE (blocker). The first
    // writeDispatchArtifact (request.json) will fail → ERR_REQUEST_WRITE_FAILED
    // is returned directly, NOT going through _writeErrorAndRollback. So we
    // need a different setup: allow request.json to write, but block
    // rollback.json. The cleanest way is to write the dispatch dir as a
    // regular file, then allow mkdir to succeed for the first call but fail
    // for subsequent. Easiest: pre-create the dir as a file at the
    // rollback.json path level. We use the *result* file as the blocker
    // since it's written after the error.
    // Simplest reproducible scenario: pre-create the file at the run path
    // (not dir) — but the test infra expects a dir. We use a different
    // approach: a custom `transport` that throws AFTER request.json is
    // written, and we block the rollback write by pre-creating the run dir
    // as a non-directory file? Actually no — we need to block SPECIFICALLY
    // the rollback.json write.
    //
    // Trick: the result.json / error.json writes happen first; if THOSE
    // succeed, then rollback.json is written. We block the rollback.json
    // by making the .tmp-<pid>-<ts> rename fail. We can simulate by
    // writing a directory at the rollback.json path *before* the
    // dispatch. fs.writeFileSync on a path that is a directory throws EISDIR.
    // Then writeDispatchArtifact's writeFileSync will fail.
    // However, the FIRST write (request.json) happens before any error, so
    // it succeeds. The error then triggers _writeErrorAndRollback, which
    // first writes error.json (succeeds — error.json path is not blocked),
    // then writes rollback.json (fails — we blocked it). Then it writes
    // rollback-failed.json (succeeds — we didn't block THAT one).
    const runId = "R-rb-http-fail-rb-fail";
    const rollPath = journalFile(root, runId, "rollback.json");
    // Don't create the run dir yet; dispatch will mkdir. We need to block
    // rollback.json AFTER the run dir exists. The dispatch loop:
    //   1. ensureDispatchDir → creates run dir
    //   2. writeDispatchArtifact("request.json") → succeeds
    //   3. transport throws
    //   4. _writeErrorAndRollback:
    //      a. writeDispatchArtifact("error.json") → succeeds
    //      b. writeDispatchArtifact("rollback.json") → we block this
    //      c. writeDispatchArtifact("rollback-failed.json") → succeeds
    //
    // To block (b), we need the .tmp-<pid>-<ts> rename to fail. Easiest:
    // pre-create a directory at the .tmp-* path? Not portable. Better:
    // pre-create a directory at the rollback.json FINAL path. When
    // writeDispatchArtifact does:
    //   const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
    //   fs.writeFileSync(tmp, ...);  // succeeds (tmp doesn't exist)
    //   fs.renameSync(tmp, file);    // fails if file is a directory
    // Yes, this works. Pre-create rollback.json as a directory.
    fs.mkdirSync(journalDir(root, runId), { recursive: true });
    fs.mkdirSync(rollPath);

    const r = await dispatchExecuteProtocol({
      protocol: PROTOCOLS.HTTP,
      projectRoot: root,
      runId,
      url: "http://stub",
      transport: async () => {
        const e = new Error("server gone"); e.statusCode = 503; throw e;
      },
      maxRetries: 1, // 1 attempt = 1 try; defaultDecision: exhausted → rollback
      backoffMs: 10,
    });
    assert.equal(r.status, "failed");
    const rbFailed = readJournal(root, runId, "rollback-failed.json");
    assert.ok(rbFailed, "rollback-failed.json should be written");
    assert.equal(rbFailed.status, "rollback_failed");
    assert.equal(rbFailed.notify_parent, true);
    assert.ok(rbFailed.primary_error);
    assert.ok(rbFailed.rollback_error);
    assert.equal(rbFailed.rollback_error.code, "ERR_ROLLBACK_WRITE_FAILED");
  } finally { rmProject(root); }
});

test("rollback: CLI rollback write fails → rollback-failed.json + notify_parent", async () => {
  const root = mkProject();
  try {
    const runId = "R-rb-cli-fail-rb-fail";
    fs.mkdirSync(journalDir(root, runId), { recursive: true });
    fs.mkdirSync(journalFile(root, runId, "rollback.json"));
    // We don't even need a real binary — the transport will throw before
    // the binary runs, because the rollback write is blocked.
    // But _writeErrorAndRollback will catch the rollback error. We still
    // need the FIRST attempt to fail so we go to _writeErrorAndRollback.
    // Use a fake CLI that exits non-zero.
    const { dir, file } = makeFakeCli(
      `'use strict'; process.stdin.on("data", () => {}); process.stdin.on("end", () => process.exit(7));`,
    );
    const r = await dispatchExecuteProtocol({
      protocol: PROTOCOLS.CLI,
      projectRoot: root,
      runId,
      bin: process.execPath,
      args: [file],
      shell: false,
      payload: {},
      timeout: 5,
      maxRetries: 1,
      backoffMs: 10,
    });
    assert.equal(r.status, "failed");
    const rbFailed = readJournal(root, runId, "rollback-failed.json");
    assert.ok(rbFailed, "rollback-failed.json should be written");
    assert.equal(rbFailed.status, "rollback_failed");
    assert.equal(rbFailed.notify_parent, true);
    assert.equal(rbFailed.rollback_error.code, "ERR_ROLLBACK_WRITE_FAILED");
    rmProject(dir);
  } finally { rmProject(root); }
});

test("rollback: file rollback write fails → rollback-failed.json + notify_parent", async () => {
  const root = mkProject();
  try {
    const runId = "R-rb-file-fail-rb-fail";
    fs.mkdirSync(journalDir(root, runId), { recursive: true });
    fs.mkdirSync(journalFile(root, runId, "rollback.json"));
    // file protocol with missing config → ERR_FILE_CONFIG_NOT_FOUND (rollback
    // immediately, no retry). The rollback write will be blocked → fallback
    // to rollback-failed.json.
    const r = await dispatchExecuteProtocol({
      protocol: PROTOCOLS.FILE,
      projectRoot: root,
      runId,
      configPath: path.join(root, "nope.json"),
      outputPath: path.join(root, "out.json"),
      timeout: 5,
      maxRetries: 1,
      backoffMs: 10,
    });
    assert.equal(r.status, "failed");
    const rbFailed = readJournal(root, runId, "rollback-failed.json");
    assert.ok(rbFailed, "rollback-failed.json should be written");
    assert.equal(rbFailed.status, "rollback_failed");
    assert.equal(rbFailed.notify_parent, true);
  } finally { rmProject(root); }
});

// ─── AC #4: 3 protocol share the same journal layout ────────────────────

test("rollback: 3 protocols all use .agent-runtime/dispatch/<run_id>/", async () => {
  const root = mkProject();
  try {
    // HTTP
    await dispatchExecuteProtocol({
      protocol: PROTOCOLS.HTTP,
      projectRoot: root,
      runId: "R-rb-layout-http",
      url: "http://stub",
      transport: async () => ({ statusCode: 200, headers: {}, body: "{}", latency_ms: 1 }),
      backoffMs: 10,
    });
    // CLI
    const { dir, file } = makeFakeCli(
      `'use strict'; process.stdin.on("data", () => {}); process.stdin.on("end", () => { process.stdout.write(JSON.stringify({})); process.exit(0); });`,
    );
    await dispatchExecuteProtocol({
      protocol: PROTOCOLS.CLI,
      projectRoot: root,
      runId: "R-rb-layout-cli",
      bin: process.execPath,
      args: [file],
      shell: false,
      payload: {},
      timeout: 5,
      backoffMs: 10,
    });
    rmProject(dir);
    // file
    const cfgPath = path.join(root, "layout-cfg.json");
    const outPath = path.join(root, "layout-out.json");
    fs.writeFileSync(cfgPath, "{}", "utf8");
    await dispatchExecuteProtocol({
      protocol: PROTOCOLS.FILE,
      projectRoot: root,
      runId: "R-rb-layout-file",
      configPath: cfgPath,
      outputPath: outPath,
      timeout: 5,
      backoffMs: 10,
    });
    // All 3 should have the same canonical layout
    for (const runId of ["R-rb-layout-http", "R-rb-layout-cli", "R-rb-layout-file"]) {
      const files = listJournal(root, runId);
      assert.ok(files.includes("request.json"), `${runId}: missing request.json`);
      assert.ok(files.includes("result.json"), `${runId}: missing result.json`);
      assert.ok(files.includes("rollback.json"), `${runId}: missing rollback.json`);
      assert.ok(!files.includes("error.json"), `${runId}: should not have error.json on success`);
    }
  } finally { rmProject(root); }
});

// ─── AC #4: 3 protocol all include protocol field in journal ───────────

test("rollback: 3 protocols all record 'protocol' field in journal", async () => {
  const root = mkProject();
  try {
    await dispatchExecuteProtocol({
      protocol: PROTOCOLS.HTTP,
      projectRoot: root,
      runId: "R-rb-protofield-http",
      url: "http://stub",
      transport: async () => ({ statusCode: 200, headers: {}, body: "{}", latency_ms: 1 }),
      backoffMs: 10,
    });
    assert.equal(readJournal(root, "R-rb-protofield-http", "request.json").protocol, "http");
    assert.equal(readJournal(root, "R-rb-protofield-http", "result.json").protocol, "http");
    assert.equal(readJournal(root, "R-rb-protofield-http", "rollback.json").protocol, "http");

    const { dir, file } = makeFakeCli(
      `'use strict'; process.stdin.on("data", () => {}); process.stdin.on("end", () => { process.stdout.write(JSON.stringify({})); process.exit(0); });`,
    );
    await dispatchExecuteProtocol({
      protocol: PROTOCOLS.CLI,
      projectRoot: root,
      runId: "R-rb-protofield-cli",
      bin: process.execPath,
      args: [file],
      shell: false,
      payload: {},
      timeout: 5,
      backoffMs: 10,
    });
    rmProject(dir);
    assert.equal(readJournal(root, "R-rb-protofield-cli", "request.json").protocol, "cli");
    assert.equal(readJournal(root, "R-rb-protofield-cli", "result.json").protocol, "cli");
    assert.equal(readJournal(root, "R-rb-protofield-cli", "rollback.json").protocol, "cli");

    const cfgPath = path.join(root, "pf-cfg.json");
    const outPath = path.join(root, "pf-out.json");
    fs.writeFileSync(cfgPath, "{}", "utf8");
    await dispatchExecuteProtocol({
      protocol: PROTOCOLS.FILE,
      projectRoot: root,
      runId: "R-rb-protofield-file",
      configPath: cfgPath,
      outputPath: outPath,
      timeout: 5,
      backoffMs: 10,
    });
    assert.equal(readJournal(root, "R-rb-protofield-file", "request.json").protocol, "file");
    assert.equal(readJournal(root, "R-rb-protofield-file", "result.json").protocol, "file");
    assert.equal(readJournal(root, "R-rb-protofield-file", "rollback.json").protocol, "file");
  } finally { rmProject(root); }
});

// ─── Custom decision step overrides default (e.g. always abort) ─────────

test("rollback: custom decision step (always abort) prevents retry", async () => {
  const root = mkProject();
  try {
    let attempts = 0;
    const r = await dispatchExecuteProtocol({
      protocol: PROTOCOLS.HTTP,
      projectRoot: root,
      runId: "R-rb-abort",
      url: "http://stub",
      transport: async () => {
        attempts++;
        const e = new Error("server busy"); e.statusCode = 503; throw e;
      },
      maxRetries: 5, // would normally retry
      backoffMs: 10,
      decision: () => "abort", // but we abort immediately
    });
    assert.equal(r.status, "failed");
    assert.equal(attempts, 1, "should not retry when decision=abort");
    assert.equal(r.decision_log[0].decision, "abort");
  } finally { rmProject(root); }
});

test("rollback: decision step that throws defaults to rollback", async () => {
  const root = mkProject();
  try {
    const r = await dispatchExecuteProtocol({
      protocol: PROTOCOLS.HTTP,
      projectRoot: root,
      runId: "R-rb-decision-throw",
      url: "http://stub",
      transport: async () => { const e = new Error("busy"); e.statusCode = 503; throw e; },
      maxRetries: 1,
      backoffMs: 10,
      decision: () => { throw new Error("decision broken"); },
    });
    assert.equal(r.status, "failed");
    assert.equal(r.decision_log[0].decision, "rollback");
    assert.match(r.decision_log[0].note, /decision step threw/);
  } finally { rmProject(root); }
});
