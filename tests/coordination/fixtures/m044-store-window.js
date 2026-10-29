"use strict";
// Test-only scheduling barriers; no production injection or retry hook.
const fs = require("node:fs");
const anchor = require("../../../lib/coordination/protected-anchor");
const { ProtectedPermitStore: Store } = require("../../../lib/coordination/protected-permit-store");
const [file, anchorDir, mode, point, release, fieldsJson] = process.argv.slice(2);
const options = { expectedDecisionId: "D-lock-test", minimumEpoch: 1, anchorDir, clock: () => 1000000,
  anchorMode: "permissive", audit: { by: "synthetic-test", reason: "crash-test" }, acceptDatabaseAsTruth: true };
const emit = value => fs.writeSync(1, JSON.stringify(value) + "\n");
function pause() {
  emit({ event: "paused", point });
  const deadline = Date.now() + 15000;
  while (!fs.existsSync(release)) {
    if (Date.now() >= deadline) throw new Error("TEST_BARRIER_TIMEOUT");
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
}
let store;
try {
  if (mode === "writer") {
    store = Store.open(file, options);
    const append = anchor.appendEntry;
    anchor.appendEntry = function(journal, entry) {
      if (entry.type === "commit" && point === "db") pause();
      const result = append(journal, entry);
      if ((entry.type === "intent" && point === "intent") || (entry.type === "commit" && point === "journal")) pause();
      return result;
    };
    const high = anchor.appendHighWater;
    anchor.appendHighWater = function(...args) { const result = high(...args); if (point === "highwater") pause(); return result; };
    const result = store.reserve(JSON.parse(fieldsJson));
    emit({ event: "result", ok: true, permitId: result.permitId });
  } else {
    emit({ event: "starting", mode });
    if (mode === "recover") emit({ event: "result", ok: true, value: Store.recoverFromAnchorCrash(file, options) });
    else if (mode === "reset") emit({ event: "result", ok: true, value: Store.resetAfterAnchorLoss(file, options) });
    else {
      store = Store.open(file, options);
      const result = store.reserve(JSON.parse(fieldsJson));
      emit({ event: "result", ok: true, permitId: result.permitId });
    }
  }
} catch (error) { emit({ event: "result", ok: false, code: error.code || error.message }); process.exitCode = 2; }
finally { if (store) store.close(); }
