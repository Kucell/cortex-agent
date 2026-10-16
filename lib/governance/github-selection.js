"use strict";

// S1: pure, read-only structural selection matching. This is NOT an identity
// authenticator, Owner binding, Decision processor, Waitpoint release or lease.
// Frozen policy supplies exact immutable account/repository IDs; no repository
// owner or login is inferred to be an Owner. Policy is data, not a trust anchor.
// Every argument remains untrusted data. Even a perfect match returns
// NOT_ESTABLISHED authentication. No caller-supplied flag, environment variable,
// callback, JSON signature label or provider capability can promote this result.
// A future protected controller must authenticate its GitHub transport/source,
// independently load frozen and latest canonical state, then revalidate and
// consume BOTH replay keys atomically with the canonical Decision transition.
// Persisted evidence is an audit object only, never a parallel grant database.

const crypto = require("node:crypto");
const evidenceSchema = JSON.parse(JSON.stringify(require("./github-selection-evidence.schema.json")));
const decisionSchema = JSON.parse(JSON.stringify(require("../../templates/_shared/.agent/decisions/decision.schema.json")));

const OPERATION_NAMES = Object.freeze(["plan", "implement", "test", "review", "local_commit"]);
const ACTIONS = Object.freeze(["approve", "reject", "request_revision"]);
const own = (v, k) => Object.prototype.hasOwnProperty.call(v, k);
const str = (pattern, maxLength = 256) => ({ type: "string", minLength: 1, maxLength, pattern });
const sha = str("^[a-f0-9]{40}$", 40);
const digest = str("^sha256:[a-f0-9]{64}$", 71);
const identifier = str("^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$", 128);
const project = str("^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$", 36);
const closed = (properties) => ({
  type: "object", required: Object.keys(properties), properties, additionalProperties: false,
});
const githubId = str("^[1-9][0-9]{0,19}$", 20);
const repositoryName = str("^[A-Za-z0-9][A-Za-z0-9_-]{0,38}/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$", 140);
const repository = (revisionField) => closed({
  id: githubId, name: repositoryName, [revisionField]: sha,
});
const controllerSchema = closed({
  workflow_path: str("^\\.github/workflows/[A-Za-z0-9_-][A-Za-z0-9_.-]{0,100}\\.ya?ml$", 128),
  ref: str("^refs/heads/[A-Za-z0-9][A-Za-z0-9_-]{0,63}$", 75),
  workflow_ref: str("^[A-Za-z0-9][A-Za-z0-9_-]{0,38}/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}/\\.github/workflows/[A-Za-z0-9_.-]+\\.ya?ml@refs/heads/[A-Za-z0-9_-]+$", 256),
  workflow_sha: sha,
  script_digest: digest,
});
const frozenSchema = closed({
  schema_version: { const: 1 },
  project_id: project,
  subject_id: githubId,
  product_repository: repository("head_sha"),
  governance_repository: repository("revision"),
  controller: controllerSchema,
  resource_ref: identifier,
  resource_digest: digest,
  decision_id: str("^D-[A-Za-z0-9][A-Za-z0-9._-]{0,125}$", 128),
  decision_digest: digest,
  operation_id: identifier,
  operation: { enum: OPERATION_NAMES },
  allowed_actions: { type: "array", minItems: 1, maxItems: 3, uniqueItems: true, items: { enum: ACTIONS } },
});
const selectionSchema = closed({
  project_id: project,
  resource_ref: identifier,
  resource_digest: digest,
  frozen_digest: digest,
  operation_id: identifier,
  action: { enum: ACTIONS },
});
const contextSchema = closed({
  repository_id: githubId,
  repository: repositoryName,
  sender_id: githubId,
  actor_id: githubId,
  triggering_actor_id: githubId,
  event_name: { const: "workflow_dispatch" },
  workflow_ref: controllerSchema.properties.workflow_ref,
  workflow_sha: sha,
  script_digest: digest,
  ref: controllerSchema.properties.ref,
  run_id: str("^[1-9][0-9]{0,19}$", 20),
  run_attempt: { const: 1 },
  inputs: selectionSchema,
});
const consumedKeys = { type: "array", maxItems: 10000, uniqueItems: true, items: digest };
const canonicalSchema = closed({
  project_id: project,
  revision: sha,
  resource_ref: identifier,
  resource_content: { type: "string", minLength: 1, maxLength: 1048576 },
  decision_id: frozenSchema.properties.decision_id,
  decision_content: { type: "string", minLength: 1, maxLength: 1048576 },
  consumed_run_keys: consumedKeys,
  consumed_selection_keys: consumedKeys,
});
const inputSchema = closed({
  selection: selectionSchema, frozen: frozenSchema, context: contextSchema, canonical: canonicalSchema,
});

class GitHubSelectionError extends Error {
  constructor(code, field = null) {
    super(code + (field ? ": " + field : ""));
    this.name = "GitHubSelectionError";
    this.code = code;
    this.field = field;
  }
}
function fail(code, field) { throw new GitHubSelectionError(code, field); }
function check(condition, code, field) { if (!condition) fail(code, field); }

// Accept inert JSON data only; never invoke accessors or toJSON callbacks.
// This is input hygiene, not a sandbox for hostile JavaScript in this process.
function copyData(value, field = "input", depth = 0, budget = { nodes: 0, chars: 0 }) {
  if (++budget.nodes > 25000 || depth > 20) fail("ERR_GITHUB_SELECTION_LIMIT", field);
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") {
    check(Number.isSafeInteger(value), "ERR_GITHUB_SELECTION_DATA", field);
    return value;
  }
  if (typeof value === "string") {
    budget.chars += value.length;
    check(budget.chars <= 2200000, "ERR_GITHUB_SELECTION_LIMIT", field);
    // Reject lone UTF-16 surrogates rather than silently replacing them in UTF-8.
    for (let i = 0; i < value.length; i++) {
      const c = value.charCodeAt(i);
      if (c >= 0xd800 && c <= 0xdbff) {
        const next = value.charCodeAt(++i);
        check(next >= 0xdc00 && next <= 0xdfff, "ERR_GITHUB_SELECTION_DATA", field);
      } else check(c < 0xdc00 || c > 0xdfff, "ERR_GITHUB_SELECTION_DATA", field);
    }
    return value;
  }
  check(value && typeof value === "object", "ERR_GITHUB_SELECTION_DATA", field);
  const array = Array.isArray(value);
  const proto = Object.getPrototypeOf(value);
  check(array ? proto === Array.prototype : proto === Object.prototype || proto === null,
    "ERR_GITHUB_SELECTION_DATA", field);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const names = Reflect.ownKeys(descriptors);
  check(names.every((k) => typeof k === "string"), "ERR_GITHUB_SELECTION_DATA", field);
  const result = array ? [] : Object.create(null);
  if (array) check(names.length === value.length + 1, "ERR_GITHUB_SELECTION_DATA", field);
  for (const key of names) {
    if (array && key === "length") continue;
    const d = descriptors[key];
    check(own(d, "value") && d.enumerable, "ERR_GITHUB_SELECTION_DATA", field + "." + key);
    if (array) check(/^(0|[1-9][0-9]*)$/.test(key) && Number(key) < value.length,
      "ERR_GITHUB_SELECTION_DATA", field);
    Object.defineProperty(result, key, { value: copyData(d.value, field + "." + key, depth + 1, budget),
      enumerable: true, writable: true, configurable: true });
  }
  return result;
}
function stable(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(stable).join(",") + "]";
  return "{" + Object.keys(value).sort().map((key) => JSON.stringify(key) + ":" + stable(value[key])).join(",") + "}";
}
function hashText(value) {
  return "sha256:" + crypto.createHash("sha256").update(value, "utf8").digest("hex");
}
function hashObject(value) { return hashText(stable(value)); }
function freeze(value) {
  if (value && typeof value === "object") {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}
freeze(evidenceSchema);
freeze(decisionSchema);

// Package-owned schema subset only. No remote schemas, code or plugins load.
function validate(schema, value, field) {
  const mismatch = () => fail("ERR_GITHUB_SELECTION_SCHEMA", field);
  const types = schema.type == null ? [] : [].concat(schema.type);
  const typeOf = value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
  if (types.length && !types.some((type) => type === typeOf || (type === "integer" && Number.isSafeInteger(value)))) mismatch();
  if (own(schema, "const") && stable(value) !== stable(schema.const)) mismatch();
  if (schema.enum && !schema.enum.some((entry) => stable(value) === stable(entry))) mismatch();
  if (typeof value === "string") {
    if (schema.minLength != null && value.length < schema.minLength) mismatch();
    if (schema.maxLength != null && value.length > schema.maxLength) mismatch();
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) mismatch();
    if (schema.format === "date-time" && (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
      || !Number.isFinite(Date.parse(value)))) mismatch();
  }
  if (Array.isArray(value)) {
    if (schema.minItems != null && value.length < schema.minItems) mismatch();
    if (schema.maxItems != null && value.length > schema.maxItems) mismatch();
    if (schema.uniqueItems && new Set(value.map(stable)).size !== value.length) mismatch();
    if (schema.items) value.forEach((entry, i) => validate(schema.items, entry, field + "[" + i + "]"));
  } else if (value !== null && typeof value === "object") {
    for (const key of schema.required || []) if (!own(value, key)) mismatch();
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) if (!own(schema.properties || {}, key)) mismatch();
    }
    for (const [key, child] of Object.entries(schema.properties || {})) {
      if (own(value, key)) validate(child, value[key], field + "." + key);
    }
  }
  for (const child of schema.allOf || []) validate(child, value, field);
  if (schema.if) {
    let matches = true;
    try { validate(schema.if, value, field); } catch (error) {
      if (!(error instanceof GitHubSelectionError)) throw error;
      matches = false;
    }
    if (matches && schema.then) validate(schema.then, value, field);
  }
}


// JSON.parse alone silently accepts duplicate object keys. Canonical audit input
// rejects them (including escaped aliases) before any selection is inspected.
function parseCanonicalJson(text, field) {
  let at = 0;
  function whitespace() { while (/[ \t\r\n]/.test(text[at] || "") && at < text.length) at++; }
  function bad() { fail("ERR_GITHUB_SELECTION_JSON", field); }
  function stringToken() {
    const start = at++;
    while (at < text.length) {
      if (text[at] === "\\") { at += 2; continue; }
      if (text[at++] === '"') {
        try { return JSON.parse(text.slice(start, at)); } catch (_) { bad(); }
      }
    }
    bad();
  }
  function value(depth) {
    if (depth > 20) bad();
    whitespace();
    if (text[at] === '"') return stringToken();
    if (text[at] === "{") {
      at++;
      const result = Object.create(null);
      whitespace();
      if (text[at] === "}") { at++; return result; }
      while (at < text.length) {
        whitespace();
        if (text[at] !== '"') bad();
        const key = stringToken();
        if (own(result, key)) bad();
        whitespace();
        if (text[at++] !== ":") bad();
        result[key] = value(depth + 1);
        whitespace();
        const separator = text[at++];
        if (separator === "}") return result;
        if (separator !== ",") bad();
      }
      bad();
    }
    if (text[at] === "[") {
      at++;
      const result = [];
      whitespace();
      if (text[at] === "]") { at++; return result; }
      while (at < text.length) {
        result.push(value(depth + 1));
        whitespace();
        const separator = text[at++];
        if (separator === "]") return result;
        if (separator !== ",") bad();
      }
      bad();
    }
    const token = /^(?:null|true|false|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/.exec(text.slice(at));
    if (!token) bad();
    at += token[0].length;
    try {
      const parsed = JSON.parse(token[0]);
      if (typeof parsed === "number" && !Number.isFinite(parsed)) bad();
      return parsed;
    } catch (_) { bad(); }
  }
  const parsed = value(0);
  whitespace();
  if (at !== text.length || !parsed || typeof parsed !== "object" || Array.isArray(parsed)) bad();
  return parsed;
}


function deriveReplayKeys(evidence) {
  return {
    run_key: hashObject({ version: 1, repository_id: evidence.governance_repository.id,
      run_id: evidence.provenance.run_id }),
    selection_key: hashObject({
      version: 1, project_id: evidence.project_id, repository_id: evidence.governance_repository.id,
      revision: evidence.governance_repository.revision,
      resource_ref: evidence.canonical.resource_ref, resource_digest: evidence.canonical.resource_digest,
      decision_id: evidence.canonical.decision_id, decision_digest: evidence.canonical.decision_digest,
      operation_id: evidence.selection.operation_id, frozen_digest: evidence.canonical.frozen_digest,
    }),
  };
}
function validateEvidenceConsistency(evidence) {
  const { subject: s, governance_repository: g, product_repository: p,
    provenance: v, controller: c } = evidence;
  check(s.account_id === v.sender_id && s.account_id === v.actor_id && s.account_id === v.triggering_actor_id &&
    v.repository_id === g.id && v.repository === g.name && p.id !== g.id && p.name !== g.name &&
    !c.workflow_path.includes("..") && c.workflow_ref === g.name + "/" + c.workflow_path + "@" + c.ref,
    "ERR_GITHUB_SELECTION_EVIDENCE_BINDING", "evidence");
  const keys = deriveReplayKeys(evidence);
  check(evidence.replay.run_key === keys.run_key && evidence.replay.selection_key === keys.selection_key,
    "ERR_GITHUB_SELECTION_EVIDENCE_REPLAY", "evidence.replay");
}

/**
 * Check supplied data and return ONLY structural evidence, or throw a typed
 * error. Canonical content digests hash the exact unmodified UTF-8 text, including
 * whitespace and trailing newline. frozen_digest hashes recursively key-sorted
 * compact JSON (arrays retain order), with no newline or Unicode normalization.
 * A trusted future loader must preserve original UTF-8 bytes and reject invalid
 * decoding; this function cannot establish where the supplied strings came from.
 *
 * run_key consumes the whole repository run, regardless of project/action.
 * selection_key consumes a frozen project/resource/Decision/operation selection,
 * regardless of run/action. Checking supplied key lists is not atomic or proof of
 * freshness. Both keys must be rechecked and recorded in ONE future canonical
 * transaction. No durable replay state or grants are kept here.
 */
function inspectGitHubSelection(input) {
  const data = copyData(input);
  validate(inputSchema, data, "input");
  const { selection: s, frozen: f, context: c, canonical: latest } = data;
  check(c.repository_id === f.governance_repository.id && c.repository === f.governance_repository.name &&
    c.actor_id === f.subject_id && c.sender_id === f.subject_id && c.triggering_actor_id === f.subject_id &&
    f.product_repository.id !== f.governance_repository.id && f.product_repository.name !== f.governance_repository.name,
    "ERR_GITHUB_SELECTION_PROVENANCE", "context");
  check(!f.controller.workflow_path.includes(".."), "ERR_GITHUB_SELECTION_WORKFLOW", "workflow_path");
  check(f.controller.workflow_ref === f.governance_repository.name + "/" + f.controller.workflow_path + "@" + f.controller.ref,
    "ERR_GITHUB_SELECTION_WORKFLOW", "workflow_ref");
  check(stable(c.inputs) === stable(s), "ERR_GITHUB_SELECTION_INPUT_MISMATCH", "context.inputs");
  check(s.project_id === f.project_id && latest.project_id === f.project_id,
    "ERR_GITHUB_SELECTION_PROJECT", "project_id");
  check(s.resource_ref === f.resource_ref && latest.resource_ref === f.resource_ref &&
    s.operation_id === f.operation_id, "ERR_GITHUB_SELECTION_RESOURCE", "selection");
  check(latest.revision === f.governance_repository.revision && latest.decision_id === f.decision_id,
    "ERR_GITHUB_SELECTION_REVISION", "canonical");
  check(Buffer.byteLength(latest.resource_content, "utf8") <= 1048576 &&
    Buffer.byteLength(latest.decision_content, "utf8") <= 1048576,
    "ERR_GITHUB_SELECTION_LIMIT", "canonical");
  check(hashText(latest.resource_content) === f.resource_digest && s.resource_digest === f.resource_digest &&
    hashText(latest.decision_content) === f.decision_digest,
    "ERR_GITHUB_SELECTION_DIGEST", "canonical");
  const frozenDigest = hashObject(f);
  check(s.frozen_digest === frozenDigest, "ERR_GITHUB_SELECTION_FROZEN_DIGEST", "selection.frozen_digest");
  check(f.allowed_actions.includes(s.action), "ERR_GITHUB_SELECTION_ACTION", "selection.action");
  check(c.workflow_ref === f.controller.workflow_ref && c.workflow_sha === f.controller.workflow_sha &&
    c.script_digest === f.controller.script_digest && c.ref === f.controller.ref,
    "ERR_GITHUB_SELECTION_WORKFLOW", "context");
  parseCanonicalJson(latest.resource_content, "canonical.resource");
  const decision = copyData(parseCanonicalJson(latest.decision_content, "canonical.decision"), "canonical.decision");
  validate(decisionSchema, decision, "canonical.decision");
  check(decision.decision_id === f.decision_id && decision.status === "open" &&
    decision.selected_option === null && decision.resolved_by === null && decision.resolved_at === null &&
    decision.gate.resource_ref === f.resource_ref && decision.options.includes(s.action),
    "ERR_GITHUB_SELECTION_DECISION", "canonical.decision");
  const { run_key: runKey, selection_key: selectionKey } = deriveReplayKeys({
    project_id: f.project_id, governance_repository: f.governance_repository,
    provenance: { run_id: c.run_id }, selection: { operation_id: f.operation_id },
    canonical: {
      resource_ref: f.resource_ref, resource_digest: f.resource_digest,
      decision_id: f.decision_id, decision_digest: f.decision_digest, frozen_digest: frozenDigest,
    },
  });
  check(!latest.consumed_run_keys.includes(runKey) && !latest.consumed_selection_keys.includes(selectionKey),
    "ERR_GITHUB_SELECTION_REPLAY", "canonical");
  const evidence = {
    schema_version: 1,
    kind: "github-selection-structural-evidence",
    verification: "STRUCTURAL_MATCH_ONLY",
    authentication: "NOT_ESTABLISHED",
    authority: "none",
    execution_authorized: false,
    effect_permitted: false,
    canonical_mutation: false,
    human_presence_verified: false,
    project_id: f.project_id,
    subject: { provider: "github", account_id: f.subject_id },
    product_repository: { ...f.product_repository },
    governance_repository: { ...f.governance_repository },
    controller: { ...f.controller },
    provenance: {
      repository_id: c.repository_id, repository: c.repository,
      sender_id: c.sender_id, actor_id: c.actor_id, triggering_actor_id: c.triggering_actor_id,
      event_name: c.event_name, run_id: c.run_id, run_attempt: c.run_attempt,
    },
    canonical: {
      resource_ref: f.resource_ref, resource_digest: f.resource_digest,
      decision_id: f.decision_id, decision_digest: f.decision_digest,
      frozen_digest: frozenDigest,
    },
    selection: { operation_id: f.operation_id, operation: f.operation, action: s.action },
    replay: {
      run_key: runKey, selection_key: selectionKey,
      observation: "NOT_ATOMIC", consumption: "CANONICAL_TRANSACTION_REQUIRED",
    },
  };
  evidence.audit_ref = hashObject(evidence);
  validate(evidenceSchema, evidence, "evidence");
  validateEvidenceConsistency(evidence);
  return freeze(evidence);
}

/** Validate persisted audit data, including its digest, without authenticating it. */
function inspectStructuralEvidence(input) {
  const evidence = copyData(input, "evidence");
  validate(evidenceSchema, evidence, "evidence");
  validateEvidenceConsistency(evidence);
  const { audit_ref: expected, ...body } = evidence;
  check(hashObject(body) === expected, "ERR_GITHUB_SELECTION_AUDIT_DIGEST", "audit_ref");
  return freeze(evidence);
}

module.exports = Object.freeze({ GitHubSelectionError, inspectGitHubSelection, inspectStructuralEvidence });
