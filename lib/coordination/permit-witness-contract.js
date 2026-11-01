"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

// Candidate state contract/offline codec, NOT a witness service or authorization.
// The future authority must load current from its database and obtain facts
// from authenticated, authorized server state (including signature, issuance,
// lease/epoch/fencing/desktop and global consumption checks). Never pass request
// data as facts. It must commit the returned full state/checkpoint together with
// permit consumption in ONE serializable transaction before authorizing anything.
// These functions provide no authentication, authority persistence, CAS exclusion, history
// retention, baseline verification, registration protocol or execution receipt.
// Offline migration below preserves an ALREADY VERIFIED complete baseline; it
// cannot establish one, upgrade incomplete legacy schemas, or activate a store.
const FORMAT_VERSION = 1;
const LIMITS = Object.freeze({ bytes: 1024 * 1024, stringBytes: 65536,
  depth: 16, nodes: 20000, entries: 1024 });
const MIGRATION_CHUNK_BYTES = 16384;
const OPERATIONS = Object.freeze([
  "register_pin", "apply_revocation", "note_revocation_seen", "observe_clock", "accept_permit",
]);
const LONGEST_OPERATION = OPERATIONS.reduce((longest, operation) =>
  Buffer.byteLength(JSON.stringify(operation)) > Buffer.byteLength(JSON.stringify(longest)) ? operation : longest, "");
const STATE_FIELDS = Object.freeze([
  "schema_version", "pins", "revoked_fingerprints", "applied_revocation_sequence",
  "highest_seen_revocation_sequence", "highest_accepted_permit_sequence",
  "last_observed_clock_ms", "clock_poisoned",
]);
const PIN_FIELDS = Object.freeze([
  "decision_id", "instance_id", "fingerprint", "public_key_pem", "registered_at_ms",
  "source_digest", "deployment_digest", "run_id", "generation", "valid_from", "valid_until",
]);
const TOKEN_FIELDS = Object.freeze([
  "format_version", "authority_id", "target_id", "store_generation", "revision", "full_state_digest",
]);

class PermitWitnessContractError extends Error {
  constructor(code) { super(code); this.name = "PermitWitnessContractError"; this.code = code; }
}
function fail(code = "ERR_WITNESS_INPUT") { throw new PermitWitnessContractError(code); }
function integer(value, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum || Object.is(value, -0)) fail();
}
function text(value) {
  if (typeof value !== "string" || !value) fail();
}
function hash(value) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) fail();
}
function exact(value, fields) {
  if (!value || Array.isArray(value) || typeof value !== "object" ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail();
  const keys = Reflect.ownKeys(value);
  if (keys.length !== fields.length || keys.some((key) => !fields.includes(key))) fail();
  for (const key of keys) {
    const desc = Object.getOwnPropertyDescriptor(value, key);
    if (!desc.enumerable || !Object.hasOwn(desc, "value")) fail();
  }
}

// Encoding v1: UTF-8 JSON, no whitespace/BOM/newline, object keys sorted by
// UTF-16 code units; array order preserved; safe integers only, no negative zero.
// Strings retain Unicode spelling (no NFC normalization); JSON escapes lone
// surrogates so legacy UTF-16 data round-trips without replacement. No omitted
// values, coercion, toJSON, accessors or exotic objects.
// Limits and domain prefix below are versioned parts of this candidate format.
function canonicalBytes(value) {
  let nodes = 0;
  let bytes = 0;
  const active = new Set();
  function charge(size) {
    bytes += size;
    if (bytes > LIMITS.bytes) fail();
  }
  function literal(item) {
    charge(Buffer.byteLength(item, "utf8"));
    return item;
  }
  function string(item) {
    if (Buffer.byteLength(item, "utf8") > LIMITS.stringBytes) fail();
    return literal(JSON.stringify(item));
  }
  function encode(item, depth) {
    if (++nodes > LIMITS.nodes || depth > LIMITS.depth) fail();
    if (item === null) return literal("null");
    if (typeof item === "string") return string(item);
    if (typeof item === "boolean") return literal(String(item));
    if (typeof item === "number") {
      if (!Number.isSafeInteger(item) || Object.is(item, -0)) fail();
      return literal(String(item));
    }
    if (!item || typeof item !== "object" || active.has(item)) fail();
    active.add(item);
    let result;
    if (Array.isArray(item)) {
      if (Object.getPrototypeOf(item) !== Array.prototype || item.length > LIMITS.entries ||
          Reflect.ownKeys(item).length !== item.length + 1) fail();
      charge(item.length ? item.length + 1 : 2); // Brackets and commas.
      const parts = [];
      for (let i = 0; i < item.length; i += 1) {
        const desc = Object.getOwnPropertyDescriptor(item, String(i));
        if (!desc || !desc.enumerable || !Object.hasOwn(desc, "value")) fail();
        parts.push(encode(desc.value, depth + 1));
      }
      result = "[" + parts.join(",") + "]";
    } else {
      if (![Object.prototype, null].includes(Object.getPrototypeOf(item))) fail();
      const keys = Reflect.ownKeys(item);
      if (keys.length > LIMITS.entries || keys.some((key) => typeof key !== "string")) fail();
      charge(keys.length ? keys.length * 2 + 1 : 2); // Braces, colons and commas.
      result = "{" + keys.sort().map((key) => {
        const desc = Object.getOwnPropertyDescriptor(item, key);
        if (!desc.enumerable || !Object.hasOwn(desc, "value")) fail();
        return string(key) + ":" + encode(desc.value, depth + 1);
      }).join(",") + "}";
    }
    active.delete(item);
    return result;
  }
  const encoded = encode(value, 0);
  return Buffer.from(encoded, "utf8");
}

function copy(value) { return JSON.parse(canonicalBytes(value).toString("utf8")); }
// Trusted authority/offline collections are not network messages. Validate
// their shape without imposing the online history/string/body ceilings. Total
// memory is NOT bounded independently of history: copies, sorting and digest
// validation require memory proportional to the complete trusted state.
function dataArray(value) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype ||
      Reflect.ownKeys(value).length !== value.length + 1) fail();
  const result = [];
  for (let i = 0; i < value.length; i += 1) {
    const desc = Object.getOwnPropertyDescriptor(value, String(i));
    if (!desc || !desc.enumerable || !Object.hasOwn(desc, "value")) fail();
    result.push(desc.value);
  }
  return result;
}
function fingerprints(values) {
  values = dataArray(values);
  values.forEach(hash);
  if (new Set(values).size !== values.length) fail();
  return [...values].sort();
}
function pinEntry(pin) {
  exact(pin, PIN_FIELDS);
  // ProtectedPinStore carries these labels as nonempty text, often `sha256:...`.
  // Preserve them verbatim; only the actual key fingerprint is a fixed hex hash.
  for (const name of ["decision_id", "instance_id", "run_id", "generation", "source_digest", "deployment_digest"]) text(pin[name]);
  hash(pin.fingerprint);
  // Historical registration records accept signed safe integers without an
  // interval-order constraint. Current validity belongs to server policy.
  for (const name of ["registered_at_ms", "valid_from", "valid_until"]) integer(pin[name], Number.MIN_SAFE_INTEGER);
  text(pin.public_key_pem);
  if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(pin.public_key_pem)) fail();
  let key;
  try { key = crypto.createPublicKey(pin.public_key_pem); } catch { fail(); }
  // Match key material, retaining the original PEM spelling and algorithm.
  // Eligibility to sign a current permit is a separate server-side decision.
  if (crypto.createHash("sha256").update(key.export({ type: "spki", format: "der" }))
        .digest("hex") !== pin.fingerprint) fail();
  return { ...pin };
}

// Internal only: input has already been schema-validated and copied. Emit the
// SAME canonical v1 bytes in bounded pieces, including strings larger than a
// message. Never split a surrogate pair before JSON escaping; lone surrogates
// retain their exact UTF-16 spelling. No public switch disables online limits.
function* trustedBytes(value) {
  if (typeof value === "string") {
    yield Buffer.from('"');
    for (let start = 0; start < value.length;) {
      let end = Math.min(start + 4096, value.length);
      if (end < value.length && /[\ud800-\udbff]/.test(value[end - 1]) &&
          /[\udc00-\udfff]/.test(value[end])) end -= 1;
      yield Buffer.from(JSON.stringify(value.slice(start, end)).slice(1, -1), "utf8");
      start = end;
    }
    yield Buffer.from('"');
  } else if (value === null || typeof value !== "object") {
    yield Buffer.from(JSON.stringify(value));
  } else if (Array.isArray(value)) {
    yield Buffer.from("[");
    for (let i = 0; i < value.length; i += 1) {
      if (i) yield Buffer.from(",");
      yield* trustedBytes(value[i]);
    }
    yield Buffer.from("]");
  } else {
    yield Buffer.from("{");
    let first = true;
    for (const key of Object.keys(value).sort()) {
      if (!first) yield Buffer.from(",");
      first = false;
      yield* trustedBytes(key);
      yield Buffer.from(":");
      yield* trustedBytes(value[key]);
    }
    yield Buffer.from("}");
  }
}
function normalizedDigest(state) {
  const digest = crypto.createHash("sha256").update("cortex-permit-witness-target-state-v1\n");
  for (const bytes of trustedBytes(state)) digest.update(bytes);
  return digest.digest("hex");
}

// The complete pin-state body of the current format-3 target, not an import or
// proof of its baseline. AUTHORITY/OFFLINE INPUT ONLY, never request state.
// Missing legacy replay/clock fields are never defaulted.
// Set-like arrays have a fixed order; duplicates and unknown fields are refused.
function normalizeTargetState(input) {
  exact(input, STATE_FIELDS);
  const state = { ...input };
  if (state.schema_version !== 3 || !Array.isArray(state.pins) ||
      typeof state.clock_poisoned !== "boolean") fail("ERR_WITNESS_STATE");
  for (const name of STATE_FIELDS.slice(3, 7)) integer(state[name]);
  if (state.highest_seen_revocation_sequence < state.applied_revocation_sequence) fail("ERR_WITNESS_STATE");
  state.pins = dataArray(state.pins).map(pinEntry);
  if (new Set(state.pins.map((pin) => pin.fingerprint)).size !== state.pins.length) fail("ERR_WITNESS_STATE");
  state.pins.sort((a, b) => a.fingerprint < b.fingerprint ? -1 : a.fingerprint > b.fingerprint ? 1 : 0);
  state.revoked_fingerprints = fingerprints(state.revoked_fingerprints);
  return state;
}
function targetStateDigest(state) {
  return normalizedDigest(normalizeTargetState(state));
}
function token(value) {
  exact(value, TOKEN_FIELDS);
  if (value.format_version !== FORMAT_VERSION) fail();
  for (const name of ["authority_id", "target_id", "store_generation"]) text(value[name]);
  integer(value.revision, 1);
  hash(value.full_state_digest);
  // A checkpoint must fit in every supported bounded envelope, including after
  // a revision grows to its largest representation. The manifest is checked
  // with the largest possible safe count and length; intent is its strict
  // subset. The longest JSON-encoded operation covers the others. Check actual
  // JSON escaping, not source string lengths.
  const future = { ...value, revision: Number.MAX_SAFE_INTEGER };
  canonicalBytes({ operation: LONGEST_OPERATION, checkpoint: future });
  canonicalBytes({ format_version: 1, checkpoint: future, chunk_bytes: MIGRATION_CHUNK_BYTES,
    chunks: Number.MAX_SAFE_INTEGER, bytes: Number.MAX_SAFE_INTEGER, chain_digest: "f".repeat(64) });
}

// Authority-only construction from a VERIFIED baseline and provisioned identity.
// store_generation is separate from the signed run's `generation` field.
function createCheckpoint(binding, input) {
  binding = copy(binding);
  exact(binding, ["authority_id", "target_id", "store_generation", "revision"]);
  // Reject unusable bindings before scanning a potentially very large state.
  token({ format_version: FORMAT_VERSION, ...binding, full_state_digest: "0".repeat(64) });
  const state = normalizeTargetState(input);
  const checkpoint = { format_version: FORMAT_VERSION, ...binding, full_state_digest: normalizedDigest(state) };
  token(checkpoint);
  return { checkpoint, state };
}
function validatedCurrent(input) {
  exact(input, ["checkpoint", "state"]);
  const current = { checkpoint: copy(input.checkpoint), state: normalizeTargetState(input.state) };
  token(current.checkpoint);
  if (normalizedDigest(current.state) !== current.checkpoint.full_state_digest) fail("ERR_WITNESS_STATE");
  return current;
}
function assertCheckpointMatches(currentInput, expectedInput) {
  const expected = copy(expectedInput);
  token(expected);
  exact(currentInput, ["checkpoint", "state"]);
  const checkpoint = copy(currentInput.checkpoint);
  token(checkpoint);
  // A client conflict must not trigger a scan of arbitrarily large trusted history.
  if (!canonicalBytes(checkpoint).equals(canonicalBytes(expected))) fail("ERR_WITNESS_CHECKPOINT_CONFLICT");
  return validatedCurrent({ checkpoint, state: currentInput.state });
}
function applyRevocation(state, entry) {
  exact(entry, ["sequence", "revoked_fingerprints"]);
  integer(entry.sequence, 1);
  if (!Number.isSafeInteger(state.applied_revocation_sequence + 1) ||
      entry.sequence !== state.applied_revocation_sequence + 1) fail("ERR_WITNESS_REVOCATION_CHAIN");
  const incoming = fingerprints(entry.revoked_fingerprints);
  const incomingSet = new Set(incoming);
  if (state.revoked_fingerprints.some((fingerprint) => !incomingSet.has(fingerprint))) {
    fail("ERR_WITNESS_REVOCATION_REGRESSION");
  }
  state.revoked_fingerprints = incoming;
  state.applied_revocation_sequence = entry.sequence;
  state.highest_seen_revocation_sequence = Math.max(state.highest_seen_revocation_sequence, entry.sequence);
}

// request is the ENTIRE client-controlled input, with an exact allowlist.
// facts is a separate authority-only argument, not a verified:true client flag.
// Returns a proposed complete state, never an executable authorization. A clock
// rollback proposes a poisoned state for the caller to commit before refusal.
// The host must commit observe_clock even when a separate accept_permit fails;
// rejecting acceptance alone does not persist poison or a valid revocation.
function deriveTransition(currentInput, requestInput, factsInput) {
  const request = copy(requestInput);
  exact(request, ["operation", "checkpoint"]);
  // Keep the envelope bound and accepted operations tied to the same list.
  if (!OPERATIONS.includes(request.operation)) fail("ERR_WITNESS_OPERATION");
  const current = assertCheckpointMatches(currentInput, request.checkpoint);
  // Like current, facts come ONLY from authenticated authority state. Each
  // operation checks exact data properties before reading them. In particular,
  // a cumulative revocation set may exceed a network message after migration.
  const facts = factsInput;
  const next = current.state;
  switch (request.operation) {
    case "register_pin": {
      exact(facts, ["pin"]);
      const pin = pinEntry(facts.pin);
      if (next.pins.some((existing) => existing.fingerprint === pin.fingerprint)) fail("ERR_WITNESS_PIN_EXISTS");
      next.pins.push(pin);
      break;
    }
    case "apply_revocation":
      applyRevocation(next, facts);
      break;
    case "note_revocation_seen":
      exact(facts, ["sequence"]);
      integer(facts.sequence, 1);
      if (facts.sequence <= next.highest_seen_revocation_sequence) fail("ERR_WITNESS_NO_CHANGE");
      next.highest_seen_revocation_sequence = facts.sequence;
      break;
    case "observe_clock":
      exact(facts, ["now_ms"]);
      integer(facts.now_ms);
      if (facts.now_ms < next.last_observed_clock_ms) next.clock_poisoned = true;
      else next.last_observed_clock_ms = facts.now_ms;
      break;
    case "accept_permit":
      exact(facts, ["now_ms", "permit_sequence", "fingerprint", "revocation"]);
      integer(facts.now_ms);
      integer(facts.permit_sequence, 1);
      hash(facts.fingerprint);
      if (next.clock_poisoned || facts.now_ms < next.last_observed_clock_ms) fail("ERR_WITNESS_CLOCK");
      if (facts.permit_sequence <= next.highest_accepted_permit_sequence) fail("ERR_WITNESS_PERMIT_REPLAY");
      // Even an unchanged revoked set requires the next authenticated chain entry.
      applyRevocation(next, facts.revocation);
      if (next.highest_seen_revocation_sequence !== next.applied_revocation_sequence) fail("ERR_WITNESS_REVOCATION_CHAIN");
      if (!next.pins.some((pin) => pin.fingerprint === facts.fingerprint) ||
          next.revoked_fingerprints.includes(facts.fingerprint)) fail("ERR_WITNESS_SIGNER");
      next.highest_accepted_permit_sequence = facts.permit_sequence;
      next.last_observed_clock_ms = facts.now_ms;
      break;
    default: fail("ERR_WITNESS_OPERATION");
  }
  if (targetStateDigest(next) === current.checkpoint.full_state_digest) fail("ERR_WITNESS_NO_CHANGE");
  const { authority_id, target_id, store_generation, revision } = current.checkpoint;
  integer(revision + 1, 1);
  return createCheckpoint({ authority_id, target_id, store_generation, revision: revision + 1 }, next);
}

// OFFLINE ONLY. The operator must quiesce all writers and provide an exclusively
// owned directory on a trusted filesystem, outside request-controlled paths.
// The caller must enforce exclusive access and directory permissions; these
// helpers have no lock and do not make concurrent readers/writers safe.
// expectedCheckpoint MUST come from independent trusted authority evidence, not
// from this directory. Neither JSON validity nor a local digest proves a legacy
// baseline. These helpers do not change registration, activation or authority
// history, and do not claim whole-volume rollback or Windows durability safety.
//
// intent.json binds every restart to the same identity/revision/full digest.
// chunk-N.bin contains the next <=16 KiB canonical state bytes (not base64).
// A domain-separated chain binds checkpoint, index, length, predecessor and
// bytes. manifest.json records exact count/length/final chain and is written
// LAST. Readers require all records and the independent state digest before
// returning anything. No partial state is ever returned or treated as current.
//
// Resume REGENERATES bytes from the complete verified source. An existing file
// must be an exact prefix; only its missing suffix may be appended. Mismatches,
// foreign files and overlong files are refused without overwriting them. This
// handles crashes even during intent/chunk/manifest writes or fsync: complete
// files are rechecked and fsynced, missing bytes are regenerated, never guessed.
// Restoring a finished bundle needs no original source or in-memory cursor.
function migrationFile(index) { return "chunk-" + String(index).padStart(12, "0") + ".bin"; }
function syncDirectory(directory) {
  const fd = fs.openSync(directory, "r");
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function migrationDirectory(directory, create) {
  if (create) {
    try {
      fs.mkdirSync(directory, { mode: 0o700 });
    } catch (error) { if (error.code !== "EEXIST") throw error; }
  }
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail("ERR_WITNESS_MIGRATION");
  if (create) syncDirectory(path.dirname(path.resolve(directory)));
}
function regularFile(fd) {
  const stat = fs.fstatSync(fd);
  if (!stat.isFile() || stat.nlink !== 1) fail("ERR_WITNESS_MIGRATION");
  return stat;
}
function readMigrationFile(filename, maximum) {
  const fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const { size } = regularFile(fd);
    if (size > maximum) fail("ERR_WITNESS_MIGRATION");
    const bytes = Buffer.alloc(size);
    let offset = 0;
    while (offset < size) {
      const read = fs.readSync(fd, bytes, offset, size - offset, offset);
      if (!read) fail("ERR_WITNESS_MIGRATION");
      offset += read;
    }
    if (fs.readSync(fd, Buffer.alloc(1), 0, 1, size)) fail("ERR_WITNESS_MIGRATION");
    return bytes;
  } finally { fs.closeSync(fd); }
}
function persistMigrationFile(directory, name, bytes) {
  const filename = path.join(directory, name);
  const fd = fs.openSync(filename, fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW, 0o600);
  try {
    const { size } = regularFile(fd);
    if (size > bytes.length || !readMigrationFile(filename, bytes.length).equals(bytes.subarray(0, size))) {
      fail("ERR_WITNESS_MIGRATION_CONFLICT");
    }
    let offset = size;
    while (offset < bytes.length) {
      const written = fs.writeSync(fd, bytes, offset, bytes.length - offset, offset);
      if (!written) fail("ERR_WITNESS_MIGRATION");
      offset += written;
    }
    fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
  syncDirectory(directory);
}
function migrationIntent(checkpoint) {
  return { format_version: 1, checkpoint, chunk_bytes: MIGRATION_CHUNK_BYTES };
}
function chainStart(checkpoint) {
  return crypto.createHash("sha256").update("cortex-permit-witness-migration-v1\n")
    .update(canonicalBytes(checkpoint)).digest("hex");
}
function chainNext(previous, index, bytes) {
  return crypto.createHash("sha256").update("cortex-permit-witness-migration-chunk-v1\n")
    .update(canonicalBytes({ previous, index, bytes: bytes.length })).update(bytes).digest("hex");
}
function* migrationChunks(state) {
  let chunk = Buffer.alloc(MIGRATION_CHUNK_BYTES);
  let used = 0;
  for (const bytes of trustedBytes(state)) {
    for (let offset = 0; offset < bytes.length;) {
      const size = Math.min(bytes.length - offset, chunk.length - used);
      bytes.copy(chunk, used, offset, offset + size);
      offset += size;
      used += size;
      if (used === chunk.length) {
        yield chunk;
        chunk = Buffer.alloc(MIGRATION_CHUNK_BYTES);
        used = 0;
      }
    }
  }
  if (used) yield chunk.subarray(0, used);
}
function migrationFiles(directory, count, completed) {
  const names = fs.readdirSync(directory);
  // Refuse forged enormous counts before allocating/iterating from metadata.
  if (completed && names.length !== count + 2) fail("ERR_WITNESS_MIGRATION");
  const expected = new Set(["intent.json", "manifest.json"]);
  for (let index = 0; index < count; index += 1) expected.add(migrationFile(index));
  if (names.some((name) => !expected.has(name))) {
    fail("ERR_WITNESS_MIGRATION");
  }
}
function writeTrustedCheckpointMigration(directory, currentInput, expectedCheckpoint) {
  const current = assertCheckpointMatches(currentInput, expectedCheckpoint);
  migrationDirectory(directory, true);
  const intent = migrationIntent(current.checkpoint);
  persistMigrationFile(directory, "intent.json", canonicalBytes(intent));
  let count = 0;
  let length = 0;
  let chain = chainStart(current.checkpoint);
  for (const bytes of migrationChunks(current.state)) {
    persistMigrationFile(directory, migrationFile(count), bytes);
    chain = chainNext(chain, count, bytes);
    count += 1;
    length += bytes.length;
    integer(count, 1);
    integer(length, 1);
  }
  migrationFiles(directory, count, false);
  const manifest = { ...intent, chunks: count, bytes: length, chain_digest: chain };
  persistMigrationFile(directory, "manifest.json", canonicalBytes(manifest));
  return manifest;
}
function readMigrationRecord(directory, name) {
  const bytes = readMigrationFile(path.join(directory, name), LIMITS.bytes);
  let record;
  try { record = JSON.parse(bytes.toString("utf8")); } catch { fail("ERR_WITNESS_MIGRATION"); }
  if (!canonicalBytes(record).equals(bytes)) fail("ERR_WITNESS_MIGRATION");
  return record;
}
function restoreTrustedCheckpointMigration(directory, expectedInput) {
  const expected = copy(expectedInput);
  token(expected);
  migrationDirectory(directory, false);
  const intent = readMigrationRecord(directory, "intent.json");
  if (!canonicalBytes(intent).equals(canonicalBytes(migrationIntent(expected)))) fail("ERR_WITNESS_MIGRATION_CONFLICT");
  const manifest = readMigrationRecord(directory, "manifest.json");
  exact(manifest, ["format_version", "checkpoint", "chunk_bytes", "chunks", "bytes", "chain_digest"]);
  if (!canonicalBytes({ format_version: manifest.format_version, checkpoint: manifest.checkpoint,
    chunk_bytes: manifest.chunk_bytes }).equals(canonicalBytes(intent))) fail("ERR_WITNESS_MIGRATION_CONFLICT");
  integer(manifest.chunks, 1);
  integer(manifest.bytes, 1);
  hash(manifest.chain_digest);
  if (manifest.chunks !== Math.ceil(manifest.bytes / MIGRATION_CHUNK_BYTES)) fail("ERR_WITNESS_MIGRATION");
  migrationFiles(directory, manifest.chunks, true);
  let chain = chainStart(expected);
  const digest = crypto.createHash("sha256").update("cortex-permit-witness-target-state-v1\n");
  const chunks = [];
  for (let index = 0; index < manifest.chunks; index += 1) {
    const size = Math.min(MIGRATION_CHUNK_BYTES, manifest.bytes - index * MIGRATION_CHUNK_BYTES);
    const bytes = readMigrationFile(path.join(directory, migrationFile(index)), size);
    if (bytes.length !== size) fail("ERR_WITNESS_MIGRATION");
    chain = chainNext(chain, index, bytes);
    digest.update(bytes);
    chunks.push(bytes);
  }
  if (chain !== manifest.chain_digest || digest.digest("hex") !== expected.full_state_digest) {
    fail("ERR_WITNESS_MIGRATION");
  }
  // This final materialization is deliberately offline. Chunks, concatenated
  // bytes, decoded JSON, parsed objects and validated copies can coexist: total
  // memory is proportional to the entire history, with no fixed upper bound;
  // runtime Buffer/string limits and available memory may still prevent restore.
  // Online requests must never call this restore helper.
  let state;
  try { state = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { fail("ERR_WITNESS_MIGRATION"); }
  return assertCheckpointMatches({ checkpoint: expected, state }, expected);
}

module.exports = { FORMAT_VERSION, LIMITS, PermitWitnessContractError, canonicalBytes,
  normalizeTargetState, targetStateDigest, createCheckpoint, assertCheckpointMatches, deriveTransition,
  MIGRATION_CHUNK_BYTES, writeTrustedCheckpointMigration, restoreTrustedCheckpointMigration };
