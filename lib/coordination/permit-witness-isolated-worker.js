"use strict";

// Fixed, one-shot worker for the offline development adapter. The provider is
// loaded ONLY here, AFTER the real managed handshake and signed query. It has
// the same OS account's powers: this file cannot confine hostile module code.
const { readSessionSecret, createExecutorEndpoint, openExecutorTransport } = require("../governed/managed-caller-supervisor");
const { CHANNEL_MESSAGE, SIGNED_MESSAGE_KIND } = require("../governed/managed-caller-session");
const { signResponse, verifyResponse, digestPayload } = require("../governed/managed-caller-signing");
const contract = require("./permit-witness-isolated-contract");
const wire = require("./permit-witness-v2-history-wire");
const providerPath = process.argv[2];
let transport = process;
let secret, endpoint, lastSeq = 0, ready = false, used = false;
const queue = [];
function send(message) { if (transport.connected) transport.send(message, () => {}); }
async function handle(message) {
  if (message.type === CHANNEL_MESSAGE.HELLO) {
    const body = { nonce: message.nonce };
    send({ type: CHANNEL_MESSAGE.RESPONSE, requestId: message.requestId, nonce: message.nonce, body,
      mac: signResponse(secret, { kind: SIGNED_MESSAGE_KIND.HELLO, requestId: message.requestId, operation: "hello", body }) });
    return;
  }
  if (message.type === CHANNEL_MESSAGE.BYE) { process.exit(0); return; }
  // Validate BEFORE provider loading/execution, not merely in endpoint.answer
  // afterwards. Reuse the existing managed signing primitive and endpoint.
  if (message.type !== CHANNEL_MESSAGE.REQUEST || !Number.isSafeInteger(message.seq) || message.seq <= lastSeq ||
      typeof message.requestId !== "string" || message.payloadDigest !== digestPayload(message.payload) ||
      !verifyResponse(secret, { kind: SIGNED_MESSAGE_KIND.REQUEST_OUT, requestId: message.requestId,
        seq: message.seq, operation: message.operation, payloadDigest: message.payloadDigest, body: null }, message.mac)) {
    throw new Error("isolated invalid managed request");
  }
  lastSeq = message.seq;
  if (message.operation === contract.OPERATIONS.ready && !ready && !used) {
    contract.exact(message.payload, []);
    ready = true;
    endpoint.answer(message, { ready: true });
    return;
  }
  if (message.operation !== contract.OPERATIONS.query || !ready || used) throw new Error("isolated action refused");
  used = true;
  contract.exact(message.payload, ["request"]);
  const bytes = contract.request(contract.base64(message.payload.request));
  const query = wire.toHostRequest(bytes).query;
  const provider = require(providerPath);
  if (typeof provider !== "function") throw new TypeError("isolated provider must be a function");
  // Species/getter/unreturned rejections are deliberately confined to this
  // process, using strict rejection mode. No arbitrary thenable crosses IPC.
  const outcome = await provider(query);
  const response = contract.frame(wire.encodeResponse(bytes, outcome));
  endpoint.answer(message, { response: response.toString("base64") });
}
function attachMessages() {
transport.on("message", message => {
  if (!endpoint) queue.push(message);
  else void handle(message); // Strict-mode failure terminates this worker.
});
transport.on("disconnect", () => process.exit(0));
}
if (process.platform !== "win32") attachMessages();
void readSessionSecret(process).then(async value => {
  if (process.platform === "win32") {
    transport = await openExecutorTransport(process);
    attachMessages();
  }
  secret = value; endpoint = createExecutorEndpoint(transport, secret);
  for (const message of queue.splice(0)) void handle(message);
});
