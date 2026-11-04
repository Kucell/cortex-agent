"use strict";

// ─── Permit Bridge Executor (M-053 / MS-008 第 9 环阶段 C) ────────────────
//
// WHAT THIS PROCESS IS
//   The long-lived executor on the ISSUING side of the bridge. It is forked by
//   `permit-bridge-host` and it is the process whose verified identity the
//   authority's `authorize` policy is bound to.
//
// WHY THE REQUEST HAS TO TRAVEL THROUGH THE SESSION
//   `permit-authority-service.dispatch` requires the transport to supply an
//   opaque VERIFIED peer context. The only verified peer the framework has is
//   a managed session's identity: the session secret travelled on a dedicated
//   pipe, the handshake proved the peer holds it, and the identity facts were
//   audited before and after each exchange.
//
//   A request that reached `dispatch` straight from an HTTP body would have no
//   verified peer at all — the transport would have to invent one. So the HTTP
//   handler does not dispatch; it RELAYS the payload into the session, and
//   this executor turns it into an inbound `permit.<action>` request. That
//   request carries the session's MAC and arrives at the coordinator as a
//   request from a process the coordinator OS-audited and whose channel it
//   verified to be exclusive.
//
// WHY IT IS LONG-LIVED
//   The policy pins the peer identity ONCE, when the session is established.
//   A one-shot executor (one fork per request) would produce a different pid
//   and a different session id on every request, and a pinned identity would
//   match none of them. A long-lived executor keeps one identity for the life
//   of the bridge, so the pin means something.
//
// WHAT IT DOES NOT DO
//   It holds no key, no store and no authority. The batch session (and the
//   signing key it guards) lives in the coordinator process. This executor
//   only moves a payload and returns a result.

const { readSessionSecret, createExecutorEndpoint, openExecutorTransport } = require("../governed/managed-caller-supervisor");
const { CHANNEL_MESSAGE, SIGNED_MESSAGE_KIND } = require("../governed/managed-caller-session");
const { signResponse, verifyResponse, digestPayload } = require("../governed/managed-caller-signing");

// The operation the coordinator uses to hand a payload to this executor.
const COLLECT_OPERATION = "permit.collect";

// The action prefix this executor sends back to the coordinator.
const ACTION_PREFIX = "permit.";

function refuse(message) {
  throw Object.assign(new Error(message), { code: "ERR_BRIDGE_EXECUTOR_REFUSED" });
}

let transport = process;
let secret = null;
let endpoint = null;
let started = false;
let lastWindowsRequestSeq = 0;
const queued = [];

function send(message) {
  if (transport.connected) transport.send(message, () => {});
}

async function handle(message) {
  if (!message || typeof message !== "object") return;

  if (message.type === CHANNEL_MESSAGE.HELLO) {
    const body = { nonce: message.nonce };
    send({
      type: CHANNEL_MESSAGE.RESPONSE,
      requestId: message.requestId,
      sessionId: message.sessionId,
      nonce: message.nonce,
      body,
      mac: signResponse(secret, {
        kind: SIGNED_MESSAGE_KIND.HELLO,
        requestId: message.requestId,
        seq: message.seq,
        operation: "hello",
        body,
      }),
    });
    return;
  }

  if (message.type === CHANNEL_MESSAGE.BYE) {
    process.exit(0);
    return;
  }

  if (message.type !== CHANNEL_MESSAGE.REQUEST) return;

  if (process.platform === "win32") {
    // Authenticate before collect can turn a payload into a signed INBOUND
    // request. answer() still verifies the original response-binding fields.
    if (!Number.isSafeInteger(message.seq) || message.seq <= lastWindowsRequestSeq ||
        typeof message.requestId !== "string" || typeof message.operation !== "string" ||
        message.payloadDigest !== digestPayload(message.payload) ||
        !verifyResponse(secret, { kind: SIGNED_MESSAGE_KIND.REQUEST_OUT, requestId: message.requestId,
          seq: message.seq, operation: message.operation, payloadDigest: message.payloadDigest, body: null }, message.mac)) {
      refuse("bridge executor request signature mismatch");
    }
    lastWindowsRequestSeq = message.seq;
  }

  // The `permit.start` handshake is answered exactly once. It is what tells
  // the coordinator that this executor is ready to carry requests.
  if (message.operation === "permit.start") {
    if (started) {
      endpoint.answer(message, { error: "bridge executor already started" });
      return;
    }
    started = true;
    endpoint.answer(message, { ready: true });
    return;
  }

  // The coordinator hands a payload to this executor. The executor turns it
  // into an INBOUND request, which is the only path on which the coordinator
  // sees a verified peer.
  if (message.operation === COLLECT_OPERATION) {
    if (!started) {
      endpoint.answer(message, { error: "bridge executor not started" });
      return;
    }
    const action = message.payload && message.payload.action;
    const args = message.payload && message.payload.args;
    if (typeof action !== "string" || !action.startsWith(ACTION_PREFIX)) {
      endpoint.answer(message, { error: "bridge executor received an unknown action" });
      return;
    }
    let result;
    try {
      result = await endpoint.request(action, args);
    } catch (error) {
      // The coordinator refused the dispatch, or the round trip failed. The
      // refusal is carried back as the answer rather than thrown: the answer
      // is the only channel the coordinator reads, and an exception here
      // would leave the coordinator waiting for a response that never comes.
      result = { error: String((error && error.message) || "bridge dispatch failed") };
    }
    // `result` is already the coordinator's answer body: `endpoint.request`
    // resolves with `body.result`. On failure it is an error marker, which
    // the host turns into a refusal.
    endpoint.answer(message, result);
    return;
  }

  // An operation the executor does not serve is refused with an answer, not
  // with an exception. The coordinator reads the answer channel; an
  // exception here would leave it waiting for a response that never comes,
  // and a refusal that arrives as a timeout is a refusal the caller cannot
  // tell apart from a slow bridge.
  if (message.type === CHANNEL_MESSAGE.REQUEST) {
    endpoint.answer(message, { error: "bridge executor received an unknown operation" });
    return;
  }
  refuse("bridge executor received an unknown operation");
}

function attachMessages() {
transport.on("message", (message) => {
  if (!endpoint) {
    queued.push(message);
    return;
  }
  // A rejection here would be an unhandled promise rejection: the executor
  // has no other way to report a failure than the answer channel, and an
  // unhandled rejection would take the whole executor down instead of
  // refusing one request.
  void handle(message).catch(() => {});
});

transport.on("disconnect", () => process.exit(0));
}
if (process.platform !== "win32") attachMessages();

void readSessionSecret(process).then(async (value) => {
  if (process.platform === "win32") {
    transport = await openExecutorTransport(process);
    attachMessages();
  }
  secret = value;
  endpoint = createExecutorEndpoint(transport, secret);
  for (const message of queued.splice(0)) void handle(message);
}, () => {
  // Without the secret there is no session. Refuse rather than run blind.
  process.exit(3);
}).catch(() => process.exit(3));

module.exports = { COLLECT_OPERATION };
