"use strict";

// ─── Project-Scoped Local Host Binding Persistence (CP-9) ──────────────────
//
// Implements the `.agent-runtime/coordination/bindings/` half of P-003 §5.2 /
// §5.3: each developer keeps their local consumer bindings on this machine,
// and the registry file is the single source of truth for "which consumer
// uses which adapter / fallback chain / subscription set".
//
// Hard guarantees enforced here:
//
//   1. Persistence is CONFINED below a caller-provided runtime root. The
//      root must contain `.agent-runtime` as a path segment, mirroring the
//      `notification-supervisor` discipline (so a misuse cannot write into
//      `.agent-shared/` or any shared / version-controlled location).
//   2. Every write is atomic: tmp file → fsync → rename → dir fsync. Files
//      are created with `O_EXCL` and `0o600`. We never follow symlinks: if
//      the consumer-dir or any parent directory is a symlink we refuse to
//      proceed.
//   3. Traversal is rejected at every entry point. Consumer ids are
//      validated against a strict safe-id regex; the resolved file path is
//      re-checked against the runtime root after every write / read.
//   4. Receipts NEVER contain credentials, prompts, responses, file bodies,
//      absolute paths, private host session / thread IDs, or exact token
//      usage. We expose `assertSafeReceiptField` so other modules can
//      share the same scrubbing contract.
//
// No fs spawn / no network / no process. Single-writer per file.

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const {
  validateLocalHostBinding,
  validateBindingPersistenceEnvelope,
} = require("./schemas");

class LocalHostBindingError extends Error {
  constructor(code, details = {}) {
    // Embed the structured reason in the message so consumers can use
    // `assert.throws(..., /reason/)` (Node's validator only inspects the
    // message string, not nested details objects).
    const reason = details && details.reason ? `:${details.reason}` : "";
    super(`${code}${reason}`);
    this.name = "LocalHostBindingError";
    this.code = code;
    this.details = details;
  }
}

const RUNTIME_SEGMENT = ".agent-runtime";
const SCHEMA_VERSION = "1.0";
const BINDINGS_DIR_NAME = "bindings";
const ENVELOPE_PREFIX = "binding-";
const ENVELOPE_SUFFIX = ".json";
const MAX_CONSUMER_ID_LEN = 128;
const MAX_ADAPTER_ID_LEN = 128;

// ─── Safe-id / redaction rules ─────────────────────────────────────────────
//
// These match the deny-rule philosophy of the existing
// `adapter-core.checkDenyRules` / `consumer-cursor.validateId`: anything
// that looks like a credential, absolute path, IP, prompt body or that
// contains control characters is refused before it can ever be persisted
// in a binding receipt. Lengths are bounded so unbounded blobs cannot
// leak into a shared runtime root either.

const ID_SAFE = /^[a-z0-9][a-z0-9._:-]{0,127}$/;
const EVENT_TYPE_SAFE = /^[a-z][a-z0-9._-]{0,127}$/;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
const SECRET_PATTERN = /(?:token|password|passwd|secret|api[_-]?key|authorization)\s*[:=]/i;
// Common raw-token shapes (independent of any "key=value" prefix). Each
// alternative has a minimum suffix length so that short benign strings that
// happen to start with a vendor prefix do not trigger the rule — EXCEPT the
// obvious short vendor-prefixed tokens (ghp_, gho_, ghs_, ghr_, xox-, AKIA)
// which are ALWAYS rejected because the prefix alone is enough signal to
// treat the value as a credential that must never reach a receipt.
const RAW_TOKEN_PATTERN = /\b(?:ghp_[A-Za-z0-9]+|gho_[A-Za-z0-9]+|ghs_[A-Za-z0-9]+|ghr_[A-Za-z0-9]+|xox[abprs]-[A-Za-z0-9-]+|AKIA[0-9A-Z]+|sk-ant-api[A-Za-z0-9-]+|sk-proj-[A-Za-z0-9]+|sk-[A-Za-z0-9]{20,}|AIza[0-9A-Za-z_-]{35})\b/;
const POSIX_ABSOLUTE_PATH = /(^|[\s"'`])\/(?:Users|home|var|tmp|private|opt|etc)\//;
const WINDOWS_ABSOLUTE_PATH = /(^|[\s"'`])[A-Za-z]:[\\/]/;
const IPV4_ADDRESS = /(^|[^0-9])(?:\d{1,3}\.){3}\d{1,3}([^0-9]|$)/;
// Prompt-body / injection markers.
const PROMPT_MARKER = /\b(?:ignore (?:all )?(?:previous|prior|above) instructions|reveal (?:the )?system prompt|disregard (?:the )?(?:system|developer) (?:prompt|messages?))\b/i;
// Session / thread IDs: refuse obvious Codex/Claude/IDE-style session or
// thread identifiers that begin with a vendor prefix and a long opaque suffix.
const SESSION_MARKER = /(?:codex|claude|windsurf|cursor|jetbrains|vscode)[_-]?(?:thread|session)[_-][A-Za-z0-9-]{6,}/i;

const MAX_SCALAR_LEN = 1024;
const MAX_LIST_LEN = 128;

function assertBoundedString(value, field, pattern, maxLen) {
  if (typeof value !== "string") {
    throw new LocalHostBindingError("ERR_BINDING_FIELD", { field, reason: "must be string" });
  }
  if (value.length === 0 || value.length > maxLen) {
    throw new LocalHostBindingError("ERR_BINDING_FIELD", { field, reason: "out_of_range", length: value.length, max: maxLen });
  }
  if (CONTROL_CHARS.test(value)) {
    throw new LocalHostBindingError("ERR_BINDING_FIELD", { field, reason: "control_chars" });
  }
  if (pattern && !pattern.test(value)) {
    throw new LocalHostBindingError("ERR_BINDING_FIELD", { field, reason: "unsafe_chars" });
  }
  return value;
}

function assertConsumerId(value) {
  return assertBoundedString(value, "consumerId", ID_SAFE, MAX_CONSUMER_ID_LEN);
}

function assertAdapterId(value) {
  return assertBoundedString(value, "adapterId", ID_SAFE, MAX_ADAPTER_ID_LEN);
}

function assertEventType(value, field) {
  return assertBoundedString(value, field, EVENT_TYPE_SAFE, MAX_SCALAR_LEN);
}

function assertStringList(values, field, itemAssert) {
  if (!Array.isArray(values)) {
    throw new LocalHostBindingError("ERR_BINDING_FIELD", { field, reason: "must be array" });
  }
  if (values.length > MAX_LIST_LEN) {
    throw new LocalHostBindingError("ERR_BINDING_FIELD", { field, reason: "too_long", length: values.length, max: MAX_LIST_LEN });
  }
  const seen = new Set();
  const out = [];
  for (const value of values) {
    const v = itemAssert(value, `${field}[]`);
    if (seen.has(v)) {
      throw new LocalHostBindingError("ERR_BINDING_FIELD", { field, reason: "duplicate", value: v });
    }
    seen.add(v);
    out.push(v);
  }
  // Stable, sorted output: persisted lists are deterministic across
  // re-saves and a / b observe identical fallback / subscription order.
  out.sort();
  return out;
}

function assertTarget(target) {
  if (!target || typeof target !== "object" || Array.isArray(target)) {
    throw new LocalHostBindingError("ERR_BINDING_FIELD", { field: "target", reason: "must be object" });
  }
  const kind = assertBoundedString(target.kind, "target.kind", ID_SAFE, 64);
  const actorId = assertBoundedString(target.actorId, "target.actorId", ID_SAFE, 256);
  return Object.freeze({ kind, actorId });
}

// Reject anything that smells like a credential, prompt, file body,
// absolute path or IP at the receipt boundary. Boolean and integer
// values pass unchanged; everything else must be a bounded safe string.
function assertSafeReceiptField(value, field) {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new LocalHostBindingError("ERR_BINDING_RECEIPT", { field, reason: "non_finite" });
    }
    return value;
  }
  if (typeof value !== "string") {
    throw new LocalHostBindingError("ERR_BINDING_RECEIPT", { field, reason: "unsupported_type" });
  }
  if (value.length > MAX_SCALAR_LEN) {
    throw new LocalHostBindingError("ERR_BINDING_RECEIPT", { field, reason: "too_long", length: value.length });
  }
  if (CONTROL_CHARS.test(value)) {
    throw new LocalHostBindingError("ERR_BINDING_RECEIPT", { field, reason: "control_chars" });
  }
  if (SECRET_PATTERN.test(value) || RAW_TOKEN_PATTERN.test(value)
      || POSIX_ABSOLUTE_PATH.test(value) || WINDOWS_ABSOLUTE_PATH.test(value)
      || IPV4_ADDRESS.test(value) || PROMPT_MARKER.test(value)
      || SESSION_MARKER.test(value)) {
    throw new LocalHostBindingError("ERR_BINDING_RECEIPT", { field, reason: "contains_private_data" });
  }
  return value;
}

// Walk a structured object and apply `assertSafeReceiptField` to every leaf.
// This is what guarantees that no credential / path / IP / file body slips
// into a persisted receipt via a deep path we forgot to validate.
function scrubReceipt(obj, field = "$", seen = new WeakSet()) {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj !== "object") return assertSafeReceiptField(obj, field);
  if (seen.has(obj)) {
    throw new LocalHostBindingError("ERR_BINDING_RECEIPT", { field, reason: "cycle" });
  }
  seen.add(obj);
  if (Array.isArray(obj)) {
    const out = obj.map((entry, index) => scrubReceipt(entry, `${field}[${index}]`, seen));
    seen.delete(obj);
    return out;
  }
  const out = {};
  for (const [key, value] of Object.entries(obj)) {
    out[key] = scrubReceipt(value, `${field}.${key}`, seen);
  }
  seen.delete(obj);
  return out;
}

// ─── Filesystem helpers ────────────────────────────────────────────────────

function assertRuntimeScoped(dir) {
  if (typeof dir !== "string" || !dir) {
    throw new LocalHostBindingError("ERR_BINDING_SCOPE", { dir });
  }
  const resolved = path.resolve(dir);
  const segments = resolved.split(path.sep);
  if (!segments.includes(RUNTIME_SEGMENT)) {
    throw new LocalHostBindingError("ERR_BINDING_SCOPE", {
      dir: resolved,
      expectedSegment: RUNTIME_SEGMENT,
    });
  }
  return resolved;
}

function assertNoSymlinkAncestors(candidate) {
  const resolved = path.resolve(candidate);
  // Inspect the caller-owned runtime root and its project-level parent. Do
  // not reject platform aliases above that boundary (for example macOS
  // `/var` -> `/private/var`), which are outside the caller's control.
  for (const cursor of [path.dirname(resolved), resolved]) {
    try {
      if (fs.lstatSync(cursor).isSymbolicLink()) {
        throw new LocalHostBindingError("ERR_BINDING_SCOPE", {
          reason: "symlink_in_path",
          path: cursor,
        });
      }
    } catch (error) {
      if (error && error.code === "ENOENT") continue;
      throw error;
    }
  }
}

function assertRegularFile(file, consumerId) {
  const lstat = fs.lstatSync(file);
  if (!lstat.isFile() || lstat.isSymbolicLink()) {
    throw new LocalHostBindingError("ERR_BINDING_SCOPE", {
      consumerId,
      reason: "unsafe_binding_file",
    });
  }
}

function fileNameForConsumer(consumerId) {
  assertConsumerId(consumerId);
  const digest = crypto.createHash("sha256").update(consumerId, "utf8").digest("hex");
  return `${ENVELOPE_PREFIX}${digest}${ENVELOPE_SUFFIX}`;
}

// Reject symlinked parent directories (any of them) and ensure the resolved
// path stays inside the caller-provided runtime root. After this call the
// caller can safely open / write the binding file.
function safeResolve(rootDir, consumerId) {
  const root = assertRuntimeScoped(rootDir);
  assertNoSymlinkAncestors(root);
  // The runtime root itself must not be a symlink: a symlink here would let
  // a caller redirect the entire bindings directory to an arbitrary path.
  // Note: the runtime root may not exist yet (first-run); we only inspect
  // when present.
  try {
    const rootLstat = fs.lstatSync(root);
    if (rootLstat.isSymbolicLink()) {
      throw new LocalHostBindingError("ERR_BINDING_SCOPE", {
        reason: "symlink_runtime_root",
        path: root,
      });
    }
  } catch (error) {
    if (!error || error.code !== "ENOENT") throw error;
  }
  const bindingsDir = path.join(root, BINDINGS_DIR_NAME);
  // Recursively refuse symlinks: a malicious runtime root could place a
  // symlink at any of the parents, redirecting the write outside `.agent-runtime`.
  let cursor = bindingsDir;
  while (true) {
    let lstat;
    try {
      lstat = fs.lstatSync(cursor);
    } catch (error) {
      if (error && error.code === "ENOENT") break;
      throw error;
    }
    if (lstat.isSymbolicLink()) {
      throw new LocalHostBindingError("ERR_BINDING_SCOPE", {
        reason: "symlink_in_path",
        path: cursor,
      });
    }
    if (cursor === root) break;
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  if (!fs.existsSync(bindingsDir)) fs.mkdirSync(bindingsDir, { recursive: true });
  // Re-stat after mkdir so a concurrent symlink-swap is caught.
  const lstat2 = fs.lstatSync(bindingsDir);
  if (lstat2.isSymbolicLink()) {
    throw new LocalHostBindingError("ERR_BINDING_SCOPE", {
      reason: "symlink_directory",
      dir: bindingsDir,
    });
  }
  const file = path.join(bindingsDir, fileNameForConsumer(consumerId));
  // Defence in depth: ensure the resolved file is inside the root.
  const resolvedFile = path.resolve(file);
  const resolvedRoot = path.resolve(root);
  const rootWithSep = resolvedRoot.endsWith(path.sep) ? resolvedRoot : resolvedRoot + path.sep;
  if (!resolvedFile.startsWith(rootWithSep)) {
    throw new LocalHostBindingError("ERR_BINDING_SCOPE", {
      reason: "outside_root",
      resolvedFile,
      resolvedRoot,
    });
  }
  return { root: resolvedRoot, bindingsDir, file };
}

function writeAtomic(file, payload) {
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  let fd;
  try {
    fd = fs.openSync(tmp, "wx", 0o600);
    fs.writeFileSync(fd, payload, "utf8");
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(tmp, file);
    const dirFd = fs.openSync(path.dirname(file), "r");
    try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
  } finally {
    if (fd != null) try { fs.closeSync(fd); } catch { /* best effort */ }
    try { fs.unlinkSync(tmp); } catch { /* renamed or already gone */ }
  }
}

// ─── Envelope normalisation ────────────────────────────────────────────────

function normaliseBinding(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new LocalHostBindingError("ERR_BINDING_FIELD", { field: "binding", reason: "must be object" });
  }
  const consumerId = assertConsumerId(input.consumerId);
  const target = assertTarget(input.target);
  const adapter = assertAdapterId(input.adapter);
  const fallback = input.fallback
    ? assertStringList(input.fallback, "fallback", assertAdapterId)
    : [];
  const subscriptions = input.subscriptions
    ? assertStringList(input.subscriptions, "subscriptions", assertEventType)
    : [];
  // Built but not yet persisted: the schema validator catches unknown keys.
  const binding = {
    consumerId,
    target,
    adapter,
    fallback,
    subscriptions,
    schemaVersion: typeof input.schemaVersion === "string" && input.schemaVersion.length > 0
      ? input.schemaVersion
      : SCHEMA_VERSION,
  };
  const verdict = validateLocalHostBinding(binding);
  if (!verdict.ok) {
    throw new LocalHostBindingError("ERR_BINDING_SCHEMA", { errors: verdict.errors });
  }
  // The schema is closed (`additionalProperties: false`), but we additionally
  // reject any unknown input keys before they could reach scrubReceipt. This
  // makes "rogue field" failures deterministic at the input boundary instead
  // of relying on the schema validator alone.
  const knownKeys = new Set(Object.keys(binding));
  for (const key of Object.keys(input)) {
    if (!knownKeys.has(key)) {
      throw new LocalHostBindingError("ERR_BINDING_FIELD", { field: key, reason: "unknown_key" });
    }
  }
  return binding;
}

function buildEnvelope(projectId, binding, clock) {
  if (typeof projectId !== "string" || !projectId) {
    throw new LocalHostBindingError("ERR_BINDING_FIELD", { field: "projectId", reason: "must be string" });
  }
  const envelope = {
    schemaVersion: SCHEMA_VERSION,
    projectId,
    binding,
    updatedAt: new Date(clock()).toISOString(),
  };
  const verdict = validateBindingPersistenceEnvelope(envelope);
  if (!verdict.ok) {
    throw new LocalHostBindingError("ERR_BINDING_SCHEMA", { errors: verdict.errors });
  }
  return envelope;
}

// ─── LocalHostBindingStore class ───────────────────────────────────────────

class LocalHostBindingStore {
  constructor(rootDir, projectId, options = {}) {
    if (typeof projectId !== "string" || !projectId) {
      throw new LocalHostBindingError("ERR_BINDING_FIELD", { field: "projectId", reason: "must be string" });
    }
    this.projectId = projectId;
    this.clock = options.clock || Date.now;
    const { root, bindingsDir, file } = safeResolve(rootDir, projectId);
    this.rootDir = root;
    this.bindingsDir = bindingsDir;
    // The store owns its `bindingsDir` but does not pre-create a per-file
    // path; file paths are resolved per-consumer on every operation.
    this._scratchFile = file; // unused beyond the scope check
    void this._scratchFile;
  }

  _resolve(consumerId) {
    return safeResolve(this.rootDir, consumerId);
  }

  _envelopeFor(binding) {
    // Scrub the binding through the receipt scrubber to make absolutely
    // sure no secret-shaped field ever reaches the disk.
    const safeBinding = scrubReceipt(binding);
    const verdict = validateLocalHostBinding(safeBinding);
    if (!verdict.ok) {
      throw new LocalHostBindingError("ERR_BINDING_SCHEMA", { errors: verdict.errors });
    }
    const envelope = {
      schemaVersion: SCHEMA_VERSION,
      projectId: this.projectId,
      binding: safeBinding,
      updatedAt: new Date(this.clock()).toISOString(),
    };
    const envVerdict = validateBindingPersistenceEnvelope(envelope);
    if (!envVerdict.ok) {
      throw new LocalHostBindingError("ERR_BINDING_SCHEMA", { errors: envVerdict.errors });
    }
    return envelope;
  }

  save(binding) {
    const normalised = normaliseBinding(binding);
    const { file } = this._resolve(normalised.consumerId);
    const envelope = this._envelopeFor(normalised);
    writeAtomic(file, JSON.stringify(envelope, null, 2) + "\n");
    return JSON.parse(JSON.stringify(envelope));
  }

  load(consumerId) {
    const id = assertConsumerId(consumerId);
    const { file } = this._resolve(id);
    if (!fs.existsSync(file)) return null;
    assertRegularFile(file, id);
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (error) {
      throw new LocalHostBindingError("ERR_BINDING_CORRUPT", {
        consumerId: id,
        reason: "read_failed",
        cause: error && error.code,
      });
    }
    const verdict = validateBindingPersistenceEnvelope(parsed);
    if (!verdict.ok) {
      throw new LocalHostBindingError("ERR_BINDING_CORRUPT", {
        consumerId: id,
        reason: "schema",
        errors: verdict.errors,
      });
    }
    if (parsed.projectId !== this.projectId) {
      throw new LocalHostBindingError("ERR_BINDING_CORRUPT", {
        consumerId: id,
        reason: "project_mismatch",
        actual: parsed.projectId,
      });
    }
    return JSON.parse(JSON.stringify(parsed));
  }

  list() {
    if (!fs.existsSync(this.bindingsDir)) return [];
    const entries = fs.readdirSync(this.bindingsDir)
      .filter((name) => name.startsWith(ENVELOPE_PREFIX) && name.endsWith(ENVELOPE_SUFFIX));
    const out = [];
    for (const name of entries) {
      const filePath = path.join(this.bindingsDir, name);
      const lstat = fs.lstatSync(filePath);
      if (lstat.isSymbolicLink()) continue;
      let parsed;
      try {
        parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
      } catch {
        continue; // skip corrupt entries — listing is best effort
      }
      const verdict = validateBindingPersistenceEnvelope(parsed);
      if (!verdict.ok) continue;
      if (parsed.projectId !== this.projectId) continue;
      out.push(JSON.parse(JSON.stringify(parsed)));
    }
    out.sort((a, b) => a.binding.consumerId.localeCompare(b.binding.consumerId));
    return out;
  }

  delete(consumerId) {
    const id = assertConsumerId(consumerId);
    const { file } = this._resolve(id);
    if (!fs.existsSync(file)) return false;
    try {
      fs.unlinkSync(file);
    } catch (error) {
      throw new LocalHostBindingError("ERR_BINDING_DELETE", {
        consumerId: id,
        cause: error && error.code,
      });
    }
    return true;
  }

  // Convenience helpers for the L3 binding envelope (P-003 §5.2). They keep
  // the same redacted-receipt invariants: every value is scrubbed before it
  // ever reaches the disk.

  setSubscriptions(consumerId, eventTypes) {
    const list = assertStringList(eventTypes, "eventTypes", assertEventType);
    const existing = this.load(consumerId);
    if (!existing) {
      throw new LocalHostBindingError("ERR_BINDING_NOT_FOUND", { consumerId });
    }
    const merged = {
      ...existing.binding,
      subscriptions: list,
    };
    return this.save(merged);
  }

  setFallback(consumerId, fallbackChain) {
    const chain = assertStringList(fallbackChain, "fallback", assertAdapterId);
    const existing = this.load(consumerId);
    if (!existing) {
      throw new LocalHostBindingError("ERR_BINDING_NOT_FOUND", { consumerId });
    }
    const merged = {
      ...existing.binding,
      fallback: chain,
    };
    return this.save(merged);
  }

  // ─── Test seams ────────────────────────────────────────────────────────

  get _directory() {
    return this.bindingsDir;
  }
}

module.exports = {
  LocalHostBindingStore,
  LocalHostBindingError,
  SCHEMA_VERSION,
  MAX_CONSUMER_ID_LEN,
  MAX_ADAPTER_ID_LEN,
  fileNameForConsumer,
  safeResolve,
  assertConsumerId,
  assertAdapterId,
  assertEventType,
  assertSafeReceiptField,
  scrubReceipt,
  normaliseBinding,
};
