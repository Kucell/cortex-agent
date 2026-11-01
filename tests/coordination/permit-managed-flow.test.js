"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { ProtectedPermitStore } = require("../../lib/coordination/protected-permit-store");
const { ProtectedPinStore } = require("../../lib/coordination/protected-pin-store");
const { createPermitBatchSession } = require("../../lib/coordination/permit-batch-session");
const { createPermitTargetService } = require("../../lib/coordination/permit-target-service");
const { createPermitAuthorityService } = require("../../lib/coordination/permit-authority-service");
const { startPermitManagedSession } = require("../../lib/coordination/permit-managed-session");
const { BINDING_FIELD_MAP } = require("../../lib/coordination/permit-delivery");

test("synthetic managed CLI exercises issue, registration, key, verify and revoke", {
  skip: process.platform === "win32" || Number(process.versions.node.split(".")[0]) < 24,
  timeout: 30000,
}, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "permit-flow-test-"));
  const dbDir = path.join(root, "db");
  const anchorDir = path.join(root, "anchor");
  const pinDir = path.join(root, "pin");
  for (const directory of [dbDir, anchorDir, pinDir]) fs.mkdirSync(directory);
  let store;
  let batch;
  try {
    const now = 1_000_000;
    store = ProtectedPermitStore.initialize(path.join(dbDir, "state.sqlite"), {
      decisionId: "D-test", anchorDir, anchorMode: "permissive", clock: () => now,
    });
    batch = createPermitBatchSession({ store, clock: () => now });
    const pinStore = ProtectedPinStore.initialize(pinDir, { decisionId: "D-test", anchorMode: "permissive" });
    let revokeFingerprint = null;
    const target = createPermitTargetService({ pinStore, clock: () => now,
      observeTarget: () => ({ targetHasProcess: false, targetHasPriorRun: false }),
      resolvePermitState: () => store.snapshot(),
      pullRevocation: () => {
        const state = pinStore.revocationState();
        const fingerprints = [...state.revokedFingerprints];
        if (revokeFingerprint && !fingerprints.includes(revokeFingerprint)) fingerprints.push(revokeFingerprint);
        return batch.signRevocation({ state, fingerprints });
      },
    });
    const authority = createPermitAuthorityService({ authorize: () => true, batchSession: batch, targetService: target });
    let counter = 0;
    async function run(action, payload, output) {
      const input = path.join(root, `input-${counter++}.json`);
      fs.writeFileSync(input, JSON.stringify(payload), { mode: 0o600 });
      const args = ["permit", action, "--input", input];
      if (output) args.push("--output", output);
      const { session, child } = await startPermitManagedSession({
        modulePath: path.join(__dirname, "../../bin/cli.js"), args, authority,
      });
      let stdout = "";
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (part) => { stdout += part; });
      const exited = new Promise((resolve) => child.once("exit", resolve));
      const ready = new Promise((resolve) => child.on("message", (message) => {
        if (message && message.type === "permit.result-ready") resolve();
      }));
      try {
        await session.request("permit.start", {});
        await ready;
        await session.close("test_complete");
        const code = await exited;
        return { code, stdout };
      } finally {
        await session.close("test_cleanup");
        if (child.exitCode === null) child.kill();
      }
    }
    const output = path.join(root, "permit.json");
    const issue = await run("issue", {
      lease: { owner: "owner", sessionId: "session", hostId: "host", workerId: "worker", runId: "run",
        generation: "1", desktopKey: "desktop", ownedAppId: "app", idempotencyKey: "lease", ttlMs: 5000 },
      permit: { idempotencyKey: "permit", operation: "op", targetDigest: "a".repeat(64),
        paramsDigest: "b".repeat(64), ttlMs: 10000 },
    }, output);
    assert.equal(issue.code, 0);
    assert.doesNotMatch(issue.stdout, /signature|PRIVATE KEY/);
    assert.equal(fs.statSync(output).mode & 0o777, 0o600);
    const issued = JSON.parse(fs.readFileSync(output, "utf8"));
    const register = await run("register", { batchIdentity: { decision_id: "D-test", instance_id: "instance",
      fingerprint: issued.fingerprint }, publicKeyPem: issued.publicKeyPem,
      sourceDigest: "sha256:" + "a".repeat(64), deploymentDigest: "sha256:" + "b".repeat(64),
      runId: "run", generation: "1", validFrom: 1, validUntil: 2_000_000 });
    assert.equal(register.code, 0);
    assert.equal((await run("key", { fingerprint: issued.fingerprint })).code, 0);
    const request = { fingerprint: issued.fingerprint, message: issued.signedPermit.message,
      signature: issued.signedPermit.signature };
    const verified = await run("verify", request);
    assert.equal(verified.code, 0);
    assert.doesNotMatch(verified.stdout, /signature|bytes/);
    const secondOutput = path.join(root, "permit-second.json");
    assert.equal((await run("issue", {
      lease: { owner: "owner", sessionId: "session", hostId: "host", workerId: "worker", runId: "run",
        generation: "1", desktopKey: "desktop", ownedAppId: "app", idempotencyKey: "lease", ttlMs: 5000 },
      permit: { idempotencyKey: "permit-second", operation: "other", targetDigest: "a".repeat(64),
        paramsDigest: "b".repeat(64), ttlMs: 10000 },
    }, secondOutput)).code, 0);
    const second = JSON.parse(fs.readFileSync(secondOutput, "utf8"));
    store.release(store.snapshot().lease);
    const consumeFields = { permitId: issued.signedPermit.message.permit_id,
      ...Object.fromEntries(BINDING_FIELD_MAP.map(([storage, signed]) => [storage, issued.signedPermit.message[signed]])) };
    assert.throws(() => store.consume(consumeFields), { code: "ERR_PERMIT_NOT_CONSUMABLE" });
    assert.equal((await run("verify", { fingerprint: second.fingerprint,
      message: second.signedPermit.message, signature: second.signedPermit.signature })).code, 3);
    revokeFingerprint = issued.fingerprint;
    assert.equal((await run("revoke", {})).code, 0);
    assert.equal((await run("verify", request)).code, 3);
  } finally {
    if (batch) batch.close();
    if (store) store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
