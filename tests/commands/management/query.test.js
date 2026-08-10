"use strict";

// ─── lib/commands/management/query.js unit tests ──────────────────────────────
//
// Coverage:
//   - managementQuery: missing projection → invalidManagementUsage banner
//   - managementQuery: projection starts with "--" → invalidManagementUsage
//   - managementQuery: UNSUPPORTED_COMMAND capabilities → legacy fallback
//   - managementQuery: unsupported projection → managementApiError
//   - managementQuery: invalid filter option → INVALID_QUERY_OPTION
//   - managementQuery: filter option missing value → INVALID_QUERY_OPTION
//   - managementQuery: non-flag arg → invalidManagementUsage
//   - managementQuery: happy path → formatQueryPayload result printed

const assert = require("node:assert/strict");
const test = require("node:test");

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

function withExitCode(fn) {
  const orig = process.exitCode;
  process.exitCode = undefined;
  let captured = undefined;
  try { fn(); } finally {
    captured = process.exitCode;
    process.exitCode = orig;
  }
  return captured;
}

// ─── module-cache swap helper ─────────────────────────────────────────────────
//
// `query.js` directly requires `../../management-client` for
// queryManagementProject + formatQueryPayload, and `./api-helpers` for
// managementApiError + printManagementPayload + invalidManagementUsage.
// All three are destructure-imported, so we must swap the cache AND evict
// `query.js` from the cache before re-requiring it.

function withMockedDeps(clientOverrides, apiHelpersOverrides, fn) {
  const clientTarget = require.resolve("../../../lib/management/client");
  const helpersTarget = require.resolve("../../../lib/commands/management/api-helpers");
  const queryTarget = require.resolve("../../../lib/commands/management/query");

  const origClient = require.cache[clientTarget];
  const origHelpers = require.cache[helpersTarget];
  const origQuery = require.cache[queryTarget];

  const defaultClient = {
    attachProject: (payload, project) => ({ ...payload, project }),
    formatQueryPayload: (payload, projection, capability, project) => ({
      ok: true,
      command: "query",
      projection,
      project: { root: project.root, agent_root: project.agent_root },
      data: payload,
    }),
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

  const defaultHelpers = {
    invalidManagementUsage: (usage) => {
      console.error(`Usage: ${usage}`);
      process.exitCode = 2;
    },
    managementApiError: (ctx, error) => {
      const normalized = typeof error === "string"
        ? { error: { code: "MANAGEMENT_API_QUERY_FAILED", message: error, details: {} }, exitCode: 3 }
        : error;
      const prefix = ctx.lang === "zh" ? "Management API 查询失败" : "Management API query failed";
      console.error(`${prefix}: ${normalized.error.message}`);
      process.stdout.write(`${JSON.stringify({ ok: false, error: normalized.error }, null, 2)}\n`);
      process.exitCode = normalized.exitCode || 3;
      return null;
    },
    printManagementPayload: (payload) => {
      process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    },
    queryManagementApi: (ctx, resource) => ({
      ok: true,
      payload: {},
      project: { root: "/r", agent_root: "/r/.agent" },
      _mockResource: resource,
    }),
  };

  require.cache[clientTarget] = {
    id: clientTarget,
    filename: clientTarget,
    loaded: true,
    exports: { ...defaultClient, ...clientOverrides },
  };
  require.cache[helpersTarget] = {
    id: helpersTarget,
    filename: helpersTarget,
    loaded: true,
    exports: { ...defaultHelpers, ...apiHelpersOverrides },
  };
  delete require.cache[queryTarget];

  try {
    return fn();
  } finally {
    if (origClient) require.cache[clientTarget] = origClient;
    else delete require.cache[clientTarget];
    if (origHelpers) require.cache[helpersTarget] = origHelpers;
    else delete require.cache[helpersTarget];
    if (origQuery) require.cache[queryTarget] = origQuery;
    else delete require.cache[queryTarget];
  }
}

// ─── tests ───────────────────────────────────────────────────────────────────

test("managementQuery: missing projection → invalidManagementUsage", () => {
  withMockedDeps({}, {}, () => {
    const { managementQuery } = require("../../../lib/commands/management/query");
    const { restore: restoreErr } = captureStderr();
    const { restore: restoreOut } = captureStdout();
    const exitCode = withExitCode(() => {
      managementQuery({ args: ["query"], lang: "en" });
    });
    const err = restoreErr();
    const out = restoreOut();
    assert.match(err, /Usage: cortex-agent query <projection>/);
    assert.equal(exitCode, 2);
    // No stdout payload should be printed for usage errors.
    assert.equal(out, "");
  });
});

test("managementQuery: projection starts with '--' → invalidManagementUsage", () => {
  withMockedDeps({}, {}, () => {
    const { managementQuery } = require("../../../lib/commands/management/query");
    const { restore: restoreErr } = captureStderr();
    const { restore: restoreOut } = captureStdout();
    const exitCode = withExitCode(() => {
      managementQuery({ args: ["query", "--bogus"], lang: "en" });
    });
    const err = restoreErr();
    const out = restoreOut();
    assert.match(err, /Usage: cortex-agent query <projection>/);
    assert.equal(exitCode, 2);
    assert.equal(out, "");
  });
});

test("managementQuery: UNSUPPORTED_COMMAND on capabilities → legacy fallback", () => {
  let directCalledWith = null;
  withMockedDeps({
    queryManagementProject: (ctx, projection) => {
      if (projection === "capabilities") {
        return {
          ok: false,
          error: { code: "UNSUPPORTED_COMMAND", message: "old API" },
          exitCode: 2,
        };
      }
      directCalledWith = projection;
      return {
        ok: true,
        payload: { hello: "legacy" },
        project: { root: "/r", agent_root: "/r/.agent" },
      };
    },
  }, {}, () => {
    const { managementQuery } = require("../../../lib/commands/management/query");
    const { restore } = captureStdout();
    try {
      managementQuery({ args: ["query", "runs"], lang: "en" });
    } finally {
      const out = restore();
      assert.equal(directCalledWith, "runs");
      // Legacy fallback prints this shape (per original code).
      const parsed = JSON.parse(out);
      assert.equal(parsed.ok, true);
      assert.equal(parsed.command, "query");
      assert.equal(parsed.projection, "runs");
      assert.deepEqual(parsed.summary, { legacy_dispatcher: true, capability_filter: "skipped" });
      assert.equal(parsed.data.hello, "legacy");
    }
  });
});

test("managementQuery: unsupported projection → managementApiError(UNSUPPORTED_PROJECTION)", () => {
  withMockedDeps({
    queryManagementProject: () => ({
      ok: true,
      payload: { projections: [{ name: "known", filters: [], data_field: "items" }] },
      project: { root: "/r", agent_root: "/r/.agent" },
    }),
  }, {}, () => {
    const { managementQuery } = require("../../../lib/commands/management/query");
    const { restore: restoreErr } = captureStderr();
    const { restore: restoreOut } = captureStdout();
    const exitCode = withExitCode(() => {
      managementQuery({ args: ["query", "unknown"], lang: "en" });
    });
    const out = restoreOut();
    const err = restoreErr();
    assert.match(err, /Unsupported Management API projection: unknown/);
    assert.match(out, /"code":\s*"UNSUPPORTED_PROJECTION"/);
    assert.match(out, /"supported":\s*\[\s*"known"\s*\]/);
    assert.equal(exitCode, 2);
  });
});

test("managementQuery: invalid filter option → INVALID_QUERY_OPTION", () => {
  withMockedDeps({
    queryManagementProject: () => ({
      ok: true,
      payload: { projections: [{ name: "runs", filters: ["status"] }] },
      project: { root: "/r", agent_root: "/r/.agent" },
    }),
  }, {}, () => {
    const { managementQuery } = require("../../../lib/commands/management/query");
    const { restore: restoreErr } = captureStderr();
    const { restore: restoreOut } = captureStdout();
    const exitCode = withExitCode(() => {
      managementQuery({ args: ["query", "runs", "--bogus", "x"], lang: "en" });
    });
    const out = restoreOut();
    const err = restoreErr();
    assert.match(err, /does not support --bogus/);
    assert.match(out, /"code":\s*"INVALID_QUERY_OPTION"/);
    assert.equal(exitCode, 2);
  });
});

test("managementQuery: filter option without value → INVALID_QUERY_OPTION", () => {
  withMockedDeps({
    queryManagementProject: () => ({
      ok: true,
      payload: { projections: [{ name: "runs", filters: ["status"] }] },
      project: { root: "/r", agent_root: "/r/.agent" },
    }),
  }, {}, () => {
    const { managementQuery } = require("../../../lib/commands/management/query");
    const { restore: restoreOut } = captureStdout();
    const exitCode = withExitCode(() => {
      managementQuery({ args: ["query", "runs", "--status"], lang: "en" });
    });
    const out = restoreOut();
    assert.match(out, /"code":\s*"INVALID_QUERY_OPTION"/);
    assert.match(out, /--status requires a value/);
    assert.equal(exitCode, 2);
  });
});

test("managementQuery: non-flag arg → invalidManagementUsage", () => {
  withMockedDeps({
    queryManagementProject: () => ({
      ok: true,
      payload: { projections: [{ name: "runs", filters: ["status"] }] },
      project: { root: "/r", agent_root: "/r/.agent" },
    }),
  }, {}, () => {
    const { managementQuery } = require("../../../lib/commands/management/query");
    const { restore: restoreErr } = captureStderr();
    const { restore: restoreOut } = captureStdout();
    const exitCode = withExitCode(() => {
      managementQuery({ args: ["query", "runs", "positional"], lang: "en" });
    });
    const err = restoreErr();
    const out = restoreOut();
    assert.match(err, /Usage: cortex-agent query <projection> \[--project <path>\] \[projection filters\]/);
    assert.equal(exitCode, 2);
    assert.equal(out, "");
  });
});

test("managementQuery: happy path → formatQueryPayload result printed", () => {
  let calls = [];
  withMockedDeps({
    queryManagementProject: (ctx, projection, extraArgs) => {
      calls.push({ projection, extraArgs });
      if (projection === "capabilities") {
        return {
          ok: true,
          payload: { projections: [{ name: "runs", filters: ["status"] }] },
          project: { root: "/r", agent_root: "/r/.agent" },
        };
      }
      return {
        ok: true,
        payload: { items: [1, 2, 3] },
        project: { root: "/r", agent_root: "/r/.agent" },
      };
    },
    formatQueryPayload: (payload, projection, capability, project) => ({
      ok: true,
      command: "query",
      projection,
      project: { root: project.root, agent_root: project.agent_root },
      filters: payload.filters || {},
      data: payload,
      summary: {},
      warnings: [],
      generated_at: null,
    }),
  }, {}, () => {
    const { managementQuery } = require("../../../lib/commands/management/query");
    const { restore } = captureStdout();
    try {
      managementQuery({ args: ["query", "runs", "--status", "active"], lang: "en" });
    } finally {
      const out = restore();
      // Two calls: capabilities + runs with --status active.
      // (capabilities is called without an extraArgs arg, so we use
      // a loose structural check rather than deepStrictEqual.)
      assert.equal(calls.length, 2);
      assert.equal(calls[0].projection, "capabilities");
      assert.equal(calls[1].projection, "runs");
      assert.deepEqual(calls[1].extraArgs, ["--status", "active"]);
      const parsed = JSON.parse(out);
      assert.equal(parsed.ok, true);
      assert.equal(parsed.command, "query");
      assert.equal(parsed.projection, "runs");
    }
  });
});
