"use strict";

const protocol = require("../../packages/protocol/src/index.js");
const {
  readOwner,
  readState,
  isPidAlive,
} = require("./daemon-state.js");

function daemonEffectiveState(projectRoot) {
  const state = readState(projectRoot);
  const owner = readOwner(projectRoot);
  const live = Boolean(
    owner
    && owner.pid === state.pid
    && isPidAlive(owner.pid),
  );
  const stale = Boolean(
    state.enabled
    && ["starting", "running", "stopping"].includes(state.status)
    && !live,
  );
  return Object.freeze({ state, owner, live, stale });
}

function createDaemonHealthProducer(projectRoot, options = {}) {
  const requestSourceConfigured = options.request_source_configured !== false;

  return protocol.createHealthProducer({
    id: "cortex.control-daemon",
    kind: "control-service-daemon",
    version: "1",
    async produce(context = {}) {
      const observedAt = context.now || new Date().toISOString();
      const current = daemonEffectiveState(projectRoot);
      const { state, live, stale } = current;

      let status = "unknown";
      if (!state.enabled && ["disabled", "stopped"].includes(state.status)) {
        status = "healthy";
      } else if (stale || state.status === "degraded") {
        status = "unhealthy";
      } else if (["starting", "stopping"].includes(state.status)) {
        status = "degraded";
      } else if (state.status === "running" && live) {
        status = requestSourceConfigured ? "healthy" : "degraded";
      }

      return [{
        id: "daemon:control-service",
        kind: "daemon",
        status,
        observed_at: observedAt,
        checks: [
          {
            id: "process.owner",
            status: stale ? "unhealthy" : (state.enabled ? (live ? "healthy" : "unknown") : "healthy"),
            message: stale
              ? "daemon state claims enabled but owner process is not alive"
              : (live ? "daemon owner process is alive" : "daemon is not running"),
            details: {
              enabled: Boolean(state.enabled),
              live,
              stale,
            },
          },
          {
            id: "request.source",
            status: !state.enabled
              ? "healthy"
              : (requestSourceConfigured ? "healthy" : "degraded"),
            message: requestSourceConfigured
              ? "daemon request source is configured"
              : "daemon is lifecycle-ready but has no executable request source",
            details: {
              configured: requestSourceConfigured,
            },
          },
        ],
        evidence_refs: [],
        redacted: true,
      }];
    },
  });
}

module.exports = {
  daemonEffectiveState,
  createDaemonHealthProducer,
};
