"use strict";

// The production timing bounds for the permit bridge.
//
// These values are not tuning knobs: they are the acceptance bounds that
// Owner approved for the cross-machine managed permit bridge
// (D-M053-MS008-P009-R5-TIMING-REVOCATION-OPEN, option A). A deployment
// that configures a longer window is not "more conservative" — it widens the
// interval in which a stale fact, a stolen ticket or a revoked permit is
// still accepted, so the bridge refuses to start instead of running with a
// bound nobody signed off.
const PERMIT_BRIDGE_BOUNDS = Object.freeze({
  // The TLS handshake and the peer authentication it carries.
  handshakeTimeoutMs: 5_000,
  // The maximum age of a witness fact the bridge is willing to act on.
  factMaxAgeMs: 1_000,
  // How long a client ticket stays usable.
  ticketTtlMs: 2_000,
  // A single permit request.
  requestTimeoutMs: 5_000,
  // How long a revocation list may stay unapplied before new actions are
  // refused.
  revocationMaxStalenessMs: 15_000,
  // The tolerated difference between the two clocks.
  clockSkewToleranceMs: 2_000,
});

/**
 * Reject a configured window that exceeds its approved bound.
 *
 * @param {string} name The configuration key, for the failure message.
 * @param {number} value The configured value.
 * @param {number} max The approved upper bound.
 * @returns {number} The value, when it is within bounds.
 */
function assertWithinBounds(name, value, max) {
  if (!Number.isSafeInteger(value) || value <= 0) fail("ERR_PERMIT_INPUT_INVALID");
  if (value > max) fail("ERR_PERMIT_INPUT_INVALID");
  return value;
}

function fail(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

module.exports = Object.freeze({ PERMIT_BRIDGE_BOUNDS, assertWithinBounds });
