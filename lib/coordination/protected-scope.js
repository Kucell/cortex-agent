"use strict";

// This namespace is owned by the protected service, never by the public
// two-file lease CLI. Other scope spellings cannot grant dispatch authority.
const PROTECTED_SCOPE = "samhmi:dispatch-authority";
const PROTECTED_LEASE_PREFIX = "P-LEASE-";

function isProtectedScope(scope) {
  return typeof scope === "string" &&
    scope.trim().toLowerCase().startsWith(PROTECTED_SCOPE);
}

function isProtectedLeaseId(leaseId) {
  return typeof leaseId === "string" &&
    leaseId.trim().toUpperCase().startsWith(PROTECTED_LEASE_PREFIX);
}

module.exports = { PROTECTED_SCOPE, PROTECTED_LEASE_PREFIX, isProtectedScope, isProtectedLeaseId };
