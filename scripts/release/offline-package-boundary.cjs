"use strict";

// Fixture-only boundary. This supplements an isolated disposable executor.
// A caught denial still fails acceptance through the parent's audit ledger.
const fs = require("node:fs");
const crypto = require("node:crypto");
const child = require("node:child_process");
const configPath = process.env.CORTEX_PACK_BOUNDARY_CONFIG;
if (!configPath) throw new Error("PACK_BOUNDARY_CONFIG_REQUIRED");
const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function record(event) {
  fs.appendFileSync(config.audit, JSON.stringify({ pid: process.pid, ...event }) + "\n");
}
function deny(kind) {
  record({ kind, allowed: false });
  throw new Error("PACK_BOUNDARY_DENIED:" + kind);
}
function checkedRealpath(value, kind) {
  try { return fs.realpathSync(value); } catch (_) { return deny(kind); }
}
function checkedHash(file) {
  try { return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex"); }
  catch (_) { return deny("node-source-read"); }
}
function safeOptions(options) {
  const opts = options && typeof options === "object" ? options : {};
  if (opts.shell || opts.detached) deny("subprocess-options");
  if (checkedRealpath(opts.cwd || process.cwd(), "subprocess-cwd-read") !== config.cwd) deny("subprocess-cwd");
  for (const [key, value] of Object.entries(config.env)) {
    if (process.env[key] !== value) deny("mutated-env:" + key);
    if (opts.env && opts.env[key] !== value) deny("subprocess-env:" + key);
  }
}
if (checkedRealpath(process.cwd(), "entrypoint-cwd-read") !== config.cwd) deny("entrypoint-cwd");
function allowedCall(method, command, args, options) {
  safeOptions(options);
  if (command === config.node) {
    if (!Array.isArray(args)) deny("node-args");
    const [file, ...rest] = args;
    const rule = config.nodeCalls.find((entry) => entry.file === file && same(entry.args, rest));
    if (!rule) deny("node-call");
    const hash = checkedHash(file);
    if (!rule.sha256.includes(hash)) deny("node-source-hash");
  } else if (command === "git") {
    if (!config.gitArgs.some((entry) => same(entry, args))) deny("git-call");
  } else if (command === "mmx") {
    if (!same(args, ["--version"]) && !same(args, ["--help"])) deny("mmx-call");
  } else {
    deny("subprocess-command");
  }
  record({ kind: method, allowed: true, command, args });
}
for (const method of ["spawn", "spawnSync", "execFile", "execFileSync"]) {
  const original = child[method];
  child[method] = function(command, args, options, ...rest) {
    allowedCall(method, command, args, options);
    return original.call(this, command, args, options, ...rest);
  };
}
const execSync = child.execSync;
child.execSync = function(command, options) {
  safeOptions(options);
  if (!config.shellCommands.includes(command)) deny("shell-command");
  record({ kind: "execSync", allowed: true, command });
  return execSync.call(this, command, options);
};
child.exec = () => deny("exec");
child.fork = () => deny("fork");
for (const [name, methods] of [
  ["node:http", ["request", "get", "createServer"]],
  ["node:https", ["request", "get", "createServer"]],
  ["node:http2", ["connect", "createServer", "createSecureServer"]],
  ["node:tls", ["connect", "createServer"]],
  ["node:net", ["connect", "createConnection", "createServer"]],
  ["node:dgram", ["createSocket"]],
]) {
  const api = require(name);
  for (const method of methods) api[method] = () => deny(name + "." + method);
}
require("node:net").Socket.prototype.connect = () => deny("net.Socket.connect");
for (const [label, api] of [["dns", require("node:dns")], ["dns.promises", require("node:dns").promises]]) {
  for (const method of Object.keys(api).filter((name) => /^(lookup|resolve|reverse)/.test(name))) {
    if (typeof api[method] === "function") api[method] = () => deny(label + "." + method);
  }
  if (typeof api.Resolver === "function") {
    const prototype = api.Resolver.prototype;
    for (const method of Object.getOwnPropertyNames(prototype).filter((name) => /^(lookup|resolve|reverse)/.test(name))) {
      if (typeof prototype[method] === "function") prototype[method] = () => deny(label + ".Resolver." + method);
    }
  }
}
globalThis.fetch = () => deny("fetch");
globalThis.WebSocket = class { constructor() { deny("WebSocket"); } };
require("node:worker_threads").Worker = class { constructor() { deny("Worker"); } };
