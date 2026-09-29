"use strict";

let protocol;
try {
  protocol = require("@cortex-agent/protocol");
} catch (_) {
  protocol = require("../../protocol/src/index.js");
}

const RUNTIME_PORT_CAPABILITIES = Object.freeze([
  "runtime.discover",
  "runtime.health",
  "runtime.run.create",
  "runtime.run.cancel",
  "runtime.run.status",
  "runtime.run.wait",
  "runtime.run.send",
  "runtime.timeline.read",
  "runtime.run.archive",
]);

const METHOD_CAPABILITY = Object.freeze({
  discoverRuntime: "runtime.discover",
  health: "runtime.health",
  createRun: "runtime.run.create",
  send: "runtime.run.send",
  cancel: "runtime.run.cancel",
  getStatus: "runtime.run.status",
  getTimeline: "runtime.timeline.read",
  wait: "runtime.run.wait",
  archive: "runtime.run.archive",
});

class RuntimePortError extends Error {
  constructor(code, details = {}) {
    super(`[runtime-port:${code}] ${JSON.stringify(details)}`);
    this.name = "RuntimePortError";
    this.code = code;
    this.details = details;
  }
}

function unsupported(capability, details = {}) {
  throw new RuntimePortError("ERR_RUNTIME_CAPABILITY_UNSUPPORTED", {
    capability,
    ...details,
  });
}

function normalizeRuntimeDescriptor(input) {
  const descriptor = protocol.createCapabilityDescriptor(input);
  if (descriptor.protocol !== protocol.RUNTIME_PROTOCOL_NAME) {
    throw new RuntimePortError("ERR_RUNTIME_PROTOCOL_REQUIRED", {
      protocol: descriptor.protocol,
    });
  }
  return descriptor;
}

function createRuntimePort(options = {}) {
  const descriptor = normalizeRuntimeDescriptor(options.descriptor || {});
  const operations = options.operations || {};
  const declared = new Set(descriptor.capabilities);

  const port = {
    descriptor,
  };

  for (const [method, capability] of Object.entries(METHOD_CAPABILITY)) {
    const implementation = operations[method];
    if (declared.has(capability) && typeof implementation !== "function") {
      throw new RuntimePortError("ERR_RUNTIME_OPERATION_MISSING", {
        method,
        capability,
      });
    }
    port[method] = typeof implementation === "function"
      ? implementation
      : (...args) => unsupported(capability, { method, args_count: args.length });
  }

  return Object.freeze(port);
}

function hasRuntimeCapability(port, capability) {
  if (!port || !port.descriptor) return false;
  return port.descriptor.capabilities.includes(capability);
}

function assertRuntimeCapability(port, capability) {
  if (!hasRuntimeCapability(port, capability)) {
    unsupported(capability);
  }
  return true;
}

module.exports = {
  RUNTIME_PORT_CAPABILITIES,
  METHOD_CAPABILITY,
  RuntimePortError,
  createRuntimePort,
  hasRuntimeCapability,
  assertRuntimeCapability,
};
