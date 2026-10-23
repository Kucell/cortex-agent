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
//   --mode=relay         hand the IPC handle to a grandchild, which replays the
//                        coordinator's own request back as an inbound request
//   --mode=exit-early    exit before the handshake completes
//   --mode=proxy         forward one inbound request back to the coordinator

const crypto = require("crypto");

const {
  CHANNEL_MESSAGE,
  SIGNED_MESSAGE_KIND,
} = require("../../../lib/governed/managed-caller-session");
const {
  signResponse,
  digestPayload,
} = require("../../../lib/governed/managed-caller-signing");
const {
  createExecutorEndpoint,
  readSessionSecret,
} = require("../../../lib/governed/managed-caller-supervisor");

const modeArg = process.argv.find((a) => a.startsWith("--mode="));
const mode = modeArg ? modeArg.slice("--mode=".length) : "echo";

const pending = new Map();
let seq = 0;
let secret = null;
// The descendant that holds the transferred IPC handle. It is created in the
// `relay` mode below; the message handler refers to it directly.
let relayGrandchild = null;
// Set by the `relay` mode below. The request handler calls it so the
// accomplice is started while the coordinator's request is in flight.
let relayStart = null;

/**
 * Write a frame straight onto the IPC socket.
 *
 * The coordinator's end of the socket is fd 3 in this process. Writing a raw
 * frame onto it produces exactly what a descendant that inherited the handle
 * produces: Node's IPC envelope, envelope and all.
 *
 * @param {object} payload The message body to deliver.
 */
function injectRawFrame(payload) {
  const frame = `${JSON.stringify({ type: "message", data: payload })}\n`;

  // The IPC socket is fd 3 in this process. Two ways to write to it, and the
  // platforms differ: `fs.writeSync` rejects a socket with EINVAL on Linux,
  // while `net.Socket({fd})` cannot be used here because adopting the
  // descriptor takes it away from the channel that is already bound to it.
  // The write is attempted both ways so the case holds on either platform.
  try {
    const fs = require("node:fs");
    fs.writeSync(3, frame);
    return;
  } catch (_) {
    // Fall through to the socket route.
  }

  try {
    const net = require("node:net");
    const socket = new net.Socket({ fd: 3 });
    socket.on("error", () => {});
    socket.write(frame);
  } catch (_) {
    // Best effort: a failure here only means the injection did not happen.
  }
}

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

  // A frame that was written straight onto the shared handle arrives with
  // Node's IPC envelope still attached. Unwrap it first, so the payload is
  // routed on its own terms.
  if (message.type === CHANNEL_MESSAGE.NODE_IPC_FRAME && message.data
      && typeof message.data === "object") {
    message = message.data;
  }

  if (message.type === "inject") {
    // Write a raw frame straight onto the IPC socket, the way a descendant
    // that inherited the handle does. The coordinator has to unwrap Node's
    // IPC envelope before it can route the payload, and then refuse the
    // payload because it carries no valid MAC.
    injectRawFrame(message.payload);
    return;
  }

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
    if (mode === "relay") {
      // In the relay case the executor is a conduit: whatever arrives on the
      // shared handle is passed up to the coordinator verbatim, which is what
      // a real compromised executor could do.
      // Hand the request to the descendant that holds the transferred handle,
      // so it can replay it as an inbound request. The descendant has no
      // session secret, which is the whole point of the case. The hand-off
      // happens FIRST, so the descendant's replay and forgery are already on
      // the wire by the time the coordinator sees the relayed request. That
      // ordering makes the case deterministic instead of a race between the
      // coordinator's answer and the attacker's.
      // Start the accomplice now, so the handle is transferred WHILE the
      // coordinator's request is in flight. The coordinator's pre-dispatch
      // audit already ran, so this transfer happens after it: the relayed
      // inbound request really reaches the coordinator and has to be refused
      // on authentication grounds rather than being blocked before dispatch.
      if (relayStart) relayStart();

      if (relayGrandchild) {
        try {
          relayGrandchild.stdin.write(`${JSON.stringify(message)}\n`);
        } catch (_) {
          // Best effort.
        }
      }
      send(message);
      return;
    }
    if (mode === "echo" || mode === "bad-seq" || mode === "no-response" || mode === "bad-mac"
        || mode === "transfer") {
      if (mode === "no-response") return;
      const replySeq = mode === "bad-seq" ? message.seq + 999 : message.seq;
      const body = { seq: replySeq, result: { handled: message.operation, seq } };
      const mac = mode === "bad-mac" || !secret
        ? crypto.randomBytes(32).toString("hex")
        : signResponse(secret, {
          kind: SIGNED_MESSAGE_KIND.REQUEST_OUT_RESPONSE,
          requestId: message.requestId,
          seq: message.seq,
          operation: message.operation,
          payloadDigest: digestPayload(message.payload),
          body,
        });
      respond(message.requestId, body, { seq: replySeq, mac });
    }
  }

  if (mode === "relay" && message.type === CHANNEL_MESSAGE.RESPONSE) {
    // A frame the descendant wrote onto the shared handle. The conduit passes
    // it up to the coordinator, which has to refuse it: the descendant holds
    // the transferable channel but not the session secret, so it cannot
    // produce a valid MAC.
    send(message);
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
  // Its stdout carries the count of forgeries it actually delivered, which
  // the coordinator's test uses to prove the attack really happened.
  let grandchildForgeries = 0;
  grandchild.stdout.on("data", (chunk) => {
    for (const line of chunk.toString().split("\n")) {
      if (!line.includes("grandchildForged")) continue;
      grandchildForgeries += 1;
      send({ type: "transfer-report", requestId: "transfer", body: { grandchildForgeries } });
    }
  });
  grandchild.stderr.on("data", () => {});
  grandchild.on("exit", () => {
    send({
      type: "transfer-report",
      requestId: "transfer",
      body: { grandchildExited: true, grandchildForgeries },
    });
  });

  setTimeout(() => {
    killGrandchild();
    process.exit(0);
  }, 8_000);
}

if (mode === "relay") {
  // The relay negative case. The grandchild holds the transferred handle and
  // replays the coordinator's own REQUEST back as an inbound request, with a
  // payload the attacker chose. A coordinator that answers inbound requests
  // without authenticating them signs that answer with its OWN key, which
  // lets the attacker feed the coordinator a response it never received from
  // the child it supervises.
  const { spawn } = require("node:child_process");
  const path = require("node:path");

  // The accomplice is started LAZILY, when the first request arrives, not
  // during startup. That ordering matters for what this case proves.
  //
  // A coordinator that audits the channel BEFORE dispatching refuses the
  // request outright when the handle was already transferred — which is the
  // right behaviour, but it means the request never reaches the wire and the
  // inbound-MAC path is never exercised. Starting the accomplice on the
  // first request makes the transfer happen DURING the round trip, so the
  // request is dispatched and the relayed inbound request really reaches the
  // coordinator, where it has to be refused on authentication grounds.
  const startGrandchild = () => {
    if (relayGrandchild) return relayGrandchild;
    const grandchild = spawn(process.execPath, [path.join(__dirname, "m044-ms002-relay.js")], {
      // stdin carries the request to replay, stdout is unused, stderr carries
      // the report, and fd 3 is the transferred IPC handle.
      stdio: ["pipe", "pipe", "pipe", 3],
    });
    relayGrandchild = grandchild;

    grandchild.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      for (const line of text.split("\n")) {
        const match = line.match(/\{.*\}/);
        if (!match) continue;
        try {
          send({ type: "relay-report", requestId: "relay", body: JSON.parse(match[0]) });
        } catch (_) {
          // Best effort.
        }
      }
    });
    grandchild.on("exit", () => {
      send({ type: "relay-report", requestId: "relay", body: { relayExited: true } });
    });

    return grandchild;
  };
  relayStart = startGrandchild;

  const killGrandchild = () => {
    if (!relayGrandchild) return;
    try {
      relayGrandchild.kill();
    } catch (_) {
      // Already gone.
    }
  };
  process.on("exit", killGrandchild);
  process.on("SIGTERM", () => {
    killGrandchild();
    process.exit(0);
  });
  process.on("SIGINT", () => {
    killGrandchild();
    process.exit(0);
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
