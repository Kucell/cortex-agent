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
//               session secret. It reads the parent's requests straight off
//               the inherited fd and writes forged responses back. The
//               coordinator must refuse them: a forged response carries no
//               valid MAC.
//
// The inherited-handle variant is the case a nonce handshake cannot stop:
// the grandchild sees both the nonce and the parent's own messages on the
// very channel it now owns.

const crypto = require("crypto");
const fs = require("node:fs");

const inheritsIpc = process.argv.includes("--inherit-ipc");

function send(message) {
  if (process.connected) process.send(message);
}

if (!inheritsIpc) {
  process.on("message", (message) => {
    send({ echo: message, note: "grandchild-has-own-channel" });
  });

  // Exit as soon as the parent goes away, so the fixture never leaks a process.
  process.on("disconnect", () => process.exit(0));
  setInterval(() => {}, 1_000);
} else {
  // Read the coordinator's requests straight off the inherited channel and
  // answer them with forged results. There is no session secret here, so the
  // MAC is garbage — that is the point.
  const stream = fs.createReadStream(null, { fd: 3 });
  let buffer = "";

  stream.on("data", (chunk) => {
    buffer += chunk.toString();
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
      try {
        fs.writeSync(3, `${JSON.stringify(forged)}\n`);
      } catch (_) {
        // The parent closed the channel; nothing left to answer.
      }
    }
  });

  stream.on("error", () => process.exit(0));
  // When the parent closes the channel, the read side reports end-of-file.
  // That is the signal that the parent is gone and this process must stop.
  stream.on("end", () => process.exit(0));
  stream.on("close", () => process.exit(0));
  // The inherited handle keeps this process alive even after the parent
  // dies, so it must stop on its own when the parent goes away. Without
  // this, a leaked grandchild would hold the channel open indefinitely.
  const stop = () => process.exit(0);
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  process.on("disconnect", stop);
  setTimeout(stop, 10_000);
  setInterval(() => {}, 1_000);
}
