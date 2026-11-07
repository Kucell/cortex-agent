"use strict";

// ─── DSH Adapter (M-029 / P-006 / MS-001) ──────────────────────────────────────
//
// Concrete adapter for the DeepSeek Harness (DSH) CLI. Promoted from a
// Token Control Plane shadow host (`D-TCP-004-add-dsh-host`) to a first-class
// dispatch adapter on par with Pi / Claude Code / Codex CLI / MiniMax.
//
// CLI invocation shape (M-034 WP-03, verified against dsh 0.2.1-rc.5 on
// 2026-11-07 via `dsh --profile headless --help`):
//
//   $ dsh --profile headless [--json] [--session-id <id>] -
//     stdin  : the task text (multi-line safe; `-` means "read task from stdin")
//     stdout : with --json, newline-delimited run events
//              (session / status / thinking / text / tool_call / tool_result /
//               final / error); without --json, the plain final answer
//     stderr : diagnostics (non-JSON)
//
// There is NO `--run-id` / `--task` / `--input` / `--config` / `--model`
// surface and NO JSON-RPC exchange on the real CLI — the pre-M-034 assumed
// shape is retired here. A successful run always writes a terminal
// `{"type":"final","text":...}` event and exits 0; `{"type":"error",...}`
// plus exit 1 reports failures.
//
// Difference from Pi / Claude Code / Codex / MiniMax adapters:
//   - ADAPTER_TYPE === "dsh" (per `lib/agents/registry-adapter-types.js`
//     `VALID_ADAPTER_TYPES_EXT` extension path — registry.js itself is
//     M-002 frozen and stays zero-modify).
//   - Default bin is "dsh" (not claude / codex / codey / pi / minimax).
//   - Override env: DSH_BIN.
//   - Capability descriptor reports explicit fallback for capabilities the
//     DSH CLI does not yet expose (tool.before.block / context.render.observe).
//
// Differences from DSH shadow adapter (`lib/host-adapter/shadow-usage/dsh-shadow.js`):
//   - The shadow adapter only measures token usage from the on-disk DSH
//     envelope and never spawns the DSH CLI. The dispatch adapter here
//     spawns the CLI and exchanges JSON-RPC requests.
//   - Both code paths co-exist: shadow keeps governance evidence flowing for
//     TCP; dispatch handles real agent work.
//
// Hard constraints (per VC-029-G01 / architecture-design.md):
//   - Zero npm deps. node:child_process / node:fs / node:path only.
//   - No real DSH CLI call in tests — tests inject a fake binary path
//     via DSH_BIN env var (or options.bin).
//   - Pure add. base.js / claude-code.js / codex.js / pi.js / minimax.js
//     / registry.js / index.js (except the try/catch tail added in MS-002)
//     unchanged in this file's commit.

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const {
  createHash,
} = require("node:crypto");
const {
  BaseAdapter,
  writeDispatchArtifact,
  generateRunId,
} = require("./base");

const ADAPTER_TYPE = "dsh";
const ADAPTER_VERSION = "0.1.0";
const ADAPTER_PROTOCOL = "external_v1";
const DEFAULT_BIN = "dsh";
const DEFAULT_TIMEOUT = 300;
const HEALTH_TIMEOUT_MS = 5000;
const STDERR_EXCERPT = 4096;
const STDOUT_EXCERPT = 4096;
// M-034 MS-001 (P-008 §4.3) — runtime compatibility probe budget.
// `--version` / `--help` answer in milliseconds; 5s is plenty.
const PROBE_TIMEOUT_MS = 5000;
// Booting `--profile headless --help` mounts the profile and measured
// 3.1–4.6s on an idle host, so the 5s budget was too tight under load (the
// independent reviewer saw ~50% flake). Give the profile probe its own
// budget and retry once on timeout before declaring the host unsupported.
const PROFILE_PROBE_TIMEOUT_MS = 15000;
// A probe result stays usable briefly so a dispatch that just probed does not
// re-boot the profile; failures expire sooner so one transient timeout does
// not pin the adapter to `unsupported` for the whole process lifetime.
const PROBE_CACHE_READY_TTL_MS = 120000;
const PROBE_CACHE_FAIL_TTL_MS = 15000;
const PROBE_HELP_EXCERPT = 512;
const PROBE_VERSION_EXCERPT = 128;
// Recognised version shape. Real dsh 0.1.1-rc.2 observed on this host;
// P-008 originally cited "dsh 3.13.7" but the probe output is authoritative.
const PROBE_VERSION_RE = /^(\d+)\.(\d+)(?:\.(\d+))?(?:[-+][\w.]+)?\s*$/;
// "headless" profile flag is the only launch surface whose behaviour was
// observable against a real binary on the M-034 base host.
const PROBE_SUPPORTED_PROFILE = "headless";
const PROBE_SUPPORTED_TRANSPORT = "text-headless-v1";
const PROBE_UNSUPPORTED_TRANSPORTS = Object.freeze(["stdio-json-rpc"]);

class DshAdapter extends BaseAdapter {
  constructor(options = {}) {
    super(options);
    this.bin = options.bin || process.env.DSH_BIN || DEFAULT_BIN;
    // MS-001 review: spawn the real CLI without a shell. The task never enters
    // argv (it is written to stdin as `-`), so a shell only adds injection
    // surface and triggers Node's DEP0190 warning for args + shell:true.
    // Callers may still opt into shell:true explicitly.
    this.shell = options.shell !== undefined ? options.shell : false;
    this.defaultTimeout = options.defaultTimeout || DEFAULT_TIMEOUT;
    // Per-instance subprocess tracking for cancel() — populated in MS-003.
    this._subprocesses = new Map();
    // M-034 MS-001 (P-008 §4.3) probe cache. Stays null until health() /
    // probe() runs at least once. discover() never touches the runtime.
    this._probeCache = null;
    this._probeCacheExpiresAt = 0;
  }

  // Fresh cache for the spawn gate / health: expired entries fall back to a
  // live probe instead of pinning an old verdict.
  _freshProbeCache() {
    if (!this._probeCache) return null;
    return Date.now() < this._probeCacheExpiresAt ? this._probeCache : null;
  }

  // 1. discover — describe this adapter. Pure metadata; never touches the
  //    external runtime. Synchronous.
  //
  //    M-034 MS-001 (P-008 §3 / §4.3): discover() exposes the supported /
  //    unsupported transport set and the cached probe summary. WP-03 makes
  //    the pre-probe answer honest: `transport` is null and
  //    `transport_supported` is empty until a probe proves the headless
  //    surface. New readers MUST consult `transport_supported` /
  //    `transport_verified`, never the legacy scalar.
  discover() {
    const probe = this._probeCache;
    // M-034 WP-03: never advertise a launch surface before the probe proves
    // it. `stdio-json-rpc` was the pre-M-034 assumption and is now explicitly
    // unsupported; it must not appear as "supported" by default.
    const transportReady = Boolean(probe && probe.ready);
    const transportSupported = transportReady ? [probe.supported_transport] : [];
    const transportPrimary = transportReady ? probe.supported_transport : null;
    return {
      adapter_type: ADAPTER_TYPE,
      version: ADAPTER_VERSION,
      protocol: ADAPTER_PROTOCOL,
      capabilities: [
        "text_generation",
        "code_review",
        "tool_use",
        "multi_turn",
        "long_context",
      ],
      schema: { request: 1, response: 1, journal: 1 },
      // Legacy single-value transport. Kept for M-029 backwards compat.
      transport: transportPrimary,
      // New (M-034 MS-001): authoritative transport list and unsupported list.
      transport_supported: transportSupported,
      transport_unsupported: PROBE_UNSUPPORTED_TRANSPORTS.slice(),
      transport_status: probe ? probe.status : "unknown",
      transport_verified: transportReady,
      supported_profile: transportReady ? probe.supported_profile : null,
      cli: { bin: this.bin, shell: this.shell },
      // Promoted from shadow host (D-TCP-004) by P-006 / M-029 MS-001.
      // Only "stable" once a probe proves the headless transport; until then
      // the adapter is usable only with an injected fake binary (tests) and
      // must not be presented as production-ready.
      maturity: transportReady ? "stable" : "experimental",
      host: "deepseek-harness",
      receipt_contract: "ms-001",
      // Probe summary (P-008 §3 evidence); null until probe()/health() runs.
      probe_summary: probe,
      // Capability descriptor per P-001 frozen vocabulary.
      capability_descriptor: this._buildCapabilityDescriptor(),
    };
  }

  // 2. health — verify the dsh binary is reachable. Uses `which` (POSIX)
  //    or `where` (Windows). Cheap, safe to call from CLI / dashboard.
  //    Mirrors claude-code / codex / pi health check shape so
  //    `agent adapter health` output stays consistent across vendors.
  async health(options = {}) {
    const base = await this._healthBinary();
    if (!options.probe && !options.strict) return base;
    if (!base.ready) {
      return {
        ...base,
        details: { ...(base.details || {}), transport_status: "unsupported" },
      };
    }
    let probe;
    try {
      probe = this._freshProbeCache() || await this.probe();
    } catch (err) {
      return {
        ...base,
        status: "degraded",
        ready: false,
        error: `probe failed: ${err.message}`,
        details: { ...(base.details || {}), transport_status: "unknown" },
      };
    }
    const ready = base.ready && probe.ready;
    return {
      ...base,
      status: ready ? "ok" : "degraded",
      ready,
      error: ready ? base.error : (probe.fail_closed_reasons || []).join(", ") || `transport ${probe.status}`,
      details: {
        ...(base.details || {}),
        transport_status: probe.status,
        transport_supported: probe.supported_transport,
        transport_unsupported: probe.unsupported_transports,
        supported_profile: probe.supported_profile,
        binary_path: probe.binary_path,
        version: probe.version ? probe.version.out_excerpt : null,
        help_exit: probe.help ? probe.help.exit_code : null,
        help_sha256: probe.help ? probe.help.sha256 : null,
        profile_exit: probe.profile ? probe.profile.exit_code : null,
        profile_ok: probe.profile ? probe.profile.ok : false,
        fail_closed_reasons: probe.fail_closed_reasons || [],
      },
    };
  }

  // Legacy `which`-only reachability check. Kept separate so the base health
  // contract (and its tests) stay unchanged; `health({ probe: true })` layers
  // the strict transport evidence on top.
  async _healthBinary() {
    const start = Date.now();
    const whichBin = process.platform === "win32" ? "where" : "which";
    return new Promise((resolve) => {
      let resolved = false;
      const settle = (result) => {
        if (resolved) return;
        resolved = true;
        resolve(result);
      };
      let child;
      try {
        child = spawn(whichBin, [this.bin], {
          stdio: "ignore",
          shell: this.shell,
        });
      } catch (err) {
        return settle({
          status: "down",
          ready: false,
          latency_ms: Date.now() - start,
          error: `spawn ${whichBin} failed: ${err.message}`,
          details: { bin: this.bin, platform: process.platform },
        });
      }
      const timeoutHandle = setTimeout(() => {
        try { child.kill("SIGKILL"); } catch (_) { /* ignore */ }
        settle({
          status: "down",
          ready: false,
          latency_ms: Date.now() - start,
          error: `which ${this.bin} timed out`,
          details: { bin: this.bin },
        });
      }, HEALTH_TIMEOUT_MS);
      child.on("error", (err) => {
        clearTimeout(timeoutHandle);
        settle({
          status: "down",
          ready: false,
          latency_ms: Date.now() - start,
          error: err.message,
          details: { bin: this.bin, platform: process.platform },
        });
      });
      child.on("exit", (code) => {
        clearTimeout(timeoutHandle);
        const latency_ms = Date.now() - start;
        if (code === 0) {
          // M-034 MS-001 (P-008 §3): health() intentionally reports `which dsh`
          // reachability only; the strict probe (version + help evidence) is
          // exposed via probe() so M-029 tests that rely on `health() = ok`
          // when the binary resolves on PATH stay green. Callers that need
          // the strict contract check must call probe() explicitly.
          settle({
            status: "ok",
            ready: true,
            latency_ms,
            error: null,
            details: {
              bin: this.bin,
              version: ADAPTER_VERSION,
              platform: process.platform,
            },
          });
        } else {
          settle({
            status: "down",
            ready: false,
            latency_ms,
            error: `${this.bin} not found in PATH (${whichBin} exit ${code})`,
            details: {
              bin: this.bin,
              platform: process.platform,
              PATH: process.env.PATH || "",
            },
          });
        }
      });
    });
  }

  // 3. invoke — execute a real DSH dispatch.
  //    payload: { task, input, ... }
  //    options: { runId, projectRoot, agentId, configRef, credentialRef, timeout }
  //
  //    Mirrors `lib/agents/adapters/codex.js` invoke() one-for-one (with
  //    `codex` → `dsh` rename and `ERR_CODEX_*` → `ERR_DSH_*`). The DSH CLI
  //    shape is currently ASSUMED per P-006 §4.3; tests inject a fake `dsh`
  //    binary path via DSH_BIN env / options.bin (no real DSH CLI required).
  // 3. invoke — real dispatch through the `headless` profile.
  //
  // Transport: `dsh --profile headless [--json] [--session-id <id>] -` with the
  // task delivered on stdin. The adapter keeps ownership of the timeout, the
  // journal artifacts, and the status contract:
  //
  //   ok      — exit 0 AND a terminal `{"type":"final"}` event was observed
  //   blocked — exit 0 but no terminal event (no settled signal; P-008)
  //   failed  — spawn error / non-zero exit / `{"type":"error"}` event /
  //             unparseable stdout
  //   timeout — adapter-side SIGTERM → SIGKILL
  //
  // `verifyTransport` (the CLI sets it) fails closed before spawning when the
  // probe has not proven the headless surface. A cached probe is always
  // honoured, so a caller that probed explicitly cannot silently fall back.
  async invoke(payload = {}, options = {}) {
    const runId = options.runId || generateRunId(`R-${ADAPTER_TYPE}`);
    const projectRoot = options.projectRoot || process.cwd();
    const timeout = Number(options.timeout) || this.defaultTimeout;
    const agentId = options.agentId || payload.agent_id || null;
    const configRef = options.configRef || null;
    const credentialRef = options.credentialRef || null;
    const start = Date.now();
    const jsonEvents = options.jsonEvents !== false && payload.json_events !== false;
    const sessionId = options.sessionId || payload.session_id || null;

    // 0. Transport gate (M-034 WP-03).
    if (options.verifyTransport === true || this._probeCache) {
      const probe = this._freshProbeCache() || await this.probe();
      if (!probe.ready) {
        return this._writeErrorAndRollback(projectRoot, runId, {
          run_id: runId,
          agent_id: agentId,
          adapter_type: ADAPTER_TYPE,
          status: "failed",
          error: {
            code: "ERR_DSH_TRANSPORT_UNSUPPORTED",
            message: `DSH transport not ready (${probe.status}); refusing to spawn`,
            probe_status: probe.status,
            supported_transport: probe.supported_transport,
            fail_closed_reasons: Array.isArray(probe.fail_closed_reasons)
              ? probe.fail_closed_reasons.slice()
              : [],
          },
          latency_ms: Date.now() - start,
          written_at: new Date().toISOString(),
        });
      }
    }

    // 1. Journal the request before touching the runtime.
    const requestRecord = {
      run_id: runId,
      agent_id: agentId,
      adapter_type: ADAPTER_TYPE,
      transport: PROBE_SUPPORTED_TRANSPORT,
      supported_profile: PROBE_SUPPORTED_PROFILE,
      payload: {
        task: payload.task || null,
        input: payload.input || null,
      },
      config_ref: configRef,
      credential_ref: credentialRef,
      model_ref: options.model || null,
      session_id: sessionId,
      json_events: jsonEvents,
      timeout,
      // `--model` / `--config` have no headless CLI equivalent; they are kept
      // for provenance only and are resolved by the DSH profile itself.
      cli: { bin: this.bin, shell: this.shell, transport: PROBE_SUPPORTED_TRANSPORT },
      created_at: new Date(start).toISOString(),
    };
    try {
      writeDispatchArtifact(projectRoot, runId, "request.json", requestRecord);
    } catch (err) {
      return {
        runId,
        status: "failed",
        result: null,
        error: { code: "ERR_REQUEST_WRITE_FAILED", message: err.message },
        latency_ms: 0,
      };
    }

    // 2. Build the real headless argv + stdin body.
    const taskText = payload.task ? String(payload.task) : "";
    const inputBlock = this._renderInputBlock(payload.input);
    if (!taskText.trim() && !inputBlock) {
      return this._writeErrorAndRollback(projectRoot, runId, {
        run_id: runId,
        agent_id: agentId,
        adapter_type: ADAPTER_TYPE,
        status: "failed",
        error: {
          code: "ERR_DSH_TASK_REQUIRED",
          message: "invoke() requires payload.task (or payload.input)",
        },
        latency_ms: Date.now() - start,
        written_at: new Date().toISOString(),
      });
    }
    const args = ["--profile", PROBE_SUPPORTED_PROFILE];
    if (jsonEvents) args.push("--json");
    if (sessionId) args.push("--session-id", String(sessionId));
    // `-` means "read the task from stdin": multi-line prompts survive intact
    // and no shell metacharacter can leak into the argv.
    args.push("-");
    const stdinBody = [taskText, inputBlock]
      .filter((part) => part && part.length > 0)
      .join("\n\n---\n\n") + "\n";

    // 3. Spawn the subprocess.
    const spawnOptions = {
      stdio: ["pipe", "pipe", "pipe"],
      cwd: projectRoot,
      shell: this.shell,
      env: {
        ...process.env,
        CORTEX_AGENT_ADAPTER: ADAPTER_TYPE,
        CORTEX_AGENT_RUN_ID: runId,
      },
    };

    let child;
    let spawnError = null;
    try {
      child = spawn(this.bin, args, spawnOptions);
    } catch (err) {
      spawnError = err;
    }

    if (spawnError || !child) {
      return this._writeErrorAndRollback(projectRoot, runId, {
        run_id: runId,
        agent_id: agentId,
        adapter_type: ADAPTER_TYPE,
        status: "failed",
        error: {
          code: "ERR_ADAPTER_SPAWN",
          message: spawnError ? spawnError.message : "spawn returned no child",
        },
        latency_ms: Date.now() - start,
        written_at: new Date().toISOString(),
      });
    }

    // Track for cancel()
    this._trackSubprocess(runId, child);

    // 4. Deliver the task on stdin and close.
    try {
      child.stdin.write(stdinBody);
      child.stdin.end();
    } catch (err) {
      this._untrackSubprocess(runId);
      return this._writeErrorAndRollback(projectRoot, runId, {
        run_id: runId,
        agent_id: agentId,
        adapter_type: ADAPTER_TYPE,
        status: "failed",
        error: { code: "ERR_ADAPTER_STDIN", message: err.message },
        latency_ms: Date.now() - start,
        written_at: new Date().toISOString(),
      });
    }

    // 5. Accumulate stdout / stderr.
    let stdoutData = "";
    let stderrData = "";
    child.stdout.on("data", (chunk) => {
      stdoutData += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderrData += chunk.toString("utf8");
    });

    // 6. Wait for completion OR timeout.
    let timedOut = false;
    let timeoutHandle = null;
    const completionPromise = new Promise((resolve) => {
      child.on("exit", (code, signal) => {
        if (timeoutHandle) { clearTimeout(timeoutHandle); timeoutHandle = null; }
        resolve({ code, signal, error: null });
      });
      child.on("error", (err) => {
        if (timeoutHandle) { clearTimeout(timeoutHandle); timeoutHandle = null; }
        resolve({ code: -1, signal: null, error: err });
      });
    });
    const timeoutPromise = new Promise((resolve) => {
      timeoutHandle = setTimeout(() => {
        timedOut = true;
        timeoutHandle = null;
        try { child.kill("SIGTERM"); } catch (_) { /* ignore */ }
        setTimeout(() => {
          try { child.kill("SIGKILL"); } catch (_) { /* ignore */ }
        }, 1500);
        resolve({ code: -1, signal: "SIGTERM", error: null, timeout: true });
      }, Math.max(1, timeout) * 1000);
    });
    const finalState = await Promise.race([completionPromise, timeoutPromise]);
    if (timeoutHandle) { clearTimeout(timeoutHandle); timeoutHandle = null; }
    this._untrackSubprocess(runId);
    const latency_ms = Date.now() - start;

    // 7. Branch on the process outcome.
    if (timedOut) {
      return this._writeErrorAndRollback(projectRoot, runId, {
        run_id: runId,
        agent_id: agentId,
        adapter_type: ADAPTER_TYPE,
        status: "timeout",
        error: {
          code: "ERR_DISPATCH_TIMEOUT",
          message: `dispatch timed out after ${timeout}s`,
        },
        stderr: stderrData.slice(0, STDERR_EXCERPT),
        latency_ms,
        written_at: new Date().toISOString(),
      });
    }
    if (finalState.error) {
      const isSpawnMissing = finalState.error.code === "ENOENT"
        || /ENOENT/.test(finalState.error.message || "");
      return this._writeErrorAndRollback(projectRoot, runId, {
        run_id: runId,
        agent_id: agentId,
        adapter_type: ADAPTER_TYPE,
        status: "failed",
        error: isSpawnMissing
          ? { code: "ERR_ADAPTER_SPAWN", message: finalState.error.message }
          : { code: "ERR_DISPATCH_ERROR", message: finalState.error.message },
        stderr: stderrData.slice(0, STDERR_EXCERPT),
        latency_ms,
        written_at: new Date().toISOString(),
      });
    }
    // 8. Parse the headless run stream BEFORE the exit-code branch: the real
    //    CLI writes a structured `{"type":"error"}` event and then exits 1, so
    //    the event carries the specific code and the exit code is the fallback.
    const parsed = this._parseHeadlessOutput(stdoutData, { jsonEvents });
    if (parsed.errorEvent) {
      const rawCode = parsed.errorEvent.code;
      const codeSuffix = rawCode === undefined || rawCode === null
        ? "EVENT_ERROR"
        : String(rawCode).toUpperCase().replace(/[^A-Z0-9_+-]/g, "_");
      return this._writeErrorAndRollback(projectRoot, runId, {
        run_id: runId,
        agent_id: agentId,
        adapter_type: ADAPTER_TYPE,
        status: "failed",
        error: {
          code: `ERR_DSH_${codeSuffix}`,
          message: parsed.errorEvent.message || "DSH reported an error event",
          data: parsed.errorEvent.data || null,
          event_type: parsed.errorEvent.type || null,
          exit_code: finalState.code,
        },
        stdout_excerpt: stdoutData.slice(0, STDOUT_EXCERPT),
        stderr: stderrData.slice(0, STDERR_EXCERPT),
        latency_ms,
        written_at: new Date().toISOString(),
      });
    }
    if (finalState.code !== 0) {
      return this._writeErrorAndRollback(projectRoot, runId, {
        run_id: runId,
        agent_id: agentId,
        adapter_type: ADAPTER_TYPE,
        status: "failed",
        error: {
          code: "ERR_DISPATCH_FAILED",
          message: `dsh exited with code ${finalState.code}`,
          exit_code: finalState.code,
          signal: finalState.signal,
        },
        stderr: stderrData.slice(0, STDERR_EXCERPT),
        latency_ms,
        written_at: new Date().toISOString(),
      });
    }
    if (parsed.parseError) {
      return this._writeErrorAndRollback(projectRoot, runId, {
        run_id: runId,
        agent_id: agentId,
        adapter_type: ADAPTER_TYPE,
        status: "failed",
        error: {
          code: "ERR_DSH_EVENT_PARSE",
          message: `failed to parse headless run stream: ${parsed.parseError}`,
        },
        stdout_excerpt: stdoutData.slice(0, STDOUT_EXCERPT),
        stderr: stderrData.slice(0, STDERR_EXCERPT),
        latency_ms,
        written_at: new Date().toISOString(),
      });
    }

    // 9. Exit 0 without a terminal `final` event is NOT a settled signal
    //    (P-008 / VC-034-001-03): record blocked instead of claiming ok.
    if (!parsed.settled) {
      const blockedRecord = {
        run_id: runId,
        agent_id: agentId,
        adapter_type: ADAPTER_TYPE,
        status: "blocked",
        reason: "missing_settled_signal",
        result: {
          text: parsed.text,
          events_count: parsed.events.length,
          json_events: jsonEvents,
        },
        stdout_excerpt: stdoutData.slice(0, STDOUT_EXCERPT),
        latency_ms,
        written_at: new Date().toISOString(),
      };
      writeDispatchArtifact(projectRoot, runId, "result.json", blockedRecord);
      writeDispatchArtifact(projectRoot, runId, "rollback.json", {
        run_id: runId,
        agent_id: agentId,
        adapter_type: ADAPTER_TYPE,
        status: "blocked",
        reason: "dispatch exited 0 without a settled run event; outcome unverified",
        written_at: new Date().toISOString(),
      });
      return blockedRecord;
    }

    // 10. Settled — write result.json + rollback.json.
    const resultRecord = {
      run_id: runId,
      agent_id: agentId,
      adapter_type: ADAPTER_TYPE,
      status: "ok",
      settlement: parsed.settlement,
      result: {
        text: parsed.text,
        events_count: parsed.events.length,
        json_events: jsonEvents,
      },
      latency_ms,
      written_at: new Date().toISOString(),
    };
    writeDispatchArtifact(projectRoot, runId, "result.json", resultRecord);
    writeDispatchArtifact(projectRoot, runId, "rollback.json", {
      run_id: runId,
      agent_id: agentId,
      adapter_type: ADAPTER_TYPE,
      status: "completed",
      reason: "real dispatch completed successfully; no rollback needed",
      written_at: new Date().toISOString(),
    });
    return resultRecord;
  }

  // 4. cancel — SIGTERM the running subprocess (if any).
  async cancel(runId, options = {}) {
    const child = this._subprocesses.get(runId);
    if (!child) {
      return {
        runId,
        cancelled: false,
        error: {
          code: "ERR_NO_RUNNING_SUBPROCESS",
          message: `no running subprocess tracked for ${runId}`,
        },
      };
    }
    try {
      child.kill("SIGTERM");
    } catch (err) {
      return {
        runId,
        cancelled: false,
        error: { code: "ERR_CANCEL_FAILED", message: err.message },
      };
    }
    this._untrackSubprocess(runId);
    return { runId, cancelled: true, error: null };
  }

  // 5. report — read the journal. We extend the base behavior with a
  //    helpful summary for the CLI surface (mirrors codex.js).
  async report(runId, options = {}) {
    const base = await super.report(runId, options);
    if (base.status === "not_found") return base;
    return {
      ...base,
      adapter_type: ADAPTER_TYPE,
      latency_ms: base.result ? base.result.latency_ms : (base.error ? base.error.latency_ms || 0 : 0),
    };
  }

  // ─── internal helpers ─────────────────────────────────────────────────────

  // Render `payload.input` as a trailing prompt block. Strings pass through;
  // objects become a fenced JSON block so the model sees the exact payload.
  _renderInputBlock(input) {
    if (input === undefined || input === null) return "";
    if (typeof input === "string") return input;
    try {
      return "```json\n" + JSON.stringify(input, null, 2) + "\n```";
    } catch (_) {
      return String(input);
    }
  }

  // Parse the `dsh --profile headless --json` newline-delimited event stream.
  //
  // Real projection (verified in @deepseek-ai/dsh-headless 0.2.1-rc.5):
  //   {"type":"session",...}
  //   {"type":"status","phase":"turn_start|step_start|step_end|turn_end",...}
  //   {"type":"thinking","text":...}
  //   {"type":"text","text":...}
  //   {"type":"tool_call",...} / {"type":"tool_result",...,"status":...}
  //   {"type":"final","text":...}        <- terminal, lossless answer
  //   {"type":"error","message":...}     <- failure
  //
  // `final` is the ONLY settled signal. `turn_end` is a turn boundary, not a
  // run settlement (a task may span several turns), so it is deliberately not
  // treated as terminal.
  _parseHeadlessOutput(stdoutData, { jsonEvents }) {
    const out = {
      text: "",
      events: [],
      settled: false,
      settlement: null,
      errorEvent: null,
      parseError: null,
      nonJsonLines: [],
    };
    const raw = String(stdoutData || "");
    if (!jsonEvents) {
      out.text = raw.trim();
      if (!out.text) out.parseError = "empty stdout from dsh CLI";
      return out;
    }
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      if (!trimmed.startsWith("{")) {
        out.nonJsonLines.push(line);
        continue;
      }
      try {
        out.events.push(JSON.parse(trimmed));
      } catch (_) {
        out.nonJsonLines.push(line);
      }
    }
    if (out.events.length === 0) {
      out.text = out.nonJsonLines.join("\n").trim();
      out.parseError = out.text
        ? "no machine-readable run events on stdout"
        : "empty stdout from dsh CLI";
      return out;
    }
    out.errorEvent = this._findErrorEvent(out.events);
    out.text = this._extractHeadlessText(out.events);
    const finalEvent = [...out.events].reverse().find((event) => (
      event && typeof event === "object" && event.type === "final"
    ));
    if (finalEvent) {
      out.settled = true;
      out.settlement = {
        type: "final",
        text_bytes: Buffer.byteLength(String(finalEvent.text || ""), "utf8"),
      };
    }
    return out;
  }

  _findErrorEvent(events) {
    // Explicit `{"type":"error"}` wins (usage errors, startup failures).
    for (const event of events) {
      if (!event || typeof event !== "object") continue;
      if (event.type === "error") {
        return {
          code: event.code,
          message: event.message || "DSH reported an error",
          data: event.data || null,
          type: "error",
        };
      }
    }
    // A failed turn is reported inside
    // `{"type":"status","phase":"turn_end","reason":{"kind":"error","error":{...}}}`
    // and followed by a `final` with empty text plus exit 1. Surfacing the
    // reason code (e.g. MISSING_CREDENTIAL) is more useful than the exit code.
    for (const event of events) {
      if (!event || typeof event !== "object") continue;
      const reason = event.reason;
      if (
        event.type === "status"
        && event.phase === "turn_end"
        && reason
        && reason.kind === "error"
      ) {
        const detail = reason.error || {};
        return {
          code: detail.code,
          message: detail.message || "DSH turn ended with an error",
          data: detail,
          type: "status/turn_end",
        };
      }
    }
    return null;
  }

  _extractHeadlessText(events) {
    let text = "";
    for (const event of events) {
      if (!event || typeof event !== "object") continue;
      if (event.type === "text" && typeof event.text === "string") {
        text += event.text;
      } else if (event.type === "final" && typeof event.text === "string") {
        // The terminal event carries the same lossless answer the default
        // (non-JSON) mode prints; prefer it over accumulated chunks.
        text = event.text;
      }
    }
    return text;
  }

  // Resolve the CLI binary. Absolute paths are taken as-is; a bare name is
  // looked up on PATH (mirroring what the OS would do when the probe spawns
  // it). The old `path.resolve(bin)` resolved a bare "dsh" against cwd, so a
  // perfectly healthy host on PATH reported `binary_not_found`.
  _resolveBinary() {
    const bin = this.bin;
    if (typeof bin !== "string" || bin.length === 0) return null;
    if (path.isAbsolute(bin)) {
      try {
        return fs.statSync(bin).isFile() ? bin : null;
      } catch (_) {
        return null;
      }
    }
    if (/[\\/]/.test(bin)) {
      const abs = path.resolve(bin);
      try {
        return fs.statSync(abs).isFile() ? abs : null;
      } catch (_) {
        return null;
      }
    }
    const exts = process.platform === "win32"
      ? String(process.env.PATHEXT || ".EXE;.CMD;.BAT;.COM").split(";").filter(Boolean)
      : [""];
    for (const dir of String(process.env.PATH || "").split(path.delimiter)) {
      if (!dir) continue;
      for (const ext of exts) {
        const candidate = path.join(dir, bin + ext);
        try {
          if (fs.statSync(candidate).isFile()) return candidate;
        } catch (_) {
          // keep looking
        }
      }
    }
    return null;
  }

  _writeErrorAndRollback(projectRoot, runId, errorRecord) {
    let written = false;
    try {
      writeDispatchArtifact(projectRoot, runId, "error.json", errorRecord);
      written = true;
    } catch (err) {
      // Could not even write error.json — catastrophic.
      return {
        ...errorRecord,
        error: {
          ...(errorRecord.error || {}),
          journal_write_failed: true,
          journal_write_error: err.message,
        },
      };
    }
    // Try to write rollback.json. If that fails, write rollback-failed.json.
    try {
      writeDispatchArtifact(projectRoot, runId, "rollback.json", {
        run_id: runId,
        agent_id: errorRecord.agent_id,
        adapter_type: ADAPTER_TYPE,
        status: "rolled_back",
        reason: `real dispatch failed (${errorRecord.error.code}); rollback journal written`,
        original_error: errorRecord.error,
        written_at: new Date().toISOString(),
      });
    } catch (rollbackErr) {
      try {
        writeDispatchArtifact(projectRoot, runId, "rollback-failed.json", {
          run_id: runId,
          agent_id: errorRecord.agent_id,
          adapter_type: ADAPTER_TYPE,
          status: "rollback_failed",
          primary_error: errorRecord.error,
          rollback_error: {
            code: "ERR_ROLLBACK_WRITE_FAILED",
            message: rollbackErr.message,
          },
          notify_parent: true,
          written_at: new Date().toISOString(),
        });
      } catch (finalErr) {
        // eslint-disable-next-line no-console
        console.error(
          `[dsh] critical: failed to write any error/rollback for ${runId}: ${finalErr.message}`,
        );
      }
    }
    void written;
    return errorRecord;
  }

  _trackSubprocess(runId, child) {
    this._subprocesses.set(runId, child);
  }
  _untrackSubprocess(runId) {
    this._subprocesses.delete(runId);
  }

  // _buildCapabilityDescriptor
  // ─── M-034 MS-001 probe (P-008 §3 / §4.3) ────────────────────────────────
  //
  // Runs `dsh --version`, `dsh --help`, and `dsh --profile headless --help`
  // against the configured binary in bounded subprocesses, captures exit
  // codes, version shape, the SHA-256 of the help text, and whether the
  // headless profile actually boots, then classifies the host:
  //
  //   ready       — binary reachable, version recognised, "headless" appears
  //                 in help, and `--profile headless --help` exits 0.
  //   degraded    — binary reachable and version recognised, but no
  //                 "headless" profile in help; only text-headless-v1 partial.
  //   unsupported — binary reachable but version unrecognised, args rejected,
  //                 timeout, or the headless profile does not boot; non-zero
  //                 abort.
  //   unknown     — probe never ran (status before health()/probe()).
  //
  // Every result includes:
  //   - binary_path, version_exit, version_out_excerpt, version_match,
  //   - help_exit, help_out_excerpt, help_sha256,
  //   - profile_exit, profile_ok (real `--profile headless --help` result),
  //   - captured_at (ISO timestamp),
  //   - fail_closed_reasons (array, may be empty).
  //
  // Hard rules:
  //   - shell:false + absolute path (options.bin or DSH_BIN) — no PATH lookup
  //     surprise.
  //   - bounded timeout per probe (PROBE_TIMEOUT_MS); kill on expiry.
  //   - never throws; always resolves with the structured envelope.
  //   - never writes journal artifacts; pure read-only evidence.

  // Cache the bounded probe summary used by discover()/health(). Keeping the
  // shape in one place keeps the pre-spawn gate and the CLI output aligned.
  _setProbeCache(result) {
    this._probeCache = Object.freeze({
      status: result.status,
      ready: result.ready,
      captured_at: result.captured_at,
      binary_path: result.binary_path,
      version: {
        major: result.version.major,
        minor: result.version.minor,
        patch: result.version.patch,
        raw: result.version.raw,
        out_excerpt: result.version.out_excerpt,
        recognised: result.version.recognised,
      },
      help_sha256: result.help.sha256,
      help_exit: result.help.exit_code,
      has_headless_profile: result.help.has_headless_profile,
      profile_exit: result.profile.exit_code,
      profile_ok: result.profile.ok,
      supported_transport: result.supported_transport,
      supported_profile: result.supported_profile,
      unsupported_transports: result.unsupported_transports,
      fail_closed_reasons: result.fail_closed_reasons,
    });
    this._probeCacheExpiresAt = Date.now() + (result.ready
      ? PROBE_CACHE_READY_TTL_MS
      : PROBE_CACHE_FAIL_TTL_MS);
    return this._probeCache;
  }

  async probe() {
    const start = Date.now();
    const binaryPath = this._resolveBinary();
    if (!binaryPath) {
      const missing = {
        status: "unsupported",
        ready: false,
        binary_path: this.bin,
        captured_at: new Date(start).toISOString(),
        latency_ms: Date.now() - start,
        version: {
          exit_code: -1,
          timed_out: false,
          out_excerpt: "",
          raw: "",
          recognised: false,
          major: null,
          minor: null,
          patch: null,
        },
        help: {
          exit_code: -1,
          timed_out: false,
          out_excerpt: "",
          sha256: createHash("sha256").update("").digest("hex"),
          has_headless_profile: false,
        },
        profile: {
          exit_code: -1,
          timed_out: false,
          ok: false,
          out_excerpt: "",
        },
        supported_transport: PROBE_SUPPORTED_TRANSPORT,
        supported_profile: PROBE_SUPPORTED_PROFILE,
        unsupported_transports: PROBE_UNSUPPORTED_TRANSPORTS,
        fail_closed_reasons: Object.freeze(["binary_not_found"]),
      };
      this._setProbeCache(missing);
      return missing;
    }
    const reasons = [];

    // ── 1. version probe
    const versionResult = await this._runProbeCommand(
      binaryPath,
      ["--version"],
      PROBE_TIMEOUT_MS,
    );
    const versionOut = String(versionResult.stdout || "").trim();
    const versionMatch = versionOut.match(PROBE_VERSION_RE);
    let versionRecognised = false;
    if (versionResult.timedOut) {
      reasons.push("version_timeout");
    } else if (versionResult.error) {
      reasons.push("version_error:" + versionResult.error.code);
    } else if (versionResult.code !== 0) {
      reasons.push(`version_exit_nonzero:${versionResult.code}`);
    } else if (!versionMatch) {
      reasons.push("version_shape_unrecognised");
    } else {
      versionRecognised = true;
    }

    // ── 2. help probe
    const helpResult = await this._runProbeCommand(
      binaryPath,
      ["--help"],
      PROBE_TIMEOUT_MS,
    );
    const helpOut = String(helpResult.stdout || "");
    const helpSha = createHash("sha256").update(helpOut).digest("hex");
    const helpHasHeadless = /--profile\s+<name>/.test(helpOut)
      && /\bheadless\b/.test(helpOut);
    if (helpResult.timedOut) {
      reasons.push("help_timeout");
    } else if (helpResult.error) {
      reasons.push("help_error:" + helpResult.error.code);
    } else if (helpResult.code !== 0) {
      reasons.push(`help_exit_nonzero:${helpResult.code}`);
    }

    // ── 2b. profile probe
    // Help text mentioning "headless" is not proof that the profile exists:
    // the real `dsh --help` cites it as an example even when
    // $DSH_HOME/profiles/headless is missing. Actually boot the profile with
    // `--help` (no task, no model call) so a missing/broken profile fails
    // closed instead of being advertised as ready.
    // Only boot the profile when the launcher help at least advertises a
    // headless profile; otherwise the host is already `degraded` and booting
    // a profile that does not exist only wastes time.
    let profileResult = { stdout: "", stderr: "", code: -1, timedOut: false };
    if (helpHasHeadless) {
      profileResult = await this._runProbeCommand(
        binaryPath,
        ["--profile", PROBE_SUPPORTED_PROFILE, "--help"],
        PROFILE_PROBE_TIMEOUT_MS,
      );
    }
    if (profileResult.timedOut) {
      // One retry absorbs a slow first mount under load; the second timeout
      // still fails closed.
      profileResult = await this._runProbeCommand(
        binaryPath,
        ["--profile", PROBE_SUPPORTED_PROFILE, "--help"],
        PROFILE_PROBE_TIMEOUT_MS,
      );
    }
    const profileOut = String(profileResult.stdout || "");
    let profileOk = false;
    if (!helpHasHeadless) {
      // Nothing to boot: the launcher help already ruled the profile out.
    } else if (profileResult.timedOut) {
      reasons.push("headless_profile_timeout");
    } else if (profileResult.error) {
      reasons.push("headless_profile_error:" + profileResult.error.code);
    } else if (profileResult.code !== 0) {
      reasons.push(`headless_profile_exit_nonzero:${profileResult.code}`);
    } else if (!/Usage:\s+dsh\s+--profile\s+headless/.test(profileOut)) {
      // A wrapper that forwards the launcher help would also exit 0; require
      // the headless app's own usage line before calling the profile ready.
      reasons.push("headless_profile_shape_unrecognised");
    } else {
      profileOk = true;
    }

    // ── 3. classify
    const binaryReachable = !versionResult.error && versionResult.code === 0
      && !helpResult.error && helpResult.code === 0
      && !versionResult.timedOut && !helpResult.timedOut;
    let status;
    if (!binaryReachable) {
      status = "unsupported";
    } else if (!versionRecognised) {
      status = "unsupported";
    } else if (!helpHasHeadless) {
      status = "degraded";
    } else if (!profileOk) {
      status = "unsupported";
    } else {
      status = "ready";
    }

    const result = {
      status,
      ready: status === "ready",
      binary_path: binaryPath,
      captured_at: new Date(start).toISOString(),
      latency_ms: Date.now() - start,
      version: {
        exit_code: versionResult.code,
        timed_out: versionResult.timedOut,
        out_excerpt: versionOut.slice(0, PROBE_VERSION_EXCERPT),
        raw: versionOut,
        recognised: versionRecognised,
        major: versionMatch ? Number(versionMatch[1]) : null,
        minor: versionMatch ? Number(versionMatch[2]) : null,
        patch: versionMatch && versionMatch[3] ? Number(versionMatch[3]) : null,
      },
      help: {
        exit_code: helpResult.code,
        timed_out: helpResult.timedOut,
        out_excerpt: helpOut.slice(0, PROBE_HELP_EXCERPT),
        sha256: helpSha,
        has_headless_profile: helpHasHeadless,
      },
      profile: {
        exit_code: profileResult.code,
        timed_out: profileResult.timedOut,
        ok: profileOk,
        out_excerpt: profileOut.slice(0, PROBE_HELP_EXCERPT),
      },
      supported_transport: PROBE_SUPPORTED_TRANSPORT,
      supported_profile: PROBE_SUPPORTED_PROFILE,
      unsupported_transports: PROBE_UNSUPPORTED_TRANSPORTS,
      fail_closed_reasons: Object.freeze([...reasons]),
    };

    this._setProbeCache(result);
    return result;
  }

  // _runProbeCommand — internal helper. Spawns `<bin> <args>` with shell:false
  // and a bounded timeout. Captures stdout / stderr excerpts and never throws.
  _runProbeCommand(binaryPath, args, timeoutMs) {
    return new Promise((resolve) => {
      let resolved = false;
      const settle = (value) => {
        if (resolved) return;
        resolved = true;
        resolve(value);
      };
      let child;
      try {
        child = spawn(binaryPath, args, {
          stdio: ["ignore", "pipe", "pipe"],
          shell: false,
          windowsHide: true,
        });
      } catch (err) {
        return settle({
          code: -1,
          signal: null,
          timedOut: false,
          stdout: "",
          stderr: "",
          error: { code: err.code || "ERR_SPAWN", message: err.message },
        });
      }
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => {
        stdout += chunk.toString("utf8");
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk.toString("utf8");
      });
      const timer = setTimeout(() => {
        try { child.kill("SIGTERM"); } catch (_) { /* ignore */ }
        setTimeout(() => {
          try { child.kill("SIGKILL"); } catch (_) { /* ignore */ }
        }, 500);
        settle({
          code: -1,
          signal: "SIGTERM",
          timedOut: true,
          stdout,
          stderr,
          error: null,
        });
      }, Math.max(1, timeoutMs));
      child.on("error", (err) => {
        clearTimeout(timer);
        settle({
          code: -1,
          signal: null,
          timedOut: false,
          stdout,
          stderr,
          error: { code: err.code || "ERR_SPAWN", message: err.message },
        });
      });
      child.on("exit", (code, signal) => {
        clearTimeout(timer);
        settle({ code, signal, timedOut: false, stdout, stderr, error: null });
      });
    });
  }

 // _buildCapabilityDescriptor — P-001 frozen vocabulary descriptor.
  // Returns an object that passes `validateCapabilityDescriptor` from
  // lib/runtime-adapters/capability-contract.js (kept as a pure data
  // builder here so the adapter does not import the contract module; the
  // contract tests live under tests/runtime-adapters/capability-contract.test.js
  // and are extended in MS-001).
  _buildCapabilityDescriptor() {
    const detectedAt = new Date().toISOString();
    return Object.freeze({
      schema_version: "1.0",
      host: Object.freeze({
        adapter_id: ADAPTER_TYPE,
        vendor: "deepseek",
        version: ADAPTER_VERSION,
      }),
      detected_at: detectedAt,
      capabilities: Object.freeze({
        "session.boundary": Object.freeze({
          level: "explicit",
          source: "self-reported",
          reason: "DSH CLI emits session lifecycle via its on-disk envelope (D-TCP-004 backfill evidence)",
        }),
        "turn.boundary": Object.freeze({
          level: "adapter",
          source: "runtime-trace",
          reason: "DSH chunk events carry turn/step metadata; derived via the shadow usage backfill",
        }),
        "message.boundary": Object.freeze({
          level: "unobservable",
          source: "not-exposed",
          reason: "DSH CLI does not expose message-level boundary events in current version",
        }),
        "tool.before.observe": Object.freeze({
          level: "unsupported",
          source: "not-implemented",
          reason: "DSH CLI tool-before hook not yet verified — M-018 (P-006 Phase 5) conditional on real hook capability",
        }),
        "tool.before.block": Object.freeze({
          level: "unsupported",
          source: "not-implemented",
          reason: "DSH CLI tool-before block not yet verified — gated by M-018",
        }),
        "tool.update": Object.freeze({
          level: "unobservable",
          source: "not-exposed",
          reason: "DSH CLI does not expose tool update callbacks in current version",
        }),
        "context.render.observe": Object.freeze({
          level: "unsupported",
          source: "not-implemented",
          reason: "DSH CLI does not expose transformContext hook in current version",
        }),
        // M-034 MS-001 (P-008 §4.3): transport evidence is intentionally NOT
        // added to the P-001 frozen capability descriptor. The strict
        // transport contract (text-headless-v1 supported / stdio-json-rpc
        // unsupported) is exposed via discover().transport_supported and
        // discover().probe_summary instead.
        // P-007 TKR extension (authorized by D-P007-TKR-CAP-EXT): DSH
        // harness surfaces first-class sub-agent delegation with full prompt
        // guidance (subagent / subagent_fork tools), verified in-session.
        "subagent": Object.freeze({
          level: "native",
          source: "runtime-trace",
          reason: "DSH host exposes subagent/subagent_fork tools; delegation with prompt guidance verified in-session (D-P007-TKR-CAP-EXT)",
        }),
        "prompt_guidance": Object.freeze({
          level: "native",
          source: "runtime-trace",
          reason: "Sub-agent invocation accepts full standalone prompt text with capability gating (D-P007-TKR-CAP-EXT)",
        }),
      }),
      // P-003 friction signal matrix (M-003A). DSH CLI currently exposes
      // structured failure/lifecycle signals via the on-disk journal; the
      // remaining signals are conservatively marked not_observed until
      // verified against real hook telemetry. redaction is aggregate_only
      // because every other field below carries only counts / refs / lifecycle
      // names — there is no free-form payload channel.
      friction_signals: Object.freeze({
        tool_denied: "not_observed",
        tool_failed: "derived",
        tool_retried: "derived",
        user_interrupted: "not_observed",
        user_correction: "not_observed",
        lifecycle_stop: "derived",
      }),
      friction_lifecycle_events: Object.freeze(["session.end"]),
      redaction_level: "aggregate_only",
    });
  }
}

module.exports = {
  DshAdapter,
  ADAPTER_TYPE,
  ADAPTER_VERSION,
  ADAPTER_PROTOCOL,
  DEFAULT_BIN,
  DEFAULT_TIMEOUT,
  // M-034 MS-001 (P-008 §3 / §4.3) probe surface.
  PROBE_TIMEOUT_MS,
  PROBE_VERSION_RE,
  PROBE_SUPPORTED_PROFILE,
  PROBE_SUPPORTED_TRANSPORT,
  PROBE_UNSUPPORTED_TRANSPORTS,
};
