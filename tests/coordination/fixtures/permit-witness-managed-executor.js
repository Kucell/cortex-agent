"use strict";

// Dedicated real-process fixture. Test control messages only cause the child
// to make authenticated inbound requests; they never call the witness directly.
const { readSessionSecret, createExecutorEndpoint } = require("../../../lib/governed/managed-caller-supervisor");
const { CHANNEL_MESSAGE, SIGNED_MESSAGE_KIND } = require("../../../lib/governed/managed-caller-session");
const { signResponse } = require("../../../lib/governed/managed-caller-signing");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const path = require("node:path");

const pidFile = process.argv.find(arg => arg.startsWith("--pid-file="));
if (pidFile) require("node:fs").writeFileSync(pidFile.slice("--pid-file=".length), String(process.pid));

const queued = [];
let secret, endpoint, holder;
function send(message) { if (process.connected) process.send(message, () => {}); }
async function handle(message) {
  if (message.type === CHANNEL_MESSAGE.HELLO) {
    if (process.argv.includes("--no-handshake")) return;
    const body = { nonce: message.nonce };
    send({ type: CHANNEL_MESSAGE.RESPONSE, requestId: message.requestId, nonce: message.nonce, body,
      mac: signResponse(secret, { kind: SIGNED_MESSAGE_KIND.HELLO, requestId: message.requestId,
        operation: "hello", body }) });
  } else if (message.type === CHANNEL_MESSAGE.BYE) {
    process.exit(0);
  } else if (message.type === "exercise") {
    try {
      const result = await endpoint.request(message.operation, message.payload, 20000);
      send({ type: "exercise-result", id: message.id, ok: true, result });
    } catch (error) {
      send({ type: "exercise-result", id: message.id, ok: false, error: error.message });
    }
  } else if (message.type === "forge") {
    send({ type: CHANNEL_MESSAGE.REQUEST, requestId: message.id, seq: 999,
      operation: message.operation, payload: message.payload, mac: "forged" });
    send({ type: "exercise-result", id: message.id, ok: true });
  } else if (message.type === "disconnect") {
    process.disconnect();
  } else if (message.type === "transfer") {
    // Only the transferable IPC descriptor goes to the descendant, never fd 4
    // or the session secret. stdin EOF ensures it exits if this child dies.
    holder = spawn(process.execPath, [path.join(__dirname, "permit-witness-managed-holder.js")], {
      stdio: ["pipe", "pipe", "pipe", 3],
    });
    holder.stderr.resume();
    await once(holder.stdout, "data");
    send({ type: "exercise-result", id: message.id, ok: true, pid: holder.pid });
  } else if (message.type === "release") {
    const exited = once(holder, "exit");
    holder.stdin.end();
    await exited;
    send({ type: "exercise-result", id: message.id, ok: true });
  }
}
process.on("message", message => {
  if (!endpoint) queued.push(message);
  else void handle(message);
});
process.on("disconnect", () => process.exit(0));
void readSessionSecret(process).then(value => {
  secret = value;
  endpoint = createExecutorEndpoint(process, secret);
  for (const message of queued.splice(0)) void handle(message);
}).catch(() => process.exit(2));
