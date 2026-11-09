"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { once } = require("node:events");
const { createInterface } = require("node:readline");
const { spawn, spawnSync } = require("node:child_process");
const { permitBridgeServiceCli, readConfig } = require("../../lib/commands/permit-bridge-service-cli");
const { ProtectedPermitStore } = require("../../lib/coordination/protected-permit-store");

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "permit-serve-cli-"));
  const configPath = path.join(root, "service.json");
  fs.mkdirSync(path.join(root, "db"), { mode: 0o700 });
  fs.mkdirSync(path.join(root, "anchor"), { mode: 0o700 });
  const config = {
    storePath: path.join(root, "db", "store.sqlite"),
    anchorDir: path.join(root, "anchor"),
    controlledAncestorPath: root,
    decisionId: "decision-1",
    serviceIdentity: "service-1",
    leaseTtlMs: 60_000,
    permitTtlMs: 5_000,
    // The ticket window stays inside the approved bound. The bridge refuses a
    // configuration that asks for a longer one, so the fixture has to live
    // within the bound rather than around it.
    ticketTtlMs: 2_000,
    port: 0,
  };
  return {
    root,
    configPath,
    config,
    write(value = config) {
      fs.writeFileSync(configPath, JSON.stringify(value));
      return configPath;
    },
    cleanup() { fs.rmSync(root, { recursive: true, force: true }); },
  };
}

test("permit-bridge serve pins strict existing-store and loopback options", () => {
  const f = fixture();
  try {
    const result = readConfig(f.write());
    assert.equal(result.storePath, f.config.storePath);
    assert.equal(result.expectedDecisionId, undefined);
    assert.equal(result.anchorMode, "strict");
    assert.equal(result.create, false);
    assert.equal(result.bindAddress, "127.0.0.1");
    assert.equal(result.executorPath, path.join(__dirname,
      "../../lib/commands/permit-bridge-executor.js"));
  } finally { f.cleanup(); }
});

test("permit-bridge serve refuses unknown authority switches and malformed config", () => {
  const f = fixture();
  try {
    for (const value of [
      { ...f.config, create: true },
      { ...f.config, bindAddress: "0.0.0.0" },
      { ...f.config, port: 65536 },
      { ...f.config, revocationPort: -1 },
      { ...f.config, port: 1234, revocationPort: 1234 },
      { ...f.config, leaseTtlMs: 0 },
      { ...f.config, storePath: "relative.sqlite" },
    ]) {
      assert.throws(() => readConfig(f.write(value)), /invalid config/);
    }
    assert.throws(() => readConfig(f.write([])), /invalid config/);
    if (process.platform !== "win32") {
      const link = path.join(f.root, "config-link.json");
      fs.symlinkSync(f.write(), link);
      assert.throws(() => readConfig(link));
    }
  } finally { f.cleanup(); }
});

test("permit-bridge serve emits only ports and closes its service on signal", async () => {
  const f = fixture();
  const signalSource = new EventEmitter();
  const lines = [];
  let options;
  let closes = 0;
  try {
    f.write();
    const running = permitBridgeServiceCli({
      args: ["permit-bridge", "serve", "--config", f.configPath],
      cwd: f.root,
    }, {
      signalSource,
      output: { log: (line) => lines.push(line), error: (line) => lines.push(line) },
      startService: async (value) => {
        options = value;
        return {
          address: { port: 1234 },
          revocationAddress: { port: 1235 },
          issueTicket: () => "secret-ticket",
          close: async () => { closes += 1; },
        };
      },
    });
    await new Promise(setImmediate);
    assert.equal(options.create, false);
    assert.deepEqual(JSON.parse(lines[0]),
      { ok: true, action: "serve", port: 1234, revocationPort: 1235 });
    assert.ok(!lines.join("").includes("secret-ticket"));
    signalSource.emit("SIGTERM");
    await running;
    assert.equal(closes, 1);
    assert.equal(signalSource.listenerCount("SIGINT"), 0);
    assert.equal(signalSource.listenerCount("SIGTERM"), 0);
  } finally { f.cleanup(); }
});

test("permit-bridge serve reports the ticket agent port only when an agent runs", async () => {
  const f = fixture();
  const signalSource = new EventEmitter();
  const lines = [];
  try {
    f.write();
    const running = permitBridgeServiceCli({
      args: ["permit-bridge", "serve", "--config", f.configPath],
      cwd: f.root,
    }, {
      signalSource,
      output: { log: (line) => lines.push(line), error: (line) => lines.push(line) },
      startService: async () => ({
        address: { port: 1234 },
        revocationAddress: { port: 1235 },
        agentAddress: { port: 1236 },
        issueTicket: () => "secret-ticket",
        close: async () => {},
      }),
    });
    await new Promise(setImmediate);
    assert.deepEqual(JSON.parse(lines[0]),
      { ok: true, action: "serve", port: 1234, revocationPort: 1235, agentPort: 1236 });
    assert.ok(!lines.join("").includes("secret-ticket"));
    signalSource.emit("SIGTERM");
    await running;
  } finally { f.cleanup(); }
});

test("permit-bridge serve is routed by the CLI and rejects absent protected stores", () => {
  const f = fixture();
  try {
    f.write();
    const result = spawnSync(process.execPath, [
      path.join(__dirname, "../../bin/cli.js"),
      "permit-bridge", "serve", "--config", f.configPath,
    ], { cwd: f.root, encoding: "utf8", timeout: 15_000 });
    assert.equal(result.status, 3, result.stderr);
    assert.match(result.stderr, /permit-bridge serve: start failed/);
    assert.ok(!result.stdout.includes("secret"));
    assert.ok(!fs.existsSync(f.config.storePath));
  } finally { f.cleanup(); }
});

test("permit serve cannot reach the bridge startup path", () => {
  const f = fixture();
  try {
    f.write();
    const result = spawnSync(process.execPath, [
      path.join(__dirname, "../../bin/cli.js"),
      "permit", "serve", "--config", f.configPath,
    ], { cwd: f.root, encoding: "utf8", timeout: 15_000 });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /permit: invalid arguments/);
    assert.ok(!fs.existsSync(f.config.storePath));
  } finally { f.cleanup(); }
});

test("permit-bridge serve starts a strict pre-provisioned domain and closes on SIGTERM", {
  skip: process.platform === "win32" || Number(process.versions.node.split(".")[0]) < 24,
  timeout: 60000,
}, async () => {
  const f = fixture();
  const config = { ...f.config, serviceIdentity: "uid:" + process.getuid() };
  let child;
  try {
    f.write(config);
    const provisioned = ProtectedPermitStore.initialize(config.storePath, {
      anchorDir: config.anchorDir,
      controlledAncestorPath: config.controlledAncestorPath,
      anchorMode: "strict",
      serviceIdentity: config.serviceIdentity,
      decisionId: config.decisionId,
    });
    provisioned.close();

    child = spawn(process.execPath, [
      path.join(__dirname, "../../bin/cli.js"),
      "permit-bridge", "serve", "--config", f.configPath,
    ], { cwd: f.root, stdio: ["ignore", "pipe", "pipe"] });
    const lines = createInterface({ input: child.stdout });
    const first = await Promise.race([
      once(lines, "line").then(([line]) => ({ line })),
      once(child, "exit").then(([code]) => ({ exited: code })),
    ]);
    assert.ok(first.line, "serve exited before readiness: " + first.exited);
    const line = first.line;
    const ready = JSON.parse(line);
    assert.equal(ready.action, "serve");
    assert.ok(ready.port > 0);
    assert.ok(ready.revocationPort > 0);
    const response = await fetch("http://127.0.0.1:" + ready.port + "/permit", {
      method: "POST",
      body: "{}",
    });
    assert.equal(response.status, 401);
    child.kill("SIGTERM");
    const [code] = await once(child, "exit");
    assert.equal(code, 0);
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      await once(child, "exit");
    }
    f.cleanup();
  }
});

test("permit-bridge serve publishes a restricted machine-readable contract", () => {
  const contract = require("../../lib/cli/contract");
  const entry = contract.commands.find((item) => item.name === "permit-bridge");
  assert.ok(entry, "permit-bridge contract entry is missing");
  assert.equal(entry.mode, "managed_service");
  assert.equal(entry.restricted, true);
  assert.match(entry.usage, /serve --config/);

  const root = path.join(__dirname, "../..");
  const result = spawnSync(process.execPath, [
    path.join(root, "bin/cli.js"), "help", "permit-bridge", "--json",
  ], { cwd: root, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.contract.commands.length, 1);
  assert.equal(payload.contract.commands[0].name, "permit-bridge");
});
