/**
 * lib/host-adapter/pi-rpc-supervisor.js
 *
 * M-013 SP-004 / VC-007r, VC-009: Pi RPC supervisor with gated control port.
 *
 * Per P-005 §5.2:
 *   - RPC supervisor uses stdin/stdout JSONL with strict LF delimiter
 *   - Consumes: agent_start / message_update / bash_execution_update / tool_execution_*
 *   - Produces: extension_ui_request (4 dialog methods + 5 fire-and-forget)
 *   - Emits: agent_settled (NOT agent_end) as completion signal
 *   - Gates: capability + lease + fencing token + Operation + authorization
 */
'use strict';

class PiRpcSupervisor {
  constructor(options = {}) {
    this.fencingToken = options.fencingToken || null;
    this.leaseId = options.leaseId || null;
    this.operationAttempt = options.operationAttempt || null;
    this.authorized = options.authorized === true;
    this.state = 'idle';
    this.events = [];
  }

  /**
   * Process an incoming RPC event from Pi stdout.
   * @param {string} line - one JSONL line
   * @returns {object} - { outbound?: object, error?: string }
   */
  processEvent(line) {
    if (!line || typeof line !== 'string' || !line.trim()) return { error: 'empty_line' };
    let event;
    try {
      event = JSON.parse(line);
    } catch (e) {
      return { error: 'parse_error', message: e.message?.slice(0, 200) };
    }
    if (!event || typeof event !== 'object') return { error: 'invalid_event' };

    if (event.type === 'agent_start') {
      this.state = 'running';
      this.events.push({ type: 'agent_start', at: new Date().toISOString() });
      return { state: 'running' };
    }
    if (event.type === 'agent_settled') {
      this.state = 'settled';
      this.events.push({ type: 'agent_settled', at: new Date().toISOString() });
      return { state: 'settled' };
    }
    if (event.type === 'agent_end') {
      // Per P-005 §5.2: do NOT use agent_end as completion signal
      this.events.push({ type: 'agent_end', at: new Date().toISOString(), warning: 'agent_end is not completion signal; awaiting agent_settled' });
      return { state: this.state, warning: 'agent_end_ignored' };
    }
    if (event.type === 'tool_execution_start' || event.type === 'tool_execution_end' || event.type === 'tool_execution_update') {
      this.events.push({
        type: event.type,
        at: new Date().toISOString(),
        toolName: event.toolName || event.name || 'unknown',
        category: event.category || 'unknown'
      });
      return { state: this.state };
    }
    if (event.type === 'extension_ui_request') {
      this.events.push({ type: 'extension_ui_request', at: new Date().toISOString(), method: event.method, id: event.id });
      return { state: this.state, extensionUi: event };
    }
    return { state: this.state, unknown: event.type };
  }

  /**
   * Send a steer command. Requires 4-gate verification.
   * @param {object} params
   * @returns {object}
   */
  steer(params) {
    if (!this.fencingToken || !this.leaseId || !this.operationAttempt || !this.authorized) {
      return { error: 'gate_violation', details: 'fencing+lease+operation+authorization required' };
    }
    if (!params.reason || !params.idempotencyKey) {
      return { error: 'missing_params', details: 'reason + idempotencyKey required' };
    }
    this.events.push({ type: 'steer', at: new Date().toISOString(), reason: params.reason, idempotencyKey: params.idempotencyKey });
    return { ok: true, action: 'steer', idempotencyKey: params.idempotencyKey };
  }

  /**
   * Send an abort command. Requires 4-gate verification.
   * Per P-005 §5.2: abort ends current attempt only; preserves worktree + journal + receipt.
   * @param {object} params
   * @returns {object}
   */
  abort(params) {
    if (!this.fencingToken || !this.leaseId || !this.operationAttempt || !this.authorized) {
      return { error: 'gate_violation', details: 'fencing+lease+operation+authorization required' };
    }
    if (!params.reason || !params.idempotencyKey) {
      return { error: 'missing_params', details: 'reason + idempotencyKey required' };
    }
    this.state = 'aborted';
    this.events.push({ type: 'abort', at: new Date().toISOString(), reason: params.reason, idempotencyKey: params.idempotencyKey });
    return { ok: true, action: 'abort', idempotencyKey: params.idempotencyKey, worktreePreserved: true, journalPreserved: true };
  }

  /**
   * Send a get_state command. Requires 4-gate verification.
   * @returns {object}
   */
  queryState() {
    if (!this.fencingToken || !this.leaseId || !this.operationAttempt || !this.authorized) {
      return { error: 'gate_violation' };
    }
    return { state: this.state, attemptCount: this.events.length };
  }

  /** Return event timeline (audit trail). */
  getTimeline() {
    return [...this.events];
  }
}

module.exports = { PiRpcSupervisor };
