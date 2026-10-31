"use strict";

const { ProtectedPermitStore } = require("../../../lib/coordination/protected-permit-store");
const [file, anchorDir, fieldsJson, fingerprint, nowText] = process.argv.slice(2);
let store;
try {
  store = ProtectedPermitStore.open(file, {
    clock: () => Number(nowText), expectedDecisionId: "D-test-init", minimumEpoch: 1, anchorDir,
  });
  const permit = store.reserveBoundToBatch(JSON.parse(fieldsJson), fingerprint);
  process.stdout.write(JSON.stringify({ ok: true, permitId: permit.permitId, fingerprint: permit.batchFingerprint }));
} catch (error) {
  process.stdout.write(JSON.stringify({ ok: false, code: error.code || error.name }));
  process.exitCode = 2;
} finally {
  if (store) store.close();
}
