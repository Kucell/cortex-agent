"use strict";

// Synthetic local authority identity from private object membership only. No
// credentials, network, N-API, Docker, signatures or real effects.
const { ProtectedPermitStore: Store } = require("../../../lib/coordination/protected-permit-store");
const principal = Object.freeze({ subjectId: "subject-a", issuer: "fixture-issuer", tenant: "fixture-tenant" });
function authority(override = {}) {
  const peer = Object.freeze({}), other = Object.freeze({});
  const contexts = new WeakMap([[peer, principal], [other, { ...principal, subjectId: "subject-b" }]]);
  const providers = { mode: "development-only", admissionMode: "development-only", authorityId: "admission-fixture",
    authorize(context, operation, input) {
      const identity = contexts.get(context);
      if (!identity || !["request.admit", "request.lookup"].includes(operation)) return false;
      return { principal: identity, grant: { id: "fixture-grant", version: 1 }, resources: input };
    },
    observeTarget() { throw Error("must not observe"); },
    signPermit() { throw Error("must not sign"); },
    pullRevocation() { throw Error("must not pull"); }, ...override };
  return { peer, other, providers };
}
function options(anchorDir, providers) {
  return { decisionId: "D-admission", expectedDecisionId: "D-admission", minimumEpoch: 1,
    anchorDir, anchorMode: "permissive", clock: () => 1000, witnessAuthority: providers };
}
function request(override = {}) {
  return { requestKey: "request-1", action: "issue", resourceScope: "resource-a", businessKey: "business-a",
    request: { checkpoint: null, targetId: "synthetic-target", params: { value: 1 } }, ...override };
}
module.exports = { authority, options, request, principal };

if (require.main === module) {
  const { file, anchorDir, input: inlineInput, inputFile, decisionIdFile, metrics, lookup, fault } = JSON.parse(process.argv[2]);
  // Large synthetic requests travel via a runtime file, not OS argv limits.
  const input = inputFile ? JSON.parse(require("node:fs").readFileSync(inputFile, "utf8")) : inlineInput;
  const a = authority(); let store;
  function run() {
    try {
      const openOptions = options(anchorDir, a.providers);
      if (decisionIdFile) openOptions.decisionId = openOptions.expectedDecisionId = require("node:fs").readFileSync(decisionIdFile, "utf8");
      store = Store.open(file, openOptions);
      if (fault) {
        const anchor = require("../../../lib/coordination/protected-anchor");
        const append = anchor.appendEntry;
        anchor.appendEntry = (...args) => {
          if (args[1].type === "commit") {
            // Exit after the business DB COMMIT, before its anchor barrier.
            if (fault === "crash-after-db-commit") process.exit(73);
          }
          return append(...args);
        };
      }
      const result = store[lookup ? "lookupAuthorityRequest" : "admitAuthorityRequest"](a.peer, input);
      if (fault === "ack-lost") process.exit(74);
      process.stdout.write(JSON.stringify({ result, ...(metrics ? { metrics: {
        rssBytes: process.memoryUsage().rss, maxRssKiB: process.resourceUsage().maxRSS } } : {}) }));
    } catch (error) { process.stdout.write(JSON.stringify({ error: error.code || error.message })); }
    finally { if (store) store.close(); }
  }
  if (process.send) {
    process.send("ready"); process.once("message", () => { run(); process.disconnect(); });
  } else run();
}
