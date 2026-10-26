"use strict";

const { ProtectedPermitStore } = require("../../../lib/coordination/protected-permit-store");

const [file, anchorDir, fieldsJson, nowText] = process.argv.slice(2);
let store;
try {
  store = ProtectedPermitStore.open(file, {
    clock: () => Number(nowText), expectedDecisionId: "D-test-init", minimumEpoch: 1, anchorDir,
  });
  const permit = store.reserve(JSON.parse(fieldsJson));
  process.stdout.write(`${JSON.stringify({ ok: true, permitId: permit.permitId, status: permit.status })}\n`);
} catch (error) {
  process.stdout.write(`${JSON.stringify({ ok: false, code: error.code || error.name })}\n`);
  process.exitCode = 2;
} finally {
  if (store) store.close();
}
