"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { startPermitBridgeService } = require("../coordination/permit-bridge-service");
const { PERMIT_BRIDGE_BOUNDS } = require("../coordination/permit-bridge-bounds");

const USAGE = "Usage: cortex-agent permit-bridge serve --config <json-file>";
const CONFIG_KEYS = new Set([
  "storePath", "anchorDir", "controlledAncestorPath", "decisionId", "serviceIdentity",
  "leaseTtlMs", "permitTtlMs", "ticketTtlMs", "requestTimeoutMs", "port", "revocationPort",
  "remotePeerTrustFile", "agentPort",
]);
const EXECUTOR_PATH = path.join(__dirname, "permit-bridge-executor.js");

// The cap on the trust file. A trust file holds a handful of pinned public
// keys; anything larger is not a trust file and must not be buffered.
const MAX_TRUST_FILE_BYTES = 64 * 1024;

/**
 * Read the pinned remote peer trust file.
 *
 * The trust root is a DEPLOYMENT fact: it comes from a file the deployment
 * owns, never from the peer that connects. The shape is checked here so a
 * malformed file is refused as a configuration error rather than as a start
 * failure; the cryptographic validation stays with the agent.
 *
 * @param {string} file
 * @returns {object[]}
 */
function readRemotePeerTrust(file) {
  const stat = fs.statSync(file);
  if (!stat.isFile() || stat.size > MAX_TRUST_FILE_BYTES) throw new Error("invalid trust file");
  const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || !Array.isArray(parsed.peers)) {
    throw new Error("invalid trust file");
  }
  for (const peer of parsed.peers) {
    if (!peer || typeof peer !== "object" || Array.isArray(peer) ||
        typeof peer.peerId !== "string" || !peer.peerId ||
        typeof peer.instanceId !== "string" || !peer.instanceId ||
        typeof peer.publicKeyPem !== "string" || !peer.publicKeyPem) {
      throw new Error("invalid trust file");
    }
  }
  return parsed.peers;
}

function readConfig(file) {
  if (!Number.isInteger(fs.constants.O_NOFOLLOW)) throw new Error("invalid config");
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  let value;
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > 64 * 1024) throw new Error("invalid config");
    value = JSON.parse(fs.readFileSync(fd, "utf8"));
  } finally {
    fs.closeSync(fd);
  }
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).some((key) => !CONFIG_KEYS.has(key))) {
    throw new Error("invalid config");
  }
  for (const key of ["storePath", "anchorDir", "controlledAncestorPath"]) {
    if (typeof value[key] !== "string" || !path.isAbsolute(value[key])) {
      throw new Error("invalid config");
    }
  }
  for (const key of ["decisionId", "serviceIdentity"]) {
    if (typeof value[key] !== "string" || !value[key].trim()) throw new Error("invalid config");
  }
  for (const key of ["leaseTtlMs", "permitTtlMs", "ticketTtlMs"]) {
    if (!Number.isSafeInteger(value[key]) || value[key] <= 0) throw new Error("invalid config");
  }
  // The ticket and request windows are approved acceptance bounds. A config
  // that asks for a longer window is refused here, before the store is
  // touched, so an over-wide deployment never reaches the serving state.
  if (value.ticketTtlMs > PERMIT_BRIDGE_BOUNDS.ticketTtlMs) throw new Error("invalid config");
  if (value.requestTimeoutMs !== undefined &&
      (!Number.isSafeInteger(value.requestTimeoutMs) || value.requestTimeoutMs <= 0 ||
       value.requestTimeoutMs > PERMIT_BRIDGE_BOUNDS.requestTimeoutMs)) {
    throw new Error("invalid config");
  }
  for (const key of ["port", "revocationPort"]) {
    if (value[key] !== undefined &&
        (!Number.isSafeInteger(value[key]) || value[key] < 0 || value[key] > 65535)) {
      throw new Error("invalid config");
    }
  }
  if (value.agentPort !== undefined &&
      (!Number.isSafeInteger(value.agentPort) || value.agentPort < 0 || value.agentPort > 65535)) {
    throw new Error("invalid config");
  }
  if (value.port && value.revocationPort && value.port === value.revocationPort) {
    throw new Error("invalid config");
  }
  if (value.agentPort !== undefined) {
    if (value.port && value.agentPort === value.port) throw new Error("invalid config");
    if (value.revocationPort && value.agentPort === value.revocationPort) throw new Error("invalid config");
  }
  if (value.remotePeerTrustFile !== undefined) {
    if (typeof value.remotePeerTrustFile !== "string" || !path.isAbsolute(value.remotePeerTrustFile)) {
      throw new Error("invalid config");
    }
  }
  // The trust file is read here, not at start time: a configuration that names
  // a trust file that cannot be read is a configuration error, and the exit
  // code for it must not be the one reserved for a start failure.
  const remotePeers = value.remotePeerTrustFile === undefined
    ? undefined
    : readRemotePeerTrust(value.remotePeerTrustFile);
  return {
    ...value,
    remotePeers,
    executorPath: EXECUTOR_PATH,
    anchorMode: "strict",
    bindAddress: "127.0.0.1",
    create: false,
  };
}

async function permitBridgeServiceCli(ctx, dependencies = {}) {
  const args = ctx.args;
  const output = dependencies.output || console;
  if (args.length === 3 && ["--help", "-h"].includes(args[2])) {
    output.log(USAGE);
    return;
  }
  if (args.length !== 4 || args[2] !== "--config" ||
      !args[3] || args[3].startsWith("--")) {
    output.error(USAGE);
    process.exitCode = 2;
    return;
  }

  let options;
  try {
    options = readConfig(path.resolve(ctx.cwd, args[3]));
  } catch {
    output.error("permit-bridge serve: invalid config");
    process.exitCode = 2;
    return;
  }

  let service;
  try {
    service = await (dependencies.startService || startPermitBridgeService)(options);
  } catch (error) {
    output.error("permit-bridge serve: start failed" + (error && error.code ? " (" + error.code + ")" : ""));
    process.exitCode = 3;
    return;
  }

  // Readiness contains only loopback ports. Tickets remain inside the managed service.
  output.log(JSON.stringify({
    ok: true,
    action: "serve",
    port: service.address.port,
    revocationPort: service.revocationAddress.port,
    // The ticket agent's port. It is null when no remote peer trust is
    // configured, because then no agent is started at all.
    agentPort: service.agentAddress ? service.agentAddress.port : null,
  }));

  const signalSource = dependencies.signalSource || process;
  const onStop = () => finish();
  let finish;
  await new Promise((resolve) => {
    finish = resolve;
    signalSource.once("SIGINT", onStop);
    signalSource.once("SIGTERM", onStop);
  });
  signalSource.off("SIGINT", onStop);
  signalSource.off("SIGTERM", onStop);
  try {
    await service.close();
  } catch {
    output.error("permit-bridge serve: close failed");
    process.exitCode = 3;
  }
}

module.exports = { permitBridgeServiceCli, readConfig };
