/**
 * lib/host-adapter/pi-json-capability.js
 *
 * M-013 SP-003 / VC-007j: JSON mode capability profile.
 *
 * Per P-005 §5.1:
 *   - JSON mode: stream.turn_events + stream.tool_events ONLY
 *   - JSON mode does NOT expose control.steer or control.abort
 *   - Version probe determines exact set; degraded mode reports
 *
 * Per P-005 §5.3:
 *   - capability loss must be fail-visible, not silent
 *   - reconciliation against capability profile before any host action
 */
'use strict';

const PI_JSON_CAPABILITIES = Object.freeze({
  'stream.turn_events': true,
  'stream.tool_events': true,
  'control.get_state': false,
  'control.steer': false,
  'control.abort': false,
  'evidence.worktree_probe': true,
  'evidence.validation_probe': true
});

function getCapabilities() {
  // Deep clone to prevent mutation of nested control/evidence objects
  const result = {};
  for (const [k, v] of Object.entries(PI_JSON_CAPABILITIES)) {
    result[k] = (v && typeof v === 'object') ? { ...v } : v;
  }
  return result;
}

function hasCapability(cap) {
  return Boolean(PI_JSON_CAPABILITIES[cap]);
}

function listCapabilities() {
  return Object.entries(PI_JSON_CAPABILITIES)
    .filter(([_, enabled]) => enabled)
    .map(([cap]) => cap);
}

function listDeniedCapabilities() {
  return Object.entries(PI_JSON_CAPABILITIES)
    .filter(([_, enabled]) => !enabled)
    .map(([cap]) => cap);
}

module.exports = {
  getCapabilities,
  hasCapability,
  listCapabilities,
  listDeniedCapabilities,
  PI_JSON_CAPABILITIES
};
