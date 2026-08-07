"use strict";

// ─── lib/commands/management/write.js unit tests ──────────────────────────────
//
// Coverage:
//   - managementWrite: missing action → invalidManagementUsage
//   - managementWrite: action not in allowed list → invalidManagementUsage
//   - managementWrite: --project flag stripped from forwarded args
//   - managementWrite: --project=…= also stripped
//   - managementWrite: invokeManagementProject result.ok=false → managementApiError
//   - managementWrite: invokeManagementProject result.ok=true → printManagementPayload
//   - decisions: forwards to managementWrite with the decisions writer list
//   - inbox: forwards to managementWrite with the inbox writer list
//   - waitpoints: forwards to managementWrite with the waitpoints writer list
//   - runs: 'list' → queryManagementApi + printManagementPayload
//   - runs: 'show' <id> → queryManagementApi + filtered run payload
//   - runs: 'show' (no id) → invalidManagementUsage
//   - runs: 'show' <missing-id> → process.exitCode 1
//   - runs: 'upsert' → falls through to managementWrite
//   - queues: 'list' → queryManagementApi + printManagementPayload
//   - queues: 'upsert' → falls through to managementWrite
//   - sessions: 'list' → queryManagementApi + printManagementPayload
//   - sessions: 'open' → falls through to managementWrite

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
// `write.js` imports from:
//   - ../../management-client        (invokeManagementProject)
//   - ../../cli-contract             (static writer lists — use real one)
//   - ./api-helpers                  (5 functions, all destructure-imported)
//
// All destructure imports are bound at require time, so we have to swap
// the cache for both management-client AND api-helpers, then evict
// write.js from the cache before re-requiring it.

function withMockedDeps(clientOverrides, apiHelpersOverrides, fn) {
  const clientTarget = require.resolve("../../../lib/management-client");
  const helpersTarget = require.resolve("../../../lib/commands/management/api-helpers");
  const writeTarget = require.resolve("../../../lib/commands/management/write");

  const origClient = require.cache[clientTarget];
  const origHelpers = require.cache[helpersTarget];
  const origWrite = require.cache[writeTarget];

  // We do NOT mock cli-contract: it's a static config module and the
  // wrappers under test look up writer lists from it.

  const defaultClient = {
    attachProject: (payload, project) => ({ ...payload, project }),
    formatQueryPayload: (payload) => payload,
    invokeManagementProject: () => ({
      ok: true,
      payload: { wrote: true },
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
    queryManagementApi: () => ({ ok: true, payload: {}, project: { root: "/r", agent_root: "/r/.agent" } }),
    attachProject: (payload, project) => ({ ...payload, project }),
  };

  require.cache[clientTarget] = {
    id: clientTarget, filename: clientTarget, loaded: true,
    exports: { ...defaultClient, ...clientOverrides },
  };
  require.cache[helpersTarget] = {
    id: helpersTarget, filename: helpersTarget, loaded: true,
    exports: { ...defaultHelpers, ...apiHelpersOverrides },
  };
  delete require.cache[writeTarget];

  try {
    return fn();
  } finally {
    if (origClient) require.cache[clientTarget] = origClient;
    else delete require.cache[clientTarget];
    if (origHelpers) require.cache[helpersTarget] = origHelpers;
    else delete require.cache[helpersTarget];
    if (origWrite) require.cache[writeTarget] = origWrite;
    else delete require.cache[writeTarget];
  }
}

// ─── managementWrite unit tests ───────────────────────────────────────────────

test("managementWrite: missing action → invalidManagementUsage", () => {
  withMockedDeps({}, {}, () => {
    const { managementWrite } = require("../../../lib/commands/management/write");
    const { restore: restoreErr } = captureStderr();
    const exitCode = withExitCode(() => {
      managementWrite({ args: ["decisions"], lang: "en" }, "decisions", ["request", "resolve"]);
    });
    const err = restoreErr();
    assert.match(err, /Usage: cortex-agent decisions <request\|resolve>/);
    assert.equal(exitCode, 2);
  });
});

test("managementWrite: action not allowed → invalidManagementUsage", () => {
  withMockedDeps({}, {}, () => {
    const { managementWrite } = require("../../../lib/commands/management/write");
    const { restore: restoreErr } = captureStderr();
    const exitCode = withExitCode(() => {
      managementWrite({ args: ["decisions", "bogus"], lang: "en" }, "decisions", ["request", "resolve"]);
    });
    const err = restoreErr();
    assert.match(err, /Usage: cortex-agent decisions <request\|resolve>/);
    assert.equal(exitCode, 2);
  });
});

test("managementWrite: ok=true → printManagementPayload called with attachProject result", () => {
  let invokeArgs = null;
  withMockedDeps({
    invokeManagementProject: (ctx, commandArgs) => {
      invokeArgs = commandArgs;
      return {
        ok: true,
        payload: { wrote: true, n: 7 },
        project: { root: "/repo", agent_root: "/repo/.agent" },
      };
    },
  }, {}, () => {
    const { managementWrite } = require("../../../lib/commands/management/write");
    const { restore } = captureStdout();
    try {
      managementWrite(
        { args: ["decisions", "request", "--id", "d-1"], lang: "en" },
        "decisions",
        ["request", "resolve"],
      );
    } finally {
      const out = restore();
      assert.deepEqual(invokeArgs, ["decisions", "request", "--id", "d-1"]);
      const parsed = JSON.parse(out);
      assert.equal(parsed.wrote, true);
      assert.equal(parsed.n, 7);
      assert.deepEqual(parsed.project, { root: "/repo", agent_root: "/repo/.agent" });
    }
  });
});

test("managementWrite: ok=false → managementApiError called", () => {
  withMockedDeps({
    invokeManagementProject: () => ({
      ok: false,
      error: { code: "BOOM", message: "kapow", details: {} },
      exitCode: 9,
    }),
  }, {}, () => {
    const { managementWrite } = require("../../../lib/commands/management/write");
    const { restore: restoreOut } = captureStdout();
    const { restore: restoreErr } = captureStderr();
    const exitCode = withExitCode(() => {
      managementWrite(
        { args: ["decisions", "request"], lang: "en" },
        "decisions",
        ["request", "resolve"],
      );
    });
    const out = restoreOut();
    const err = restoreErr();
    assert.match(err, /Management API query failed: kapow/);
    assert.match(out, /"code":\s*"BOOM"/);
    assert.equal(exitCode, 9);
  });
});

test("managementWrite: --project flag stripped, --project= stripped, other args forwarded", () => {
  let invokeArgs = null;
  withMockedDeps({
    invokeManagementProject: (_ctx, commandArgs) => {
      invokeArgs = commandArgs;
      return { ok: true, payload: {}, project: { root: "/r", agent_root: "/r/.agent" } };
    },
  }, {}, () => {
    const { managementWrite } = require("../../../lib/commands/management/write");
    captureStdout();
    managementWrite(
      {
        args: ["decisions", "request", "--project", "/p", "--project=/q", "--keep", "v"],
        lang: "en",
      },
      "decisions",
      ["request", "resolve"],
    );
    // --project and --project=… stripped; --keep v forwarded.
    assert.deepEqual(invokeArgs, ["decisions", "request", "--keep", "v"]);
  });
});

// ─── decisions / inbox / waitpoints one-liner wrappers ────────────────────────

test("decisions: forwards (resource=decisions, allowedActions=cliContract.management.writers.decisions)", () => {
  let invokeArgs = null;
  withMockedDeps({
    invokeManagementProject: (_ctx, commandArgs) => {
      invokeArgs = commandArgs;
      return { ok: true, payload: {}, project: { root: "/r", agent_root: "/r/.agent" } };
    },
  }, {}, () => {
    const cliContract = require("../../../lib/cli/contract.js");
    const { decisions } = require("../../../lib/commands/management/write");
    captureStdout();
    decisions({ args: ["decisions", "request"], lang: "en" });
    assert.deepEqual(invokeArgs, ["decisions", "request"]);
    // Cross-check the resource list is actually the one in cliContract.
    assert.deepEqual(
      cliContract.management.writers.decisions,
      ["request", "resolve", "supersede"],
    );
  });
});

test("inbox: forwards (resource=inbox, allowedActions=cliContract.management.writers.inbox)", () => {
  let invokeArgs = null;
  withMockedDeps({
    invokeManagementProject: (_ctx, commandArgs) => {
      invokeArgs = commandArgs;
      return { ok: true, payload: {}, project: { root: "/r", agent_root: "/r/.agent" } };
    },
  }, {}, () => {
    const cliContract = require("../../../lib/cli/contract.js");
    const { inbox } = require("../../../lib/commands/management/write");
    captureStdout();
    inbox({ args: ["inbox", "send"], lang: "en" });
    assert.deepEqual(invokeArgs, ["inbox", "send"]);
    assert.deepEqual(
      cliContract.management.writers.inbox,
      ["send", "transition"],
    );
  });
});

test("waitpoints: forwards (resource=waitpoints, allowedActions=cliContract.management.writers.waitpoints)", () => {
  let invokeArgs = null;
  withMockedDeps({
    invokeManagementProject: (_ctx, commandArgs) => {
      invokeArgs = commandArgs;
      return { ok: true, payload: {}, project: { root: "/r", agent_root: "/r/.agent" } };
    },
  }, {}, () => {
    const cliContract = require("../../../lib/cli/contract.js");
    const { waitpoints } = require("../../../lib/commands/management/write");
    captureStdout();
    waitpoints({ args: ["waitpoints", "create"], lang: "en" });
    assert.deepEqual(invokeArgs, ["waitpoints", "create"]);
    assert.deepEqual(
      cliContract.management.writers.waitpoints,
      ["create", "release", "cancel"],
    );
  });
});

// ─── runs / queues / sessions with their list/show special cases ──────────────

test("runs: action='list' → queryManagementApi('runs') + printManagementPayload", () => {
  let queryArgs = null;
  withMockedDeps({}, {
    queryManagementApi: (ctx, resource) => {
      queryArgs = { resource };
      return { runs: [{ run_id: "r1" }], generated_at: "now" };
    },
  }, () => {
    const { runs } = require("../../../lib/commands/management/write");
    const { restore } = captureStdout();
    try {
      runs({ args: ["runs", "list"], lang: "en" });
    } finally {
      const out = restore();
      assert.deepEqual(queryArgs, { resource: "runs" });
      const parsed = JSON.parse(out);
      assert.deepEqual(parsed.runs, [{ run_id: "r1" }]);
    }
  });
});

test("runs: action='show' <id> → queryManagementApi('runs') + filtered run payload", () => {
  withMockedDeps({}, {
    queryManagementApi: () => ({
      runs: [
        { run_id: "r1" },
        { run_id: "r2" },
      ],
      generated_at: "ts",
    }),
  }, () => {
    const { runs } = require("../../../lib/commands/management/write");
    const { restore } = captureStdout();
    try {
      runs({ args: ["runs", "show", "r2"], lang: "en" });
    } finally {
      const out = restore();
      const parsed = JSON.parse(out);
      assert.equal(parsed.ok, true);
      assert.equal(parsed.query, "run");
      assert.equal(parsed.generated_at, "ts");
      assert.deepEqual(parsed.run, { run_id: "r2" });
    }
  });
});

test("runs: action='show' without run-id → invalidManagementUsage", () => {
  withMockedDeps({}, {}, () => {
    const { runs } = require("../../../lib/commands/management/write");
    const { restore } = captureStderr();
    const exitCode = withExitCode(() => {
      runs({ args: ["runs", "show"], lang: "en" });
    });
    const err = restore();
    assert.match(err, /Usage: cortex-agent runs show <run-id>/);
    assert.equal(exitCode, 2);
  });
});

test("runs: action='show' <missing-id> → process.exitCode 1 (no payload)", () => {
  withMockedDeps({}, {
    queryManagementApi: () => ({ runs: [{ run_id: "r1" }], generated_at: "ts" }),
  }, () => {
    const { runs } = require("../../../lib/commands/management/write");
    const { restore: restoreOut } = captureStdout();
    const { restore: restoreErr } = captureStderr();
    const exitCode = withExitCode(() => {
      runs({ args: ["runs", "show", "missing"], lang: "en" });
    });
    const out = restoreOut();
    const err = restoreErr();
    assert.match(err, /Run not found: missing/);
    assert.equal(out, "");
    assert.equal(exitCode, 1);
  });
});

test("runs: zh lang + show missing id → Chinese error", () => {
  withMockedDeps({}, {
    queryManagementApi: () => ({ runs: [], generated_at: "ts" }),
  }, () => {
    const { runs } = require("../../../lib/commands/management/write");
    const { restore } = captureStderr();
    withExitCode(() => {
      runs({ args: ["runs", "show", "missing"], lang: "zh" });
    });
    const err = restore();
    assert.match(err, /未找到 Run: missing/);
  });
});

test("runs: action='upsert' falls through to managementWrite", () => {
  let invokeArgs = null;
  withMockedDeps({
    invokeManagementProject: (_ctx, commandArgs) => {
      invokeArgs = commandArgs;
      return { ok: true, payload: {}, project: { root: "/r", agent_root: "/r/.agent" } };
    },
  }, {}, () => {
    const { runs } = require("../../../lib/commands/management/write");
    captureStdout();
    runs({ args: ["runs", "upsert", "--id", "r1"], lang: "en" });
    assert.deepEqual(invokeArgs, ["runs", "upsert", "--id", "r1"]);
  });
});

test("queues: action='list' → queryManagementApi('queues') + printManagementPayload", () => {
  let queryArgs = null;
  withMockedDeps({}, {
    queryManagementApi: (ctx, resource) => {
      queryArgs = { resource };
      return { queues: [{ id: "q1" }] };
    },
  }, () => {
    const { queues } = require("../../../lib/commands/management/write");
    const { restore } = captureStdout();
    try {
      queues({ args: ["queues", "list"], lang: "en" });
    } finally {
      const out = restore();
      assert.deepEqual(queryArgs, { resource: "queues" });
      const parsed = JSON.parse(out);
      assert.deepEqual(parsed.queues, [{ id: "q1" }]);
    }
  });
});

test("queues: action='upsert' falls through to managementWrite", () => {
  let invokeArgs = null;
  withMockedDeps({
    invokeManagementProject: (_ctx, commandArgs) => {
      invokeArgs = commandArgs;
      return { ok: true, payload: {}, project: { root: "/r", agent_root: "/r/.agent" } };
    },
  }, {}, () => {
    const { queues } = require("../../../lib/commands/management/write");
    captureStdout();
    queues({ args: ["queues", "upsert", "--id", "q1"], lang: "en" });
    assert.deepEqual(invokeArgs, ["queues", "upsert", "--id", "q1"]);
  });
});

test("sessions: action='list' → queryManagementApi('sessions') + printManagementPayload", () => {
  let queryArgs = null;
  withMockedDeps({}, {
    queryManagementApi: (ctx, resource) => {
      queryArgs = { resource };
      return { sessions: [{ id: "s1" }] };
    },
  }, () => {
    const { sessions } = require("../../../lib/commands/management/write");
    const { restore } = captureStdout();
    try {
      sessions({ args: ["sessions", "list"], lang: "en" });
    } finally {
      const out = restore();
      assert.deepEqual(queryArgs, { resource: "sessions" });
      const parsed = JSON.parse(out);
      assert.deepEqual(parsed.sessions, [{ id: "s1" }]);
    }
  });
});

test("sessions: action='open' falls through to managementWrite", () => {
  let invokeArgs = null;
  withMockedDeps({
    invokeManagementProject: (_ctx, commandArgs) => {
      invokeArgs = commandArgs;
      return { ok: true, payload: {}, project: { root: "/r", agent_root: "/r/.agent" } };
    },
  }, {}, () => {
    const { sessions } = require("../../../lib/commands/management/write");
    captureStdout();
    sessions({ args: ["sessions", "open", "--id", "s1"], lang: "en" });
    assert.deepEqual(invokeArgs, ["sessions", "open", "--id", "s1"]);
  });
});

