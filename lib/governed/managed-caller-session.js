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

// The fact source is reached through the module object rather than through
// destructured bindings, so that the OS-level facts stay a replaceable
// dependency. A degraded environment has to be reproducible in a test, and
// the only honest way to reproduce it is to make the fact source return the
// degraded fact — not to overwrite the identity that was derived from it.
const identityFacts = require("./managed-caller-identity");
const {
  SIGNED_MESSAGE_KIND,
  digestPayload,
  signResponse,
  verifyResponse,
} = require("./managed-caller-signing");

/**
 * Channel message names. Kept short — they travel over the IPC channel.
 *
 * Direction matters, because both ends are peers on the same channel:
 *
 *   HELLO / RESPONSE  parent -> child, and child -> parent during handshake.
 *   REQUEST           either side asks the other to do something. The
 *                     direction decides which MAC kind the exchange uses, so
 *                     an answer to an outbound request can never be replayed
 *                     as an answer to an inbound one.
 */
const CHANNEL_MESSAGE = Object.freeze({
  HELLO: "hello",
  REQUEST: "request",
  RESPONSE: "response",
  BYE: "bye",
  // The envelope Node's IPC layer uses for a frame that was written straight
  // onto the socket. It is not a protocol message of ours; it is the shape a
  // descendant that inherited the handle produces, and it has to be unwrapped
  // before routing.
  NODE_IPC_FRAME: "message",
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
    const {
      child,
      sessionId,
      owner,
      secret,
      handshakeTimeoutMs,
      requestTimeoutMs,
      factSource,
    } = options;
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
    // The identity is stored in a private slot and exposed through a
    // read-only accessor defined on the instance itself. A plain writable
    // property could be replaced wholesale by anything holding a reference to
    // the session, and a prototype accessor could be shadowed by
    // `Object.defineProperty`. A non-configurable own accessor resists both.
    //
    // The slot behind it is a closure variable rather than a property. It
    // used to be a writable property of the same name, which left a way in:
    // overwriting it made the recorded start token match whatever the caller
    // put there, and that defeated the pid-reuse check the continuity audit
    // compares against.
    let identitySlot = null;
    // The OS-level fact source is held in the same closure as the identity
    // slot. It used to be reached through a plain module reference that any
    // holder of the session could swap for one that reports clean facts,
    // which would have defeated the audit the same way overwriting the
    // identity did.
    const facts = factSource || identityFacts;
    // The individual fact readers are bound here rather than reached through
    // the source object. Exposing the source would let a holder of the
    // session REPLACE a reader on it, and for the real source that object is
    // the shared module, so the replacement would affect every session in
    // the process.
    const collectFacts = facts.collectProcessFacts.bind(facts);
    const readHolders = facts.readSocketHolders.bind(facts);
    const tokenIsPrecise = facts.isPreciseStartToken.bind(facts);
    // The readers are needed by methods other than the constructor, so they
    // are bound to the instance as non-configurable own properties. They are
    // bound FUNCTIONS rather than the source object: exposing the source
    // would let a holder of the session replace a reader on it, and for the
    // real source that object is the shared module, so the replacement would
    // affect every session in the process.
    Object.defineProperty(this, "_collectFacts", {
      enumerable: false,
      configurable: false,
      writable: false,
      value: collectFacts,
    });
    Object.defineProperty(this, "_readHolders", {
      enumerable: false,
      configurable: false,
      writable: false,
      value: readHolders,
    });
    Object.defineProperty(this, "_tokenIsPrecise", {
      enumerable: false,
      configurable: false,
      writable: false,
      value: tokenIsPrecise,
    });
    Object.defineProperty(this, "childIdentity", {
      enumerable: true,
      configurable: false,
      get: () => identitySlot,
      set: (_value) => {
        throw new TypeError(
          "managed caller identity is derived from OS facts and cannot be assigned",
        );
      },
    });
    // The only way to write the slot. It is not reachable from outside the
    // module, so the identity can be established once and then only read.
    Object.defineProperty(this, "_setChildIdentity", {
      enumerable: false,
      configurable: false,
      writable: false,
      value: (value) => {
        identitySlot = value;
      },
    });
    this.pending = new Map();
    this.nextRequestSeq = 0;
    this.listeners = { request: [], close: [] };
    // Rejected inbound messages, kept for the local audit trail. A refusal is
    // never sent back over the channel, so this is the only record of it.
    this.rejections = [];
    // Inbound requests that were authenticated and executed, with the payload
    // they carried. This is the record a negative case needs: it shows what
    // the coordinator actually ran, so "the attacker payload never executed"
    // is a fact rather than an inference.
    this.inboundExecutions = [];

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
      {
        kind: SIGNED_MESSAGE_KIND.HELLO,
        requestId,
        seq: undefined,
        operation: "hello",
      },
    );

    if (!reply || reply.nonce !== nonce) {
      await this.close("handshake_nonce_mismatch");
      throw new Error("managed caller handshake failed: nonce mismatch");
    }

    const facts = this._collectFacts(this.child);
    this._setChildIdentity(Object.freeze({
      sessionId: this.sessionId,
      pid: facts.pid,
      owner: this.owner,
      startToken: facts.startToken,
      commandDigest: facts.commandDigest,
      socketAddress: facts.socketAddress,
      socketEndpoint: facts.socketEndpoint
        ? Object.freeze({ ...facts.socketEndpoint })
        : null,
      establishedAt: new Date().toISOString(),
    }));
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
    const payloadDigest = digestPayload(payload);
    // The outbound request is signed too, so the supervised child can tell a
    // genuine coordinator apart from a process that inherited the channel
    // and writes onto it. The MAC kind encodes the direction, so this
    // signature cannot be replayed as an inbound request.
    const outboundMac = signResponse(this.secret, {
      kind: SIGNED_MESSAGE_KIND.REQUEST_OUT,
      requestId,
      seq,
      operation,
      payloadDigest,
      body: null,
    });

    // The identity has to be trustworthy BEFORE the payload is written, not
    // only after the answer comes back. If the IPC handle left the
    // supervised process, or the process behind the handle was replaced, the
    // session is no longer talking to the child it established — and the
    // payload that is about to go onto the channel would be readable by
    // whoever holds the transferred handle. Auditing afterwards would report
    // "refused to dispatch" while the sensitive payload had already gone
    // out over the wire.
    //
    // Both audits fail closed, so a degraded environment stops the session
    // instead of quietly serving unauthenticated work.
    const audit = await this._auditIdentity();
    if (!audit.ok) {
      await this.close(audit.reason || "identity_audit_failed");
      throw new Error(`managed caller session refused to dispatch: ${audit.reason}`);
    }

    const reply = await this._exchange(
      CHANNEL_MESSAGE.REQUEST,
      { seq, operation, payload, payloadDigest, kind: SIGNED_MESSAGE_KIND.REQUEST_OUT, mac: outboundMac },
      this.requestTimeoutMs,
      requestId,
    );

    // The identity has to still be trustworthy at the moment the answer came
    // back. The handle can be transferred WHILE the request is in flight, so
    // the pre-dispatch audit alone does not cover the whole exchange. This
    // second audit catches a transfer that happened during the round trip.
    const postAudit = await this._auditIdentity();
    if (!postAudit.ok) {
      await this.close(postAudit.reason || "identity_audit_failed");
      throw new Error(`managed caller session refused to dispatch: ${postAudit.reason}`);
    }

    if (!reply || reply.seq !== seq) {
      throw new Error("managed caller response did not match the request sequence");
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
   * This fails CLOSED. An environment where the socket address cannot be
   * determined is not an environment where the handle is known to be
   * exclusive — treating "cannot tell" as "fine" is exactly the degradation
   * the negative matrix has to rule out.
   *
   * @returns {{ok: boolean, reason?: string, holders?: number[]}}
   */
  auditChannelHolders() {
    const identity = this.childIdentity;
    // The endpoint is what identifies the socket: on Linux that is the
    // kernel inode, on macOS the address pair. Either identity is enough to
    // recognise the socket again; without one the handle cannot be checked.
    const endpoint = identity && identity.socketEndpoint
      ? identity.socketEndpoint
      : identity && identity.socketAddress
        ? { inode: null, address: identity.socketAddress, peerAddress: null }
        : null;
    if (!endpoint) {
      return { ok: false, reason: "socket_address_unknown", holders: [] };
    }

    // The holder set is looked up for the socket the session ESTABLISHED,
    // not for whatever fd 3 happens to point at now. Looking up the current
    // endpoint would make the audit answer a different question: a child
    // that swapped its descriptor would be audited on the new socket and
    // pass, while the channel the session established was abandoned.
    const current = this._collectFacts(this.child);
    if (current.socketEndpoint && endpoint.inode !== null
        && current.socketEndpoint.inode !== endpoint.inode) {
      return {
        ok: false,
        reason: "channel_endpoint_changed",
        holders: [],
      };
    }

    const holders = this._readHolders(endpoint) || [];
    const unexpected = holders.filter((pid) => pid !== this.child.pid && pid !== process.pid);
    if (unexpected.length) {
      return { ok: false, reason: "channel_handle_transferred", holders };
    }
    // The socket was located but nothing holds it — the channel is gone even
    // though the handle still looks alive. That is a degraded environment,
    // not a clean one.
    if (!holders.length) {
      return { ok: false, reason: "socket_holders_unknown", holders };
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

    const current = this._collectFacts(this.child);
    if (!current.startToken || !this.childIdentity.startToken) {
      // Without a start token a pid reuse cannot be detected, and pid reuse
      // is one of the negative cases this session has to reject.
      return { ok: false, reason: "start_token_unavailable" };
    }
    // A coarse token resolves to whole seconds. Two processes started within
    // the same second share it, so a pid reuse by one of them would compare
    // equal and go undetected. A comparison the audit cannot actually make
    // must not be reported as a pass.
    if (!this._tokenIsPrecise(current.startToken)
        || !this._tokenIsPrecise(this.childIdentity.startToken)) {
      return { ok: false, reason: "start_token_too_coarse" };
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
   * Run both identity audits and report the first failure.
   *
   * Both audits fail closed, so a degraded environment produces
   * `ok: false` rather than a permissive answer.
   *
   * @returns {Promise<{ok: boolean, reason?: string}>}
   */
  async _auditIdentity() {
    const holders = this.auditChannelHolders();
    if (!holders.ok) return holders;
    const continuity = this.auditProcessContinuity();
    if (!continuity.ok) return continuity;
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
  _exchange(type, body, timeoutMs, requestId, expect) {
    const promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`managed caller ${type} timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      // The pending entry carries everything the answer has to be signed
      // over. The MAC is verified when the answer arrives, not afterwards: an
      // answer that does not verify must reject the request immediately,
      // rather than being dropped and leaving the caller to time out. A
      // timeout would be indistinguishable from an answer that never came.
      this.pending.set(requestId, {
        resolve,
        reject,
        timer,
        // The fields the answer has to be signed over. The handshake is signed
        // under its own kind and operation; a request exchange is signed under
        // the outbound-request kind. The kind is what tells a handshake proof
        // apart from a request answer.
        expect: expect || {
          kind: SIGNED_MESSAGE_KIND.REQUEST_OUT_RESPONSE,
          requestId,
          seq: body.seq,
          operation: body.operation,
          payloadDigest: body.payloadDigest,
        },
      });

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
    // The promise is rejected from the message handler, which runs outside
    // the awaiting caller's stack. Without this guard the rejection would be
    // reported as unhandled for the moment between the handler and the
    // `await` in the caller that receives it.
    promise.catch(() => {});
    return promise;
  }

  /** Route an inbound channel message. */
  _handleMessage(message) {
    if (!message || typeof message !== "object") return;

    // Node's IPC parser hands a frame that was written straight onto the
    // socket to us verbatim, envelope included. A process that inherited the
    // channel writes exactly that envelope, so the envelope has to be
    // unwrapped before the payload can be routed — otherwise a message that
    // arrives over the transferred handle is silently ignored and the
    // negative cases would prove nothing.
    if (message.type === CHANNEL_MESSAGE.NODE_IPC_FRAME && message.data
        && typeof message.data === "object") {
      message = message.data;
    }

    if (message.sessionId && message.sessionId !== this.sessionId) return;

    if (message.type === CHANNEL_MESSAGE.RESPONSE) {
      const entry = this.pending.get(message.requestId);
      if (!entry) return;
      clearTimeout(entry.timer);
      this.pending.delete(message.requestId);

      // Verify before resolving. An answer that does not carry a valid MAC
      // for this exact request is a forgery or a replay, and the request must
      // fail loudly and immediately instead of waiting for the timeout.
      if (!verifyResponse(this.secret, {
        ...entry.expect,
        body: message.body || null,
      }, message.mac)) {
        // A failed verification means the channel can no longer be trusted:
        // somebody on it produced an answer the coordinator cannot attribute
        // to the supervised child. The session ends here rather than serving
        // anything else over the same channel.
        this.state = "closed";
        this.closedReason = "response_signature_mismatch";
        // The rejection is delivered first, so the caller waiting for THIS
        // request learns why it failed. The teardown then rejects every other
        // entry still in flight. The order matters: teardown alone would
        // produce a generic "session closed" and hide the real cause.
        entry.reject(new Error("managed caller response failed signature verification"));
        this._teardown();
        for (const handler of this.listeners.close) {
          try {
            handler(this.closedReason);
          } catch (_) {
            // Ignore listener failures during teardown.
          }
        }
        return;
      }

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

    // An inbound request is only executed after its own MAC verifies under
    // the INBOUND kind. A descendant that holds the transferred IPC handle
    // but not the session secret cannot produce that MAC, so it cannot make
    // the coordinator execute a payload of its choosing.
    //
    // This is also what stops the relay attack at its root: the coordinator
    // never signs an answer to an unauthenticated inbound request, so there
    // is no signed answer for the attacker to feed back in.
    const payloadDigest = digestPayload(message.payload);
    const macValid = verifyResponse(this.secret, {
      kind: SIGNED_MESSAGE_KIND.REQUEST_IN,
      requestId: message.requestId,
      seq: message.seq,
      operation: message.operation,
      payloadDigest,
      body: message.body === undefined ? null : message.body,
    }, message.mac);

    if (!macValid) {
      // Refuse silently on the channel: answering an unauthenticated request
      // would hand the attacker exactly the signed material it wants. The
      // refusal is recorded for the local audit instead.
      this._recordRejection("inbound_request_signature_mismatch", message);
      return;
    }

    const handlers = this.listeners.request.slice();
    if (!handlers.length) return;

    this.inboundExecutions.push({
      requestId: message.requestId,
      operation: message.operation,
      payload: message.payload,
      at: new Date().toISOString(),
    });

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
        // The answer to an INBOUND request is signed as an inbound answer. The
        // coordinator's own outbound answers carry a different kind, so an
        // answer produced here can never be mistaken for the supervised
        // child's answer to an outbound request.
        mac: signResponse(this.secret, {
          kind: SIGNED_MESSAGE_KIND.REQUEST_IN_RESPONSE,
          requestId: message.requestId,
          seq: message.seq,
          operation: message.operation,
          payloadDigest,
          body,
        }),
      });
    } catch (_) {
      // The child may have exited mid-request; the session is closing anyway.
    }
  }

  /**
   * Record a refused inbound message for the local audit trail.
   *
   * The rejection is never sent back over the channel: replying to an
   * unauthenticated message hands the attacker signed material.
   */
  _recordRejection(reason, message) {
    if (!this.rejections) this.rejections = [];
    this.rejections.push({
      reason,
      requestId: message && message.requestId ? message.requestId : null,
      operation: message && message.operation ? message.operation : null,
      at: new Date().toISOString(),
    });
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
