"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { CHANNEL_MESSAGE, SIGNED_MESSAGE_KIND } = require("../governed/managed-caller-session");
const { readSessionSecret, createExecutorEndpoint } = require("../governed/managed-caller-supervisor");
const { signResponse } = require("../governed/managed-caller-signing");

const ACTIONS = new Set(["issue", "register", "key", "verify", "revoke"]);
const USAGE = "Usage: cortex-agent permit <issue|register|key|verify|revoke> --input <json-file> [--output <file>] (managed session required)";

function parseArgs(args) {
  const action = args[1];
  if (!ACTIONS.has(action)) throw new Error("invalid arguments");
  const options = {};
  for (let i = 2; i < args.length; i += 2) {
    const key = args[i];
    if (!["--input", "--output"].includes(key) || options[key] !== undefined ||
        typeof args[i + 1] !== "string" || args[i + 1].startsWith("--")) throw new Error("invalid arguments");
    options[key] = args[i + 1];
  }
  if (!options["--input"] || (action === "issue") !== Boolean(options["--output"])) throw new Error("invalid arguments");
  return { action, input: options["--input"], output: options["--output"] };
}

function readInput(file) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  let raw;
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > 1024 * 1024) throw new Error("invalid input");
    raw = fs.readFileSync(fd, "utf8");
  } finally { fs.closeSync(fd); }
  if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(raw)) throw new Error("private material refused");
  const value = JSON.parse(raw);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid input");
  return value;
}

function writeIssue(fd, result) {
  if (!result || typeof result !== "object" || !result.signedPermit ||
      typeof result.fingerprint !== "string" || typeof result.publicKeyPem !== "string" ||
      /PRIVATE KEY|privateKeyRef/.test(JSON.stringify(result))) throw new Error("invalid result");
  fs.writeFileSync(fd, JSON.stringify(result) + "\n");
  fs.fsyncSync(fd);
}

function waitForSupervisorClose() {
  if (!process.connected) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, 30000);
    function done() {
      clearTimeout(timer);
      process.off("message", onMessage);
      process.off("disconnect", done);
      resolve();
    }
    function onMessage(message) {
      if (message && message.type === CHANNEL_MESSAGE.BYE) done();
    }
    process.on("message", onMessage);
    process.once("disconnect", done);
  });
}

async function permitManagedCli(ctx) {
  if (ctx.args.includes("--help") || ctx.args.includes("-h")) { console.log(USAGE); return; }
  let options;
  try { options = parseArgs(ctx.args); }
  catch { console.error("permit: invalid arguments"); process.exitCode = 2; return; }
  if (!process.channel || typeof process.send !== "function") {
    console.error("permit: managed session required"); process.exitCode = 3; return;
  }
  let secret;
  let endpoint;
  let outputFd;
  let started = false;
  const queued = [];
  const start = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("managed session timeout")), 30000);
    function handle(message) {
      if (!secret) {
        if (queued.length >= 32) { clearTimeout(timer); reject(new Error("managed session refused")); return; }
        queued.push(message);
        return;
      }
      if (!message || typeof message !== "object") return;
      if (message.type === CHANNEL_MESSAGE.HELLO) {
        const body = { nonce: message.nonce };
        process.send({ type: CHANNEL_MESSAGE.RESPONSE, requestId: message.requestId,
          sessionId: message.sessionId, nonce: message.nonce, body,
          mac: signResponse(secret, { kind: SIGNED_MESSAGE_KIND.HELLO, requestId: message.requestId,
            seq: message.seq, operation: "hello", body }) });
      } else if (!started && message.type === CHANNEL_MESSAGE.REQUEST && message.operation === "permit.start") {
        try { endpoint.answer(message, { ready: true }); }
        catch { clearTimeout(timer); reject(new Error("managed session refused")); return; }
        started = true;
        clearTimeout(timer);
        process.off("message", handle);
        resolve();
      }
    }
    process.on("message", handle);
    readSessionSecret(process).then((value) => {
      secret = value;
      endpoint = createExecutorEndpoint(process, secret);
      for (const message of queued.splice(0)) handle(message);
    }, () => { clearTimeout(timer); reject(new Error("managed session refused")); });
  });
  try {
    await start;
    const input = readInput(path.resolve(ctx.cwd, options.input));
    // Reserve the output before issuing so an existing destination cannot
    // cause a committed reservation whose result has nowhere to be written.
    if (options.action === "issue") {
      outputFd = fs.openSync(path.resolve(ctx.cwd, options.output), "wx", 0o600);
    }
    const result = await endpoint.request(`permit.${options.action}`, input);
    if (/PRIVATE KEY|privateKeyRef/.test(JSON.stringify(result))) throw new Error("private material refused");
    if (options.action === "issue") {
      writeIssue(outputFd, result);
      console.log(JSON.stringify({ ok: true, action: "issue", written: true }));
    } else {
      console.log(JSON.stringify({ ok: true, action: options.action, result }));
    }
  } catch {
    console.error("permit: managed operation rejected");
    process.exitCode = 3;
  } finally {
    if (outputFd !== undefined) fs.closeSync(outputFd);
    if (started && process.connected) {
      const close = waitForSupervisorClose();
      process.send({ type: "permit.result-ready" });
      await close;
    }
    if (process.connected) process.disconnect();
  }
}

module.exports = { permitManagedCli };
