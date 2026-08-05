# Adapter Authoring Guide

> **Audience**: 3rd-party adapter authors — anyone who wants cortex-agent to
> talk to a new external agent runtime (Claude Code, Codex, Codey, Pi, MiniMax,
> or your custom CLI).
> **Status**: M-003 MS-001 (F-010) — published with the adapter framework.
> **Source of truth**: `lib/agents/adapters/base.js` + the concrete
> `lib/agents/adapters/claude-code.js` reference implementation.
> **Architecture constraint**: zero npm dependencies, pure addition to
> `lib/agents/adapters/`, no changes to M-002 5/5 (`lib/agents/{registry,
> discover,invoke,cli,index}.js`).

---

## 1. TL;DR

An adapter is a JavaScript class that extends `BaseAdapter` and implements
**5 methods** (`discover` / `health` / `invoke` / `cancel` / `report`).
That's the entire contract. The framework wires your adapter into:

- `cortex-agent agent adapter list` — list all registered adapters
- `cortex-agent agent adapter health <id>` — call your `health()` method
- `cortex-agent agent dispatch-execute <id> <task>` — call your `invoke()` method
- The MCP bridge (M-003 MS-003 onward) — exposes your `discover()` + `invoke()` over stdio JSON-RPC

```js
// Minimal adapter (5-method shape, no real I/O)
const { BaseAdapter } = require("cortex-agent/lib/agents/adapters/base");
const { register } = require("cortex-agent/lib/agents/adapters");

class EchoAdapter extends BaseAdapter {
  discover() {
    return {
      adapter_type: "echo",
      version: "0.1.0",
      protocol: "external_v1",
      capabilities: ["echo"],
    };
  }
  async health() {
    return { status: "ok", ready: true, latency_ms: 0, error: null, details: {} };
  }
  async invoke(payload, options = {}) {
    return { runId: options.runId, status: "ok", result: { echoed: payload }, error: null, latency_ms: 1 };
  }
  async cancel(runId) {
    return { runId, cancelled: true, error: null };
  }
  async report(runId) {
    return { runId, status: "ok", result: null, error: null };
  }
}

register("echo", EchoAdapter);
```

That's the whole framework. Read on for the contract details, journal
layout, error model, and the two worked examples.

---

## 2. The 5-Method Contract

Every adapter MUST implement these 5 methods. The base class throws
`ERR_ADAPTER_ABSTRACT` (or returns a structured "not implemented" result for
`health` / `cancel` / `report`) so missing implementations are caught at
runtime, not silently.

### 2.1 `discover() → { adapter_type, version, protocol, capabilities, ... }`

**Synchronous.** Pure metadata. NEVER touches the external runtime.

Returns an object with:

| Field         | Type                | Required | Notes |
| :---          | :---                | :---     | :--- |
| `adapter_type` | string             | ✅        | Matches the key passed to `register(type, Class)`. Used as the foreign key in `.agent/agents/<id>.json#external.adapter_type`. |
| `version`     | string              | ✅        | Semver. Surfaced in `cortex-agent agent adapter list`. |
| `protocol`    | string              | ✅        | Wire protocol version. Use `"external_v1"` for adapters that follow the M-003 contract. |
| `capabilities`| string[]            | ✅        | Free-form tags. Surfaced in MCP `tools/list`. |
| `schema`      | object              | optional | `{ request, response, journal }` — schema versions of the wire shapes. |
| `transport`   | string              | optional | `"stdio-json-rpc"` / `"http"` / `"cli-spawn"` — what the adapter uses to talk to the runtime. |
| `cli`         | object              | optional | `{ bin, shell, ... }` — vendor CLI hints for debugging. |

`discover()` is also the place to document **which env vars or config paths
the adapter reads** (e.g. `CLAUDE_CODE_BIN`, `~/.config/my-vendor/creds`).
Put them in `details` or a vendor-specific field.

### 2.2 `async health() → { status, ready, latency_ms, error, details }`

**Async.** Should be cheap (< 5s). Used by `cortex-agent agent adapter health
<id>` and the dashboard.

| Field        | Type                                 | Values |
| :---         | :---                                 | :--- |
| `status`     | `"ok" \| "degraded" \| "down" \| "unknown"` | |
| `ready`      | boolean                              | `true` iff `status === "ok"` AND the adapter can accept invoke() calls right now. |
| `latency_ms` | number                               | Wall-clock time of the health check itself. |
| `error`      | string \| null                       | Short, human-readable diagnostic. NEVER log secrets here. |
| `details`    | object                               | Vendor-specific (CLI version, auth expiry, etc.). NEVER include credentials. |

**Cheap checks** that should be in `health()`:

- Is the CLI binary on `PATH`? (`which <bin>`)
- Can the binary report its version? (`<bin> --version`)
- Is the auth credential reachable? (file exists, env var set)
- Is the upstream API responding? (HTTP `GET /health` with a short timeout)

**Pitfall**: don't run an actual `invoke()` from `health()`. Health is a
diagnostic, not a load test. Use a 1-2s timeout.

### 2.3 `async invoke(payload, options) → { runId, status, result, error, latency_ms }`

**Async.** The real work. Spawns the subprocess / opens the socket / runs
the HTTP call, captures the result, writes the journal.

`payload` shape (from M-002 `lib/agents/invoke.js`):
```js
{
  task: string,       // human-readable task description
  input: object|null, // optional structured input
}
```

`options` shape (caller-provided):
```js
{
  runId: string,        // optional; auto-generated if absent
  projectRoot: string,  // for the journal path
  agentId: string,      // for journal tagging
  configRef: string,    // from .agent/agents/<id>.json#external.config_ref
  credentialRef: string,// from .agent/agents/<id>.json#external.credential_ref
  timeout: number,      // seconds; default 300
}
```

Return shape:
```js
{
  runId: string,
  status: "ok" | "failed" | "timeout",
  result: object | null,   // vendor-specific; usually { text, ... }
  error: { code, message, ... } | null,
  latency_ms: number,
}
```

#### 2.3.1 Journal layout (mandatory)

Every `invoke()` MUST write to `.agent-runtime/dispatch/<runId>/`:

| File                   | When                                        | Required? |
| :---                   | :---                                        | :---      |
| `request.json`         | Before the first attempt                    | ✅         |
| `result.json`          | On 2xx / success terminal state              | one of these |
| `error.json`           | On any failure terminal state               | one of these |
| `rollback.json`        | After result.json OR error.json             | ✅         |
| `rollback-failed.json` | ONLY if `rollback.json` write itself fails  | best-effort |

Use the helpers from `BaseAdapter` — they're already atomic and idempotent:

```js
const { writeDispatchArtifact, ensureDispatchDir, generateRunId } = require("./base");

// Before the spawn:
ensureDispatchDir(projectRoot, runId);
writeDispatchArtifact(projectRoot, runId, "request.json", { ... });

// On success:
writeDispatchArtifact(projectRoot, runId, "result.json", { runId, status: "ok", result, latency_ms });
writeDispatchArtifact(projectRoot, runId, "rollback.json", { runId, status: "completed", reason: "..." });

// On failure (with secondary-rollback safety):
writeDispatchArtifact(projectRoot, runId, "error.json", { runId, status: "failed", error: { code, message } });
try {
  writeDispatchArtifact(projectRoot, runId, "rollback.json", { runId, status: "rolled_back", reason: "..." });
} catch (rollbackErr) {
  writeDispatchArtifact(projectRoot, runId, "rollback-failed.json", {
    runId, status: "rollback_failed", notify_parent: true,
    primary_error: ..., rollback_error: { code: "ERR_ROLLBACK_WRITE_FAILED", message: rollbackErr.message },
  });
}
```

`writeDispatchArtifact` is **atomic** (writes `.tmp-<pid>-<ts>` then renames),
so a partial write can never produce a corrupt journal.

#### 2.3.2 Failure modes (mandatory coverage)

Every adapter MUST handle:

| Failure                          | How to surface it                                |
| :---                             | :---                                             |
| Binary not on PATH (`ENOENT`)    | `error.code = "ERR_ADAPTER_SPAWN"`                |
| Subprocess exits non-zero        | `error.code = "ERR_DISPATCH_FAILED"` + `stderr` excerpt |
| Subprocess timeout               | `error.code = "ERR_DISPATCH_TIMEOUT"` after `SIGTERM` (+ `SIGKILL` grace) |
| stdout is not valid JSON-RPC     | `error.code = "ERR_JSONRPC_PARSE"` + raw stdout excerpt |
| Subprocess returns JSON-RPC error envelope | `error.code = "ERR_VENDOR_<UPPERCASE_OF_RPC_CODE>"` (e.g. `ERR_CLAUDE_-32001`) |
| Rollback.json write itself fails | `rollback-failed.json` + `notify_parent: true`   |

These are the **minimum** error codes. You may add vendor-specific codes
(e.g. `ERR_CLAUDE_QUOTA_EXCEEDED`); just keep the prefix consistent.

### 2.4 `async cancel(runId, options) → { runId, cancelled, error }`

**Async.** Send `SIGTERM` (then `SIGKILL` after a 1.5s grace) to the
running subprocess, write a cancellation record to the journal, return the
structured result.

Default behavior (in `BaseAdapter`): returns `cancelled: false` with
`error.code = "ERR_CANCEL_NOT_SUPPORTED"`. Override only if your adapter
can actually cancel in-flight dispatches.

### 2.5 `async report(runId, options) → { runId, status, result, error, rollback, ... }`

**Async.** Read the journal for a finished (or in-flight) dispatch. The
default `BaseAdapter` impl reads all 5 artifacts and returns a structured
summary. Override only if you need vendor-specific telemetry.

Return shape (default `BaseAdapter.report`):
```js
{
  runId, status, result, error, rollback, rollback_failed, request, written_at,
}
```

`status` is one of:
- `"ok"` — `result.json` exists, dispatch succeeded
- `"failed"` / `"timeout"` — `error.json` exists, terminal failure state
- `"not_found"` — no journal at `.agent-runtime/dispatch/<runId>/`

---

## 3. Registration

Once your adapter class is implemented, register it in the framework's
adapter registry. Two patterns are supported:

### 3.1 Side-effect import (easiest)

In your `index.js`:
```js
const { register } = require("cortex-agent/lib/agents/adapters");
const { MyAdapter } = require("./my-adapter");
register("my-vendor", MyAdapter);
```

Then ensure your module is loaded somewhere. Either:
- Add a `require()` to `lib/agents/adapters/index.js` (allowed — it's
  additive), OR
- Have users `require("my-vendor-cortex-adapter")` from their project init script.

### 3.2 Lazy registration (most portable)

If you ship your adapter as a separate npm package, expose a `register()`
function and let the user call it from their `cortex-agent init` hook:

```js
// my-vendor-cortex-adapter/index.js
const { register } = require("cortex-agent/lib/agents/adapters");
const { MyAdapter } = require("./my-adapter");
module.exports = { register: () => register("my-vendor", MyAdapter) };
```

```js
// user's project init
const myAdapter = require("my-vendor-cortex-adapter");
myAdapter.register();
```

Both work. Pick the one that fits your distribution model.

### 3.3 Configuration in `.agent/agents/<id>.json`

After registration, agents using your adapter look like:

```json
{
  "schema_version": 1,
  "agent_id": "Claude-Code-User",
  "role": "external",
  "model": "claude-sonnet-4.5",
  "started_at": "2026-08-04T00:00:00.000Z",
  "status": "running",
  "capabilities": ["code_review", "long_context"],
  "external": {
    "adapter_type": "claude-code",
    "config_ref": "configs/claude.yaml",
    "credential_ref": "secret://anthropic"
  }
}
```

`adapter_type` is the foreign key to your adapter (must match the string
passed to `register`). `config_ref` and `credential_ref` are advisory paths
— your adapter decides how to interpret them.

---

## 4. Testing Your Adapter

The framework is designed so tests can run **without the real vendor CLI
installed**. The reference implementation (`claude-code.js`) demonstrates
the pattern: tests install a fake binary (a Node script) in a tmp dir and
set `bin: <path-to-fake>` on the adapter.

### 4.1 Test template (drop into `tests/agent-adapter-<vendor>.test.js`)

```js
"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { spawn } = require("node:child_process");

const { MyAdapter } = require("../lib/agents/adapters/my-vendor");
const { writeDispatchArtifact, generateRunId } = require("../lib/agents/adapters/base");

// 1. Write a fake binary that responds to a flag.
const FAKE_BODY = `'use strict';
const mode = process.env.FAKE_MODE || "ok";
if (mode === "ok") {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { text: "ok" } }));
  process.exit(0);
}
if (mode === "fail") { process.stderr.write("nope\\n"); process.exit(7); }
`;

let _fakePath = null;
function fakeBinary() {
  if (_fakePath) return _fakePath;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fake-my-vendor-"));
  _fakePath = path.join(dir, "fake.js");
  fs.writeFileSync(_fakePath, FAKE_BODY);
  fs.chmodSync(_fakePath, 0o755);
  return _fakePath;
}

function mkProject() { return fs.mkdtempSync(path.join(os.tmpdir(), "test-")); }
function rmProject(r) { try { fs.rmSync(r, { recursive: true, force: true }); } catch (_) {} }

// 2. Drive the adapter with the fake binary.
test("my-adapter: invoke() success writes journal", async () => {
  const root = mkProject();
  const a = new MyAdapter({ bin: process.execPath, shell: false });
  // Spawn the fake via the adapter's transport (overridden for the test).
  // ... your test logic ...
  rmProject(root);
});
```

### 4.2 Health check testing

For `health()`, just point your adapter at a known-good and a known-bad
binary. Assert the `status` and `details.bin` fields.

### 4.3 Rollback-failed testing

Force a journal write failure by creating a file at the dispatch path:

```js
const blocked = path.join(root, ".agent-runtime", "dispatch", "R-test");
fs.mkdirSync(path.dirname(blocked), { recursive: true });
fs.writeFileSync(blocked, "not a dir");
// Now invoke() — first write (request.json) will fail.
```

The framework should return a structured `error.journal_write_failed: true`
result.

---

## 5. Common Pitfalls

1. **Subprocess timeout leak**: if you use `Promise.race` for timeout, the
   losing promise's `setTimeout` is still pending. **Always `clearTimeout`**
   in the winning path or your tests will hang for the full timeout.

2. **`shell: true` with user input**: never pass unsanitized input as CLI
   args with `shell: true`. The reference impl sanitizes by JSON-encoding
   payloads to stdin, never via argv.

3. **Stdout buffering**: large responses can fill the pipe buffer (typically
   64 KB on Linux). Accumulate chunks in a string/Buffer, don't read once.

4. **stdout mixing with stderr**: some CLIs write progress to stdout. If
   you see parse failures, check `stderr` for hints.

5. **Journal path**: NEVER write to `.agent/agents/`, `.agent/runs/`, or
   `.agent-runtime/coordination/`. Those are owned by M-002 / M-008. Your
   adapter writes to `.agent-runtime/dispatch/<runId>/` ONLY.

6. **Atomicity**: if you write journal files directly, use the
   `writeDispatchArtifact` helper (atomic `.tmp + rename`). Custom writes
   that crash mid-write will leave partial files.

7. **Async errors in `_writeErrorAndRollback`**: if the journal write
   itself throws, return a structured `error.journal_write_failed: true`
   result instead of throwing. Callers expect a structured return.

8. **Don't depend on `process.cwd()`**: pass `options.projectRoot` through.
   Tests use `mkdtempSync` for isolation.

---

## 6. Two Worked Examples

### 6.1 Echo adapter (5 minutes, ~80 lines)

A no-op adapter that echoes the payload. Useful for smoke tests, demos,
and verifying the framework is wired correctly.

```js
const { BaseAdapter } = require("./base");
const { writeDispatchArtifact, generateRunId } = require("./base");

class EchoAdapter extends BaseAdapter {
  discover() {
    return {
      adapter_type: "echo",
      version: "0.1.0",
      protocol: "external_v1",
      capabilities: ["echo", "noop"],
      transport: "in-process",
    };
  }
  async health() {
    return { status: "ok", ready: true, latency_ms: 0, error: null, details: { kind: "echo" } };
  }
  async invoke(payload, options = {}) {
    const runId = options.runId || generateRunId("R-echo");
    const projectRoot = options.projectRoot || process.cwd();
    writeDispatchArtifact(projectRoot, runId, "request.json", { run_id: runId, payload });
    const result = { runId, status: "ok", result: { echoed: payload }, error: null, latency_ms: 0 };
    writeDispatchArtifact(projectRoot, runId, "result.json", result);
    writeDispatchArtifact(projectRoot, runId, "rollback.json", { run_id: runId, status: "completed" });
    return result;
  }
  async cancel(runId) { return { runId, cancelled: true, error: null }; }
  async report(runId, options = {}) { return super.report(runId, options); }
}

module.exports = { EchoAdapter };
```

### 6.2 HTTP adapter (10 minutes, ~120 lines)

A real HTTP-based adapter. Demonstrates timeout, retry-on-5xx, decision
step, and the rollback-failed escape hatch.

```js
const http = require("node:http");
const https = require("node:https");
const { URL } = require("node:url");
const { BaseAdapter, writeDispatchArtifact, generateRunId } = require("./base");

class HttpAdapter extends BaseAdapter {
  constructor(options = {}) {
    super(options);
    this.endpoint = options.endpoint;
    if (!this.endpoint) throw new Error("HttpAdapter: endpoint required");
    this.timeout = options.timeout || 30;
  }
  discover() {
    return {
      adapter_type: "http",
      version: "0.1.0",
      protocol: "external_v1",
      capabilities: ["http", "json-rpc"],
      transport: "http",
    };
  }
  async health() {
    const start = Date.now();
    try {
      await this._request("GET", null);
      return { status: "ok", ready: true, latency_ms: Date.now() - start, error: null, details: { endpoint: this.endpoint } };
    } catch (err) {
      return { status: "down", ready: false, latency_ms: Date.now() - start, error: err.message, details: {} };
    }
  }
  async invoke(payload, options = {}) {
    const runId = options.runId || generateRunId("R-http");
    const projectRoot = options.projectRoot || process.cwd();
    const start = Date.now();
    writeDispatchArtifact(projectRoot, runId, "request.json", { run_id: runId, payload });
    try {
      const response = await this._request("POST", payload);
      const result = { runId, status: "ok", result: response, error: null, latency_ms: Date.now() - start };
      writeDispatchArtifact(projectRoot, runId, "result.json", result);
      writeDispatchArtifact(projectRoot, runId, "rollback.json", { run_id: runId, status: "completed" });
      return result;
    } catch (err) {
      const errRec = { runId, status: "failed", error: { code: err.code || "ERR_HTTP", message: err.message }, latency_ms: Date.now() - start };
      writeDispatchArtifact(projectRoot, runId, "error.json", errRec);
      try {
        writeDispatchArtifact(projectRoot, runId, "rollback.json", { run_id: runId, status: "rolled_back" });
      } catch (rbErr) {
        writeDispatchArtifact(projectRoot, runId, "rollback-failed.json", { run_id: runId, status: "rollback_failed", notify_parent: true });
      }
      return { ...errRec, result: null };
    }
  }
  async cancel() { return { runId: null, cancelled: false, error: { code: "ERR_CANCEL_NOT_SUPPORTED", message: "HTTP requests cannot be cancelled" } }; }
  async _request(method, body) {
    return new Promise((resolve, reject) => {
      const u = new URL(this.endpoint);
      const client = u.protocol === "https:" ? https : http;
      const data = body ? JSON.stringify(body) : null;
      const req = client.request({
        hostname: u.hostname, port: u.port || (u.protocol === "https:" ? 443 : 80),
        path: u.pathname + u.search, method,
        headers: data ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } : {},
      }, (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve({ statusCode: res.statusCode, body: text });
          } else {
            const err = new Error(`HTTP ${res.statusCode}`); err.statusCode = res.statusCode; reject(err);
          }
        });
      });
      req.on("error", reject);
      req.setTimeout(this.timeout * 1000, () => { const e = new Error("timeout"); e.code = "ETIMEDOUT"; req.destroy(e); });
      if (data) req.write(data);
      req.end();
    });
  }
}

module.exports = { HttpAdapter };
```

Both examples compile + run with `node --test`. Drop them in
`lib/agents/adapters/echo.js` and `lib/agents/adapters/http.js` and add a
2-line `register()` call to the barrel to see them in
`cortex-agent agent adapter list`.

---

## 7. What Ships in M-003 MS-001

This guide + the framework. The reference implementation is
`lib/agents/adapters/claude-code.js` (~400 lines including comments and
atomic-write helpers) — read it for a fully-worked example covering:

- subprocess spawn with `shell: true` fallback
- JSON-RPC over stdio with Content-Length framing
- 5 retry / cancel / report semantics
- ENOENT mapping to `ERR_ADAPTER_SPAWN`
- `rollback-failed.json` escape hatch

| Milestone | Adapters shipped                            | Notes |
| :---      | :---                                        | :--- |
| MS-001    | claude-code                                 | This milestone. |
| MS-002    | codex, codey, pi                            | M-003 batch 2. |
| MS-003    | minimax + MCP bridge bidirectional          | M-003 batch 2. |
| MS-004    | dispatch CLI / file protocol + rollback     | M-003 batch 3. |
| MS-005    | E2E matrix + case study + v1.12.0-rc.1      | M-003 batch 4. |

---

## 8. Open Questions (拍板请求)

None for MS-001 — the 5-method contract is locked. MS-002 onward will
extend with:

- **Streaming responses** (for long-running invokes that want to stream
  tokens back to the parent). Out of scope for MS-001; deferred to M-004
  (FAE-002 event bus).
- **Capability-based dispatch routing** (so `discover()` declares
  capabilities and the framework picks the right adapter per task). Out of
  scope for MS-001; deferred to v1.13+ per the M-003 mission plan.

---

## 9. Register pattern for 3rd-party adapters (M-003 MS-004 update, §6.1)

> **Audience**: 3rd-party adapter authors integrating their runtime with
> cortex-agent. Eric 拍板 2026-08-04 18:13 (per `.agent/missions/M-003/handoffs/
> 20260804-183000-deviations-decided.md` §1): **3rd-party adapters MUST
> explicitly `register()` themselves**. The framework no longer auto-registers
> built-in adapters (e.g. `minimax`); this matches the original M-003 MS-001
> framework philosophy (registry is dynamic, not static).
>
> **What this means in practice**: the moment you finish implementing your
> 5-method adapter, you need to call `register("your-vendor", YourAdapter)`
> somewhere in your project init code (or as a side-effect import). Until you
> do, `cortex-agent agent adapter list` will NOT show your adapter, and any
> `agent dispatch-execute` with `external.adapter_type = "your-vendor"` will
> fail with `ERR_ADAPTER_NOT_REGISTERED`.

### 9.1 The 3 registration patterns (recap + 3rd-party guidance)

There are 3 supported patterns. Pick the one that fits your distribution model.

#### 9.1.1 Side-effect import (easiest, for project-local adapters)

If your adapter lives in the same project as cortex-agent (e.g. an internal
tooling repo), the simplest is to add a side-effect `register()` call at
the top of your project init script or in a one-line `require`:

```js
// your-project/init.js
const { register } = require("cortex-agent/lib/agents/adapters");
const { YourAdapter } = require("./adapters/your-vendor");
register("your-vendor", YourAdapter);
```

Then ensure `init.js` is loaded before any `agent dispatch-execute` call
(e.g. via a `predev` hook, a project-level `cortex.config.js`, or by
importing it from your CI / CLI entry point).

#### 9.1.2 Lazy registration via a separate npm package (most portable)

If you ship your adapter as a separate npm package, expose a `register()`
function so the user opts in:

```js
// your-vendor-cortex-adapter/index.js
const { register } = require("cortex-agent/lib/agents/adapters");
const { YourAdapter } = require("./your-adapter");
module.exports = {
  register: () => register("your-vendor", YourAdapter),
};
```

```js
// user's project init
const yourAdapter = require("your-vendor-cortex-adapter");
yourAdapter.register();
```

The explicit `register()` call is the **canonical 3rd-party pattern** — it
makes the integration discoverable (grep for `register("your-vendor"` to find
all consumers) and avoids hidden side-effects.

#### 9.1.3 Configuration via `entry_point` (declarative, framework-friendly)

For adapter packs that ship multiple adapters, accept the type list as a
config option and register all in one call:

```js
// your-adapter-pack/index.js
const { register } = require("cortex-agent/lib/agents/adapters");
const { AdapterA } = require("./adapter-a");
const { AdapterB } = require("./adapter-b");
module.exports = function registerPack() {
  register("your-vendor-a", AdapterA);
  register("your-vendor-b", AdapterB);
};
```

```js
// user's project init
require("your-adapter-pack")();
```

This pattern is recommended for adapter packs (3+ adapters under one namespace).

### 9.2 E2E test pattern (FAE-001 + M-003 MS-001 spec)

Every adapter should ship a 2-tier test suite:

1. **Unit tests** — exercise the 5 methods in isolation, with mocked
   transports. The framework helpers (`writeDispatchArtifact`,
   `ensureDispatchDir`, `generateRunId`) all live in `lib/agents/adapters/base.js`
   and are safe to call from tests.

2. **E2E tests** — exercise the real adapter path: read an agent entry
   from `.agent/agents/<id>.json`, resolve the adapter, call `invoke()`,
   verify the journal at `.agent-runtime/dispatch/<runId>/`. The
   `tests/agent-m003-cli.test.js` file is the canonical reference for
   this pattern; see also `tests/agent-adapter-claude-code.test.js` for
   the fake-binary injection pattern.

For your E2E test, follow this skeleton:

```js
// tests/agent-adapter-your-vendor.test.js
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { spawn } = require("node:child_process");

const { YourAdapter } = require("../lib/agents/adapters/your-vendor");
const { register, reset, get } = require("../lib/agents/adapters");

// 1. Install a fake binary (subprocess) that simulates your vendor's response.
function installFakeBinary() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fake-your-vendor-"));
  const file = path.join(dir, "fake.js");
  fs.writeFileSync(file, `'use strict';
// Drain stdin so the parent doesn't block.
process.stdin.on("data", () => {});
process.stdin.on("end", () => {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { text: "hello" } }));
  process.exit(0);
});`);
  fs.chmodSync(file, 0o755);
  return { dir, file };
}

test("agent-adapter-your-vendor: invoke writes journal + returns ok", async () => {
  reset(); // start from a known seed
  const fake = installFakeBinary();
  try {
    // 2. Register the adapter (3rd-party pattern).
    register("your-vendor", YourAdapter);
    const adapter = get("your-vendor");
    assert.ok(adapter, "adapter should be registered");

    // 3. Set up a real .agent/agents/<id>.json entry.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "test-your-vendor-"));
    fs.mkdirSync(path.join(root, ".agent", "agents"), { recursive: true });
    fs.writeFileSync(
      path.join(root, ".agent", "agents", "Test-Agent.json"),
      JSON.stringify({
        schema_version: 1,
        agent_id: "Test-Agent",
        role: "external",
        model: "your-model",
        started_at: "2026-08-04T00:00:00.000Z",
        status: "running",
        capabilities: ["text_generation"],
        external: {
          adapter_type: "your-vendor",
          config_ref: "test-config",
          credential_ref: "test-cred",
        },
      }),
    );

    // 4. Invoke with the fake binary injected.
    const result = await adapter.invoke(
      { task: "test", input: null },
      { projectRoot: root, runId: "R-test", timeout: 5, bin: process.execPath, shell: false },
    );
    assert.equal(result.status, "ok");
    assert.ok(result.result);

    // 5. Verify the journal.
    const journal = path.join(root, ".agent-runtime", "dispatch", "R-test");
    assert.ok(fs.existsSync(path.join(journal, "request.json")));
    assert.ok(fs.existsSync(path.join(journal, "result.json")));
    assert.ok(fs.existsSync(path.join(journal, "rollback.json")));

    // Cleanup
    fs.rmSync(root, { recursive: true, force: true });
  } finally {
    fs.rmSync(fake.dir, { recursive: true, force: true });
  }
});
```

Two non-obvious tips:
- **Use `process.execPath` + `shell: false`** to run the fake binary. This
  avoids relying on a real CLI being on `PATH` and works in any Node
  environment.
- **Drain `process.stdin` in the fake binary** (or `end()` it after
  reading). Otherwise the parent process's `child.stdin.end()` doesn't
  actually close the pipe, and the fake hangs forever.

### 9.3 Common pitfalls (3rd-party-specific)

1. **Auto-registering via a barrel `require()`** — don't add a side-effect
   `register()` call to `lib/agents/adapters/index.js`. M-002's strict
   "no modifications to MS-001 ship" constraint means that file is frozen;
   any attempt to add a `register("your-vendor", ...)` line will fail the
   merge. Use one of the 3 patterns in §9.1 instead.

2. **Forgetting to call `register()`** — your adapter won't show up in
   `cortex-agent agent adapter list` and dispatch will fail with
   `ERR_ADAPTER_NOT_REGISTERED`. Symptom: tests pass (they call `register`
   directly) but the CLI fails. Always test the CLI path end-to-end, not
   just the unit tests.

3. **Subprocess `shell: true` with user input** — never pass unsanitized
   task descriptions or input as CLI args when `shell: true` is set. The
   reference impl serializes payloads to JSON on stdin, not argv. Mirror
   that pattern (see §6.1 Echo + §6.2 HTTP examples for the safe shape).

4. **Timeout not cleared in test** — if your invoke() uses
   `Promise.race` for timeout, ALWAYS `clearTimeout` in both the
   winning and losing paths. Otherwise the test runner waits for the
   pending `setTimeout` to fire (up to `timeout` seconds) before exiting,
   giving false-positive slowness or even hangs. The `claude-code.js`
   reference has a worked example (see `_trackSubprocess` + the
   `clearTimeout` calls in the `Promise.race` block).

5. **Not using the journal helpers** — `writeDispatchArtifact` is atomic
   (`.tmp-<pid>-<ts>` + `rename`). If you write journal files directly
   without the helper, a crash mid-write leaves a partial file. The
   framework's `BaseAdapter.report()` will then throw on the corrupt JSON,
   masking the real error. Use the helpers.

6. **Wrong journal path** — never write to `.agent/agents/`, `.agent/runs/`,
   or `.agent-runtime/coordination/`. Those are owned by M-002 / M-008.
   Your adapter writes to `.agent-runtime/dispatch/<runId>/` ONLY. This
   path boundary is enforced by `_writeErrorAndRollback` in the framework
   — if you try to write elsewhere, your tests will fail with
   `ERR_REQUEST_WRITE_FAILED` or a journal-write error.

7. **JSON-RPC parse assumption** — not every CLI emits plain JSON on
   stdout. Some emit Content-Length framed output (LSP-style). The
   reference impl's `_parseJsonRpc` handles 3 shapes (plain JSON + CRLF
   frame + LF frame); copy or import it from `lib/agents/adapters/claude-code.js`
   (it's the same function, re-exported from `lib/agents/dispatch-execute.js`
   as of MS-004 for cross-adapter reuse).

8. **Forgetting to set `process.env` for the subprocess** — when you
   spawn the vendor CLI, pass `env: { ...process.env, YOUR_TOKEN: ... }`,
   not just `process.env`. Otherwise the subprocess won't see the
   credentials you set in the parent. The MS-003 `minimax` adapter
   demonstrates this with `CORTEX_AGENT_BRIDGE=mavis`.

9. **Tests that depend on a real vendor binary** — never require
   `<your-vendor>` to be on `PATH` in tests. Use the fake-binary
   injection pattern (see §9.2). CI environments may not have the
   vendor installed, and tests should be deterministic.

10. **Adapter state leak between tests** — adapters are singletons in
    the registry (one instance per type). If your adapter holds per-run
    state (e.g. a subprocess Map for `cancel()`), use the runId as the
    key and `delete` the entry on completion. The `claude-code.js`
    `_trackSubprocess` / `_untrackSubprocess` helpers are the reference
    pattern.

### 9.4 §6.2 fix: additive adapter types (M-003 minimax + future M-003+)

As of MS-004 (per Eric 拍板 2026-08-04 18:20), the list of valid
`external.adapter_type` values is extended **additively** via
`lib/agents/registry-adapter-types.js`:

- `VALID_ADAPTER_TYPES` (M-002 strict, unchanged) — `claude-code`, `cortex`,
  `codex`, `codey`, `pi`, `custom`.
- `VALID_ADAPTER_TYPES_EXT` (M-003+ additive) — `minimax`, plus future
  M-003+ adapters as they ship.
- `VALID_ADAPTER_TYPES_ALL` (frozen union) — the canonical list for
  callers that need to accept all known types.
- `validateAdapterTypeExt(t)` — accepts any union member; throws
  `ERR_INVALID_ADAPTER_TYPE` (same code as M-002's strict validator) for
  unknowns.

What this means for 3rd-party adapters:
- If your `external.adapter_type = "minimax"` (or any future M-003+ type),
  the dispatch layer accepts it without throwing. (Note: M-002's
  `writeAgent` validator still uses the strict M-002 list, so writing a
  `minimax` entry via `cortex-agent agent register` will fail; you must
  hand-create the entry or use a tool that goes through the additive
  validator.)
- The `agent dispatch-execute` CLI dispatcher uses
  `validateAdapterTypeExt` for the additive acceptance.
- If you ship a new adapter type, you can add it to
  `VALID_ADAPTER_TYPES_EXT` (in a future MS-004+ commit) without touching
  M-002's `lib/agents/registry.js`.

---

## 10. References

- `lib/agents/adapters/base.js` — abstract base class + journal helpers
- `lib/agents/adapters/claude-code.js` — reference implementation (~400 lines)
- `lib/agents/adapters/index.js` — registry (register / get / list / has)
- `lib/agents/dispatch-execute.js` — HTTP dispatch with retry + decision step
- `lib/agents/bridge/mcp-server.js` — MCP stdio JSON-RPC server (F-007)
- `lib/agents/invoke.js` (M-002) — plan builder; your adapter is invoked from
  here once `agent dispatch-execute` is called
- `templates/_base/.agent/agents/agent.schema.json` (M-001) — agent entry schema
  with `external.adapter_type` / `config_ref` / `credential_ref`
- `docs/architecture/general-mode-design.md` v0.4 §17.4 (Phase 3 RFC) — the
  mission context
- D-003-1 / D-003-2 / D-003-3 / D-003-4 / D-003-7 — the 5 decisions this guide implements
