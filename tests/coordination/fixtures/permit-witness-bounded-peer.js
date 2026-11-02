"use strict";

// Real cross-process peer, deliberately NOT a managed/authenticated launcher.
// No Node IPC descriptor; only trusted ASCII harness control on stdin/stdout.
const net = require("node:net");
const mode = process.argv[2];
let peer, received = [], size = 0;
function note(value) { process.stdout.write(value + "\n"); }
function frame(bytes) { const b = Buffer.alloc(4 + bytes.length); b.writeUInt32BE(bytes.length); bytes.copy(b, 4); return b; }
const packet = frame(Buffer.from("opaque"));
const server = net.createServer({ allowHalfOpen: true }, socket => {
  peer = socket; socket.on("error", () => {}); note("CONNECTED");
  if (mode === "early-eof") {
    socket.pause();
    socket.on("data", data => {
      received.push(data); size += data.length;
      if (size > 1048580) { socket.destroy(); return; }
      if (size === 1048580) {
        const bytes = Buffer.concat(received, size);
        note(bytes.readUInt32BE(0) === 1048576 && bytes.subarray(4).every(byte => byte === 7) ? "FRAME_OK" : "FRAME_BAD");
      }
    });
    socket.on("end", () => note("INPUT_EOF"));
    return;
  }
  if (mode === "echo" || mode === "sink") {
    if (mode === "sink") socket.pause();
    socket.on("data", data => { received.push(data); size += data.length; if (size > 1048580) socket.destroy(); });
    socket.on("end", () => {
      if (mode === "echo") socket.end(Buffer.concat(received, size));
      else socket.end(frame(Buffer.from("ack")));
    });
    return;
  }
  if (mode === "valid") socket.end(packet);
  if (mode === "drip") {
    // Drip the frame one byte at a time so the receiver keeps making progress
    // for the whole window without ever completing the frame. A deadline that
    // is extended by progress would never fire here; an absolute deadline has
    // to end the channel at the original instant.
    let sent = 0;
    const timer = setInterval(() => {
      if (sent >= packet.length || socket.destroyed) { clearInterval(timer); return; }
      socket.write(packet.subarray(sent, sent + 1));
      sent++;
    }, 20);
    socket.on("close", () => clearInterval(timer));
  }
  if (mode === "oversize") { const b = Buffer.alloc(4); b.writeUInt32BE(0xffffffff); socket.end(b); }
  if (mode === "zero") socket.end(Buffer.alloc(4));
  if (mode === "truncated-header") socket.end(packet.subarray(0, 2));
  if (mode === "truncated-body") socket.end(packet.subarray(0, 6));
  if (mode === "trailing") socket.end(Buffer.concat([packet, Buffer.from([0])]));
  if (["no-eof", "late-tail"].includes(mode)) socket.write(packet);
  if (mode === "deep-raw") socket.end(frame(Buffer.from("[".repeat(12000) + "0" + "]".repeat(12000))));
  if (mode === "node-ipc-json") socket.end(Buffer.from('{"type":"message","data":' + "[".repeat(12000) + "0" + "]".repeat(12000) + '}\n'));
  if (mode === "reset") socket.resetAndDestroy();
  if (mode === "flood") {
    const chunk = Buffer.alloc(16384, 0xff);
    function push() {
      for (let i = 0; i < 64 && !socket.destroyed; i++) if (!socket.write(chunk)) { socket.once("drain", push); return; }
    }
    push();
  }
});
server.on("error", error => { console.error(error.code); process.exitCode = 1; });
server.listen(0, "127.0.0.1", () => note("READY " + server.address().port + " " + (!process.send && !process.env.NODE_CHANNEL_FD ? "NOIPC" : "UNSAFE")));
let control = "";
process.stdin.on("data", chunk => {
  control += chunk.toString("ascii");
  if (control.length > 128) process.exit(2);
  let end;
  while ((end = control.indexOf("\n")) >= 0) {
    const command = control.slice(0, end); control = control.slice(end + 1);
    if (command === "stop") { if (peer) peer.destroy(); server.close(() => process.exit(0)); }
    else if (peer) {
      if (command === "header-a") peer.write(packet.subarray(0, 2));
      if (command === "header-b") peer.write(packet.subarray(2, 4));
      if (command === "body-a") peer.write(packet.subarray(4, 6));
      if (command === "body-b") peer.write(packet.subarray(6));
      if (command === "tail") peer.write(Buffer.from([1]));
      if (command === "eof") peer.end();
      if (command === "early-eof" && mode === "early-eof") peer.end(frame(Buffer.from("ack")), () => note("OUTPUT_EOF"));
      if (command === "drain") { note("DRAINING"); peer.resume(); }
    }
  }
});
process.stdin.on("end", () => { if (peer) peer.destroy(); server.close(() => process.exit(0)); });
setTimeout(() => process.exit(3), 15000).unref();
