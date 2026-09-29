"use strict";

const { createRef } = require("../../packages/protocol/src/index.js");
const {
  createRuntimePort,
} = require("../../packages/runtime-port/src/index.js");

const DEFAULT_WAIT_INTERVAL_MS = 50;
const DEFAULT_WAIT_TIMEOUT_MS = 30_000;

function adapterRunId(refOrId) {
  if (typeof refOrId !== "string" || !refOrId) {
    const error = new Error("run reference or id is required");
    error.code = "ERR_RUN_REF_REQUIRED";
    throw error;
  }
  return refOrId.startsWith("run:") ? refOrId.slice("run:".length) : refOrId;
}

function normalizeStatus(report) {
  if (!report || typeof report !== "object") return "unknown";
  if (report.status === "not_found") return "pending";
  if (report.error) return "failed";
  if (report.result) return "completed";
  const value = String(report.status || "").toLowerCase();
  if (["ok", "success", "completed"].includes(value)) return "completed";
  if (["failed", "error"].includes(value)) return "failed";
  if (["cancelled", "canceled"].includes(value)) return "cancelled";
  if (["running", "pending", "queued", "waiting"].includes(value)) return value;
  return value || "unknown";
}

function normalizeRunResult(result) {
  const runId = result && (result.runId || result.run_id);
  if (!runId) {
    const error = new Error("legacy adapter invoke() returned no runId");
    error.code = "ERR_LEGACY_ADAPTER_RUN_ID_MISSING";
    throw error;
  }
  return {
    run_ref: createRef("run", runId),
    status: normalizeStatus(result),
    result: result.result ?? null,
    error: result.error ?? null,
    latency_ms: result.latency_ms ?? null,
  };
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createLegacyAdapterRuntimePort(adapter, options = {}) {
  if (!adapter || typeof adapter.discover !== "function"
    || typeof adapter.health !== "function"
    || typeof adapter.invoke !== "function"
    || typeof adapter.cancel !== "function"
    || typeof adapter.report !== "function") {
    const error = new Error("legacy adapter must implement discover/health/invoke/cancel/report");
    error.code = "ERR_LEGACY_ADAPTER_CONTRACT";
    throw error;
  }

  const discovered = adapter.discover() || {};
  const adapterType = discovered.adapter_type || options.adapterType || "legacy";
  const implementationVersion = discovered.version || null;

  const capabilities = [
    "runtime.discover",
    "runtime.health",
    "runtime.run.status",
    "runtime.run.wait",
  ];
  if (discovered.invoke_supported !== false) capabilities.push("runtime.run.create");
  if (discovered.cancel_supported !== false) capabilities.push("runtime.run.cancel");

  const descriptor = {
    protocol: "cortex-runtime",
    protocol_version: "1.0",
    implementation: `native-adapter:${adapterType}`,
    implementation_version: implementationVersion,
    capabilities,
  };

  return createRuntimePort({
    descriptor,
    operations: {
      discoverRuntime() {
        return {
          descriptor,
          adapter: discovered,
        };
      },

      health() {
        return adapter.health();
      },

      async createRun(payload, invokeOptions = {}) {
        const result = await adapter.invoke(payload, invokeOptions);
        return normalizeRunResult(result);
      },

      async cancel(refOrId, cancelOptions = {}) {
        const runId = adapterRunId(refOrId);
        const result = await adapter.cancel(runId, cancelOptions);
        return {
          run_ref: createRef("run", runId),
          cancelled: Boolean(result && result.cancelled),
          error: result && result.error ? result.error : null,
        };
      },

      async getStatus(refOrId, reportOptions = {}) {
        const runId = adapterRunId(refOrId);
        const report = await adapter.report(runId, reportOptions);
        return {
          run_ref: createRef("run", runId),
          status: normalizeStatus(report),
          result: report && report.result ? report.result : null,
          error: report && report.error ? report.error : null,
          evidence: {
            result_present: Boolean(report && report.result),
            error_present: Boolean(report && report.error),
            rollback_present: Boolean(report && report.rollback),
            rollback_failed: Boolean(report && report.rollback_failed),
            written_at: report && report.written_at ? report.written_at : null,
          },
        };
      },

      async wait(refOrId, waitOptions = {}) {
        const runId = adapterRunId(refOrId);
        const timeoutMs = Number.isFinite(waitOptions.timeout_ms)
          ? Math.max(0, waitOptions.timeout_ms)
          : DEFAULT_WAIT_TIMEOUT_MS;
        const intervalMs = Number.isFinite(waitOptions.interval_ms)
          ? Math.max(1, waitOptions.interval_ms)
          : DEFAULT_WAIT_INTERVAL_MS;
        const reportOptions = waitOptions.report_options || {};
        const started = Date.now();

        while (true) {
          const report = await adapter.report(runId, reportOptions);
          const status = normalizeStatus(report);
          if (["completed", "failed", "cancelled"].includes(status)) {
            return {
              run_ref: createRef("run", runId),
              status,
              result: report && report.result ? report.result : null,
              error: report && report.error ? report.error : null,
              evidence: {
                result_present: Boolean(report && report.result),
                error_present: Boolean(report && report.error),
                rollback_present: Boolean(report && report.rollback),
                rollback_failed: Boolean(report && report.rollback_failed),
                written_at: report && report.written_at ? report.written_at : null,
              },
            };
          }
          if (Date.now() - started >= timeoutMs) {
            const error = new Error(`wait timed out for ${runId}`);
            error.code = "ERR_RUNTIME_WAIT_TIMEOUT";
            error.run_id = runId;
            throw error;
          }
          await delay(intervalMs);
        }
      },
    },
  });
}

module.exports = {
  createLegacyAdapterRuntimePort,
  adapterRunId,
  normalizeStatus,
  normalizeRunResult,
};
