"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { validateEntryExt, readAgentExt } = require("./registry-ext");
const { reject, deriveAgentId, managedId, MAX_AUDIT_EVENTS } = require("./registry-identity");
const { authorize, noSymlink } = require("./registry-authorization");

function appendEvent(entry, action, auth, loaded) {
  const event = { action, actor_id: auth.actor_id, session_id: auth.session_id,
    at: new Date().toISOString(), policy_sha256: loaded.sha256 };
  return { ...entry, enabled: action === "enable", registration: {
    owner_id: loaded.policy.owner_id, events: [...(entry.registration?.events || []), event],
  } };
}

function recordCleanup(state, operation, file, action) {
  try { action(); return true; }
  catch (error) {
    if (operation !== "lock_close" && error.code === "ENOENT") return true;
    state.cleanup.push({ operation, path: file, code: error.code || "ERR_REGISTRY_CLEANUP" });
    return false;
  }
}

function withWriter(projectRoot, operation) {
  const dir = path.join(path.resolve(projectRoot), ".agent", "agents");
  // Authorization is performed before reaching this function. A denied call
  // creates neither an agents directory nor a lock/temp file.
  fs.mkdirSync(dir, { recursive: true });
  noSymlink(dir, true);
  const lock = path.join(dir, ".registry-write.lock");
  let fd;
  try { fd = fs.openSync(lock, "wx", 0o600); }
  catch (error) {
    if (error.code === "EEXIST") reject("ERR_REGISTRY_BUSY", "Registry writer is busy; inspect the owner before recovering a stale lock");
    throw error;
  }
  const state = { committed: false, cleanup: [] };
  let result, primary;
  try {
    fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() }));
    result = operation(dir, state);
  } catch (error) { primary = error; }
  // Ambiguous close leaves the lock in place for explicit owner recovery.
  if (recordCleanup(state, "lock_close", lock, () => fs.closeSync(fd))) {
    recordCleanup(state, "lock_unlink", lock, () => fs.unlinkSync(lock));
  }
  if (!primary && state.cleanup.length) {
    primary = new Error("Registry cleanup failed; inspect remaining artifacts before retrying");
    primary.code = "ERR_REGISTRY_CLEANUP";
  }
  if (primary) {
    primary.committed = state.committed;
    if (state.cleanup.length) {
      primary.cleanup = state.cleanup;
      primary.remaining_artifacts = [...new Set(state.cleanup.map((item) => item.path))];
    }
    throw primary;
  }
  return result;
}

function publish(dir, entry, create, state) {
  validateEntryExt(entry);
  const file = path.join(dir, `${managedId(entry.agent_id)}.json`);
  const tmp = path.join(dir, `.${entry.agent_id}-${randomUUID()}.tmp`);
  try {
    fs.writeFileSync(tmp, JSON.stringify(entry, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    if (create) {
      // link is an atomic no-replace publication, unlike rename which can
      // silently replace a duplicate registered by another writer.
      try { fs.linkSync(tmp, file); }
      catch (error) {
        if (error.code === "EEXIST") reject("ERR_REGISTRY_DUPLICATE", "Agent identity is already registered");
        throw error;
      }
    } else {
      noSymlink(file);
      fs.renameSync(tmp, file);
    }
    state.committed = true;
    // Confirm the exact record, not a tolerant directory listing that can
    // silently skip corrupt files. An IO error here may follow publication.
    try {
      const saved = validateEntryExt(JSON.parse(fs.readFileSync(file, "utf8")));
      if (JSON.stringify(saved) !== JSON.stringify(entry)) throw new Error("readback differs");
      return saved;
    } catch (_) {
      const error = new Error("Registry record was published but exact readback failed; inspect before retrying");
      error.code = "ERR_REGISTRY_READBACK";
      error.committed = true;
      throw error;
    }
  } finally {
    recordCleanup(state, "temp_unlink", tmp, () => fs.unlinkSync(tmp));
  }
}

function register(projectRoot, identity, auth) {
  const loaded = authorize(projectRoot, auth, identity);
  const { grant } = loaded;
  const entry = appendEvent({ schema_version: 1, agent_id: deriveAgentId(identity),
    ...grant, external: { adapter_type: grant.identity.adapter_type },
    started_at: new Date().toISOString(), status: "running",
  }, "register", auth, loaded);
  validateEntryExt(entry);
  return withWriter(projectRoot, (dir, state) => publish(dir, entry, true, state));
}

function setEnabled(projectRoot, agentId, enabled, auth) {
  managedId(agentId);
  if (typeof enabled !== "boolean") reject("ERR_REGISTRY_INVALID", "enabled must be boolean");
  // Read is side-effect free. Authorization is checked again under the writer
  // lock so a concurrent enable/disable cannot overwrite another audit event.
  const initial = readAgentExt(projectRoot, agentId, { includeDisabled: true });
  if (!initial) reject("ERR_AGENT_NOT_FOUND", "Managed agent is not registered");
  const revoke = enabled ? {} : { revokingProjects: initial.projects };
  authorize(projectRoot, auth, initial.identity, revoke);
  return withWriter(projectRoot, (dir, state) => {
    const entry = readAgentExt(projectRoot, agentId, { includeDisabled: true });
    const loaded = authorize(projectRoot, auth, entry.identity, enabled ? {} : { revokingProjects: entry.projects });
    if (entry.registration.owner_id !== loaded.policy.owner_id) {
      reject("ERR_REGISTRY_UNAUTHORIZED", "Registry owner changed; explicit migration is required");
    }
    if (enabled) {
      for (const field of ["role", "model", "capabilities", "projects", "owned_files"]) {
        if (JSON.stringify(entry[field]) !== JSON.stringify(loaded.grant[field])) {
          reject("ERR_REGISTRY_UNAUTHORIZED", "Stored profile no longer matches the owner grant");
        }
      }
    }
    if (entry.enabled === enabled) return entry;
    // Reserve a final disable slot. Also permit one recovery disable for a
    // preexisting enabled record already at the old 10,000-event ceiling.
    if (enabled && entry.registration.events.length >= MAX_AUDIT_EVENTS - 1) {
      reject("ERR_REGISTRY_AUDIT_CAPACITY", "Audit capacity reserved for disable; owner archival/migration is required before enabling again");
    }
    return publish(dir, appendEvent(entry, enabled ? "enable" : "disable", auth, loaded), false, state);
  });
}

module.exports = { register, setEnabled };
