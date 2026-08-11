/**
 * lib/host-adapter/control-port.js
 *
 * M-013 SP-004 / VC-008, VC-009: Gated control port for status / steer / abort.
 *
 * Per P-005 §8.2:
 *   - status: read-only
 *   - steer: requires 4-gate (capability + lease + Operation + authorization)
 *   - abort: requires 4-gate + idempotency-key; abort ends current attempt only,
 *     preserves worktree + journal + receipt
 */
'use strict';

class ControlPort {
  constructor(options = {}) {
    this.supervisor = options.supervisor;
    this.hostCapabilities = options.hostCapabilities || {};
  }

  /**
   * status — read-only, no gate required.
   */
  status() {
    if (!this.supervisor) return { error: 'no_supervisor' };
    return this.supervisor.queryState();
  }

  /**
   * steer — gated 4-way: capability + lease + operation + authorization.
   * @param {object} params
   * @param {string} params.reason
   * @param {string} params.idempotencyKey
   * @param {string} params.launchId
   * @param {string} params.policyRevision
   */
  steer(params) {
    if (!this.hasCapability('control.steer')) {
      return { error: 'capability_denied', capability: 'control.steer' };
    }
    if (!this.supervisor) {
      return { error: 'no_supervisor' };
    }
    return this.supervisor.steer(params);
  }

  /**
   * abort — gated 4-way + idempotency.
   * @param {object} params
   */
  abort(params) {
    if (!this.hasCapability('control.abort')) {
      return { error: 'capability_denied', capability: 'control.abort' };
    }
    if (!this.supervisor) {
      return { error: 'no_supervisor' };
    }
    return this.supervisor.abort(params);
  }

  hasCapability(cap) {
    return Boolean(this.hostCapabilities[cap]);
  }
}

module.exports = { ControlPort };
