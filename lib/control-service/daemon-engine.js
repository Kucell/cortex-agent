"use strict";

class DaemonEngineError extends Error {
  constructor(code, details = {}) {
    super(`[daemon-engine:${code}] ${JSON.stringify(details)}`);
    this.name = "DaemonEngineError";
    this.code = code;
    this.details = details;
  }
}

function createMemoryIdempotencyStore(limit = 1000) {
  const seen = new Map();
  return Object.freeze({
    has(key) {
      return seen.has(key);
    },
    mark(key, value = true) {
      if (seen.has(key)) seen.delete(key);
      seen.set(key, value);
      while (seen.size > limit) {
        seen.delete(seen.keys().next().value);
      }
    },
    size() {
      return seen.size;
    },
  });
}

function createDaemonEngine(options = {}) {
  if (typeof options.requestSource !== "function") {
    throw new DaemonEngineError("ERR_DAEMON_REQUEST_SOURCE_REQUIRED", {});
  }
  if (!options.controlService || typeof options.controlService.execute !== "function") {
    throw new DaemonEngineError("ERR_DAEMON_CONTROL_SERVICE_REQUIRED", {});
  }

  const concurrencyLimit = Number.isInteger(options.concurrencyLimit)
    ? Math.max(1, options.concurrencyLimit)
    : 1;
  const idempotency = options.idempotency || createMemoryIdempotencyStore();
  const onResult = typeof options.onResult === "function" ? options.onResult : async () => {};
  const rememberResult = typeof options.rememberResult === "function"
    ? options.rememberResult
    : (result) => Boolean(result && result.status === "dispatched");

  async function executeOne(request) {
    if (!request || typeof request !== "object") {
      throw new DaemonEngineError("ERR_DAEMON_REQUEST_INVALID", {});
    }
    const key = request.idempotency_key;
    if (typeof key !== "string" || !key.trim()) {
      throw new DaemonEngineError("ERR_DAEMON_IDEMPOTENCY_REQUIRED", {
        task_id: request.task_id || null,
      });
    }
    if (idempotency.has(key)) {
      const result = Object.freeze({
        skipped: true,
        reason: "idempotent_replay",
        idempotency_key: key,
        task_id: request.task_id || null,
      });
      await onResult(result, request);
      return result;
    }

    const result = await options.controlService.execute(request);
    if (rememberResult(result, request)) {
      idempotency.mark(key, {
        task_id: request.task_id || null,
        status: result && result.status || null,
      });
    }
    const envelope = Object.freeze({
      skipped: false,
      idempotency_key: key,
      task_id: request.task_id || null,
      result,
    });
    await onResult(envelope, request);
    return envelope;
  }

  async function tick(context = {}) {
    const requests = await options.requestSource(context);
    if (!Array.isArray(requests)) {
      throw new DaemonEngineError("ERR_DAEMON_REQUEST_SOURCE_RESULT", {});
    }

    const results = [];
    for (let index = 0; index < requests.length; index += concurrencyLimit) {
      const batch = requests.slice(index, index + concurrencyLimit);
      const batchResults = await Promise.all(batch.map(executeOne));
      results.push(...batchResults);
    }

    return Object.freeze({
      polled: requests.length,
      processed: results.filter((item) => !item.skipped).length,
      skipped: results.filter((item) => item.skipped).length,
      results: Object.freeze(results),
    });
  }

  return Object.freeze({
    concurrency_limit: concurrencyLimit,
    tick,
  });
}

module.exports = {
  DaemonEngineError,
  createMemoryIdempotencyStore,
  createDaemonEngine,
};
