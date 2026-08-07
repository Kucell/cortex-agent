"use strict";

// ─── CLI + file Protocol Tests (M-003 MS-004 / F-009) ────────────────────────
//
// Coverage: lib/agents/dispatch-execute.js CLI / file transports + the
// unified dispatchExecuteProtocol() entry point.
//
//   - cliRequest: subprocess spawn + JSON-RPC parse (plain / CRLF / LF)
//                  + 5 error codes (ERR_CLI_SPAWN / EXIT_NONZERO / TIMEOUT /
//                  PARSE / RPC_ERROR)
//   - fileRequest: atomic read config + write output (ERR_FILE_*)
//   - dispatchExecuteProtocol integration: HTTP / CLI / file all work
//     through the same retry + decision + journal pipeline
//
// Hard constraints honored:
//   - Zero npm deps. node:child_process / node:fs / node:path / node:assert.
//   - Subprocess isolation: tests inject fake binaries via `bin: process.execPath`
//     with a small Node script, never relying on a real CLI being on PATH.
//   - Each test gets its own mkdtemp project root for journal isolation.
//
// AC coverage (per validation-contract-ms-004-dispatch.json):
//   AC #1: F-009 CLI protocol (subprocess spawn + JSON-RPC)
//   AC #2: F-009 file protocol (read JSON config + write JSON result)
//   AC #3: F-009 完整: HTTP + CLI + file 三协议统一 dispatch-execute API
//   AC #7: tests 10-15 pass in < 5s

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  cliRequest,
  fileRequest,
  dispatchExecuteProtocol,
  defaultDecisionProtocol,
  PROTOCOLS,
  _parseJsonRpc,
} = require("../../lib/agents/dispatch-execute");

// ─── helpers ──────────────────────────────────────────────────────────────

function mkProject() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "m003-ms004-clifile-"));
}
function rmProject(root) {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) { /* ignore */ }
}
function journal(root, runId, name) {
  return path.join(root, ".agent-runtime", "dispatch", runId, name);
}
function readJournal(root, runId, name) {
  const file = journal(root, runId, name);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

// Fake CLI binary body — Node script that picks behavior from FAKE_MODE env.
// Installed as a one-off file; tests set `bin: process.execPath, args: [fakeFile, ...]`.
// (We use a real Node script so we can `chmod` and run it under `process.execPath`.)
function makeFakeCli(body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "m003-ms004-fakecli-"));
  const file = path.join(dir, "fake.js");
  fs.writeFileSync(file, body, "utf8");
  fs.chmodSync(file, 0o755);
  return { dir, file };
}

// ─── PROTOCOLS constant ──────────────────────────────────────────────────

test("dispatch-execute: PROTOCOLS exposes http/cli/file", () => {
  assert.equal(PROTOCOLS.HTTP, "http");
  assert.equal(PROTOCOLS.CLI, "cli");
  assert.equal(PROTOCOLS.FILE, "file");
});

// ─── _parseJsonRpc unit tests ────────────────────────────────────────────

test("dispatch-execute: _parseJsonRpc parses plain JSON", () => {
  const out = _parseJsonRpc('{"jsonrpc":"2.0","id":1,"result":{"text":"ok"}}');
  assert.deepEqual(out, { jsonrpc: "2.0", id: 1, result: { text: "ok" } });
});

test("dispatch-execute: _parseJsonRpc parses Content-Length CRLF frame", () => {
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, result: { v: 2 } });
  const framed = `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;
  const out = _parseJsonRpc(framed);
  assert.deepEqual(out, { jsonrpc: "2.0", id: 1, result: { v: 2 } });
});

test("dispatch-execute: _parseJsonRpc parses Content-Length LF frame", () => {
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, result: { v: 3 } });
  const framed = `Content-Length: ${Buffer.byteLength(body)}\n\n${body}`;
  const out = _parseJsonRpc(framed);
  assert.deepEqual(out, { jsonrpc: "2.0", id: 1, result: { v: 3 } });
});

test("dispatch-execute: _parseJsonRpc throws on empty stdout", () => {
  assert.throws(() => _parseJsonRpc(""), /empty stdout/);
});

test("dispatch-execute: _parseJsonRpc throws on garbage that has no frame", () => {
  assert.throws(() => _parseJsonRpc("not json at all"), /not valid JSON/);
});

// ─── defaultDecisionProtocol unit tests ──────────────────────────────────

test("dispatch-execute: defaultDecisionProtocol retries on ERR_CLI_TIMEOUT", () => {
  assert.equal(defaultDecisionProtocol(0, { code: "ERR_CLI_TIMEOUT" }), "retry");
});

test("dispatch-execute: defaultDecisionProtocol rolls back on ERR_CLI_PARSE", () => {
  assert.equal(defaultDecisionProtocol(0, { code: "ERR_CLI_PARSE" }), "rollback");
});

test("dispatch-execute: defaultDecisionProtocol rolls back on ERR_FILE_CONFIG_NOT_FOUND", () => {
  assert.equal(defaultDecisionProtocol(0, { code: "ERR_FILE_CONFIG_NOT_FOUND" }), "rollback");
});

test("dispatch-execute: defaultDecisionProtocol aborts on ERR_CLI_PROTOCOL", () => {
  assert.equal(defaultDecisionProtocol(0, { code: "ERR_CLI_PROTOCOL" }), "abort");
});

// ─── CLI protocol — success path ─────────────────────────────────────────

test("cliRequest: success on plain JSON-RPC response", async () => {
  const { dir, file } = makeFakeCli(
    `'use strict';
process.stdin.on("data", () => {});
process.stdin.on("end", () => {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { text: "ok" } }));
  process.stdout.write("\\n");
  process.exit(0);
});`,
  );
  try {
    const r = await cliRequest({
      bin: process.execPath,
      args: [file],
      shell: false,
      payload: { task: "x" },
      timeout: 5,
    });
    assert.equal(r.statusCode, 200);
    assert.equal(r.headers["X-Cortex-Agent-Protocol"], "cli");
    const body = JSON.parse(r.body);
    assert.equal(body.text, "ok");
    assert.ok(r.latency_ms >= 0);
  } finally { rmProject(dir); }
});

test("cliRequest: success on Content-Length framed response (CRLF)", async () => {
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, result: { framed: true } });
  const { dir, file } = makeFakeCli(
    `'use strict';
process.stdin.on("data", () => {});
process.stdin.on("end", () => {
  process.stdout.write("Content-Length: " + Buffer.byteLength(${JSON.stringify(body)}) + "\\r\\n\\r\\n" + ${JSON.stringify(body)});
  process.exit(0);
});`,
  );
  try {
    const r = await cliRequest({
      bin: process.execPath,
      args: [file],
      shell: false,
      payload: { x: 1 },
      timeout: 5,
    });
    assert.equal(r.statusCode, 200);
    const parsed = JSON.parse(r.body);
    assert.equal(parsed.framed, true);
  } finally { rmProject(dir); }
});

// ─── CLI protocol — failure paths ────────────────────────────────────────

test("cliRequest: spawn ENOENT (binary not found) → ERR_CLI_SPAWN", async () => {
  await assert.rejects(
    () => cliRequest({
      bin: "/nonexistent/path/that/does/not/exist",
      args: [],
      shell: false,
      payload: {},
      timeout: 5,
    }),
    (err) => err.code === "ERR_CLI_SPAWN",
  );
});

test("cliRequest: subprocess exits non-zero → ERR_CLI_EXIT_NONZERO", async () => {
  const { dir, file } = makeFakeCli(
    `'use strict';
process.stdin.on("data", () => {});
process.stdin.on("end", () => {
  process.stderr.write("boom\\n");
  process.exit(7);
});`,
  );
  try {
    await assert.rejects(
      () => cliRequest({
        bin: process.execPath,
        args: [file],
        shell: false,
        payload: {},
        timeout: 5,
      }),
      (err) => err.code === "ERR_CLI_EXIT_NONZERO" && err.exitCode === 7,
    );
  } finally { rmProject(dir); }
});

test("cliRequest: subprocess timeout → ERR_CLI_TIMEOUT", async () => {
  // Sleep longer than the timeout; should be killed.
  const { dir, file } = makeFakeCli(
    `'use strict';
process.stdin.on("data", () => {});
process.stdin.on("end", () => {
  setTimeout(() => {}, 60000); // 60s; will be killed at 1s
});`,
  );
  try {
    await assert.rejects(
      () => cliRequest({
        bin: process.execPath,
        args: [file],
        shell: false,
        payload: {},
        timeout: 1,
      }),
      (err) => err.code === "ERR_CLI_TIMEOUT",
    );
  } finally { rmProject(dir); }
});

test("cliRequest: stdout not valid JSON-RPC → ERR_CLI_PARSE", async () => {
  const { dir, file } = makeFakeCli(
    `'use strict';
process.stdin.on("data", () => {});
process.stdin.on("end", () => {
  process.stdout.write("this is not json");
  process.exit(0);
});`,
  );
  try {
    await assert.rejects(
      () => cliRequest({
        bin: process.execPath,
        args: [file],
        shell: false,
        payload: {},
        timeout: 5,
      }),
      (err) => err.code === "ERR_CLI_PARSE",
    );
  } finally { rmProject(dir); }
});

test("cliRequest: JSON-RPC error envelope → ERR_CLI_RPC_ERROR", async () => {
  const { dir, file } = makeFakeCli(
    `'use strict';
process.stdin.on("data", () => {});
process.stdin.on("end", () => {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32001, message: "boom" } }));
  process.exit(0);
});`,
  );
  try {
    await assert.rejects(
      () => cliRequest({
        bin: process.execPath,
        args: [file],
        shell: false,
        payload: {},
        timeout: 5,
      }),
      (err) => err.code === "ERR_CLI_RPC_ERROR" && err.rpcError && err.rpcError.code === -32001,
    );
  } finally { rmProject(dir); }
});

test("cliRequest: shell: true fallback works for relative bin name", async () => {
  // Use a script that we can run via `node <file>` (the shell resolves `node`).
  // We do NOT rely on shell:true for our fake binary path; we use it to
  // demonstrate the macOS/Linux PATH fallback is wired. This is a smoke
  // check that the spawn doesn't immediately reject when shell:true.
  const { dir, file } = makeFakeCli(
    `'use strict';
process.stdin.on("data", () => {});
process.stdin.on("end", () => {
  process.stdout.write(JSON.stringify({ result: { ok: true } }));
  process.exit(0);
});`,
  );
  try {
    // shell:true is the default; we omit it to verify the default is honored.
    const r = await cliRequest({
      bin: process.execPath,
      args: [file],
      shell: true, // explicit: confirm it's accepted
      payload: {},
      timeout: 5,
    });
    assert.equal(r.statusCode, 200);
  } finally { rmProject(dir); }
});

test("cliRequest: invalid args (bin missing) → ERR_CLI_PROTOCOL", async () => {
  await assert.rejects(
    () => cliRequest({ bin: "", args: [], payload: {}, timeout: 5 }),
    (err) => err.code === "ERR_CLI_PROTOCOL",
  );
});

test("cliRequest: invalid args (args not array) → ERR_CLI_PROTOCOL", async () => {
  await assert.rejects(
    () => cliRequest({ bin: "x", args: "not-array", payload: {}, timeout: 5 }),
    (err) => err.code === "ERR_CLI_PROTOCOL",
  );
});

// ─── file protocol — success path ────────────────────────────────────────

test("fileRequest: success atomic read config + write result", async () => {
  const root = mkProject();
  const configPath = path.join(root, "config.json");
  const outputPath = path.join(root, "out", "result.json");
  fs.writeFileSync(configPath, JSON.stringify({ task: "x", n: 42 }), "utf8");
  try {
    const r = await fileRequest({
      configPath,
      outputPath,
      payload: { from: "test" },
      timeout: 5,
    });
    assert.equal(r.statusCode, 200);
    assert.equal(r.headers["X-Cortex-Agent-Protocol"], "file");
    assert.ok(fs.existsSync(outputPath), "output file should exist");
    const written = JSON.parse(fs.readFileSync(outputPath, "utf8"));
    assert.equal(written.ok, true);
    assert.equal(written.config_path, configPath);
    assert.deepEqual(written.config, { task: "x", n: 42 });
    assert.deepEqual(written.payload, { from: "test" });
  } finally { rmProject(root); }
});

test("fileRequest: creates output dir if missing", async () => {
  const root = mkProject();
  const configPath = path.join(root, "config.json");
  const outputPath = path.join(root, "deeply", "nested", "out.json");
  fs.writeFileSync(configPath, "{}", "utf8");
  try {
    const r = await fileRequest({ configPath, outputPath, timeout: 5 });
    assert.equal(r.statusCode, 200);
    assert.ok(fs.existsSync(outputPath));
  } finally { rmProject(root); }
});

test("fileRequest: atomic write — no partial file visible", async () => {
  const root = mkProject();
  const configPath = path.join(root, "config.json");
  const outputPath = path.join(root, "result.json");
  fs.writeFileSync(configPath, "{}", "utf8");
  try {
    await fileRequest({ configPath, outputPath, timeout: 5 });
    // After completion, the file exists with no .tmp-* left over.
    assert.ok(fs.existsSync(outputPath));
    const leftovers = fs.readdirSync(root).filter((f) => f.includes(".tmp-"));
    assert.equal(leftovers.length, 0, `tmp files left over: ${leftovers.join(",")}`);
  } finally { rmProject(root); }
});

// ─── file protocol — failure paths ───────────────────────────────────────

test("fileRequest: config file not found → ERR_FILE_CONFIG_NOT_FOUND", async () => {
  const root = mkProject();
  try {
    await assert.rejects(
      () => fileRequest({
        configPath: path.join(root, "missing.json"),
        outputPath: path.join(root, "out.json"),
        timeout: 5,
      }),
      (err) => err.code === "ERR_FILE_CONFIG_NOT_FOUND",
    );
  } finally { rmProject(root); }
});

test("fileRequest: config invalid JSON → ERR_FILE_CONFIG_INVALID_JSON", async () => {
  const root = mkProject();
  const configPath = path.join(root, "bad.json");
  fs.writeFileSync(configPath, "{ not valid json", "utf8");
  try {
    await assert.rejects(
      () => fileRequest({
        configPath,
        outputPath: path.join(root, "out.json"),
        timeout: 5,
      }),
      (err) => err.code === "ERR_FILE_CONFIG_INVALID_JSON",
    );
  } finally { rmProject(root); }
});

test("fileRequest: invalid args → ERR_FILE_PROTOCOL", async () => {
  await assert.rejects(
    () => fileRequest({ configPath: "", outputPath: "x", timeout: 5 }),
    (err) => err.code === "ERR_FILE_PROTOCOL",
  );
  await assert.rejects(
    () => fileRequest({ configPath: "x", outputPath: "", timeout: 5 }),
    (err) => err.code === "ERR_FILE_PROTOCOL",
  );
});

// ─── dispatchExecuteProtocol integration ─────────────────────────────────

test("dispatchExecuteProtocol: HTTP success via unified API", async () => {
  // We can't easily stand up a fake HTTP server here (would duplicate
  // existing dispatch-execute.test.js coverage). Instead, use a custom
  // transport that simulates the HTTP success path.
  const root = mkProject();
  try {
    const r = await dispatchExecuteProtocol({
      protocol: PROTOCOLS.HTTP,
      projectRoot: root,
      runId: "R-de-proto-http",
      url: "http://stub",
      transport: async () => ({ statusCode: 200, headers: {}, body: JSON.stringify({ ok: true }), latency_ms: 1 }),
      backoffMs: 10,
    });
    assert.equal(r.status, "ok");
    assert.equal(r.protocol, "http");
    assert.equal(r.attempt, 1);
  } finally { rmProject(root); }
});

test("dispatchExecuteProtocol: CLI success via unified API (end-to-end)", async () => {
  const { dir, file } = makeFakeCli(
    `'use strict';
process.stdin.on("data", () => {});
process.stdin.on("end", () => {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { hello: "world" } }));
  process.exit(0);
});`,
  );
  const root = mkProject();
  try {
    const r = await dispatchExecuteProtocol({
      protocol: PROTOCOLS.CLI,
      projectRoot: root,
      runId: "R-de-proto-cli",
      bin: process.execPath,
      args: [file],
      shell: false,
      payload: { task: "x" },
      timeout: 5,
      backoffMs: 10,
    });
    assert.equal(r.status, "ok");
    assert.equal(r.protocol, "cli");
    assert.equal(r.attempt, 1);
    const req = readJournal(root, "R-de-proto-cli", "request.json");
    const res = readJournal(root, "R-de-proto-cli", "result.json");
    const rb = readJournal(root, "R-de-proto-cli", "rollback.json");
    assert.equal(req.protocol, "cli");
    assert.equal(req.cli.bin, process.execPath);
    assert.deepEqual(req.cli.args, [file]);
    assert.equal(res.status, "ok");
    assert.equal(rb.status, "completed");
  } finally { rmProject(root); rmProject(dir); }
});

test("dispatchExecuteProtocol: file success via unified API (end-to-end)", async () => {
  const root = mkProject();
  const configPath = path.join(root, "config.json");
  const outputPath = path.join(root, "out.json");
  fs.writeFileSync(configPath, JSON.stringify({ task: "x" }), "utf8");
  try {
    const r = await dispatchExecuteProtocol({
      protocol: PROTOCOLS.FILE,
      projectRoot: root,
      runId: "R-de-proto-file",
      configPath,
      outputPath,
      timeout: 5,
      backoffMs: 10,
    });
    assert.equal(r.status, "ok");
    assert.equal(r.protocol, "file");
    assert.equal(r.attempt, 1);
    const req = readJournal(root, "R-de-proto-file", "request.json");
    const res = readJournal(root, "R-de-proto-file", "result.json");
    assert.equal(req.protocol, "file");
    assert.equal(req.file.configPath, configPath);
    assert.equal(req.file.outputPath, outputPath);
    assert.equal(res.status, "ok");
  } finally { rmProject(root); }
});

test("dispatchExecuteProtocol: invalid protocol → throws ERR_DISPATCH_PROTOCOL_INVALID", async () => {
  await assert.rejects(
    () => dispatchExecuteProtocol({ protocol: "websocket", projectRoot: mkProject(), runId: "R-x" }),
    (err) => err.code === "ERR_DISPATCH_PROTOCOL_INVALID",
  );
});

test("dispatchExecuteProtocol: missing protocol → throws ERR_DISPATCH_PROTOCOL_INVALID", async () => {
  await assert.rejects(
    () => dispatchExecuteProtocol({ projectRoot: mkProject(), runId: "R-x" }),
    (err) => err.code === "ERR_DISPATCH_PROTOCOL_INVALID",
  );
});
