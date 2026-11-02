"use strict";

// Synthetic trusted composition, NOT remote authentication or real effects.
const { createPermitWitnessAdmissionHost } = require("../../../lib/coordination/permit-witness-admission-host");
function request(override = {}) {
  return { requestKey: "request-a", action: "issue", resourceScope: "canonical-resource-a", businessKey: "canonical-business-a",
    request: { checkpoint: null, targetId: "target-a", params: { value: 1 }, generation: "run-1" }, ...override };
}
function config(file, anchorDir, access = "initialize") {
  return { backend: "development-witness", mode: "development-only", access, file, authorityId: "dev-admission-authority",
    storeOptions: { decisionId: "D-admission-host", anchorDir, anchorMode: "permissive", minimumEpoch: 1 }, clock: () => 1000 };
}
function assignment(override = {}) {
  const identity = Object.freeze({});
  return { identity, incarnation: "incarnation-1",
    principal: { subjectId: "subject-a", issuer: "synthetic-issuer", tenant: "synthetic-tenant" },
    grant: Object.freeze({ id: "grant-a", version: 1 }), permissions: ["request.admit", "request.lookup"],
    resources: request(), isCurrent: (actual, binding) => actual === identity && binding.incarnation === "incarnation-1",
    ...override };
}
module.exports = { request, config, assignment };

if (require.main === module) {
  const { file, anchorDir, fault, lookup = false } = JSON.parse(process.argv[2]);
  const host = createPermitWitnessAdmissionHost(config(file, anchorDir, "open"));
  if (fault === "crash-after-db-commit") {
    const anchor = require("../../../lib/coordination/protected-anchor"), append = anchor.appendEntry;
    anchor.appendEntry = (...args) => {
      if (args[1].type === "commit") process.exit(73);
      return append(...args);
    };
  }
  const context = host.createContext(assignment({ permissions: [lookup ? "request.lookup" : "request.admit"] }));
  const result = host[lookup ? "lookup" : "admit"](context, request());
  if (fault === "ack-lost") process.exit(74);
  process.stdout.write(JSON.stringify(result));
  host.close();
}
