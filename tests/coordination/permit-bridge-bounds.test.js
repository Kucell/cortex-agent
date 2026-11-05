"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { PERMIT_BRIDGE_BOUNDS } = require("../../lib/coordination/permit-bridge-bounds");
const { createTicketRegistry } = require("../../lib/coordination/permit-bridge-ticket");

test("the approved bounds are the ones Owner signed off", () => {
  assert.equal(PERMIT_BRIDGE_BOUNDS.handshakeTimeoutMs, 5_000);
  assert.equal(PERMIT_BRIDGE_BOUNDS.factMaxAgeMs, 1_000);
  assert.equal(PERMIT_BRIDGE_BOUNDS.ticketTtlMs, 2_000);
  assert.equal(PERMIT_BRIDGE_BOUNDS.requestTimeoutMs, 5_000);
  assert.equal(PERMIT_BRIDGE_BOUNDS.revocationMaxStalenessMs, 15_000);
  assert.equal(PERMIT_BRIDGE_BOUNDS.clockSkewToleranceMs, 2_000);
  // The table is frozen: a caller cannot widen a bound at runtime.
  assert.throws(() => { "use strict"; PERMIT_BRIDGE_BOUNDS.ticketTtlMs = 60_000; }, TypeError);
});

test("the ticket registry defaults to the approved window instead of a minute", () => {
  const registry = createTicketRegistry();
  assert.equal(registry.ttlMs, PERMIT_BRIDGE_BOUNDS.ticketTtlMs);
  assert.equal(registry.ttlMs, 2_000);
});

test("the ticket registry refuses a window wider than the approved bound", () => {
  assert.throws(() => createTicketRegistry({ ttlMs: 2_001 }), { code: "ERR_PERMIT_INPUT_INVALID" });
  assert.throws(() => createTicketRegistry({ ttlMs: 60_000 }), { code: "ERR_PERMIT_INPUT_INVALID" });
  // A shorter window is allowed: tightening is safe, widening is not.
  const registry = createTicketRegistry({ ttlMs: 500 });
  assert.equal(registry.ttlMs, 500);
});

test("the bridge host refuses to start beyond the approved ticket window", async () => {
  const { startPermitBridgeHost } = require("../../lib/coordination/permit-bridge-host");
  const base = {
    executorPath: __filename,
    batchSession: { issue: () => ({}) },
    revocationBatchSession: { signRevocation: () => ({}) },
    revocationStateSource: () => ({ appliedRevocationSequence: 0, revokedFingerprints: new Set() }),
    leaseTtlMs: 60_000,
    permitTtlMs: 30_000,
  };
  await assert.rejects(
    () => startPermitBridgeHost({ ...base, ticketTtlMs: 60_000 }),
    { key: "ERR_PERMIT_INPUT_INVALID" },
  );
  await assert.rejects(
    () => startPermitBridgeHost({ ...base, requestTimeoutMs: 6_000 }),
    { key: "ERR_PERMIT_INPUT_INVALID" },
  );
});

test("the serve CLI refuses a config that asks for a wider window", () => {
  const { readConfig } = require("../../lib/commands/permit-bridge-service-cli");
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "permit-bridge-bounds-"));
  const write = (value) => {
    const file = path.join(dir, "config.json");
    fs.writeFileSync(file, JSON.stringify(value));
    return file;
  };
  const base = {
    storePath: path.join(dir, "state.sqlite"),
    anchorDir: path.join(dir, "anchor"),
    controlledAncestorPath: path.join(dir, "ancestor"),
    decisionId: "d-1",
    serviceIdentity: "test",
    leaseTtlMs: 60_000,
    permitTtlMs: 30_000,
    ticketTtlMs: 2_000,
  };
  try {
    assert.equal(readConfig(write(base)).ticketTtlMs, 2_000);
    assert.throws(() => readConfig(write({ ...base, ticketTtlMs: 60_000 })), /invalid config/);
    assert.throws(() => readConfig(write({ ...base, requestTimeoutMs: 6_000 })), /invalid config/);
    assert.equal(readConfig(write({ ...base, requestTimeoutMs: 5_000 })).requestTimeoutMs, 5_000);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
