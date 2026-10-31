"use strict";

const { startManagedCallerSession } = require("../governed/managed-caller-supervisor");
const { CoordinationError } = require("./errors");

const OPERATIONS = Object.freeze(["permit.issue", "permit.register", "permit.key", "permit.verify", "permit.revoke"]);

// Internal host entry. modulePath and authority must come from trusted host
// configuration; an untrusted request must not select either of them.
function startPermitManagedSession({ modulePath, args = [], authority, owner } = {}) {
  if (typeof modulePath !== "string" || !modulePath || !Array.isArray(args) ||
      !authority || typeof authority.dispatch !== "function") {
    throw new CoordinationError("ERR_PERMIT_INPUT_INVALID");
  }
  return startManagedCallerSession({
    modulePath, args, owner, allowedOperations: OPERATIONS,
    onAuthorizedRequest: ({ identity, operation, payload }) =>
      authority.dispatch(identity, operation.slice("permit.".length), payload),
  });
}

module.exports = { OPERATIONS, startPermitManagedSession };
