"use strict";

const { CoordinationError } = require("./errors");

function freezeRequest(value) {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freezeRequest(child);
    Object.freeze(value);
  }
  return value;
}

// The transport owns peer authentication and must supply an opaque verified
// context; this function neither creates a listener nor authenticates a peer.
function createPermitAuthorityService({ authorize, batchSession, targetService } = {}) {
  if (typeof authorize !== "function") throw new CoordinationError("ERR_PERMIT_INPUT_INVALID");

  function dispatch(peer, action, args) {
    if (!["issue", "register", "key", "verify", "revoke"].includes(action) ||
        !args || typeof args !== "object" || Array.isArray(args)) {
      throw new CoordinationError("ERR_PERMIT_INPUT_INVALID");
    }
    // Authorize and execute the same detached request, including its resource
    // bindings. The host still has to compare those bindings to trusted state.
    let request;
    try { request = freezeRequest(JSON.parse(JSON.stringify(args))); }
    catch { throw new CoordinationError("ERR_PERMIT_INPUT_INVALID"); }
    // Promise-like and non-boolean results are deliberately not accepted.
    let authorized;
    try { authorized = authorize(peer, action, request); }
    catch { throw new CoordinationError("ERR_PERMIT_INPUT_INVALID"); }
    if (authorized !== true) throw new CoordinationError("ERR_PERMIT_INPUT_INVALID");
    if (action === "issue") {
      if (!batchSession || typeof batchSession.issue !== "function") throw new CoordinationError("ERR_PERMIT_INPUT_INVALID");
      return batchSession.issue({ lease: request.lease, permit: request.permit });
    }
    if (!targetService || typeof targetService[action] !== "function") {
      throw new CoordinationError("ERR_PERMIT_INPUT_INVALID");
    }
    if (action === "key") return targetService.key(request.fingerprint);
    if (action === "revoke") return targetService.revoke();
    return targetService[action](request);
  }

  return Object.freeze({ dispatch });
}

module.exports = { createPermitAuthorityService };
