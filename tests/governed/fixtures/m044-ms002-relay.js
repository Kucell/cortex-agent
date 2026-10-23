"use strict";

// Test fixture: the relay attacker (M-044 / MS-002).
//
// It is spawned by the supervised child with a *transferred* copy of the IPC
// handle. It has NO session secret: it holds the transferable channel and
// nothing else, which is exactly what a descendant that inherited the handle
// looks like.
//
// It replays the coordinator's own REQUEST back as an inbound REQUEST, with
// a payload it chose itself, and it forges answers to that request.
//
// The attack works only if the coordinator answers inbound requests without
// authenticating them: it would sign the answer with its own key, and the
// relay could feed that signed answer straight back into the coordinator's
// pending request. The coordinator would then accept a response that its
// supervised child never sent, computed from an attacker-chosen payload.
//
// The second half of the attack is the response half: whatever the
// coordinator sends back — including a signed answer to the replayed inbound
// request — is written straight back onto the channel as if the supervised
// child had produced it. On the pre-fix coordinator that answer carried a
// valid MAC, so the coordinator accepted its own answer as the child's.
//
// This fixture reports what it did on stderr, so the test can prove the
// attack really reached the coordinator rather than merely timing out.

/**
 * Write a frame onto the inherited channel.
 *
 * The descriptor is written with `fs.writeSync`, which works on macOS. On
 * Linux the same call is rejected with EINVAL for a socket, so the socket
 * route is used there.
 *
 * The descriptor is deliberately NOT adopted with `net.Socket` for reading:
 * mixing a libuv-owned socket with a raw write on the same descriptor makes
 * the writes flaky, and the attack must be deterministic for the case to mean
 * anything. The request to relay arrives over stdin instead, which works the
 * same on both platforms.
 *
 * @param {object} payload The message body to deliver.
 */
function writeFrame(payload) {
  const frame = `${JSON.stringify({ type: "message", data: payload })}\n`;
  try {
    require("node:fs").writeSync(3, frame);
    return true;
  } catch (_) {
    // Fall through to the socket route.
  }
  try {
    const net = require("node:net");
    const socket = new net.Socket({ fd: 3 });
    socket.on("error", () => {});
    socket.write(frame);
    return true;
  } catch (_) {
    return false;
  }
}

let relayed = 0;

// The request to relay arrives over stdin. On Linux the inherited descriptor
// is write-only, so the request cannot be read back off the channel; the
// parent passes it over stdin instead, which works on both platforms.
let stdinBuffer = "";
process.stdin.on("data", (chunk) => {
  stdinBuffer += chunk.toString();
  let index;
  while ((index = stdinBuffer.indexOf("\n")) >= 0) {
    const line = stdinBuffer.slice(0, index);
    stdinBuffer = stdinBuffer.slice(index + 1);
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed && parsed.type === "request") {
        attack(parsed);
      }
    } catch (_) {
      // Best effort.
    }
  }
});

/**
 * Replay the relayed request as an inbound request with an attacker-chosen
 * payload, and forge an answer to it.
 *
 * The replayed message keeps the coordinator's own request id, sequence and
 * operation, so it looks exactly like a request the supervised child sent.
 * Its MAC is the coordinator's own REQUEST_OUT signature, which is why the
 * direction has to be part of the signed kind: a coordinator that accepted
 * it would run the attacker's payload and sign the answer with its own key.
 */
function attack(request) {
  if (!request) return;

  relayed += 1;

  writeFrame({
    type: "request",
    requestId: request.requestId,
    sessionId: request.sessionId,
    seq: request.seq,
    operation: request.operation,
    payload: { attackerControlled: true, target: "/etc/shadow" },
    mac: request.mac || null,
  });

  // A forged answer to the coordinator's pending request. It carries a MAC
  // this process cannot compute — it has no secret — so it must be refused.
  // The two writes are separated: writing twice to the same descriptor in
  // the same tick loses the second frame on some platforms, and a case that
  // drops half its attack proves nothing.
  setTimeout(() => {
    writeFrame({
      type: "response",
      requestId: request.requestId,
      sessionId: request.sessionId,
      seq: request.seq,
      body: { seq: request.seq, result: { handled: "forged", FORGED: true } },
      mac: require("node:crypto").randomBytes(32).toString("hex"),
    });
  }, 30);

  try {
    process.stderr.write(`${JSON.stringify({ relayed, requestId: request.requestId })}\n`);
  } catch (_) {
    // Best effort.
  }
}

process.on("SIGTERM", () => process.exit(0));
process.on("SIGINT", () => process.exit(0));
setTimeout(() => process.exit(0), 9_000);
setInterval(() => {}, 1_000);
