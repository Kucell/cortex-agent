/**
 * lib/host-adapter/extension-ui.js
 *
 * M-013 SP-004 / VC-009a: RPC extension UI sub-protocol.
 *
 * Per P-005 §5.2:
 *   - 4 dialog methods: select / confirm / input / editor (request/response)
 *   - 5 fire-and-forget: notify / setStatus / setWidget / setTitle / set_editor_text
 *   - Default behavior: auto-resolve on timeout (server-side)
 *   - Cancel/late response is idempotent
 */

'use strict';

const VALID_DIALOG_METHODS = ['select', 'confirm', 'input', 'editor'];
const VALID_FIRE_AND_FORGET = ['notify', 'setStatus', 'setWidget', 'setTitle', 'set_editor_text'];
const DEFAULT_TIMEOUT_MS = 5000;

class ExtensionUiHandler {
  constructor() {
    this.pendingRequests = new Map(); // id -> { method, timeout, resolve }
    this.responses = new Map(); // id -> response (for replay)
  }

  registerRequest(req) {
    if (!req || !req.id || !req.method) {
      return { error: 'invalid_request', details: 'id + method required' };
    }
    if (!VALID_DIALOG_METHODS.includes(req.method)) {
      return { error: 'invalid_method', method: req.method };
    }
    const timeout = req.timeout || DEFAULT_TIMEOUT_MS;
    this.pendingRequests.set(req.id, {
      method: req.method,
      timeout,
      receivedAt: new Date().toISOString()
    });
    return { ok: true, id: req.id, timeout };
  }

  /**
   * Process an extension_ui_request from Pi stdout.
   * @param {object} event
   * @returns {object} - { action: 'respond' | 'await' | 'cancel', response? }
   */
  handleRequest(event) {
    if (!event || !event.id || !event.method) {
      return { action: 'cancel', reason: 'invalid_event' };
    }
    if (VALID_FIRE_AND_FORGET.includes(event.method)) {
      return { action: 'fire_and_forget', id: event.id, method: event.method };
    }
    if (!VALID_DIALOG_METHODS.includes(event.method)) {
      return { action: 'cancel', reason: 'invalid_method', id: event.id };
    }
    this.registerRequest(event);
    return { action: 'await', id: event.id, method: event.method, timeout: event.timeout || DEFAULT_TIMEOUT_MS };
  }

  /**
   * Receive a response from the orchestrator.
   * @param {object} response
   * @returns {object}
   */
  receiveResponse(response) {
    if (!response || !response.id) {
      return { error: 'invalid_response' };
    }
    const request = this.pendingRequests.get(response.id);
    if (!request) {
      // Late response — idempotent
      return { ok: true, idempotent: true, id: response.id };
    }
    if (response.cancelled) {
      this.pendingRequests.delete(response.id);
      return { ok: true, cancelled: true, id: response.id };
    }
    if (response.confirmed !== undefined) {
      this.responses.set(response.id, { value: response.confirmed });
    } else if (response.value !== undefined) {
      this.responses.set(response.id, { value: response.value });
    }
    this.pendingRequests.delete(response.id);
    return { ok: true, id: response.id };
  }

  /**
   * Cancel a pending request.
   * @param {string} id
   */
  cancelRequest(id) {
    if (!this.pendingRequests.has(id)) return { error: 'no_pending_request' };
    this.pendingRequests.delete(id);
    return { ok: true, cancelled: true, id };
  }

  /**
   * Tick — auto-resolve expired requests on timeout.
   * @returns {string[]} - ids that were auto-resolved
   */
  tick() {
    const now = Date.now();
    const expired = [];
    for (const [id, req] of this.pendingRequests.entries()) {
      const receivedAt = Date.parse(req.receivedAt);
      if (now - receivedAt > req.timeout) {
        this.pendingRequests.delete(id);
        this.responses.set(id, { value: undefined, autoResolved: true });
        expired.push(id);
      }
    }
    return expired;
  }

  /** Get pending request count. */
  pendingCount() {
    return this.pendingRequests.size;
  }

  /** Get response for a request id. */
  getResponse(id) {
    return this.responses.get(id) || null;
  }
}

module.exports = {
  ExtensionUiHandler,
  VALID_DIALOG_METHODS,
  VALID_FIRE_AND_FORGET,
  DEFAULT_TIMEOUT_MS
};
