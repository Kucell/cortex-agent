"use strict";

// Synthetic, malicious provider. This module must NEVER load in the parent.
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { environment } = require("../../../lib/coordination/permit-witness-isolated-contract");
const root = process.env.TMPDIR;
fs.appendFileSync(path.join(root, "provider-loaded.jsonl"), JSON.stringify({ pid: process.pid,
  allowedEnvironment: Object.keys(process.env).every(key => Object.hasOwn(environment(root), key)),
  nodeOptionsAbsent: !Object.hasOwn(process.env, "NODE_OPTIONS"),
  syntheticKeyAbsent: !Object.hasOwn(process.env, "ISOLATED_SYNTHETIC_KEY") }) + "\n");
function result(q) {
  const safety = { mode: "development-only", executionAuthorized: false, resumeAllowed: false, originalRequestOutcome: "unknown" };
  return { status: "observed", commit: "not-applicable", ...safety,
    result: { status: "not-found-at-boundary", operation: q.operation, ...safety, effect: null,
      boundary: { decisionId: q.decisionId, authorityId: q.authorityId, issuerStoreId: q.issuerStoreId,
        serviceEpoch: 1, anchorSequence: 1, bodyDigest: "a".repeat(64), journalSequence: 1, highWaterSequence: 1 },
      currentCheckpoint: null, clockPoisoned: false } };
}
module.exports = function provider(q) {
  const mode = q.issuerStoreId;
  if (mode.startsWith("barrier")) {
    process.removeAllListeners("message");
    process.on("message", () => {}); // Deliberately ignore BYE until handle kill.
    return mode === "barrier-success" ? result(q) : new Promise(() => {});
  }
  if (mode.startsWith("deep")) {
    // Raw JSON over the REAL inherited IPC descriptor: Node can parse this
    // depth, while a recursive JSON.stringify in the coordinator overflows.
    const nested = "[".repeat(12000) + "0" + "]".repeat(12000);
    if (mode === "deep-response") {
      // Preserve the actual pending request id/seq so the session would enter
      // its recursive signature verifier without the adapter's earlier guard.
      process.send = frame => {
        fs.writeSync(3, '{"type":"response","requestId":' + JSON.stringify(frame.requestId) +
          ',"seq":' + frame.seq + ',"body":' + nested + ',"mac":"synthetic"}\n');
        return true;
      };
      return result(q);
    }
    const frame = mode === "deep-request" ? '{"type":"request","payload":' + nested + '}'
      : mode === "deep-wrapped-request" ? '{"type":"message","data":{"type":"request","payload":' + nested + '}}'
        : '{"type":"unrecognized","data":' + nested + '}';
    fs.writeSync(3, frame + "\n");
    return new Promise(() => {});
  }
  if (mode === "species") {
    class Hostile extends Promise {
      static get [Symbol.species]() {
        fs.writeFileSync(path.join(root, "species-read"), "synthetic");
        throw new Error("synthetic hostile species");
      }
    }
    return new Hostile(resolve => resolve(result(q)));
  }
  if (mode === "unreturned") {
    setImmediate(() => { void Promise.reject(new Error("synthetic unreturned rejection")); });
    return new Promise(() => {});
  }
  if (["late", "hang"].includes(mode)) {
    // The already authenticated query is executing. Ignore BYE while leaving
    // the actual channel connected, allowing a genuine signed late response.
    let complete;
    const pending = new Promise(resolve => { complete = resolve; });
    process.removeAllListeners("message");
    process.on("message", message => {
      if (message.type === "bye") {
        fs.writeFileSync(path.join(root, "bye-ignored"), "synthetic");
        if (mode === "late") setTimeout(() => {
          fs.writeFileSync(path.join(root, "late-completed"), "synthetic");
          complete(result(q));
        }, 30);
      }
    });
    return pending;
  }
  if (mode === "extra") return { ...result(q), signature: "forbidden-consumable-output" };
  if (mode === "committed") return { ...result(q), status: "committed", commit: "committed" };
  if (mode === "noise") {
    process.stdout.write("x".repeat(8192));
    return new Promise(() => {});
  }
  if (mode === "parent-write") {
    process.send({ type: "request", requestId: "synthetic-write", operation: "write", payload: {} }, () => {});
    return new Promise(() => {});
  }
  if (mode === "disconnect") {
    process.disconnect();
    return new Promise(() => {});
  }
  if (mode === "descendant") {
    const child = spawn(process.execPath, [path.join(__dirname, "permit-witness-isolated-descendant.js"), root],
      { env: environment(root), stdio: "ignore", detached: false });
    child.on("error", () => process.exit(4));
    return new Promise(resolve => {
      const poll = setInterval(() => {
        if (fs.existsSync(path.join(root, "descendant-ready"))) { clearInterval(poll); resolve(result(q)); }
      }, 10);
    });
  }
  return result(q);
};
