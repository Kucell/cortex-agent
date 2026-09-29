"use strict";

let protocol;
let runtimePort;
try {
  protocol = require("@cortex-agent/protocol");
  runtimePort = require("@cortex-agent/runtime-port");
} catch (_) {
  protocol = require("../../protocol/src/index.js");
  runtimePort = require("../../runtime-port/src/index.js");
}

const PASEO_CLIENT_VERSION = "0.10.0";
const DEFAULT_TIMELINE_LIMIT = 200;

class PaseoRuntimeError extends Error {
  constructor(code, details = {}, cause) {
    super(`[paseo-runtime:${code}] ${JSON.stringify(details)}`);
    this.name = "PaseoRuntimeError";
    this.code = code;
    this.details = details;
    if (cause !== undefined) this.cause = cause;
  }
}

async function defaultClientFactory(config) {
  let mod;
  try {
    mod = await import("@getpaseo/client");
  } catch (error) {
    throw new PaseoRuntimeError(
      "ERR_PASEO_CLIENT_UNAVAILABLE",
      {
        package: "@getpaseo/client",
        required: "^0.10.0",
      },
      error,
    );
  }
  if (!mod || typeof mod.createPaseoClient !== "function") {
    throw new PaseoRuntimeError("ERR_PASEO_CLIENT_INVALID", {});
  }
  return mod.createPaseoClient(config);
}

function paseoRunRef(agentId) {
  if (typeof agentId !== "string" || !agentId.trim()) {
    throw new PaseoRuntimeError("ERR_PASEO_AGENT_ID", {});
  }
  return protocol.createRef("run", `paseo:${agentId.trim()}`);
}

function paseoAgentId(runRef) {
  const parsed = protocol.parseRef(runRef, "run");
  if (!parsed || !parsed.value.startsWith("paseo:") || parsed.value.length <= "paseo:".length) {
    throw new PaseoRuntimeError("ERR_PASEO_RUN_REF", { run_ref: runRef });
  }
  return parsed.value.slice("paseo:".length);
}

function normalizeAgentStatus(snapshotOrHandle) {
  const archivedAt = snapshotOrHandle && snapshotOrHandle.archivedAt;
  if (archivedAt) return "archived";
  const status = snapshotOrHandle && snapshotOrHandle.status;
  switch (status) {
    case "initializing": return "created";
    case "running": return "running";
    case "idle": return "waiting";
    case "error": return "failed";
    case "closed": return "stopped";
    case null:
    case undefined:
      return "unknown";
    default:
      return "unknown";
  }
}

function normalizeWaitStatus(result) {
  const status = result && result.status;
  switch (status) {
    case "idle": return "waiting";
    case "error": return "failed";
    case "permission": return "waiting";
    case "timeout": return "waiting";
    default: return "unknown";
  }
}

function requiredString(value, code, details = {}) {
  if (typeof value !== "string" || !value.trim()) {
    throw new PaseoRuntimeError(code, details);
  }
  return value.trim();
}

function safeTimelineType(item) {
  const raw = item && typeof item.type === "string" ? item.type : "event";
  const normalized = raw
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, ".")
    .replace(/^\.+|\.+$/g, "")
    .replace(/\.{2,}/g, ".");
  return normalized || "event";
}

function safeTimelinePayload(entry) {
  const item = entry && entry.item && typeof entry.item === "object" ? entry.item : {};
  const payload = {
    provider: typeof entry.provider === "string" ? entry.provider : "unknown",
    item_type: typeof item.type === "string" ? item.type : "unknown",
  };
  if (typeof item.turnId === "string" && item.turnId.length <= 256) {
    payload.turn_id = item.turnId;
  }
  if (typeof item.status === "string" && item.status.length <= 64) {
    payload.status = item.status;
  }
  return payload;
}

function encodePaseoCursor(cursor) {
  if (!cursor || typeof cursor.epoch !== "string" || !Number.isSafeInteger(cursor.seq)) {
    return null;
  }
  return {
    stream_id: `paseo:${cursor.epoch}`,
    position: `epoch:${encodeURIComponent(cursor.epoch)}:seq:${cursor.seq}`,
    event_id: null,
  };
}

function normalizePaseoTimeline(agentId, runRef, page, context = {}) {
  if (!page || typeof page !== "object") {
    throw new PaseoRuntimeError("ERR_PASEO_TIMELINE_INVALID", {});
  }
  if (page.error) {
    throw new PaseoRuntimeError("ERR_PASEO_TIMELINE", { error: String(page.error) });
  }

  const entries = Array.isArray(page.entries) ? page.entries : [];
  const events = entries.map((entry, index) => {
    const epoch = typeof entry.epoch === "string"
      ? entry.epoch
      : (typeof page.epoch === "string" ? page.epoch : "unknown");
    const seq = Number.isSafeInteger(entry.seq) ? entry.seq : index;
    const sourceEventId = `paseo:${agentId}:${epoch}:${seq}`;
    return protocol.normalizeCortexEvent({
      event_id: protocol.canonicalEventId("runtime", sourceEventId),
      type: `runtime.paseo.${safeTimelineType(entry.item)}`,
      occurred_at: typeof entry.timestamp === "string"
        ? entry.timestamp
        : new Date(0).toISOString(),
      source: {
        kind: "runtime",
        source_event_id: sourceEventId,
        producer_id: "paseo",
        producer_kind: "runtime",
        project_ref: context.project_ref || null,
        host_ref: context.host_ref || null,
        runtime_ref: context.runtime_ref || "runtime:paseo",
      },
      correlation: {
        mission_id: context.mission_id || null,
        milestone_id: context.milestone_id || null,
        task_id: context.task_id || null,
        run_ref: runRef,
        workspace_ref: context.workspace_ref || null,
      },
      sequence: {
        stream_id: `paseo:${agentId}:${epoch}`,
        value: seq,
      },
      causation_id: null,
      payload: safeTimelinePayload(entry),
      evidence_refs: [],
      redacted: true,
    });
  });

  const analysis = protocol.analyzeCortexTimeline(events);
  const reset = page.reset === true;
  return Object.freeze({
    events: analysis.events,
    cursor: protocol.normalizeTimelineCursor(encodePaseoCursor(page.startCursor)),
    next_cursor: protocol.normalizeTimelineCursor(encodePaseoCursor(page.endCursor)),
    duplicate_event_ids: analysis.duplicate_event_ids,
    gaps: analysis.gaps,
    reconciliation: Object.freeze({
      required: reset || analysis.reconciliation_required,
      reason: reset
        ? "paseo_timeline_reset_or_epoch_replacement"
        : (analysis.reconciliation_required ? "sequence_gap_or_regression" : null),
    }),
    stream_positions: analysis.stream_positions,
    source: Object.freeze({
      epoch: typeof page.epoch === "string" ? page.epoch : null,
      reset,
      projection: typeof page.projection === "string" ? page.projection : null,
      direction: typeof page.direction === "string" ? page.direction : null,
      has_older: page.hasOlder === true,
      has_newer: page.hasNewer === true,
    }),
  });
}

function createPaseoRuntime(options = {}) {
  const url = requiredString(options.url, "ERR_PASEO_URL_REQUIRED");
  const clientFactory = options.clientFactory || defaultClientFactory;
  if (typeof clientFactory !== "function") {
    throw new PaseoRuntimeError("ERR_PASEO_CLIENT_FACTORY", {});
  }

  const runtimeRef = options.runtime_ref || "runtime:paseo";
  if (!protocol.isRef(runtimeRef, "runtime")) {
    throw new PaseoRuntimeError("ERR_PASEO_RUNTIME_REF", { runtime_ref: runtimeRef });
  }

  const descriptor = {
    protocol: "cortex-runtime",
    protocol_version: "1.0",
    implementation: "paseo",
    implementation_version: options.paseo_client_version || PASEO_CLIENT_VERSION,
    capabilities: [
      "runtime.discover",
      "runtime.health",
      "runtime.run.create",
      "runtime.run.send",
      "runtime.run.status",
      "runtime.run.wait",
      "runtime.timeline.read",
      "runtime.run.archive",
    ],
  };

  let clientPromise = null;
  let connected = false;
  const handles = new Map();

  async function getClient({ connect = true } = {}) {
    if (!clientPromise) {
      clientPromise = Promise.resolve(clientFactory({
        url,
        ...(options.client_config || {}),
      }));
    }
    const client = await clientPromise;
    if (!client || !client.agents || typeof client.agents.create !== "function") {
      throw new PaseoRuntimeError("ERR_PASEO_CLIENT_INVALID", {});
    }
    if (connect && !connected) {
      if (typeof client.connect !== "function") {
        throw new PaseoRuntimeError("ERR_PASEO_CLIENT_CONNECT_MISSING", {});
      }
      await client.connect();
      connected = true;
    }
    return client;
  }

  async function handleFor(runRef, { refresh = false } = {}) {
    const agentId = paseoAgentId(runRef);
    if (handles.has(agentId)) {
      const handle = handles.get(agentId);
      if (refresh && typeof handle.refresh === "function") await handle.refresh();
      return handle;
    }
    const client = await getClient();
    if (!client.agents || typeof client.agents.ref !== "function") {
      throw new PaseoRuntimeError("ERR_PASEO_AGENT_REF_UNAVAILABLE", {});
    }
    const handle = client.agents.ref(agentId);
    handles.set(agentId, handle);
    if (refresh && typeof handle.refresh === "function") await handle.refresh();
    return handle;
  }

  const port = runtimePort.createRuntimePort({
    descriptor,
    operations: {
      discoverRuntime() {
        return Object.freeze({
          descriptor,
          runtime_ref: runtimeRef,
          endpoint: url,
          public_sdk: "@getpaseo/client",
          public_sdk_version: descriptor.implementation_version,
          cancel_exposed: false,
        });
      },

      async health() {
        const started = Date.now();
        try {
          const client = await getClient();
          const state = typeof client.getConnectionState === "function"
            ? client.getConnectionState()
            : { status: "connected" };
          return {
            status: state && state.status === "connected" ? "ok" : "unknown",
            ready: !state || state.status === "connected",
            latency_ms: Date.now() - started,
            error: null,
            details: { connection: state || null, url },
          };
        } catch (error) {
          return {
            status: "down",
            ready: false,
            latency_ms: Date.now() - started,
            error: error && error.message ? error.message : String(error),
            details: { code: error && error.code ? error.code : null, url },
          };
        }
      },

      async createRun(payload = {}, createOptions = {}) {
        const client = await getClient();
        const cwd = requiredString(
          createOptions.cwd || payload.cwd,
          "ERR_PASEO_CWD_REQUIRED",
        );
        const provider = requiredString(
          createOptions.provider
            || (createOptions.config && createOptions.config.provider)
            || payload.provider
            || (payload.config && payload.config.provider),
          "ERR_PASEO_PROVIDER_REQUIRED",
        );
        const prompt = createOptions.prompt !== undefined
          ? createOptions.prompt
          : (payload.prompt !== undefined ? payload.prompt : payload.task);
        if (prompt !== undefined && typeof prompt !== "string") {
          throw new PaseoRuntimeError("ERR_PASEO_PROMPT_INVALID", {});
        }

        const baseConfig = {
          ...((payload.config && typeof payload.config === "object") ? payload.config : {}),
          ...((createOptions.config && typeof createOptions.config === "object") ? createOptions.config : {}),
          provider,
        };

        const handle = await client.agents.create({
          config: baseConfig,
          cwd,
          ...(prompt !== undefined ? { prompt } : {}),
          ...(createOptions.idempotency_key
            ? { idempotencyKey: createOptions.idempotency_key }
            : {}),
          ...(createOptions.agent_id ? { agentId: createOptions.agent_id } : {}),
          ...(createOptions.title ? { title: createOptions.title } : {}),
          ...(createOptions.labels ? { labels: createOptions.labels } : {}),
        });

        handles.set(handle.id, handle);
        const runRef = paseoRunRef(handle.id);
        return {
          run_ref: runRef,
          status: normalizeAgentStatus(handle),
          evidence: {
            runtime_ref: runtimeRef,
            workspace_id: handle.workspaceId || null,
            cwd: handle.cwd || cwd,
          },
        };
      },

      async send(runRef, message, sendOptions = {}) {
        const text = requiredString(message, "ERR_PASEO_MESSAGE_REQUIRED");
        const handle = await handleFor(runRef);
        if (typeof handle.send !== "function") {
          throw new PaseoRuntimeError("ERR_PASEO_SEND_UNAVAILABLE", {});
        }
        await handle.send(text, sendOptions);
        return {
          run_ref: runRef,
          status: normalizeAgentStatus(handle),
        };
      },

      async getStatus(runRef) {
        const handle = await handleFor(runRef, { refresh: true });
        const snapshot = typeof handle.current === "function" ? handle.current() : null;
        return {
          run_ref: runRef,
          status: normalizeAgentStatus(snapshot || handle),
          evidence: {
            paseo_status: (snapshot && snapshot.status) || handle.status || null,
            archived_at: (snapshot && snapshot.archivedAt) || handle.archivedAt || null,
            last_error: (snapshot && snapshot.lastError) || handle.lastError || null,
            pending_permissions: Array.isArray((snapshot && snapshot.pendingPermissions) || handle.pendingPermissions)
              ? ((snapshot && snapshot.pendingPermissions) || handle.pendingPermissions).length
              : 0,
          },
        };
      },

      async wait(runRef, waitOptions = {}) {
        const handle = await handleFor(runRef);
        if (typeof handle.waitForFinish !== "function") {
          throw new PaseoRuntimeError("ERR_PASEO_WAIT_UNAVAILABLE", {});
        }
        const result = await handle.waitForFinish(waitOptions.timeout_ms);
        return {
          run_ref: runRef,
          status: normalizeWaitStatus(result),
          result: {
            wait_status: result && result.status ? result.status : "unknown",
            last_message: result && typeof result.lastMessage === "string"
              ? result.lastMessage
              : null,
          },
          error: result && result.error ? { message: result.error } : null,
          evidence: {
            paseo_final_status: result && result.final ? result.final.status || null : null,
            requires_attention: result && result.status === "permission",
            timed_out: result && result.status === "timeout",
          },
        };
      },

      async getTimeline(runRef, timelineOptions = {}) {
        const agentId = paseoAgentId(runRef);
        const handle = await handleFor(runRef);
        if (!handle.timeline || typeof handle.timeline.refetch !== "function") {
          throw new PaseoRuntimeError("ERR_PASEO_TIMELINE_UNAVAILABLE", {});
        }
        const page = await handle.timeline.refetch({
          direction: timelineOptions.direction || "tail",
          projection: timelineOptions.projection || "projected",
          limit: Number.isSafeInteger(timelineOptions.limit)
            ? timelineOptions.limit
            : DEFAULT_TIMELINE_LIMIT,
          ...(timelineOptions.cursor ? { cursor: timelineOptions.cursor } : {}),
        });
        return normalizePaseoTimeline(agentId, runRef, page, {
          runtime_ref: runtimeRef,
          project_ref: timelineOptions.project_ref || null,
          host_ref: timelineOptions.host_ref || null,
          workspace_ref: timelineOptions.workspace_ref || null,
          mission_id: timelineOptions.mission_id || null,
          milestone_id: timelineOptions.milestone_id || null,
          task_id: timelineOptions.task_id || null,
        });
      },

      async archive(runRef) {
        const handle = await handleFor(runRef);
        if (typeof handle.archive !== "function") {
          throw new PaseoRuntimeError("ERR_PASEO_ARCHIVE_UNAVAILABLE", {});
        }
        const result = await handle.archive();
        return {
          run_ref: runRef,
          status: "archived",
          archived_at: result && result.archivedAt ? result.archivedAt : null,
        };
      },
    },
  });

  async function close() {
    if (!clientPromise) return;
    const client = await clientPromise;
    handles.clear();
    if (client && typeof client.close === "function") {
      await client.close();
    } else if (client && typeof client.dispose === "function") {
      await client.dispose();
    }
    connected = false;
  }

  return Object.freeze({
    port,
    close,
  });
}

module.exports = {
  PASEO_CLIENT_VERSION,
  PaseoRuntimeError,
  defaultClientFactory,
  paseoRunRef,
  paseoAgentId,
  normalizeAgentStatus,
  normalizeWaitStatus,
  normalizePaseoTimeline,
  createPaseoRuntime,
};
