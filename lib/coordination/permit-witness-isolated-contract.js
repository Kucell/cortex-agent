"use strict";

// Development candidate only. These are application admission limits, NOT an
// OS memory/process/IPC sandbox. Node deserializes IPC before our size checks.
const wire = require("./permit-witness-v2-history-wire");
const LIMITS = Object.freeze({ frameBytes: 65536, stdioBytes: 4096, messages: 16, messageDepth: 64, messageNodes: 4096,
  reservationBytes: 2 * 65536 + 4096 });
const OPERATIONS = Object.freeze({ ready: "isolated.history.ready", query: "isolated.history.query",
  denied: "isolated.no-parent-authority" });
function exact(value, keys) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new TypeError("isolated schema");
  const names = Reflect.ownKeys(value);
  if (names.length !== keys.length || names.some(key => !keys.includes(key))) throw new TypeError("isolated fields");
  for (const key of names) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, "value")) throw new TypeError("isolated data fields required");
  }
}
function frame(bytes) {
  if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > LIMITS.frameBytes) throw new TypeError("isolated frame limit");
  return Buffer.from(bytes);
}
function base64(value) {
  if (typeof value !== "string" || !value.length || value.length > Math.ceil(LIMITS.frameBytes / 3) * 4) {
    throw new TypeError("isolated encoded frame limit");
  }
  const bytes = frame(Buffer.from(value, "base64"));
  if (bytes.toString("base64") !== value) throw new TypeError("isolated noncanonical base64");
  return bytes;
}
function request(bytes) { const copy = frame(bytes); wire.decodeRequest(copy); return copy; }
function admitMessage(message) {
  // All checks run AFTER Node's JSON parser. Avoid recursive traversal before
  // stringify, and leave stack headroom for the existing signing primitive.
  try {
    const pending = [[message, 0]];
    let nodes = 0;
    while (pending.length) {
      const [value, depth] = pending.pop();
      if (++nodes > LIMITS.messageNodes || depth > LIMITS.messageDepth) return false;
      if (value && typeof value === "object") {
        const keys = Object.keys(value);
        if (keys.length + pending.length + nodes > LIMITS.messageNodes) return false;
        for (const key of keys) pending.push([value[key], depth + 1]);
      }
    }
    return Buffer.byteLength(JSON.stringify(message) || "") <= 2 * LIMITS.frameBytes;
  } catch { return false; }
}
function environment(directory) {
  return { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", TMPDIR: directory, TMP: directory, TEMP: directory,
    ...(process.platform === "darwin" ? { __CF_USER_TEXT_ENCODING: "0x0:0:0" } : {}) };
}
module.exports = { LIMITS, OPERATIONS, exact, frame, base64, request, admitMessage, environment };
