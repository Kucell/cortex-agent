/**
 * lib/host-adapter/pi-rpc-capability.js
 *
 * M-013 SP-004 / VC-007r: RPC mode capability profile (after real handshake).
 *
 * Per P-005 §5.2:
 *   - Before handshake: stream.* only (no control.*)
 *   - After handshake: stream.* + control.* + evidence.*
 *   - Capability loss must be fail-visible (degraded mode), not silent
 */
'use strict';

const PI_RPC_CAPABILITIES_BEFORE_HANDSHAKE = Object.freeze({
  'stream.turn_events': true,
  'stream.tool_events': true,
  'control.get_state': false,
  'control.steer': false,
  'control.abort': false,
  'evidence.worktree_probe': false,
  'evidence.validation_probe': false
});

const PI_RPC_CAPABILITIES_AFTER_HANDSHAKE = Object.freeze({
  'stream.turn_events': true,
  'stream.tool_events': true,
  'control.get_state': true,
  'control.steer': true,
  'control.abort': true,
  'evidence.worktree_probe': true,
  'evidence.validation_probe': true
});

function getCapabilities(handshakeState = 'before') {
  const source = handshakeState === 'after' ? PI_RPC_CAPABILITIES_AFTER_HANDSHAKE : PI_RPC_CAPABILITIES_BEFORE_HANDSHAKE;
  const result = {};
  for (const [k, v] of Object.entries(source)) {
    result[k] = (v && typeof v === 'object') ? { ...v } : v;
  }
  return result;
}

function hasCapability(cap, handshakeState = 'before') {
  const caps = handshakeState === 'after' ? PI_RPC_CAPABILITIES_AFTER_HANDSHAKE : PI_RPC_CAPABILITIES_BEFORE_HANDSHAKE;
  return Boolean(caps[cap]);
}

function listCapabilities(handshakeState = 'before') {
  const caps = handshakeState === 'after' ? PI_RPC_CAPABILITIES_AFTER_HANDSHAKE : PI_RPC_CAPABILITIES_BEFORE_HANDSHAKE;
  return Object.entries(caps).filter(([_, enabled]) => enabled).map(([cap]) => cap);
}

function listDeniedCapabilities(handshakeState = 'before') {
  const caps = handshakeState === 'after' ? PI_RPC_CAPABILITIES_AFTER_HANDSHAKE : PI_RPC_CAPABILITIES_BEFORE_HANDSHAKE;
  return Object.entries(caps).filter(([_, enabled]) => !enabled).map(([cap]) => cap);
}

module.exports = {
  getCapabilities,
  hasCapability,
  listCapabilities,
  listDeniedCapabilities,
  PI_RPC_CAPABILITIES_BEFORE_HANDSHAKE,
  PI_RPC_CAPABILITIES_AFTER_HANDSHAKE
};
