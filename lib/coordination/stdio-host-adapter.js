"use strict";

// ─── stdio / JSONL transport ─────────────────────────────────────────────────
// Pure encode / decode for the Host Wakeup Adapter over JSONL. The transport
// exposes encode(frame) and decode(buffer). It MUST NOT spawn any process or
// touch the filesystem — the calling host owns the actual stdin/stdout wires.
// On decode, every envelope passes through protocol.checkDenyRules.

const protocol = require("./host-adapter-protocol");

function normalizeRawFrame(raw) {
  if (raw === null || raw === undefined) {
    throw new TypeError("non-object frame: null/undefined");
  }
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new TypeError("non-object frame: must be plain object");
  }
  return raw;
}

function createTransport() {
  function encode(rawFrame) {
    const frame = normalizeRawFrame(rawFrame);
    // Every outbound frame is checked for deny-rule violations, even though
    // the host is the destination — fail-closed prevents accidental leaks.
    const verdict = protocol.checkDenyRules(frame);
    if (!verdict.ok) {
      throw new Error(`encode denied by deny rule '${verdict.ruleId}': ${verdict.reason}`);
    }
    return JSON.stringify(frame) + "\n";
  }

  function decode(raw) {
    if (typeof raw !== "string") {
      throw new TypeError("invalid jsonl frame: expected string");
    }
    const text = raw.replace(/\r?\n$/, "");
    if (text.length === 0) {
      throw new Error("empty frame");
    }
    let frame;
    try {
      frame = JSON.parse(text);
    } catch (_err) {
      throw new Error("invalid jsonl frame: not parseable");
    }
    if (frame === null || typeof frame !== "object" || Array.isArray(frame)) {
      throw new TypeError("invalid jsonl frame: not an object");
    }
    const verdict = protocol.checkDenyRules(frame);
    if (!verdict.ok) {
      throw new Error(`decode denied by deny rule '${verdict.ruleId}': ${verdict.reason}`);
    }
    return frame;
  }

  return Object.freeze({ encode, decode });
}

module.exports = {
  createTransport,
};
