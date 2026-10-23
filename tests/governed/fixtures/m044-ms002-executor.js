"use strict";

// Test fixture executor for M-044 / MS-002.
//
// This is the CHILD side. The coordinator (the parent) drives the batch: it
// sends REQUEST messages, and this fixture answers with MAC-signed RESPONSE
// messages. The session secret arrives on the dedicated secret pipe (fd 4),
// never on the IPC channel.
//
// Behaviour is driven by argv so one fixture can serve several negative
// cases: the coordinator can ask it to misbehave in a specific way and the
// test asserts the coordinator refuses it.
//
//   --mode=echo          respond to every request with the same payload
//   --mode=bad-nonce     answer the handshake with a wrong nonce
//   --mode=no-handshake  never answer the handshake
//   --mode=bad-seq       answer a request with the wrong sequence number
//   --mode=no-response   answer the handshake but never answer requests
//   --mode=bad-mac       answer with a MAC that was not computed with the secret
//   --mode=transfer      hand the IPC handle to a grandchild, which forges a reply
//   --mode=exit-early    exit before the handshake completes
//   --mode=proxy         forward one inbound request back to the coordinator

const crypto = require("crypto");

const {
  CHANNEL_MESSAGE,
  SIGNED_MESSAGE_KIND,
} = require("../../../lib/governed/managed-caller-session");
const { signResponse } = require("../../../lib/governed/managed-caller-signing");
const {
  createExecutorEndpoint,
  readSessionSecret,
} = require("../../../lib/governed/managed-caller-supervisor");

const modeArg = process.argv.find((a) => a.startsWith("--mode="));
const mode = modeArg ? modeArg.slice("--mode=".length) : "echo";

const pending = new Map();
let seq = 0;
let secret = null;

function send(message) {
  if (process.connected) process.send(message);
}

function respond(requestId, body, extra) {
  send({ type: CHANNEL_MESSAGE.RESPONSE, requestId, body, ...(extra || {}) });
}

// The secret arrives on its own pipe, never on the IPC channel.
//
// The message listener is attached immediately and messages are queued until
// the secret lands, because a HELLO can arrive before the pipe has been read.
// Dropping it would make the fixture flaky for reasons that have nothing to
// do with what these tests are checking.
const queued = [];
let ready = false;

function handleMessage(message) {
  if (!message || typeof message !== "object") return;

  if (message.type === CHANNEL_MESSAGE.HELLO) {
    if (mode === "no-handshake") return;
    if (mode === "exit-early") {
      process.exit(3);
      return;
    }
    const nonce = mode === "bad-nonce" ? crypto.randomBytes(32).toString("hex") : message.nonce;
    const body = { nonce };
    const mac = secret
      ? signResponse(secret, {
        kind: SIGNED_MESSAGE_KIND.HELLO,
        requestId: message.requestId,
        seq: message.seq,
        operation: "hello",
        body,
      })
      : crypto.randomBytes(32).toString("hex");
    respond(message.requestId, body, { nonce, mac });
    return;
  }

  if (message.type === CHANNEL_MESSAGE.REQUEST) {
    seq += 1;
    pending.set(message.requestId, message);
    if (mode === "echo" || mode === "bad-seq" || mode === "no-response" || mode === "bad-mac") {
      if (mode === "no-response") return;
      const replySeq = mode === "bad-seq" ? message.seq + 999 : message.seq;
      const body = { seq: replySeq, result: { handled: message.operation, seq } };
      const mac = mode === "bad-mac" || !secret
        ? crypto.randomBytes(32).toString("hex")
        : signResponse(secret, {
          kind: SIGNED_MESSAGE_KIND.REQUEST,
          requestId: message.requestId,
          seq: message.seq,
          operation: message.operation,
          body,
        });
      respond(message.requestId, body, { seq: replySeq, mac });
    }
  }
}

process.on("message", (message) => {
  if (!ready) {
    queued.push(message);
    return;
  }
  handleMessage(message);
});

readSessionSecret(process)
  .then((value) => {
    secret = value;
  })
  .catch(() => {
    // Without the secret the fixture can still misbehave on purpose; that is
    // exactly what the negative modes need.
    secret = null;
  })
  .then(() => {
    ready = true;
    while (queued.length) handleMessage(queued.shift());
  });

if (mode === "proxy") {
  // The coordinator asks the child to make a request of its own; the child
  // forwards it verbatim, so the coordinator can observe how an out-of-batch
  // operation is refused by the supervisor's own scope check.
  let endpoint = null;
  const proxyHandler = async (message) => {
    if (!message || message.type !== "proxy") return;
    // The endpoint is built lazily: the secret must be in hand before the
    // child signs anything.
    if (!endpoint) endpoint = createExecutorEndpoint(process, secret || "missing-secret");
    try {
      const result = await endpoint.request(message.operation, message.payload, 3_000);
      send({ type: "proxy-result", requestId: message.requestId, ok: true, result });
    } catch (error) {
      send({ type: "proxy-result", requestId: message.requestId, ok: false, error: String(error.message || error) });
    }
  };
  process.on("message", async (message) => {
    if (!message || message.type !== "proxy") return;
    await proxyHandler(message);
  });
}

if (mode === "transfer") {
  // The decisive negative case: the child deliberately hands its IPC handle
  // to a grandchild. The grandchild holds the transferable channel but NOT
  // the session secret, so it cannot produce a valid MAC. The coordinator
  // must reject the forged response and detect the transfer.
  const { spawn } = require("node:child_process");
  const path = require("node:path");
  const grandchild = spawn(process.execPath, [path.join(__dirname, "m044-ms002-grandchild.js"), "--inherit-ipc"], {
    stdio: ["ignore", "pipe", "pipe", 3],
  });

  const killGrandchild = () => {
    try {
      grandchild.kill();
    } catch (_) {
      // Already gone.
    }
  };
  // The grandchild holds the inherited IPC handle, so it survives a plain
  // `kill` of this process unless it is stopped explicitly. A leaked
  // grandchild would keep the channel open after the test ends.
  const shutdown = () => {
    killGrandchild();
    process.exit(0);
  };
  process.on("exit", killGrandchild);
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
  process.on("disconnect", shutdown);

  // The grandchild holds the inherited IPC handle, not its own `ipc` stdio,
  // so it cannot report back over a Node channel. Its forged responses
  // arrive on the coordinator's channel directly, which is the point.
  grandchild.stderr.on("data", () => {});
  grandchild.on("exit", () => {
    send({ type: "transfer-report", requestId: "transfer", body: { grandchildExited: true } });
  });

  setTimeout(() => {
    killGrandchild();
    process.exit(0);
  }, 8_000);
}

if (mode === "inherit") {
  // Negative case: spawn a grandchild with the ordinary default stdio, so it
  // inherits nothing of ours. It must not be able to answer on our channel.
  const { spawn } = require("node:child_process");
  const path = require("node:path");
  const grandchild = spawn(process.execPath, [path.join(__dirname, "m044-ms002-grandchild.js")], {
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  const killGrandchild = () => {
    try {
      grandchild.kill();
    } catch (_) {
      // Already gone.
    }
  };
  process.on("exit", killGrandchild);
  process.on("SIGTERM", () => {
    killGrandchild();
    process.exit(0);
  });
  grandchild.on("message", (m) => {
    send({ type: CHANNEL_MESSAGE.RESPONSE, requestId: "probe", body: { grandchild: m } });
  });
  setTimeout(() => {
    killGrandchild();
    process.exit(0);
  }, 5_000);
}

// Keep the event loop alive so the supervisor can talk to us.
setInterval(() => {}, 1_000);
