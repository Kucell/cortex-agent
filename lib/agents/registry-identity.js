"use strict";

const { createHash } = require("node:crypto");
const { validateAdapterTypeExt } = require("./registry-adapter-types");
const MAX_AUDIT_EVENTS = 10000;

function reject(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function object(value, keys, required = keys) {
  if (!value || typeof value !== "object" || Array.isArray(value)
      || Object.keys(value).some((key) => !keys.includes(key))
      || required.some((key) => !Object.prototype.hasOwnProperty.call(value, key))) {
    reject("ERR_REGISTRY_INVALID", `Expected object fields: ${keys.join(", ")}`);
  }
}

function text(value, name) {
  if (typeof value !== "string" || !value.trim() || value !== value.trim()
      || value.length > 512 || /[\x00-\x1f\x7f]/.test(value)) {
    reject("ERR_REGISTRY_INVALID", `Invalid ${name}`);
  }
  return value;
}

function strings(value, name, { nonempty = true } = {}) {
  if (!Array.isArray(value) || (nonempty && value.length === 0)
      || value.length > 1024 || new Set(value).size !== value.length) {
    reject("ERR_REGISTRY_INVALID", `Invalid ${name}`);
  }
  value.forEach((item) => text(item, name));
  return value;
}

function validateIdentity(identity) {
  object(identity, ["provider", "adapter_type", "subject"]);
  text(identity.provider, "provider");
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(identity.provider)) {
    reject("ERR_REGISTRY_INVALID", "provider must be a normalized provider identifier");
  }
  validateAdapterTypeExt(identity.adapter_type);
  text(identity.subject, "native host subject");
  return identity;
}

function deriveAgentId(identity) {
  validateIdentity(identity);
  // Role/model/project are grants, not identity. Changing them cannot mint a
  // second identity for the same host subject (including a fake reviewer).
  const tuple = [identity.provider, identity.adapter_type, identity.subject];
  return `agent-${createHash("sha256").update(JSON.stringify(tuple)).digest("hex")}`;
}

function managedId(id) {
  if (typeof id !== "string" || !/^agent-[a-f0-9]{64}$/.test(id)) {
    reject("ERR_REGISTRY_INVALID", "Expected a generated managed agent_id");
  }
  return id;
}

function validateOwnedFiles(files) {
  strings(files, "owned_files");
  for (const file of files) {
    if (file.startsWith("/") || /[\\:*?\[\]{}]/.test(file)
        || file.split("/").some((part) => !part || part === "." || part === "..")) {
      reject("ERR_REGISTRY_INVALID", "owned_files must contain exact repository-relative file paths");
    }
  }
}

function validateManagedEntry(entry) {
  const fields = ["identity", "enabled", "registration"];
  if (!fields.some((field) => Object.prototype.hasOwnProperty.call(entry, field))) return entry;
  if (!fields.every((field) => Object.prototype.hasOwnProperty.call(entry, field))) {
    reject("ERR_REGISTRY_INVALID", "Managed records require identity, enabled and registration together");
  }
  const allowed = ["schema_version", "agent_id", "role", "model", "task_id", "mission_id",
    "session_id", "started_at", "last_heartbeat", "status", "owned_files", "pending_artifacts",
    "capabilities", "projects", "recall", "external", ...fields];
  object(entry, allowed, fields);
  if (entry.agent_id !== deriveAgentId(entry.identity) || typeof entry.enabled !== "boolean"
      || !entry.external || entry.external.adapter_type !== entry.identity.adapter_type) {
    reject("ERR_REGISTRY_INVALID", "Managed identity, adapter or enabled state is inconsistent");
  }
  object(entry.external, ["adapter_type", "config_ref", "credential_ref"], ["adapter_type"]);
  strings(entry.capabilities, "capabilities");
  strings(entry.projects, "projects");
  validateOwnedFiles(entry.owned_files);
  object(entry.registration, ["owner_id", "events"]);
  text(entry.registration.owner_id, "owner_id");
  const events = entry.registration.events;
  if (!Array.isArray(events) || events.length === 0 || events.length > MAX_AUDIT_EVENTS + 1) {
    reject("ERR_REGISTRY_INVALID", "Managed record requires a bounded registration journal");
  }
  let enabled = false;
  events.forEach((event, index) => {
    object(event, ["action", "actor_id", "session_id", "at", "policy_sha256"]);
    if ((index === 0 && event.action !== "register")
        || (index > 0 && !["enable", "disable"].includes(event.action))
        || !Number.isFinite(Date.parse(event.at))
        || !/^[a-f0-9]{64}$/.test(event.policy_sha256)) {
      reject("ERR_REGISTRY_INVALID", "Invalid registration journal event");
    }
    text(event.actor_id, "actor_id");
    text(event.session_id, "session_id");
    if (index > 0) enabled = event.action === "enable";
  });
  if (enabled !== entry.enabled) reject("ERR_REGISTRY_INVALID", "Journal and enabled state differ");
  if (events.length > MAX_AUDIT_EVENTS && enabled) {
    reject("ERR_REGISTRY_INVALID", "The audit recovery slot is reserved for final disable");
  }
  return entry;
}

module.exports = { reject, object, text, strings, validateIdentity, deriveAgentId,
  managedId, validateOwnedFiles, validateManagedEntry, MAX_AUDIT_EVENTS };
