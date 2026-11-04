"use strict";

// Synthetic buffers only. The EOF barrier forces the parent to fail closed
// before the child can finish its stack unwinding and write the final proof.
const fs = require("node:fs"), path = require("node:path");
const { acceptBoundedSession } = require("../../../lib/coordination/permit-witness-bounded-session");
const mode = process.argv[4];
const from = Buffer.from, alloc = Buffer.alloc, open = fs.openSync, close = fs.closeSync;
const secrets = [], wait = new Int32Array(new SharedArrayBuffer(4));
let responseFd, observed = false;
Buffer.from = function (bytes, ...args) {
  if (Buffer.isBuffer(bytes) && bytes.length === 16 && mode === "copy") throw new Error("injected session copy failure");
  const result = from(bytes, ...args);
  if (Buffer.isBuffer(bytes) && [16, 32].includes(bytes.length)) secrets.push(result);
  return result;
};
Buffer.alloc = function (length, ...args) {
  const bytes = alloc(length, ...args);
  if (length === 56) secrets.push(bytes);
  return bytes;
};
fs.openSync = function (file, ...args) {
  const fd = open(file, ...args);
  if (path.basename(file) === "responses") responseFd = fd;
  return fd;
};
fs.closeSync = function (fd) {
  if (fd !== responseFd || observed) return close(fd);
  observed = true;
  fs.writeFileSync("cleanup-at-eof.json", JSON.stringify({ copies: secrets.length,
    cleared: secrets.length > 1 && secrets.every(bytes => bytes.every(byte => byte === 0)) }));
  close(fd);
  // A local finite watchdog prevents a broken test from leaving a live child.
  // Parent release is a causal barrier, not a probabilistic sleep/delay.
  const until = process.hrtime.bigint() + 2000000000n;
  while (!fs.existsSync("release-cleanup")) {
    if (process.hrtime.bigint() >= until) throw new Error("missing parent release");
    Atomics.wait(wait, 0, 0, 2);
  }
};
async function run() {
  let rejected = false;
  try {
    const session = await acceptBoundedSession({ maxPayloadBytes: Number(process.argv[2]), maxFrames: Number(process.argv[3]),
      allowedOperations: mode === "established" ? [1] : [0], handler: () => alloc(0) });
    if (mode === "established") {
      await session.ready;
      const until = process.hrtime.bigint() + 2000000000n;
      while (!fs.existsSync("abort-session")) {
        if (process.hrtime.bigint() >= until) throw new Error("missing abort trigger");
        await new Promise(resolve => setTimeout(resolve, 2));
      }
      session.abort(); await session.closed;
    }
  } catch { rejected = true; }
  finally { Buffer.from = from; Buffer.alloc = alloc; fs.openSync = open; fs.closeSync = close; }
  fs.writeFileSync("key-cleanup.json", JSON.stringify({ rejected, copies: secrets.length,
    cleared: secrets.length > 1 && secrets.every(bytes => bytes.every(byte => byte === 0)) }));
}
void run().catch(() => { process.exitCode = 1; });
