"use strict";

// Test fixture grandchild for M-044 / MS-002.
//
// Two variants, driven by argv:
//
//   (default)   It has its own `ipc` stdio, which is a DIFFERENT socket from
//               the parent's. It cannot read the parent's requests and
//               therefore cannot answer them.
//
//   --inherit-ipc
//               The parent deliberately handed its IPC handle over. This
//               process now holds the transferable channel but NOT the
//               session secret. It writes forged responses onto that channel.
//               The coordinator must refuse them: a forged response carries
//               no valid MAC.
//
// The inherited-handle variant is the case a nonce handshake cannot stop:
// the grandchild sees both the nonce and the parent's own messages on the
// very channel it now owns.
//
// Platform note: on Linux the inherited descriptor is the write end of a
// bidirectional socket, so the descendant can inject into the coordinator's
// channel but cannot read the coordinator's requests back (the read fails
// with EAGAIN). On macOS the descriptor is readable and requests come back.
// The fixture therefore does BOTH — it answers any request it can read, and
// it keeps injecting blind forgeries the coordinator never asked for. A
// coordinator that only defends against solicited responses would pass the
// blind case on Linux and fail it on macOS; both must be rejected.
//
// The channel is adopted with `net.Socket`. Neither `fs.createReadStream`
// (libuv aborts with `uv__io_poll: Assertion errno == EEXIST failed` when it
// is handed a socket) nor `fs.writeSync` (rejects a socket with EINVAL on
// Linux) works on an already-open socket descriptor.

const crypto = require("crypto");
const fs = require("node:fs");
const net = require("node:net");

const inheritsIpc = process.argv.includes("--inherit-ipc");

function send(message) {
  if (process.connected) process.send(message);
}

/**
 * Write a message onto the inherited channel in Node's own IPC wire format.
 *
 * A raw JSON object is not enough: Node frames every channel message as
 * `{"type":"message","data":<payload>}` and separates the frames with a
 * newline. A descendant that writes anything else is silently ignored by the
 * coordinator, which would make this fixture prove nothing.
 *
 * @param {object} payload The message body.
 * @param {net.Socket} channel The adopted channel.
 */
function writeToChannel(payload, channel) {
  if (!channel || channel.destroyed) return false;
  try {
    channel.write(`${JSON.stringify({ type: "message", data: payload })}\n`);
    return true;
  } catch (_) {
    return false;
  }
}

if (!inheritsIpc) {
  process.on("message", (message) => {
    send({ echo: message, note: "grandchild-has-own-channel" });
  });

  // Exit as soon as the parent goes away, so the fixture never leaks a process.
  process.on("disconnect", () => process.exit(0));
  setInterval(() => {}, 1_000);
} else {
  // There is no session secret here, so any response this process writes
  // carries a garbage MAC — that is the point.
  let buffer = "";

  // Adopt the inherited descriptor as a socket. Neither a read stream nor a
  // raw fd read works on it: libuv aborts when handed a socket to poll, and
  // on Linux the descriptor is non-blocking so a raw read returns EAGAIN.
  const channel = new net.Socket({ fd: 3 });
  channel.on("error", () => {});
  channel.on("data", (chunk) => {
    buffer += chunk.toString();
    handleLines();
  });

  const handleLines = () => {
    let index;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      let message;
      try {
        message = JSON.parse(line);
      } catch (_) {
        continue;
      }
      if (!message || message.type !== "request") continue;

      const forged = {
        type: "response",
        requestId: message.requestId,
        sessionId: message.sessionId,
        seq: message.seq,
        body: { seq: message.seq, result: { handled: "forged", FORGED: true } },
        mac: crypto.randomBytes(32).toString("hex"),
      };
      writeToChannel(forged, channel);
    }
  };

  /** Inject a forgery the coordinator never asked for. */
  const injectBlindForgery = () => {
    const forged = {
      type: "response",
      requestId: `blind-${process.pid}`,
      seq: 1,
      body: { seq: 1, result: { handled: "forged", FORGED: true } },
      mac: crypto.randomBytes(32).toString("hex"),
    };
    if (!writeToChannel(forged, channel)) return;
    // Report the attempt on stdout. The executor forwards this so the test
    // can prove the forgery really travelled, rather than inferring it from
    // a rejection that might have been caused by the forgery never arriving.
    try {
      fs.writeSync(1, `${JSON.stringify({ grandchildForged: true })}\n`);
    } catch (_) {
      // Reporting is best-effort.
    }
  };

  // A read error must not end the process: on Linux the inherited descriptor
  // reports EAGAIN, and the fixture still has to keep injecting blind
  // forgeries. The process stops on the parent going away instead.
  // The inherited handle keeps this process alive even after the parent
  // dies, so it must stop on its own when the parent goes away. Without
  // this, a leaked grandchild would hold the channel open indefinitely.
  const stop = () => process.exit(0);
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  process.on("disconnect", stop);
  setTimeout(stop, 10_000);
  // Keep injecting blind forgeries: the coordinator must reject every one of
  // them, whether or not it happens to be expecting an answer at that moment.
  const blindTimer = setInterval(injectBlindForgery, 200);
  process.on("exit", () => clearInterval(blindTimer));
  setInterval(() => {}, 1_000);
}
