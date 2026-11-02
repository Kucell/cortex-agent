"use strict";
// Synthetic in-process deployment only. No keys/signatures/effects or real
// active-ready/identity evidence. Caller objects cannot supply prepare facts.
const { ProtectedPermitStore: Store } = require("../../../lib/coordination/protected-permit-store");
const base = require("./permit-authority-admission");
function authority(override = {}) {
  const a = base.authority();
  const authorize = a.providers.authorize;
  const facts = { storeGeneration: "synthetic-generation", lifecycleVersion: "synthetic-version",
    ownerIncarnation: "synthetic-owner", signerId: "synthetic-signer", validUntilMs: 100000 };
  return { ...a, facts, providers: { ...a.providers, signingGateMode: "development-only",
    authorize(peer, operation, input) {
      if (!["request.admit", "request.lookup", "sign.prepare", "sign.call-gate", "sign.abandon"].includes(operation)) return false;
      return authorize(peer, "request.admit", input);
    }, prepareSigning: () => facts, ...override } };
}
function request(override = {}) {
  return base.request({ request: { targetId: "synthetic-target", checkpoint: { format_version: 1, authority_id: "admission-fixture",
    target_id: "synthetic-target", store_generation: "synthetic-generation", revision: 1, full_state_digest: "a".repeat(64) },
    lease: { owner: "subject-a", sessionId: "session", hostId: "host", workerId: "worker", runId: "run", generation: "gen",
      desktopKey: "desktop", ownedAppId: "app", idempotencyKey: "lease", ttlMs: 10000 },
    permit: { idempotencyKey: "permit", ttlMs: 5000, operation: "synthetic-op", targetDigest: "b".repeat(64), paramsDigest: "c".repeat(64) },
    batchFingerprint: "d".repeat(64) }, ...override });
}
module.exports = { authority, request, options: base.options };
if (require.main === module) {
  const args = JSON.parse(process.argv[2]), a = authority(); let store;
  const input = args.input || request();
  try {
    const options = base.options(args.anchorDir, a.providers);
    if (args.clockMs !== undefined) options.clock = () => args.clockMs;
    store = Store.open(args.file, options);
    let result;
    if (args.action === "crash-boundary") {
      const prepared = args.stage === "gate" ? store.prepareAuthoritySigning(a.peer, input) : null;
      const anchor = require("../../../lib/coordination/protected-anchor"), sqlite = require("node:sqlite");
      const append = anchor.appendEntry, high = anchor.appendHighWater;
      const exec = sqlite.DatabaseSync.prototype.exec, prepareSql = sqlite.DatabaseSync.prototype.prepare;
      const close = sqlite.DatabaseSync.prototype.close;
      function die(point) { if (args.point === point) process.exit(75); }
      anchor.appendEntry = (...values) => { const result = append(...values); die(values[1].type); return result; };
      anchor.appendHighWater = (...values) => { const result = high(...values); die("highwater"); return result; };
      sqlite.DatabaseSync.prototype.exec = function(sql) {
        const result = exec.call(this, sql);
        if (sql === "COMMIT") die(new Error().stack.includes("#transactionUnlocked") ? "db-commit" : "coord-commit");
        return result;
      };
      sqlite.DatabaseSync.prototype.prepare = function(sql, ...values) {
        const stmt = prepareSql.call(this, sql, ...values);
        if (!sql.startsWith("UPDATE protected_state")) return stmt;
        return { run(...params) { const result = stmt.run(...params); die("update"); return result; } };
      };
      sqlite.DatabaseSync.prototype.close = function() {
        const result = close.call(this);
        if (new Error().stack.includes("Object.withLock")) die("coord-close");
        return result;
      };
      if (prepared) store.claimAuthoritySigningCall(a.peer, input, prepared.ticket);
      else store.prepareAuthoritySigning(a.peer, input);
      throw Error("crash boundary not reached");
    }
    if (args.action === "snapshot") result = store.snapshot();
    if (args.action === "lookup") result = store.lookupAuthorityRequest(a.peer, input);
    if (args.action === "prepare") result = store.prepareAuthoritySigning(a.peer, input);
    if (args.action === "claim") result = store.claimAuthoritySigningCall(a.peer, input, args.token || {});
    if (args.action === "abandon") result = store.abandonAuthoritySigningCall(a.peer, input, args.token || {});
    if (args.action === "prepare-crash") {
      store.prepareAuthoritySigning(a.peer, input); process.exit(73);
    }
    if (args.action === "prepare-and-claim") {
      const prepared = store.prepareAuthoritySigning(a.peer, input);
      result = store.claimAuthoritySigningCall(a.peer, input, prepared.ticket);
    }
    if (args.action === "claim-crash") {
      const prepared = store.prepareAuthoritySigning(a.peer, input);
      store.claimAuthoritySigningCall(a.peer, input, prepared.ticket); process.exit(74);
    }
    process.stdout.write(JSON.stringify({ result }));
  } catch (error) { process.stdout.write(JSON.stringify({ error: error.code || error.message })); }
  finally { if (store) store.close(); }
}
