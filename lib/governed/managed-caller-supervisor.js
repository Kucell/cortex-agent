"use strict";

// ─── Managed Caller Supervisor (M-044 / MS-002) ────────────────────────────
//
// The coordinator-side half of the managed caller trust primitive. It spawns
// a fixed-batch executor, keeps the child's process handle and inherited IPC
// channel for the whole session, and refuses to serve anything once either
// fact is gone.
//
// Design constraints that are NOT negotiable here:
//
//  - The child is started with `stdio: ['ignore', 'pipe', 'pipe', 'ipc',
//    'pipe']`. The `ipc` entry is the transferable work channel; the trailing
//    `pipe` is the *secret* channel. The session secret travels ONLY on the
//    secret pipe, so a descendant that inherits the IPC handle still cannot
//    authenticate a response. See `managed-caller-session.js` for why the
//    nonce handshake alone is insufficient.
//  - `detached` stays OFF. A detached child survives the coordinator, which
//    would leave a supervised process nobody holds a handle to.
//  - The launch context is NOT passed through an environment variable or a
//    0600 context file. Those are same-account readable and therefore cannot
//    carry the caller's identity. They may still carry non-secret
//    configuration, but never the authority to act.
//  - The batch is fixed at spawn time. The executor may only request the
//    operations the coordinator listed for this batch; it cannot widen its
//    own scope by sending a different operation name.
//
// The supervisor is the only component that decides *identity*. It hands the
// caller a session object; what the caller may then DO with that identity is
// MS-003's business and is deliberately not implemented here.

const crypto = require("node:crypto");
const fs = require("node:fs");
const { fork } = require("node:child_process");
const path = require("node:path");

const {
  ManagedCallerSession,
  CHANNEL_MESSAGE,
  newSessionId,
  SIGNED_MESSAGE_KIND,
} = require("./managed-caller-session");
const { signResponse } = require("./managed-caller-signing");
const { digestPayload } = require("./managed-caller-signing");

/**
 * Operations the supervisor itself understands. The executor may only ask
 * for these; anything else is refused before it reaches a handler.
 */
const SUPERVISOR_OPERATIONS = Object.freeze({
  PING: "ping",
});

/** The fd the child reads the session secret from. */
const SECRET_FD = 4;

/**
 * Spawn a supervised executor and establish a managed caller session.
 *
 * @param {object} options
 * @param {string} options.modulePath Absolute path to the executor module.
 * @param {string[]} [options.args] Arguments passed to the executor.
 * @param {object} [options.env] Extra environment for the child.
 * @param {string[]} [options.allowedOperations] Batch scope. Defaults to
 *   [`SUPERVISOR_OPERATIONS.PING`].
 * @param {string} [options.owner] Audit-only label for the batch.
 * @param {number} [options.handshakeTimeoutMs]
 * @param {number} [options.requestTimeoutMs]
 * @param {object} [options.spawnOptions] Escape hatch for advanced callers.
 * @returns {Promise<{ session: ManagedCallerSession, child: object }>}
 */
async function startManagedCallerSession(options) {
  const {
    modulePath,
    args = [],
    env = {},
    allowedOperations = [SUPERVISOR_OPERATIONS.PING],
    owner,
    handshakeTimeoutMs,
    requestTimeoutMs,
    spawnOptions = {},
  } = options || {};

  if (typeof modulePath !== "string" || !modulePath) {
    throw new TypeError("modulePath is required");
  }
  if (!Array.isArray(allowedOperations) || !allowedOperations.length) {
    throw new TypeError("allowedOperations must be a non-empty array");
  }

  const permitted = new Set(allowedOperations);
  const sessionId = newSessionId();
  const secret = crypto.randomBytes(32).toString("hex");

  const child = fork(path.resolve(modulePath), args, {
    stdio: ["ignore", "pipe", "pipe", "ipc", "pipe"],
    detached: false,
    env: { ...process.env, ...env },
    ...spawnOptions,
  });

  // The secret goes down the dedicated pipe and nowhere else. It is never
  // placed in argv, the environment, or a file, so a same-account bystander
  // cannot read it and a descendant that inherits only the IPC handle does
  // not have it either.
  try {
    child.stdio[SECRET_FD].write(`${secret}\n`);
    child.stdio[SECRET_FD].end();
  } catch (_) {
    // Handshake will fail closed below if the child never got the secret.
  }

  const session = new ManagedCallerSession({
    child,
    sessionId,
    owner,
    secret,
    handshakeTimeoutMs,
    requestTimeoutMs,
  });

  session.onRequest(async ({ operation }) => {
    if (!permitted.has(operation)) {
      throw new Error(`operation_not_in_batch:${operation}`);
    }
    if (operation === SUPERVISOR_OPERATIONS.PING) {
      return { pong: true, sessionId };
    }
    throw new Error(`operation_not_implemented:${operation}`);
  });

  await session.handshake();
  return { session, child };
}

/**
 * Read the session secret from the dedicated secret pipe.
 *
 * This runs INSIDE the child. The coordinator never uses it — the coordinator
 * side is `ManagedCallerSession`.
 *
 * @param {object} child The forked child process (i.e. `process` in the child).
 * @returns {Promise<string>} The hex session secret.
 */
async function readSessionSecret(child) {
  if (!child) {
    throw new Error("executor endpoint requires the dedicated secret channel");
  }
  // In the child, `process.stdio` is not populated — the pipe arrives as a
  // plain file descriptor. The coordinator side does have `child.stdio`, so
  // both shapes are accepted.
  const stream = child.stdio && child.stdio[SECRET_FD]
    ? child.stdio[SECRET_FD]
    : fs.createReadStream(null, { fd: SECRET_FD });
  if (!stream) {
    throw new Error("executor endpoint requires the dedicated secret channel");
  }
  return new Promise((resolve, reject) => {
    let buffer = "";
    stream.on("data", (chunk) => {
      buffer += chunk.toString();
      const index = buffer.indexOf("\n");
      if (index < 0) return;
      stream.pause();
      resolve(buffer.slice(0, index).trim());
    });
    stream.on("error", reject);
    stream.on("end", () => {
      const value = buffer.trim();
      if (value) resolve(value);
      else reject(new Error("session secret channel closed before a secret arrived"));
    });
  });
}

/**
 * Build the child-side counterpart: a thin channel endpoint the executor
 * uses to talk to its supervisor. The executor receives only the channel; it
 * never learns the supervisor's authority, and it cannot open a second one.
 *
 * This runs INSIDE the child. The coordinator never uses it — the coordinator
 * side is `ManagedCallerSession`.
 *
 * @param {object} child The forked child process (i.e. `process` in the child).
 * @param {string} secret The session secret read from the secret pipe.
 */
function createExecutorEndpoint(child, secret) {
  if (!child || !child.channel) {
    throw new TypeError("executor endpoint requires an inherited IPC channel");
  }
  if (typeof secret !== "string" || !secret) {
    throw new TypeError("executor endpoint requires the session secret");
  }

  const pending = new Map();
  let seq = 0;

  child.on("message", (message) => {
    if (!message || message.type !== CHANNEL_MESSAGE.RESPONSE) return;
    const entry = pending.get(message.requestId);
    if (!entry) return;
    pending.delete(message.requestId);
    clearTimeout(entry.timer);
    const body = message.body || {};
    if (body.error) entry.reject(new Error(body.error));
    else entry.resolve(body.result === undefined ? null : body.result);
  });

  /**
   * Answer a coordinator request. The response is MAC-signed with the secret,
   * so a descendant that inherited the IPC handle cannot forge one.
   *
   * @param {object} message The inbound REQUEST message.
   * @param {*} result The result to return.
   */
  function answer(message, result) {
    const body = { seq: message.seq, result };
    child.send({
      type: CHANNEL_MESSAGE.RESPONSE,
      requestId: message.requestId,
      sessionId: message.sessionId,
      seq: message.seq,
      body,
      mac: signResponse(secret, {
        kind: SIGNED_MESSAGE_KIND.REQUEST_OUT_RESPONSE,
        requestId: message.requestId,
        seq: message.seq,
        operation: message.operation,
        payloadDigest: digestPayload(message.payload),
        body,
      }),
    });
  }

  /**
   * Ask the coordinator to perform an operation and await its response.
   *
   * @param {string} operation
   * @param {object} [payload]
   * @param {number} [timeoutMs]
   */
  async function request(operation, payload, timeoutMs = 30_000) {
    seq += 1;
    const requestId = `ex-${process.pid}-${seq}`;
    const payloadDigest = digestPayload(payload);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(requestId);
        reject(new Error(`executor request timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      pending.set(requestId, { resolve, reject, timer });
      child.send({
        type: CHANNEL_MESSAGE.REQUEST,
        requestId,
        seq,
        operation,
        payload,
        payloadDigest,
        // The inbound request is signed with the session secret, so the
        // coordinator can tell it apart from a replayed outbound request
        // written onto the channel by a descendant that inherited the handle.
        mac: signResponse(secret, {
          kind: SIGNED_MESSAGE_KIND.REQUEST_IN,
          requestId,
          seq,
          operation,
          payloadDigest,
          body: null,
        }),
      });
    });
  }

  return { request, answer };
}

module.exports = {
  startManagedCallerSession,
  createExecutorEndpoint,
  readSessionSecret,
  SUPERVISOR_OPERATIONS,
  SECRET_FD,
};
