"use strict";

// Pure candidate declaration codec. No filesystem/DB/path resolution, discovery,
// authority, activation or migration. A digest binds content, not its provenance.
// Missing input is an error; even stores:[] is not a not-configured decision.
const { createHash } = require("node:crypto");
const { types } = require("node:util");
const { TextDecoder } = require("node:util");
const FORMAT_VERSION = 1;
const LIMITS = Object.freeze({ bytes: 65536, depth: 8, nodes: 4096, stores: 64, id: 128, uri: 512 });
const DOMAIN = "cortex-permit-store-declaration-v1\0";
const typed = Object.getPrototypeOf(Uint8Array.prototype);
const byteLength = Object.getOwnPropertyDescriptor(typed, "byteLength").get;
const backing = Object.getOwnPropertyDescriptor(typed, "buffer").get;
const byteOffset = Object.getOwnPropertyDescriptor(typed, "byteOffset").get;
const Uint8 = Uint8Array, setBytes = Uint8Array.prototype.set;
const bufferPrototype = Buffer.prototype;
const isBuffer = Buffer.isBuffer, isProxy = types.isProxy;
const isUint8Array = types.isUint8Array, isShared = types.isSharedArrayBuffer;

class PermitStoreDeclarationError extends Error {
  constructor(code) { super(code); this.name = "PermitStoreDeclarationError"; this.code = code; }
}
function fail(code = "ERR_PERMIT_DECLARATION_SCHEMA") { throw new PermitStoreDeclarationError(code); }
function unicode(text) {
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = text.charCodeAt(++i);
      if (!(next >= 0xdc00 && next <= 0xdfff)) fail("ERR_PERMIT_DECLARATION_UTF8");
    } else if (c >= 0xdc00 && c <= 0xdfff) fail("ERR_PERMIT_DECLARATION_UTF8");
  }
  return text;
}
function source(input) {
  // Includes revoked proxies; do this before any reflection or Buffer check.
  if (isProxy(input)) fail("ERR_PERMIT_DECLARATION_INPUT");
  if (typeof input === "string") {
    if (input.length > LIMITS.bytes || Buffer.byteLength(input) > LIMITS.bytes) fail("ERR_PERMIT_DECLARATION_LIMIT");
    return unicode(input);
  }
  if (!isUint8Array(input) || !isBuffer(input) || Object.getPrototypeOf(input) !== bufferPrototype) fail("ERR_PERMIT_DECLARATION_INPUT");
  const size = byteLength.call(input);
  if (size > LIMITS.bytes) fail("ERR_PERMIT_DECLARATION_LIMIT");
  const buffer = backing.call(input);
  if (isShared(buffer)) fail("ERR_PERMIT_DECLARATION_INPUT");
  // A Buffer is only a byte carrier. Never enumerate its arbitrary own keys
  // or read shadowed .buffer/.offset/.length/iterator/constructor properties.
  // The captured view constructor also rejects a detached backing buffer,
  // including detached zero-length views, before any decode can succeed.
  let copy;
  try {
    const view = new Uint8(buffer, byteOffset.call(input), size);
    copy = new Uint8(size);
    setBytes.call(copy, view);
  } catch { fail("ERR_PERMIT_DECLARATION_INPUT"); }
  try { return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(copy); }
  catch { fail("ERR_PERMIT_DECLARATION_UTF8"); }
}

// Bounded recursive descent: unlike JSON.parse, retains escaped-key duplicate
// evidence. Never allocates a caller-selected nesting depth or calls user code.
function json(text) {
  let at = 0, nodes = 0;
  const bad = () => fail("ERR_PERMIT_DECLARATION_JSON");
  const space = () => { while (at < text.length && /[ \r\n\t]/.test(text[at])) at++; };
  function string() {
    const start = at++;
    while (at < text.length) {
      if (text[at] === "\\") { at += 2; continue; }
      if (text[at++] === '"') {
        let value;
        try { value = JSON.parse(text.slice(start, at)); } catch { bad(); }
        return unicode(value);
      }
    }
    bad();
  }
  function value(depth) {
    if (depth > LIMITS.depth || ++nodes > LIMITS.nodes) fail("ERR_PERMIT_DECLARATION_LIMIT");
    space();
    if (text[at] === '"') return string();
    if (text[at] === "{") {
      at++; space(); const result = Object.create(null), keys = new Set();
      if (text[at] === "}") { at++; return result; }
      for (;;) {
        space(); if (text[at] !== '"') bad(); const key = string();
        if (keys.has(key)) fail("ERR_PERMIT_DECLARATION_DUPLICATE_KEY");
        keys.add(key);
        if (["__proto__", "prototype", "constructor"].includes(key)) fail("ERR_PERMIT_DECLARATION_SCHEMA");
        space(); if (text[at++] !== ":") bad(); result[key] = value(depth + 1); space();
        const end = text[at++]; if (end === "}") return result; if (end !== ",") bad();
      }
    }
    if (text[at] === "[") {
      at++; space(); const result = [];
      if (text[at] === "]") { at++; return result; }
      for (;;) {
        result.push(value(depth + 1)); space(); const end = text[at++];
        if (end === "]") return result; if (end !== ",") bad();
      }
    }
    const token = /^(?:null|true|false|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/.exec(text.slice(at));
    if (!token) bad(); at += token[0].length;
    const parsed = JSON.parse(token[0]);
    // Integer syntax only: decimals may round to an apparently safe integer
    // before Number.isSafeInteger can detect the lost input precision.
    if (typeof parsed === "number" && (!/^-?(?:0|[1-9][0-9]*)$/.test(token[0]) || !Number.isSafeInteger(parsed) || Object.is(parsed, -0))) fail();
    return parsed;
  }
  const result = value(0); space(); if (at !== text.length) bad(); return result;
}
function exact(value, fields) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail();
  const keys = Object.keys(value);
  if (keys.length !== fields.length || keys.some(key => !fields.includes(key))) fail();
}
function identity(value) {
  if (typeof value !== "string" || value.length > LIMITS.id || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value)) fail();
  return value;
}
function binding(value) {
  // A single ASCII spelling avoids case-fold/Unicode aliases on later hosts.
  if (typeof value !== "string" || value.length > LIMITS.id || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)) fail();
  return value;
}
function uri(value) {
  // Strict subset of runtime-layout/resolver.portablePath: coordination is
  // a real portable namespace; the permit subtree is this declaration's scope.
  // This does not resolve a filesystem root or attest containment/identity.
  if (typeof value !== "string" || value.length > LIMITS.uri || !value.startsWith("runtime://coordination/permit/")) fail();
  const segments = value.slice(10).split("/");
  if (segments.length < 3 || segments.length > 8) fail();
  for (const segment of segments) {
    if (!/^[a-z0-9][a-z0-9._-]*$/.test(segment) || segment.endsWith(".") || segment.length > LIMITS.id ||
        /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/.test(segment)) fail();
  }
  return value;
}
function canonical(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  return "{" + Object.keys(value).sort().map(key => JSON.stringify(key) + ":" + canonical(value[key])).join(",") + "}";
}
function freeze(value) {
  if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}

// expectedProjectId is mandatory trusted context; minimumRevision is only a
// caller-provided lower bound, NOT an independent anti-rollback authority/CAS.
// Original array order is irrelevant: stores canonicalize by binding_id.
function parsePermitStoreDeclaration(input, expectedProjectId, minimumRevision = 1) {
  identity(expectedProjectId);
  if (!Number.isSafeInteger(minimumRevision) || minimumRevision < 1) fail();
  const data = json(source(input));
  exact(data, ["format_version", "project_id", "revision", "stores"]);
  if (data.format_version !== FORMAT_VERSION) fail("ERR_PERMIT_DECLARATION_VERSION");
  identity(data.project_id);
  if (data.project_id !== expectedProjectId) fail("ERR_PERMIT_DECLARATION_PROJECT");
  if (!Number.isSafeInteger(data.revision) || data.revision < minimumRevision) fail("ERR_PERMIT_DECLARATION_REVISION");
  if (!Array.isArray(data.stores) || data.stores.length > LIMITS.stores) fail("ERR_PERMIT_DECLARATION_LIMIT");
  const storeIds = new Set(), databaseRefs = new Set(), storeBindings = new Set(), anchors = new Set();
  function unique(set, value) {
    if (set.has(value)) fail("ERR_PERMIT_DECLARATION_DUPLICATE_BINDING"); set.add(value);
  }
  for (const store of data.stores) {
    exact(store, ["binding_id", "backend", "mode", "database_ref", "anchor_binding_id", "deployment_binding_id",
      "expected_decision_id", "expected_store_id", "migration_policy"]);
    if (store.backend !== "protected-permit-store" || store.mode !== "ordinary" || store.migration_policy !== "automatic-when-proven") fail();
    // References are typed by role. Deployments may control several stores;
    // each anchor journal, however, supports only one store identity today.
    unique(storeBindings, binding(store.binding_id));
    unique(anchors, binding(store.anchor_binding_id));
    binding(store.deployment_binding_id);
    identity(store.expected_decision_id); unique(storeIds, identity(store.expected_store_id));
    if (store.database_ref && store.database_ref.kind === "project-logical") {
      exact(store.database_ref, ["kind", "uri"]); unique(databaseRefs, "project-logical:" + uri(store.database_ref.uri));
    } else {
      exact(store.database_ref, ["kind", "binding_id"]);
      if (store.database_ref.kind !== "machine-binding") fail();
      unique(databaseRefs, "machine-binding:" + binding(store.database_ref.binding_id));
    }
  }
  data.stores.sort((left, right) => left.binding_id < right.binding_id ? -1 : left.binding_id > right.binding_id ? 1 : 0);
  const canonicalJson = canonical(data);
  const digest = createHash("sha256").update(DOMAIN, "utf8").update(canonicalJson, "utf8").digest("hex");
  return freeze({ snapshot: data, canonicalJson, digest });
}

module.exports = { FORMAT_VERSION, LIMITS, PermitStoreDeclarationError, parsePermitStoreDeclaration };
