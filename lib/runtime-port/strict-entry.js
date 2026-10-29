"use strict";

// This is an inert assembly, NOT a live strict runtime entry. No option accepts
// a port, createRun callback, source/verifier, module path, command or identity.
// The only RuntimePort below is constructed here and does computation in memory.
// Its IDs and reviewer are explicitly synthetic, never authenticated subjects.
// Production physical-effect fencing, hard expiry and Host isolation: MustResolve.
const { createRuntimePort } = require("../../packages/runtime-port/src/index.js");
const { isInertAdmissionPrototype } = require("../runtime-state/runtime-admission");
const { clone, freeze, digest, json } = require("../governance/canonical-records");
const SCENARIOS = ["complete", "start-throws", "missing-session", "wrong-attempt", "cancel-unknown", "review-rejected"];
function fail(code) { const e = new Error(code); e.code = code; throw e; }
function createInertStrictEntry(options) {
  if (!options || Object.getPrototypeOf(options) !== Object.prototype || Object.getOwnPropertySymbols(options).length ||
    Object.keys(options).sort().join(",") !== "admission,scenario" ||
    Object.values(Object.getOwnPropertyDescriptors(options)).some(d => !("value" in d))) fail("INERT_ENTRY_OPTIONS");
  const admission = options.admission, scenario = options.scenario;
  if (!isInertAdmissionPrototype(admission) || typeof scenario !== "string" || !SCENARIOS.includes(scenario)) fail("INERT_ENTRY_OPTIONS");
  const attempts = new WeakMap(); let starts = 0, cancels = 0, captured = null;
  const port = createRuntimePort({ descriptor:{ protocol:"cortex-runtime",protocol_version:"1.0",implementation:"inert-admission-fixture",implementation_version:"1.0",
    capabilities:["runtime.run.create","runtime.run.cancel","runtime.run.wait"] }, operations:{
    createRun(payload) {
      starts++; captured = freeze(clone(payload));
      if (scenario === "start-throws") fail("SYNTHETIC_START_UNCERTAIN");
      const nonce = payload.attempt_nonce;
      const ack = { schema_version:1,kind:"inert-runtime-ack-v1",effect_authority:false,project_id:payload.project_id,
        operation_id:payload.operation_id,attempt_nonce:nonce,runtime_ref:"synthetic:fixed-port",
        run_id:"synthetic:run:"+nonce,session_id:"synthetic:session:"+nonce,workspace_id:"synthetic:workspace:"+nonce };
      if (scenario === "missing-session") delete ack.session_id;
      if (scenario === "wrong-attempt") ack.attempt_nonce = "f".repeat(32);
      return freeze(ack);
    },
    wait(ack) {
      return freeze({ schema_version:1,kind:"inert-candidate-v1",effect_authority:false,ack_digest:digest(json(ack)),
        operation_id:ack.operation_id,attempt_nonce:ack.attempt_nonce,content_digest:digest(json(captured.input)),actual_units:1 });
    },
    cancel() { cancels++; return freeze({ status:scenario === "cancel-unknown" ? "UNKNOWN" : "CANCELED",effect_authority:false }); }
  } });
  // Capture immutable methods; never look up a caller-supplied method at dispatch.
  const createRun = port.createRun, wait = port.wait, cancel = port.cancel;
  async function uncertain(handle) {
    // Once createRun was invoked, even a rejected/failed acknowledgement write
    // is not permission to resend. Recording UNKNOWN is best effort only; the
    // caller always receives explicit uncertainty and the budget stays held.
    try { return await admission.markUnknown(handle); }
    catch (_) { return freeze({status:"UNKNOWN",effect_authority:false,execution_authorized:false,budget_held:true,recovery_required:true,recorded:false}); }
  }
  async function dispatch(handle) {
    // Do not return a cached success before revalidating the latest gates.
    await admission.revalidate(handle);
    if (attempts.has(handle)) fail("INERT_ENTRY_ONE_SHOT");
    attempts.set(handle, { used:true,ack:null });
    const claim = await admission.claimDispatch(handle);
    if (claim.status !== "PUBLISHED") return claim;
    // The second read is still a client observation, NOT a physical-effect fence.
    await admission.revalidate(handle);
    let ack;
    try { ack = createRun(claim.payload); } catch (_) { return uncertain(handle); }
    attempts.get(handle).ack = ack;
    try {
      const out = await admission.acknowledge(handle,ack);
      return out.status === "PUBLISHED" ? out : uncertain(handle);
    } catch (_) { return uncertain(handle); }
  }
  async function complete(handle) {
    await admission.revalidate(handle);
    const attempt = attempts.get(handle);
    if (!attempt || !attempt.ack || attempt.completed) fail("INERT_ENTRY_ONE_SHOT");
    attempt.completed = true;
    const candidate = wait(attempt.ack);
    // A closed deterministic TEST reviewer, not a verification callback or real
    // independent reviewer. Content binding is tested; provenance is not claimed.
    const review = freeze({ schema_version:1,kind:"inert-review-v1",effect_authority:false,reviewer_id:"synthetic:independent-reviewer",
      candidate_digest:digest(json(candidate)),tests:"passed",review:scenario === "review-rejected" ? "rejected" : "approved" });
    return admission.acceptOutcome(handle,candidate,review);
  }
  async function revoke(handle) {
    const out = await admission.revoke(handle), attempt = attempts.get(handle);
    if (attempt && attempt.ack && ["PUBLISHED","UNKNOWN"].includes(out.status)) {
      const canceled = cancel(attempt.ack);
      if (canceled.status !== "CANCELED" && out.status === "PUBLISHED") return admission.markUnknown(handle);
      return freeze({ ...out,cancellation:canceled.status,budget_held:true });
    }
    return out;
  }
  return Object.freeze({ dispatch,complete,revoke,inspect:() => freeze({ effect_authority:false,starts,cancels,payload:captured }),
    effect_authority:false,evidence_level:"SYNTHETIC_ONLY" });
}
module.exports = Object.freeze({ createInertStrictEntry });
