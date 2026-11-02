"use strict";

// Real supervised fixture: use only the existing secret-pipe, signed handshake
// and executor endpoint. The secret is ephemeral test plumbing, never output.
const { readSessionSecret, createExecutorEndpoint } = require("../../../lib/governed/managed-caller-supervisor");
const { CHANNEL_MESSAGE, SIGNED_MESSAGE_KIND } = require("../../../lib/governed/managed-caller-session");
const { signResponse, verifyResponse, digestPayload } = require("../../../lib/governed/managed-caller-signing");
const { SingleExchange, ExchangeBudget } = require("../../../lib/coordination/permit-witness-v2-exchange");
const fixture = require("./permit-witness-v2-history");
const { spawn } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");
const { environment, evidence } = require("./permit-witness-isolation-env");
const [mode, readyFile, stopFile, token, preloadFile] = process.argv.slice(2);
let endpoint, secret, armed = false;
const queued = [];
function send(value) { if (process.connected) process.send(value, () => {}); }
function late(operation, seq) {
  const payload = { synthetic: true }, requestId = "isolation-late-" + seq;
  return { type: CHANNEL_MESSAGE.REQUEST, requestId, seq, operation, payload,
    mac: signResponse(secret, { kind: SIGNED_MESSAGE_KIND.REQUEST_IN, requestId, seq, operation,
      payloadDigest: digestPayload(payload), body: null }) };
}
function crash() {
  if (mode === "unreturned-rejection") {
    // Deliberately neither returned nor caught. Strict rejection policy kills
    // only this synthetic worker, not the coordinator hosting the supervisor.
    void Promise.reject(new Error("synthetic unreturned rejection"));
    return;
  }
  class Hostile extends Promise {
    static get [Symbol.species]() {
      process.stderr.write("synthetic species getter invoked\n");
      throw new Error("synthetic hostile species");
    }
  }
  let reject, reads = 0;
  const promise = new Hostile((_, fail) => { reject = fail; });
  Object.defineProperty(promise, "then", { get() {
    if (++reads === 1) throw new Error("synthetic then getter");
    return Promise.prototype.then;
  } });
  const exchange = new SingleExchange({ role: "server", protocol: "history", deadlineNs: 2000n,
    now: () => 1000n, budget: new ExchangeBudget({ maxActive: 1, maxDispatches: 1 }),
    history: { context: {}, isCurrent: () => true, host: { queryHistory: () => promise, revokeContext() {} } } });
  exchange.append(fixture.request());
  try { exchange.observeHistory(); } catch { /* Expected synchronous refusal. */ }
  exchange.beginClosing(1100n); exchange.close("dispose");
  reject(new Error("synthetic species rejection"));
}
async function handle(message) {
  if (message.type === CHANNEL_MESSAGE.HELLO) {
    const body = { nonce: message.nonce };
    send({ type: CHANNEL_MESSAGE.RESPONSE, requestId: message.requestId, nonce: message.nonce, body,
      mac: signResponse(secret, { kind: SIGNED_MESSAGE_KIND.HELLO, requestId: message.requestId, operation: "hello", body }) });
  } else if (message.type === CHANNEL_MESSAGE.BYE) {
    if (mode === "ignore-bye") { send({ type: "isolation-bye-ignored" }); return; }
    process.exit(0);
  } else if (message.type === CHANNEL_MESSAGE.REQUEST && message.operation === "isolation.ready") {
    endpoint.answer(message, { loaded: true, mode, environment: evidence() });
  }
  else if (message.type === CHANNEL_MESSAGE.REQUEST && message.operation === "isolation.arm") {
    // Capture the actual accepted request, then replay its exact signed bytes
    // over the still-live inherited channel; no local emit or forged session.
    const originalSend = process.send;
    let accepted;
    process.send = function(frame, ...args) {
      if (frame.type === CHANNEL_MESSAGE.REQUEST && frame.operation === "isolation.probe") accepted = frame;
      return originalSend.call(process, frame, ...args);
    };
    let probe;
    try { probe = await endpoint.request("isolation.probe", { synthetic: true }, 5000); }
    finally { process.send = originalSend; }
    if (!probe || probe.accepted !== true) throw new Error("synthetic live-path probe refused");
    const replay = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { process.off("message", reply); reject(new Error("live replay timeout")); }, 5000);
      function reply(frame) {
        if (frame.type !== CHANNEL_MESSAGE.RESPONSE || frame.requestId !== accepted.requestId) return;
        clearTimeout(timer); process.off("message", reply);
        if (!verifyResponse(secret, { kind: SIGNED_MESSAGE_KIND.REQUEST_IN_RESPONSE,
          requestId: accepted.requestId, seq: accepted.seq, operation: accepted.operation,
          payloadDigest: digestPayload(accepted.payload), body: frame.body }, frame.mac)) {
          reject(new Error("live replay response signature mismatch")); return;
        }
        resolve(frame.body?.error);
      }
      process.on("message", reply); send(accepted);
    });
    if (readyFile) {
      // Deliberately seed the worker's ambient env with harmless test values,
      // then prove the descendant's explicit whitelist strips them as well.
      const saved = Object.fromEntries(["NODE_OPTIONS", "ISOLATION_FAKE_API_KEY", "ISOLATION_PRELOAD_DIR"].map(key => [key, process.env[key]]));
      let descendant;
      try {
        process.env.NODE_OPTIONS = "--require=" + JSON.stringify(preloadFile);
        process.env.ISOLATION_FAKE_API_KEY = "synthetic-not-a-real-key";
        process.env.ISOLATION_PRELOAD_DIR = path.dirname(readyFile);
        descendant = spawn(process.execPath, [path.join(__dirname, "permit-witness-isolation-descendant.js"), readyFile, stopFile, token],
          { detached: false, stdio: "ignore", env: environment(process.env.TMPDIR) });
      } finally {
        for (const [key, value] of Object.entries(saved)) {
          if (value === undefined) delete process.env[key]; else process.env[key] = value;
        }
      }
      descendant.on("error", () => process.exit(4));
      const deadline = Date.now() + 3000;
      while (!fs.existsSync(readyFile)) {
        if (Date.now() >= deadline) throw new Error("synthetic descendant startup timeout");
        await new Promise(resolve => setTimeout(resolve, 10));
      }
    }
    // Sequences exceed the accepted probe's seq=1, so replay rejection cannot
    // be mistaken for the closed-session barrier in the coordinator test.
    send({ type: "isolation-envelopes", frames: [late("isolation.write", 2), late("isolation.recover", 3)] });
    armed = true;
    endpoint.answer(message, { loaded: true, mode, environment: evidence(), liveReplayError: replay });
  } else if (message.type === "isolation-trigger" && armed) {
    armed = false; crash();
  }
}
process.on("message", message => {
  if (!endpoint) queued.push(message);
  else void handle(message);
});
process.on("disconnect", () => process.exit(0));
void readSessionSecret(process).then(value => {
  secret = value; endpoint = createExecutorEndpoint(process, secret);
  if (mode === "ignore-bye") setTimeout(() => process.exit(5), 15000);
  for (const message of queued.splice(0)) void handle(message);
}).catch(() => process.exit(2));
