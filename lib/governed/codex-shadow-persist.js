"use strict"

// P-010 observation storage. It is invoked after the public observer returns an
// observation and must not change the observer result, task acceptance, or any
// Codex execution path. Write failure is captured and surfaced only via status.
const { createShadowObservation, toPublicError } = require("../../scripts/codex-p002-shadow-pilot.js")
const ledger = require("./codex-shadow-ledger.js")

function persistObservation(admissionText, options = {}) {
  if (typeof admissionText !== "string" || admissionText.length === 0 || admissionText.length > 16384) return { status: "not_requested" }
  try {
    const parsed = JSON.parse(admissionText)
    const observation = createShadowObservation(parsed, options)
    if (!observation.ok) return { status: "rejected", error: observation.error }
    try {
      const result = ledger.appendObservation(observation, { root: options.root || process.cwd(), now: options.now || new Date(), writeFile: options.writeFile })
      return { status: "observed", observation, ledger: result }
    } catch (error) {
      return { status: "ledger_failed", error: error.message || "ledger_failed" }
    }
  } catch (_) {
    return { status: "failed", ...toPublicError() }
  }
}

module.exports = { persistObservation }
