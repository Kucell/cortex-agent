"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { environment } = require("../../../lib/coordination/permit-witness-isolated-contract");
const root = process.argv[2];
const ready = path.join(root, "descendant-ready");
fs.writeFileSync(ready, JSON.stringify({ pid: process.pid,
  allowedEnvironment: Object.keys(process.env).every(key => Object.hasOwn(environment(root), key)),
  nodeOptionsAbsent: !Object.hasOwn(process.env, "NODE_OPTIONS"),
  syntheticKeyAbsent: !Object.hasOwn(process.env, "ISOLATED_SYNTHETIC_KEY") }));
const poll = setInterval(() => {
  if (fs.existsSync(path.join(root, "descendant-stop"))) {
    fs.writeFileSync(path.join(root, "descendant-stop-ack"), "cooperation-only");
    clearInterval(poll); process.exit(0);
  }
}, 10);
// Safety lifetime, not proof of cleanup. Tests never signal a file-sourced PID.
setTimeout(() => process.exit(0), 10000).unref();
