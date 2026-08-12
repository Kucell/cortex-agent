"use strict";

// ─── Validation Probe Receipt Parser (M-013 SP-007) ──────────────────────────
//
// Normalizes the structured output of a `validation_probe` run (e.g. fake-host
// replay, real-pi pilot, SamHMI replay) into the {commandId, status,
// evidenceRef} shape that lib/governed-attempt-progress/reducer.js expects on
// `events.validation_probe`.
//
// Input shape (what the probe runner emits — see scripts/run-pilot-stack.js,
// M-013 §3.2, P-005 §15.3):
//
//   {
//     commandId:    string,           // required, non-empty
//     exitCode:     number,           // 0 == pass, != 0 == fail
//     durationMs:   number,           // optional, default 0
//     artifactRef:  string,           // optional, maps to evidenceRef
//     summary:      string,           // optional, preserved verbatim
//     capturedAt:   ISO 8601 string,  // optional, default now()
//   }
//
// Output shape (what the reducer consumes — see reducer.js:94-99):
//
//   {
//     commandId:    string,
//     status:       "passed" | "failed" | "not_run",
//     evidenceRef:  string | null,
//     durationMs:   number,
//     summary:      string | undefined,
//     capturedAt:   string,
//   }
//
// Status mapping:
//   exitCode === 0                       → "passed"
//   typeof exitCode === "number" && != 0 → "failed"
//   exitCode missing / non-number         → "not_run"

function parseValidationReceipt(receipt) {
  if (!receipt || typeof receipt !== "object") {
    throw new Error("parseValidationReceipt: receipt must be a non-null object");
  }
  const commandId = typeof receipt.commandId === "string" ? receipt.commandId.trim() : "";
  if (!commandId) {
    throw new Error("parseValidationReceipt: commandId is required");
  }

  let status;
  if (typeof receipt.exitCode === "number" && Number.isFinite(receipt.exitCode)) {
    status = receipt.exitCode === 0 ? "passed" : "failed";
  } else {
    status = "not_run";
  }

  const durationMs = typeof receipt.durationMs === "number" && Number.isFinite(receipt.durationMs)
    ? Math.max(0, Math.trunc(receipt.durationMs))
    : 0;

  const evidenceRef = typeof receipt.artifactRef === "string" && receipt.artifactRef.trim()
    ? receipt.artifactRef.trim()
    : null;

  const capturedAt = typeof receipt.capturedAt === "string" && receipt.capturedAt.trim()
    ? receipt.capturedAt.trim()
    : new Date().toISOString();

  const normalized = {
    commandId,
    status,
    evidenceRef,
    durationMs,
    capturedAt,
  };
  if (typeof receipt.summary === "string" && receipt.summary.trim()) {
    normalized.summary = receipt.summary;
  }
  return Object.freeze(normalized);
}

module.exports = { parseValidationReceipt };