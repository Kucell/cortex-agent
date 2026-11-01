"use strict";

// No IPC or session-secret descriptor is inherited. This synthetic descendant
// demonstrates that a direct worker exit does not prove process-tree exit.
const fs = require("node:fs");
const { evidence } = require("./permit-witness-isolation-env");
const [readyFile, stopFile, token] = process.argv.slice(2);
fs.writeFileSync(readyFile, JSON.stringify({ pid: process.pid, token, environment: evidence() }));
const poll = setInterval(() => {
  if (fs.existsSync(stopFile) && fs.readFileSync(stopFile, "utf8") === token) {
    clearInterval(poll);
    fs.writeFileSync(stopFile + ".ack", JSON.stringify({ token, cooperativeStopObserved: true }));
    process.exit(0);
  }
}, 20);
setTimeout(() => {
  fs.writeFileSync(stopFile + ".timeout", JSON.stringify({ token, fallbackTimeout: true }));
  process.exit(3);
}, 15000); // Fixture fallback, not proof of arbitrary descendant cleanup.
