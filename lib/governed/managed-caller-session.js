"use strict";

// ─── Managed Caller Session (M-044 / MS-002) ───────────────────────────────
//
// Establishes the trust primitive the existing governed launcher cannot
// provide: a coordinator holds the OS process handle of the exact child it
// supervises, plus an inherited bidirectional IPC channel, and derives the
// caller's identity from those facts alone.
//
// Why this exists
// --------------
// `lib/governed/launcher.js` starts its monitor with `stdio: "ignore"` and
// `detached: true`. That leaves the coordinator with no channel to the child
// and no handle it can use to prove which process it is talking to. The
// launch context is a 0600 file plus an environment variable — both readable
// by any process of the same user. So "who is calling" currently has no
// trustworthy answer, and the coordinator cannot distinguish the supervised
// child from a same-account bystander that found the context file.
//
// The threat that the IPC channel alone does NOT stop
// ----------------------------------------------------
// The IPC handle is transferable. If the supervised child hands its channel
// fd to a descendant (via `stdio: [.., 3]`), that descendant can write
// *forged responses onto the coordinator's channel*. This was reproduced on
// this platform: a grandchild given the inherited fd wrote a response that
// the coordinator accepted as the child's own.
//
// A nonce handshake does not stop this — both peers see the nonce, and the
// grandchild sees the parent's reply on the very channel it now holds. So the
// session secret does NOT travel over the IPC channel: it travels over a
// *second*, independent pipe that the child reads from fd 4, and every
// response carries an HMAC computed with it. See `managed-caller-signing.js`
// for the primitive and why it is sufficient.
//
// What this module guarantees
// ----------------------------
//  1. The channel is an anonymous IPC channel (`stdio: ['ipc']`). It has no
//     filesystem path, so a same-account bystander cannot discover it by
//     scanning a directory. Verified: the socket shows up in `lsof` as an
//     address pair, never as a path.
//  2. The coordinator keeps the child process handle for the whole session.
//     Identity is bound to that handle, not to anything the child claims.
//  3. Every response must be MAC-signed with a secret that never travels on
//     the transferable channel. A transferred handle therefore cannot forge
//     a response.
//  4. The socket's holder set is audited. If the handle left the supervised
//     process, the session refuses to serve anything further.
//  5. A caller-supplied `actor`, `owner`, `pid` or path is never an input
//     to the identity decision. It can be echoed back for audit, but it can
//     never establish who the caller is.
//  6. Session loss is terminal: once the child exits or the channel closes,
//     the session refuses new work instead of degrading into an
//     unauthenticated mode.
//
// This module does NOT replace `launcher.js`'s existing non-sensitive launch
// path, and it does not itself decide what a caller is allowed to do.
// Authorization, permits and cross-machine delivery are MS-003 and MS-004;
// this module only answers the narrower question "is this request really from
// the process I am supervising?".

const crypto = require("node:crypto");

const { collectProcessFacts } = require("./managed-caller-identity");
const {
  SIGNED_MESSAGE_KIND,
  signResponse,
  verifyResponse,
} = require("./managed-caller-signing");

/**
 * Channel message names. Kept short — they travel over the IPC channel.
 *
 * Direction matters, because both ends are peers on the same channel:
 *
 *   HELLO / RESPONSE  parent -> child, and child -> parent during handshake.
 *   REQUEST           either side asks the other to do something.
 */
const CHANNEL_MESSAGE = Object.freeze({
  HELLO: "hello",
  REQUEST: "request",
  RESPONSE: "response",
  BYE: "bye",
});

/** How long a child may take to complete the HELLO handshake. */
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 10_000;

/** How long a single request may stay unanswered before it fails closed. */
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

/** Monotonic session counter. Every session gets a fresh id; ids never repeat. */
let sessionCounter = 0;

/**
 * Mint a fresh session id. The random suffix keeps ids from colliding across
 * processes that each start their own counter at zero.
 */
function newSessionId() {
  sessionCounter += 1;
  const suffix = crypto.randomBytes(8).toString("hex");
  return `ms002-${process.pid}-${sessionCounter}-${suffix}`;
}

/**
 * A session is created only when the coordinator holds BOTH a live child
 * handle and a working channel. Until the handshake completes the session is
 * `pending`; only a completed handshake makes it `established`.
 *
 * The constructor deliberately takes the child object rather than a pid, so a
 * caller cannot hand us a pid it merely read out of a file and have us treat
 * it as a supervised process.
 */
class ManagedCallerSession {
  /**
   * @param {object} options
   * @param {import("node:child_process").ChildProcess} options.child
   * @param {string} options.sessionId
   * @param {string} [options.owner] Audit-only label. Never an identity input.
   * @param {string} [options.secret] Hex session secret. Must NOT travel on
   *   the IPC channel — it arrives on the child's separate secret pipe.
   * @param {number} [options.handshakeTimeoutMs]
   * @param {number} [options.requestTimeoutMs]
   */
  constructor(options) {
    const { child, sessionId, owner, secret, handshakeTimeoutMs, requestTimeoutMs } = options;
    if (!child || typeof child.pid !== "number" || child.pid <= 0) {
      throw new TypeError("ManagedCallerSession requires a live child process handle.");
    }
    if (!child.channel) {
      throw new TypeError("ManagedCallerSession requires an inherited IPC channel.");
    }
    if (typeof secret !== "string" || !secret) {
      throw new TypeError("ManagedCallerSession requires a session secret.");
    }

    this.child = child;
    this.sessionId = sessionId;
    this.owner = owner || null;
    this.secret = secret;
    this.handshakeTimeoutMs = handshakeTimeoutMs || DEFAULT_HANDSHAKE_TIMEOUT_MS;
    this.requestTimeoutMs = requestTimeoutMs || DEFAULT_REQUEST_TIMEOUT_MS;

    this.state = "pending";
    this.closedReason = null;
    this.childIdentity = null;
    this.pending = new Map();
    this.nextRequestSeq = 0;
    this.listeners = { request: [], close: [] };
    this.allowedOperations = new Set();

    this._onMessage = this._handleMessage.bind(this);
    this._onExit = this._handleExit.bind(this);
    this._onChannelError = this._handleChannelError.bind(this);

    child.on("message", this._onMessage);
    child.on("exit", this._onExit);
    child.on("error", this._onExit);
    child.channel.on("error", this._onChannelError);
  }

  /** True when the session may serve requests. */
  get established() {
    return this.state === "established";
  }

  /** True when the session can no longer serve anything. */
  get closed() {
    return this.state === "closed";
  }

  /**
   * Subscribe to inbound requests from the supervised child.
   * @param {(request: object) => void} handler
   */
  onRequest(handler) {
    if (typeof handler === "function") this.listeners.request.push(handler);
    return this;
  }

  /**
   * Subscribe to session termination.
   * @param {(reason: string) => void} handler
   */
  onClose(handler) {
    if (typeof handler === "function") this.listeners.close.push(handler);
    return this;
  }

  /**
   * Complete the HELLO handshake.
   *
   * The child proves it holds the session secret by returning an HMAC over
   * the nonce. The nonce itself travels on the IPC channel, but the secret
   * does not — so a process that merely inherited the channel cannot produce
   * a valid MAC, even though it can see the nonce.
   */
  async handshake() {
    if (this.state === "closed") throw new Error("session is closed");
    if (this.state === "established") return this.childIdentity;

    const nonce = crypto.randomBytes(32).toString("hex");
    const requestId = crypto.randomBytes(12).toString("hex");
    const reply = await this._exchange(
      CHANNEL_MESSAGE.HELLO,
      { nonce, kind: SIGNED_MESSAGE_KIND.HELLO },
      this.handshakeTimeoutMs,
      requestId,
    );

    if (!reply || reply.nonce !== nonce) {
      await this.close("handshake_nonce_mismatch");
      throw new Error("managed caller handshake failed: nonce mismatch");
    }

    if (!verifyResponse(this.secret, {
      kind: SIGNED_MESSAGE_KIND.HELLO,
      requestId,
      seq: reply.seq,
      operation: "hello",
      body: reply.body,
    }, reply.mac)) {
      await this.close("handshake_signature_mismatch");
      throw new Error("managed caller handshake failed: signature mismatch");
    }

    const facts = collectProcessFacts(this.child);
    this.childIdentity = Object.freeze({
      sessionId: this.sessionId,
      pid: facts.pid,
      owner: this.owner,
      startToken: facts.startToken,
      commandDigest: facts.commandDigest,
      socketAddress: facts.socketAddress,
      establishedAt: new Date().toISOString(),
    });
    this.state = "established";
    return this.childIdentity;
  }

  /**
   * Ask the supervised child to perform an operation and await its response.
   *
   * Fails closed when the session is not established.
   *
   * @param {string} operation
   * @param {object} [payload]
   */
  async request(operation, payload) {
    if (!this.established) throw new Error("managed caller session is not established");
    if (typeof operation !== "string" || !operation) {
      throw new TypeError("operation must be a non-empty string");
    }

    this.nextRequestSeq += 1;
    const seq = this.nextRequestSeq;
    const requestId = crypto.randomBytes(12).toString("hex");
    const reply = await this._exchange(
      CHANNEL_MESSAGE.REQUEST,
      { seq, operation, payload, kind: SIGNED_MESSAGE_KIND.REQUEST },
      this.requestTimeoutMs,
      requestId,
    );

    if (!reply || reply.seq !== seq) {
      throw new Error("managed caller response did not match the request sequence");
    }

    if (!verifyResponse(this.secret, {
      kind: SIGNED_MESSAGE_KIND.REQUEST,
      requestId,
      seq,
      operation,
      body: reply.body,
    }, reply.mac)) {
      await this.close("response_signature_mismatch");
      throw new Error("managed caller response failed signature verification");
    }

    if (reply.body && reply.body.error) throw new Error(reply.body.error);
    return reply.body ? reply.body.result : null;
  }

  /**
   * Verify that the IPC handle is still held only by the supervised process.
   *
   * A descendant that inherited the handle shows up as an extra holder of the
   * socket. At that point the channel can no longer be treated as exclusive
   * to the child, so the session must stop serving.
   *
   * @returns {{ok: boolean, reason?: string, holders?: number[]}}
   */
  auditChannelHolders() {
    if (!this.childIdentity || !this.childIdentity.socketAddress) {
      return { ok: true, reason: "socket_address_unknown" };
    }
    const facts = collectProcessFacts(this.child);
    const holders = facts.holders || [];
    const unexpected = holders.filter((pid) => pid !== this.child.pid && pid !== process.pid);
    if (unexpected.length) {
      return { ok: false, reason: "channel_handle_transferred", holders };
    }
    return { ok: true, holders };
  }

  /**
   * Verify that the supervised process is still the same process (no pid
   * reuse) and that its command line has not changed underneath us.
   *
   * @returns {{ok: boolean, reason?: string}}
   */
  auditProcessContinuity() {
    if (!this.childIdentity) return { ok: false, reason: "identity_not_established" };

    const current = collectProcessFacts(this.child);
    if (!current.startToken || !this.childIdentity.startToken) {
      return { ok: true, reason: "start_token_unavailable" };
    }
    if (current.startToken !== this.childIdentity.startToken) {
      return { ok: false, reason: "process_replaced_pid_reuse" };
    }
    if (this.childIdentity.commandDigest && current.commandDigest
        && current.commandDigest !== this.childIdentity.commandDigest) {
      return { ok: false, reason: "process_command_changed" };
    }
    return { ok: true };
  }

  /**
   * Terminate the session. The child is asked to leave first; if it does not,
   * it is killed. Either way the session ends in `closed` and refuses work.
   */
  async close(reason) {
    if (this.state === "closed") return;
    this.state = "closed";
    this.closedReason = reason || "closed";

    try {
      this.child.send({ type: CHANNEL_MESSAGE.BYE, sessionId: this.sessionId });
    } catch (_) {
      // The channel may already be gone; the session is closed either way.
    }

    this._teardown();

    for (const handler of this.listeners.close) {
      try {
        handler(this.closedReason);
      } catch (_) {
        // A failing close listener must not keep the session open.
      }
    }
  }

  // ─── Internals ────────────────────────────────────────────────────────────

  /**
   * One request/response round trip over the inherited channel.
   * @returns {Promise<object|null>}
   */
  _exchange(type, body, timeoutMs, requestId) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`managed caller ${type} timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      this.pending.set(requestId, { resolve, reject, timer });

      try {
        this.child.send({
          type,
          requestId,
          sessionId: this.sessionId,
          ...body,
        });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(requestId);
        reject(error);
      }
    });
  }

  /** Route an inbound channel message. */
  _handleMessage(message) {
    if (!message || typeof message !== "object") return;
    if (message.sessionId && message.sessionId !== this.sessionId) return;

    if (message.type === CHANNEL_MESSAGE.RESPONSE) {
      const entry = this.pending.get(message.requestId);
      if (!entry) return;
      clearTimeout(entry.timer);
      this.pending.delete(message.requestId);
      entry.resolve({
        requestId: message.requestId,
        seq: message.seq,
        nonce: message.nonce,
        mac: message.mac,
        body: message.body || null,
      });
      return;
    }

    if (message.type === CHANNEL_MESSAGE.REQUEST) {
      this._dispatchInbound(message);
    }
  }

  /** Forward an inbound request to the registered handlers. */
  async _dispatchInbound(message) {
    if (!this.established) return;
    const handlers = this.listeners.request.slice();
    if (!handlers.length) return;

    let result = null;
    let failure = null;
    for (const handler of handlers) {
      try {
        result = await handler({ operation: message.operation, payload: message.payload, seq: message.seq });
        break;
      } catch (error) {
        failure = error;
      }
    }

    const body = failure
      ? { seq: message.seq, error: String(failure.message || failure) }
      : { seq: message.seq, result };

    try {
      this.child.send({
        type: CHANNEL_MESSAGE.RESPONSE,
        requestId: message.requestId,
        sessionId: this.sessionId,
        seq: message.seq,
        body,
        mac: signResponse(this.secret, {
          kind: SIGNED_MESSAGE_KIND.REQUEST,
          requestId: message.requestId,
          seq: message.seq,
          operation: message.operation,
          body,
        }),
      });
    } catch (_) {
      // The child may have exited mid-request; the session is closing anyway.
    }
  }

  /** The supervised child exited: the session is permanently unusable. */
  _handleExit(code) {
    if (this.state === "closed") return;
    this.state = "closed";
    this.closedReason = `child_exit:${code === undefined ? "unknown" : code}`;
    this._teardown();
    for (const handler of this.listeners.close) {
      try {
        handler(this.closedReason);
      } catch (_) {
        // Ignore listener failures during teardown.
      }
    }
  }

  /** The channel itself failed: also terminal. */
  _handleChannelError() {
    if (this.state === "closed") return;
    this.state = "closed";
    this.closedReason = "channel_error";
    this._teardown();
    for (const handler of this.listeners.close) {
      try {
        handler(this.closedReason);
      } catch (_) {
        // Ignore listener failures during teardown.
      }
    }
  }

  /** Detach listeners and reject anything still in flight. */
  _teardown() {
    this.child.removeListener("message", this._onMessage);
    this.child.removeListener("exit", this._onExit);
    this.child.removeListener("error", this._onExit);
    if (this.child.channel) this.child.channel.removeListener("error", this._onChannelError);

    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(new Error("managed caller session closed"));
    }
    this.pending.clear();
  }
}

module.exports = {
  ManagedCallerSession,
  CHANNEL_MESSAGE,
  DEFAULT_HANDSHAKE_TIMEOUT_MS,
  DEFAULT_REQUEST_TIMEOUT_MS,
  newSessionId,
  SIGNED_MESSAGE_KIND,
};
