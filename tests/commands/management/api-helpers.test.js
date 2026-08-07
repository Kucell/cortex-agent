"use strict";

// ─── lib/commands/management/api-helpers.js unit tests ────────────────────────
//
// Coverage:
//   - printManagementPayload: writes pretty-printed JSON + trailing newline
//   - invalidManagementUsage: writes "Usage: <text>" to stderr, exit code 2
//   - managementApiError (string error): normalized to MANAGEMENT_API_QUERY_FAILED
//   - managementApiError (object error): passed through
//   - managementApiError: zh/en prefix
//   - managementApiError: custom exitCode honored
//   - queryManagementApi: ok=true → attachProject wrapper applied
//   - queryManagementApi: ok=false → managementApiError called (returns null)
//   - queryManagementApi: extraArgs forwarded to queryManagementProject

const assert = require("node:assert/strict");
const test = require("node:test");

// ─── stdout / stderr capture helpers ──────────────────────────────────────────

function captureStdout() {
  const chunks = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk) => { chunks.push(String(chunk)); return true; };
  return { restore: () => { process.stdout.write = orig; return chunks.join(""); } };
}

function captureStderr() {
  const chunks = [];
  const orig = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk) => { chunks.push(String(chunk)); return true; };
  return { restore: () => { process.stderr.write = orig; return chunks.join(""); } };
}

// Save/restore helpers for process.exitCode so child processes don't inherit.
// Returns the exit code that was set during fn() so the caller can assert it
// after the original value has been restored.
function withExitCode(fn) {
  const orig = process.exitCode;
  process.exitCode = undefined;
  let captured = undefined;
  try {
    fn();
  } finally {
    captured = process.exitCode;
    process.exitCode = orig;
  }
  return captured;
}

// ─── module-cache swap: mock management-client before api-helpers is loaded ──
//
// api-helpers.js uses destructure imports at the top:
//
//     const { attachProject, queryManagementProject } = require("../../../lib/management/client.js");
//
// So a bare cache replacement on the management-client entry is too late —
// the destructure has already happened. To re-bind the destructure, we have
// to also evict api-helpers from the cache, then re-require it under a fresh
// require() call that sees the mocked client. The helper below does all
// three steps in a single withMockedClient() call.

function withMockedClient(overrides, fn) {
  const clientTarget = require.resolve("../../../lib/management-client");
  const helpersTarget = require.resolve("../../../lib/commands/management/api-helpers");

  const origClient = require.cache[clientTarget];
  const origHelpers = require.cache[helpersTarget];

  const defaultExports = {
    attachProject: (payload, project) => ({ ...payload, project }),
    formatQueryPayload: (payload) => payload,
    invokeManagementProject: () => ({
      ok: true,
      payload: {},
      project: { root: "/r", agent_root: "/r/.agent" },
    }),
    queryManagementProject: () => ({
      ok: true,
      payload: {},
      project: { root: "/r", agent_root: "/r/.agent" },
    }),
    resolveManagementProject: () => ({
      ok: true,
      project: { root: "/r", agent_root: "/r/.agent" },
    }),
  };

  require.cache[clientTarget] = {
    id: clientTarget,
    filename: clientTarget,
    loaded: true,
    exports: { ...defaultExports, ...overrides },
  };
  delete require.cache[helpersTarget];

  try {
    return fn();
  } finally {
    if (origClient) require.cache[clientTarget] = origClient;
    else delete require.cache[clientTarget];
    if (origHelpers) require.cache[helpersTarget] = origHelpers;
    else delete require.cache[helpersTarget];
  }
}

// ─── printManagementPayload ───────────────────────────────────────────────────

test("printManagementPayload: writes pretty JSON + trailing newline to stdout", () => {
  const { printManagementPayload } = require("../../../lib/commands/management/api-helpers");
  const { restore } = captureStdout();
  try {
    printManagementPayload({ ok: true, data: { a: 1, b: [1, 2, 3] } });
  } finally {
    const out = restore();
    // JSON.stringify with 2-space indent + trailing newline.
    assert.equal(out, `${JSON.stringify({ ok: true, data: { a: 1, b: [1, 2, 3] } }, null, 2)}\n`);
    // The output is valid JSON (round-trips).
    const parsed = JSON.parse(out);
    assert.equal(parsed.ok, true);
    assert.deepEqual(parsed.data, { a: 1, b: [1, 2, 3] });
  }
});

// ─── invalidManagementUsage ───────────────────────────────────────────────────

test("invalidManagementUsage: writes 'Usage: ...' to stderr, exit code = 2", () => {
  const { invalidManagementUsage } = require("../../../lib/commands/management/api-helpers");
  const { restore } = captureStderr();
  const exitCode = withExitCode(() => {
    invalidManagementUsage("cortex-agent runs <list|show> [options]");
  });
  const err = restore();
  assert.match(err, /Usage: cortex-agent runs <list\|show> \[options\]/);
  assert.equal(exitCode, 2);
});

// ─── managementApiError ──────────────────────────────────────────────────────

test("managementApiError: string error → normalized with default code + exit 3", () => {
  const { managementApiError } = require("../../../lib/commands/management/api-helpers");
  const { restore: restoreOut } = captureStdout();
  const { restore: restoreErr } = captureStderr();
  let result;
  const exitCode = withExitCode(() => {
    result = managementApiError({ lang: "en" }, "boom");
  });
  const out = restoreOut();
  const err = restoreErr();
  assert.equal(result, null, "must return null");
  assert.match(err, /Management API query failed: boom/);
  // JSON envelope printed to stdout.
  assert.match(out, /"code":\s*"MANAGEMENT_API_QUERY_FAILED"/);
  assert.match(out, /"message":\s*"boom"/);
  assert.match(out, /"ok":\s*false/);
  assert.equal(exitCode, 3);
});

test("managementApiError: object error → passed through, exit code from object", () => {
  const { managementApiError } = require("../../../lib/commands/management/api-helpers");
  const { restore: restoreOut } = captureStdout();
  const { restore: restoreErr } = captureStderr();
  const errObj = {
    error: { code: "CUSTOM_CODE", message: "custom message", details: { x: 1 } },
    exitCode: 7,
  };
  let result;
  const exitCode = withExitCode(() => {
    result = managementApiError({ lang: "en" }, errObj);
  });
  const out = restoreOut();
  const err = restoreErr();
  assert.equal(result, null);
  assert.match(err, /Management API query failed: custom message/);
  assert.match(out, /"code":\s*"CUSTOM_CODE"/);
  assert.match(out, /"details":\s*\{\s*"x":\s*1\s*\}/);
  assert.equal(exitCode, 7);
});

test("managementApiError: zh lang → Chinese prefix", () => {
  const { managementApiError } = require("../../../lib/commands/management/api-helpers");
  const { restore: restoreOut } = captureStdout();
  const { restore: restoreErr } = captureStderr();
  withExitCode(() => {
    managementApiError({ lang: "zh" }, "出错了");
  });
  const out = restoreOut();
  const err = restoreErr();
  assert.match(err, /Management API 查询失败/);
  // And the JSON envelope still has the same shape.
  assert.match(out, /"ok":\s*false/);
  assert.match(out, /"message":\s*"出错了"/);
});

test("managementApiError: object without exitCode → defaults to 3", () => {
  const { managementApiError } = require("../../../lib/commands/management/api-helpers");
  const { restore: restoreOut } = captureStdout();
  const { restore: restoreErr } = captureStderr();
  const exitCode = withExitCode(() => {
    managementApiError({ lang: "en" }, {
      error: { code: "X", message: "y", details: {} },
    });
  });
  restoreOut();
  restoreErr();
  assert.equal(exitCode, 3);
});

// ─── queryManagementApi ──────────────────────────────────────────────────────

test("queryManagementApi: ok=true → returns attachProject(payload, project)", () => {
  let captured = null;
  withMockedClient({
    queryManagementProject: (ctx, resource, extraArgs) => {
      captured = { ctx, resource, extraArgs };
      return {
        ok: true,
        payload: { hello: "world" },
        project: { root: "/repo", agent_root: "/repo/.agent" },
      };
    },
  }, () => {
    const { queryManagementApi } = require("../../../lib/commands/management/api-helpers");
    const { restore: restoreOut } = captureStdout();
    try {
      const out = queryManagementApi({ lang: "en", args: ["query"] }, "runs");
      assert.deepEqual(out, {
        hello: "world",
        project: { root: "/repo", agent_root: "/repo/.agent" },
      });
      // The mocked queryManagementProject was actually called.
      assert.equal(captured.resource, "runs");
    } finally {
      restoreOut();
    }
  });
});

test("queryManagementApi: ok=false → managementApiError called, returns null", () => {
  withMockedClient({
    queryManagementProject: () => ({
      ok: false,
      error: { code: "BOOM", message: "kapow", details: {} },
      exitCode: 9,
    }),
  }, () => {
    const { queryManagementApi } = require("../../../lib/commands/management/api-helpers");
    const { restore: restoreOut } = captureStdout();
    const { restore: restoreErr } = captureStderr();
    let result;
    const exitCode = withExitCode(() => {
      result = queryManagementApi({ lang: "en", args: ["query"] }, "runs");
    });
    const out = restoreOut();
    const err = restoreErr();
    assert.equal(result, null);
    assert.match(err, /Management API query failed: kapow/);
    assert.match(out, /"code":\s*"BOOM"/);
    assert.equal(exitCode, 9);
  });
});

test("queryManagementApi: extraArgs forwarded to queryManagementProject", () => {
  let captured = null;
  withMockedClient({
    queryManagementProject: (_ctx, resource, extraArgs) => {
      captured = { resource, extraArgs };
      return { ok: true, payload: {}, project: { root: "/r", agent_root: "/r/.agent" } };
    },
  }, () => {
    const { queryManagementApi } = require("../../../lib/commands/management/api-helpers");
    queryManagementApi({ lang: "en", args: ["query"] }, "runs", ["--filter", "active"]);
    assert.deepEqual(captured, { resource: "runs", extraArgs: ["--filter", "active"] });
  });
});
