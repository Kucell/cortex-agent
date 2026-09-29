"use strict";

const {
  createRef,
  parseRef,
} = require("../../packages/protocol/src/index.js");
const {
  normalizeRuntimeEndpoint,
} = require("../../packages/runtime-port/src/index.js");
const {
  createLegacyAdapterRuntimePort,
} = require("./legacy-adapter-bridge.js");

function mapLegacyTransport(value) {
  const transport = String(value || "").toLowerCase();
  if (transport.includes("websocket") || transport === "ws" || transport === "wss") {
    return "websocket";
  }
  if (transport.includes("http")) return "http";
  if (transport.includes("stdio")) return "stdio";
  if (transport.includes("ipc")) return "ipc";
  if (transport.includes("ssh")) return "ssh";
  if (transport.includes("in-process") || transport.includes("internal")) {
    return "in-process";
  }
  return "custom";
}

function endpointValue(hostRef, adapterType) {
  const host = parseRef(hostRef, "host");
  if (!host) {
    const error = new Error("native endpoint discovery requires a valid HostRef");
    error.code = "ERR_NATIVE_HOST_REF_INVALID";
    throw error;
  }
  return `${host.value}:native:${adapterType}`;
}

async function discoverNativeRuntimeEndpoint(adapter, options = {}) {
  const port = createLegacyAdapterRuntimePort(adapter, options);
  const discovery = port.discoverRuntime();
  const adapterMeta = discovery.adapter || {};
  const adapterType = adapterMeta.adapter_type
    || options.adapterType
    || port.descriptor.implementation.replace(/^native-adapter:/, "")
    || "legacy";

  const hostRef = options.host_ref || createRef("host", "local");
  const runtimeRef = options.runtime_ref
    || createRef("runtime", `native:${adapterType}`);
  const endpointRef = options.endpoint_ref
    || createRef("runtime-endpoint", endpointValue(hostRef, adapterType));

  let health = null;
  let availability = "unknown";
  if (options.check_health !== false) {
    health = await port.health();
    if (health && health.ready === true) availability = "available";
    else if (health && health.ready === false) availability = "unavailable";
  }

  const endpoint = normalizeRuntimeEndpoint({
    endpoint_ref: endpointRef,
    host_ref: hostRef,
    runtime_ref: runtimeRef,
    location: options.location || "local",
    transport: options.transport || mapLegacyTransport(adapterMeta.transport),
    availability,
    descriptor: port.descriptor,
    workspace_refs: options.workspace_refs || [],
  });

  return Object.freeze({
    endpoint,
    port,
    health,
    adapter: adapterMeta,
  });
}

module.exports = {
  mapLegacyTransport,
  discoverNativeRuntimeEndpoint,
};
