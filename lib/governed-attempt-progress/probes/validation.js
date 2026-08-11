"use strict";

// ─── Validation Probe (M-013 SP-002 / VC-005) ────────────────────────────────
//
// Read-only structured receipt parser. The probe NEVER inspects stdout,
// stderr, or natural language — it only accepts structured receipt fields
// (status enum + commandId + exitCode + optional artifactRef).
//
// Privacy guarantees (P-005 §9):
//   - The probe strips raw command output before exposing the receipt.
//   - artifactRef paths are HASHED into opaque sha256 digests.
//   - No file body, absolute path, or free text survives.

const crypto = require("node:crypto");

const VALID_STATUSES = Object.freeze(["not_run", "running", "passed", "failed"]);

// Status → evidence level mapping (per P-005 §3.1)
function classify(status) {
  switch (status) {
    case "passed":
      return "verified";
    case "failed":
      return "blocked";
    case "running":
      return "testing";
    case "not_run":
    default:
      return "alive";
  }
}

/**
 * Map a raw exitCode / state hint to a structured status.
 *
 * @param {number|string|null|undefined} code  - 0 = passed, non-zero = failed,
 *                                                "running" = running,
 *                                                null/undefined = not_run
 * @returns {string} one of not_run|running|passed|failed
 */
function mapStatus(code) {
  if (code === null || code === undefined) return "not_run";
  if (typeof code === "string" && VALID_STATUSES.includes(code)) return code;
  if (code === 0) return "passed";
  if (typeof code === "number" && code > 0) return "failed";
  return "not_run";
}

/**
 * Parse a structured validation receipt into the canonical form.
 *
 * Required: { status, commandId, exitCode }
 * Optional: { artifactRef } — gets hashed into opaque evidenceRef.
 *
 * The returned receipt NEVER includes raw stdout/stderr/text fields. Any
 * such field on the input is silently dropped.
 */
function parseValidationReceipt(input) {
  if (!input || typeof input !== "object") {
    throw new Error("validation probe: receipt must be a non-null object");
  }
  const status = mapStatus(input.status || input.exitCode);
  if (!VALID_STATUSES.includes(status)) {
    throw new Error(
      `validation probe: status must be one of ${VALID_STATUSES.join("|")} (got ${JSON.stringify(status)})`
    );
  }
  if (!input.commandId || typeof input.commandId !== "string") {
    throw new Error("validation probe: receipt must include commandId (string)");
  }
  if (input.exitCode === undefined || input.exitCode === null) {
    // exitCode may be null only when status === "running"
    if (status !== "running") {
      throw new Error(
        `validation probe: receipt must include exitCode (number or null when running)`
      );
    }
  } else if (typeof input.exitCode !== "number") {
    throw new Error("validation probe: exitCode must be a number or null");
  }

  // artifactRef — if present, hash it into opaque sha256; never expose raw path.
  let evidenceRef = null;
  if (input.artifactRef !== undefined && input.artifactRef !== null) {
    if (typeof input.artifactRef !== "string") {
      throw new Error("validation probe: artifactRef must be a string path");
    }
    evidenceRef = "sha256:" + crypto.createHash("sha256").update(input.artifactRef).digest("hex");
  }

  return Object.freeze({
    status,
    commandId: input.commandId,
    exitCode: input.exitCode === undefined ? null : input.exitCode,
    evidenceRef,
  });
}

module.exports = {
  parseValidationReceipt,
  mapStatus,
  classify,
  VALID_STATUSES,
};