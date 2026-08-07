"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");

const RETRYABLE_CODES = new Set([
  "ERR_LOCKED",
  "ERR_LOCK_TIMEOUT",
  "ERR_LOCK_RECLAIM_FAILED",
]);

function errorCode(error) {
  return error && (error.key || error.code) || "UNKNOWN_INTERNAL";
}

function classifyCoordinationError(error) {
  const code = errorCode(error);
  const reason = error && error.details && error.details.reason;
  const resource = error && error.details && error.details.resource;
  if (RETRYABLE_CODES.has(code) || code.includes("LOCK")
      || (code === "ERR_LEASE_CONFLICT" && resource === "journal")
      || reason === "reclaim_raced" || reason === "lock_renewed") {
    return Object.freeze({ code: "COORDINATION_BUSY", retryable: true });
  }
  if (code === "EACCES" || code === "EPERM") {
    return Object.freeze({ code: "COORDINATION_PERMISSION_DENIED", retryable: false });
  }
  if (code === "ENOENT") {
    return Object.freeze({ code: "COORDINATION_RUNTIME_MISSING", retryable: true });
  }
  if (code.includes("HASH") || code.includes("SEQUENCE")
      || code === "ERR_INVALID_STATE" || code === "ERR_INVALID_EVENT") {
    return Object.freeze({ code: "COORDINATION_CORRUPT", retryable: false });
  }
  if (code === "ERR_LEASE_CONFLICT") {
    return Object.freeze({ code: "LEASE_INVALID", retryable: false });
  }
  return Object.freeze({ code: "UNKNOWN_INTERNAL", retryable: false });
}

function fileDigest(file) {
  try {
    const content = fs.readFileSync(file);
    return Object.freeze({
      bytes: content.length,
      sha256: crypto.createHash("sha256").update(content).digest("hex"),
    });
  } catch {
    return Object.freeze({ bytes: 0, sha256: null });
  }
}

module.exports = {
  classifyCoordinationError,
  fileDigest,
};
