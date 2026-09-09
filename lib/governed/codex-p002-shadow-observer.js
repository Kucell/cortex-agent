"use strict";

// P-009 public-only observer. It is invoked only after a durable task.accepted
// event and must never influence task acceptance or a host runtime payload.
const { createShadowObservation, toPublicError } = require("../../scripts/codex-p002-shadow-pilot.js");

function observeAccepted(admissionText, options = {}) {
  if (admissionText === undefined) return { status: "not_requested" };
  if (typeof admissionText !== "string" || admissionText.length === 0 || admissionText.length > 16384) return { status: "rejected", error: "invalid_admission" };
  try {
    const parsed = JSON.parse(admissionText);
    const observation = createShadowObservation(parsed, options);
    return observation.ok ? { status: "observed", observation } : { status: "rejected", error: observation.error };
  } catch (_) {
    return { status: "failed", ...toPublicError() };
  }
}

module.exports = { observeAccepted };
