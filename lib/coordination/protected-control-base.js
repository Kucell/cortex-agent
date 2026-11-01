"use strict";

// CANDIDATE control-domain base. NOT an authority, NOT production wiring.
//
// The publication proposal (section 4.3) requires a trusted control domain
// with five properties: an independent rollback domain, authenticated
// access, a complete verifiable head, anti-rollback and a genesis that was
// installed through a trusted provisioning registration. All five need
// independent verification, rather than declarations by their consumer.
//
// This module validates evidence descriptions and their scope, not their
// authenticity. `complete` means structural coverage only. Production
// admission needs an opaque capability issued by a trusted composition root
// after authenticating external witnesses. No such issuer exists here, so
// these descriptions must never authorize the production controller.

const crypto = require("node:crypto");

class ControlBaseError extends Error {
  constructor(code, details) {
    super(code);
    this.name = "ControlBaseError";
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

function fail(code, details) { throw new ControlBaseError(code, details); }

// The five properties whose descriptions can be checked here. Neither a
// description nor a boolean proves the property holds in production.
const PROPERTIES = Object.freeze([
  "independentRollbackDomain",
  "authenticatedAccess",
  "completeHead",
  "antiRollback",
  "genesisProvisioned",
]);

// The evidence kinds this module understands. Each kind names WHO produced
// the evidence, because an evidence that the backend produced itself about
// itself proves nothing.
const EVIDENCE_KINDS = Object.freeze({
  // A party outside the business rollback domain vouches for the domain's
  // independence. Without such a party the independence is an assumption.
  EXTERNAL_WITNESS: "external-witness",
  // The operating system attests the identity of the writer and the
  // ownership of the domain (a service identity, a certificate, an ACL).
  OS_IDENTITY: "os-identity",
  // The head is complete because the domain itself enumerates every record
  // it holds and binds them into one chain.
  SELF_ENUMERATED_CHAIN: "self-enumerated-chain",
  // A registration that was written when the domain was installed, and that
  // names the domain identity the installer provisioned.
  INSTALLER_REGISTRATION: "installer-registration",
});

// The properties that a LOCAL base can prove by itself, and the properties
// that it cannot. The second group is the reason the production path stays
// closed: a single machine can enumerate its own records and can prove who
// owns them, but it cannot prove that a snapshot of the machine does not
// carry the control domain back to an earlier state.
const LOCAL_PROVABLE = Object.freeze(["authenticatedAccess", "completeHead", "genesisProvisioned"]);
const LOCAL_NOT_PROVABLE = Object.freeze(["independentRollbackDomain", "antiRollback"]);

function binding(input) {
  if (!input || typeof input !== "object") fail("ERR_CONTROL_BASE_INPUT");
  const { domain, head, owner } = input;
  if (typeof domain !== "string" || domain.length === 0 || domain.length > 128) fail("ERR_CONTROL_BASE_INPUT");
  if (typeof head !== "string" || !/^[a-f0-9]{64}$/.test(head)) fail("ERR_CONTROL_BASE_INPUT");
  if (!owner || typeof owner !== "object" || typeof owner.owner_id !== "string" ||
      owner.owner_id.length === 0 || owner.owner_id.length > 128 ||
      !Number.isSafeInteger(owner.owner_generation) || owner.owner_generation < 1 ||
      !Number.isSafeInteger(owner.fence) || owner.fence < 1) fail("ERR_CONTROL_BASE_INPUT");
  return Object.freeze({ domain, head, owner: Object.freeze({
    owner_id: owner.owner_id, owner_generation: owner.owner_generation, fence: owner.fence,
  }) });
}

// A scoped evidence description. Naming a kind and producer is necessary,
// but is not authentication of that producer.
function evidence(property, kind, producer, detail) {
  if (!PROPERTIES.includes(property)) fail("ERR_CONTROL_BASE_INPUT");
  if (!Object.values(EVIDENCE_KINDS).includes(kind)) fail("ERR_CONTROL_BASE_INPUT");
  if (typeof producer !== "string" || producer.trim().length === 0 || producer.length > 256) fail("ERR_CONTROL_BASE_INPUT");
  const scope = binding(detail);
  const { issued_at_ms, expires_at_ms } = detail;
  if (!Number.isSafeInteger(issued_at_ms) || issued_at_ms < 0 ||
      !Number.isSafeInteger(expires_at_ms) || expires_at_ms <= issued_at_ms) fail("ERR_CONTROL_BASE_INPUT");
  return Object.freeze({ property, kind, producer, detail: Object.freeze({ ...scope, issued_at_ms, expires_at_ms }) });
}

// Structural coverage only. Check every description, including the first
// and duplicate entries, against the caller's exact scope and observation time.
function inspect(evidenceList, context) {
  if (!Array.isArray(evidenceList)) fail("ERR_CONTROL_BASE_INPUT");
  const scope = evidenceList.length ? binding(context) : null;
  if (scope && (!Number.isSafeInteger(context.now_ms) || context.now_ms < 0)) fail("ERR_CONTROL_BASE_INPUT");
  const satisfied = new Map();
  for (const input of evidenceList) {
    if (!input || typeof input !== "object") fail("ERR_CONTROL_BASE_INPUT");
    const item = evidence(input.property, input.kind, input.producer, input.detail);
    const detail = item.detail;
    if (detail.domain !== scope.domain || detail.head !== scope.head ||
        detail.owner.owner_id !== scope.owner.owner_id ||
        detail.owner.owner_generation !== scope.owner.owner_generation ||
        detail.owner.fence !== scope.owner.fence ||
        context.now_ms < detail.issued_at_ms || context.now_ms >= detail.expires_at_ms) {
      fail("ERR_CONTROL_BASE_INPUT");
    }
    const known = satisfied.get(item.property);
    if (known === undefined) { satisfied.set(item.property, item); continue; }
    // A second, different evidence for the same property is not a conflict
    // when both name the same producer and kind; it is only recorded once.
    if (known.kind !== item.kind || known.producer !== item.producer) {
      fail("ERR_CONTROL_BASE_EVIDENCE_CONFLICT", { property: item.property });
    }
  }
  const missing = PROPERTIES.filter((property) => !satisfied.has(property));
  return Object.freeze({
    satisfied: Object.freeze([...satisfied.keys()].sort()),
    missing: Object.freeze(missing),
    complete: missing.length === 0,
  });
}

// Diagnostic description only; these booleans are not admission credentials.
function describe(base, context) {
  if (!base || typeof base !== "object") fail("ERR_CONTROL_BASE_INPUT");
  const view = inspect(base.evidence || [], context);
  const properties = {};
  for (const property of PROPERTIES) properties[property] = view.satisfied.includes(property);
  return Object.freeze({ properties: Object.freeze(properties), view });
}

// The identity of a control domain. The identity binds the domain to the
// registration that provisioned it, so a domain that was replaced by a
// snapshot cannot claim the identity of the domain it replaced without the
// installer registration naming it.
function domainIdentity(input) {
  if (!input || typeof input !== "object") fail("ERR_CONTROL_BASE_INPUT");
  const { domain_id, installer_id, provisioned_at_ms } = input;
  if (typeof domain_id !== "string" || domain_id.length === 0 || domain_id.length > 128) fail("ERR_CONTROL_BASE_INPUT");
  if (typeof installer_id !== "string" || installer_id.length === 0 || installer_id.length > 128) fail("ERR_CONTROL_BASE_INPUT");
  if (!Number.isSafeInteger(provisioned_at_ms) || provisioned_at_ms < 0) fail("ERR_CONTROL_BASE_INPUT");
  const digest = crypto.createHash("sha256")
    .update([domain_id, installer_id, String(provisioned_at_ms)].join("\n"))
    .digest("hex");
  return Object.freeze({ domain_id, installer_id, provisioned_at_ms, digest });
}

module.exports = {
  PROPERTIES,
  EVIDENCE_KINDS,
  LOCAL_PROVABLE,
  LOCAL_NOT_PROVABLE,
  ControlBaseError,
  evidence,
  inspect,
  describe,
  domainIdentity,
};
