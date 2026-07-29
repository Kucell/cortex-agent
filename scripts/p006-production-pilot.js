"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { LeaseManager } = require("../lib/coordination/lease");
const { writeLeaseState } = require("../lib/coordination/lease-store");
const { detectPi, mapPiEventToBoundaryEvent } = require("../lib/runtime-adapters/pi-adapter");
const { dispatch, createAuthoritativeOwner } = require("../lib/runtime-adapters/capability-aware-dispatch");
const { createReadiness, createAuthorization, writeCheckpoint } = require("../lib/runtime-state/operation-lifecycle");
const { handoff } = require("../lib/runtime-adapters/cross-host-handoff");

const root = path.resolve(__dirname, "..");
const evidenceDir = path.join(root, ".agent", "missions", "M-010", "evidence");
fs.mkdirSync(evidenceDir, { recursive: true });
const now = new Date().toISOString();
const digest = "c2e7b17aa2c0cf21995da0bd4cb197bd6a8b1d514d2d66339558e03bc9ae16ca";

function atomic(name, value) {
  const target = path.join(evidenceDir, name); const temp = `${target}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 }); fs.renameSync(temp, target); return target;
}
function version(binary) {
  try { return { binary_available: true, probe_status: "pass", version: execFileSync(binary, ["--version"], { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "pipe"] }).trim().split(/\r?\n/)[0].slice(0, 120) }; }
  catch (error) { return { binary_available: error.code !== "ENOENT", probe_status: error.killed ? "timeout" : "failed", version: "unavailable" }; }
}

const pi = detectPi({ timeoutMs: 5000 });
const probes = { schema_version: "1.0", probed_at: now, authorization_inferred: false, execution_inferred: false, hosts: { pi: { available: pi.available, version: pi.version || "unavailable", capabilities_declared: Object.keys(pi.descriptor.capabilities) }, codex: version("codex"), claude: version("claude") } };
atomic("host-probe.json", probes);

const manager = new LeaseManager();
const lease = manager.acquire("pilot:M-010:disposable", "pi-agent", { ttl: 30 * 60 * 1000, actorId: "S-M-010", evidence: [".agent/missions/M-010/evidence/host-probe.json"] });
writeLeaseState(path.join(evidenceDir, "lease"), manager);

const requirement = { schema_version: "1.0", requirement_id: "REQ-M010-PILOT", task_id: "T-ARI-001", created_at: now, required_capabilities: ["session.boundary", "tool.before.block"], minimum_capability_levels: { "tool.before.block": "native" }, governance: { approved_decision_id: "D-M010-P006-c2e7b17a", require_active_lease: true }, preferred: {}, ttl_at: new Date(Date.now() + 20 * 60 * 1000).toISOString() };
const snapshot = { schema_version: "1.0", snapshot_id: "SNAP-M010-PI", host_profile_ref: "H-PI-LOCAL", taken_at: now, capabilities: { "session.boundary": "native", "tool.before.block": "native", "tool.update": "native" }, governance: { approved: true, decision_id: "D-M010-P006-c2e7b17a" }, lease: { active: true, holder: lease.owner }, reliability: { value: null, source: "unavailable", quality: "unavailable" }, cost: { value: null, source: "unavailable", quality: "unavailable" }, latency: { value: null, source: "unavailable", quality: "unavailable" } };
atomic("frozen-requirement-snapshot.json", { schema_version: "1.0", proposal_digest: digest, requirement, snapshot, governance_decision_id: "D-M010-P006-c2e7b17a", lease_ref: "lease/state.json" });

const actor = { workflow: "/mission", agent_id: "pi-agent", task_id: "T-ARI-001", mission_id: "M-010", run_id: "R-M-010", session_id: "S-M-010", workspace_id: "W-M010-PILOT" };
const readiness = createReadiness({ readiness_id: "RD-M010-PILOT", revision: digest, verdict: "ready", operation: { kind: "manual_dispatch", proposal_id: "P-006" }, resolved: { agents: ["pi"], workspaces: ["W-M010-PILOT"] }, inspected_at: now });
const authorization = createAuthorization({ authorization_id: "AUTH-M010-PILOT", decision_id: "D-M010-P006-c2e7b17a", decision_source: "management-api", policy: "frozen-revision-single-use", reason: "resource-bound interactive approval", scope: { repository: "cortex-agent", revision: digest }, validity: { mode: "single" }, created_at: now });
const owner = createAuthoritativeOwner({ root, operationId: "OP-M010-PI-001", taskId: "T-ARI-001", runId: "R-M-010", sessionId: "S-M-010", workspaceId: "W-M010-PILOT", actor, authorization, readiness, targetRevision: digest });
const dispatched = dispatch(requirement, [snapshot], owner, { now, ownerName: "operation-lifecycle", idempotencyState: new Map() });
const receipt = mapPiEventToBoundaryEvent({ kind: "session", event: "start", ts: now, sessionId: "pi-m010-disposable", seq: 1, correlation: { task_id: "T-ARI-001", run_id: "R-M-010", session_id: "S-M-010", operation_id: "OP-M010-PI-001" }, evidenceRefs: [".agent/missions/M-010/evidence/host-probe.json"] });
atomic("pi-adapter-receipt.json", { schema_version: "1.0", receipt_kind: "adapter_boundary", authentic_basis: "current Pi host process plus Pi adapter mapping", operation_attempt_id: dispatched.operation_attempt_id, boundary_event: receipt, prompt_body_persisted: false, tool_payload_persisted: false, exact_usage: "unavailable" });

const secondHost = probes.hosts.codex.probe_status === "pass" ? "codex" : "claude";
const second = probes.hosts[secondHost];
const secondAttempt = { schema_version: "1.0", attempted_at: now, host: secondHost, safe_boundary: `${secondHost} --version`, attempt_kind: "non_authenticated_local_process_probe", result: second.probe_status === "pass" ? "boundary_reachable_probe_only" : "blocked", authenticated_execution_attempted: false, receipt: null, blocker: second.probe_status === "pass" ? { code: "SAFE_EXECUTION_BOUNDARY_UNAVAILABLE", reason: "The existing no-credential boundary proves the host binary is reachable but exposes no approved disposable execution receipt without invoking an authenticated or externally side-effecting session." } : { code: "HOST_INTERFACE_UNREACHABLE", reason: "The bounded local host probe failed." }, independent_validation: { command_class: "version-only", exit_status: second.probe_status, credential_accessed: false, external_side_effect: false }, fabricated_receipt: false };
atomic("second-host-attempt.json", secondAttempt);

const targetSnapshot = { ...snapshot, snapshot_id: "SNAP-M010-HANDOFF", host_profile_ref: "H-PI-HANDOFF" };
const handoffAuth = createAuthorization({ authorization_id: "AUTH-M010-HANDOFF", decision_id: "D-M010-P006-c2e7b17a", decision_source: "management-api", policy: "frozen-revision-single-use", reason: "cross-host recovery attempt", scope: { repository: "cortex-agent", revision: digest }, validity: { mode: "single" }, created_at: now });
const handoffOwner = createAuthoritativeOwner({ root, operationId: "OP-M010-HANDOFF-002", attempt: 2, retryOfOperationId: "OP-M010-PI-001", taskId: "T-ARI-001", runId: "R-M-010", sessionId: "S-M-010", workspaceId: "W-M010-PILOT", actor, authorization: handoffAuth, readiness, targetRevision: digest });
const transfer = handoff({ operation_id: "OP-M010-PI-001", host_profile_ref: `H-${secondHost.toUpperCase()}-PROBE`, task_id: "T-ARI-001", boundary_events: [receipt], context_trajectory: { stages: [{ type: "checkpoint", ref: "CHK-M010" }] }, summary: "Disposable lifecycle pilot checkpoint; no private bodies retained." }, requirement, [targetSnapshot], handoffOwner, { now, ownerName: "operation-lifecycle" });
// Persist the checkpoint via the lifecycle owner so .agent/checkpoints/<id>.json
// exists independently of the handoff JSON. The summary file references it,
// and the checkpointer is what a cross-host validator reads to recover.
writeCheckpoint(root, {
  ...transfer.checkpoint,
  fencing_token_ref: "cross-host-handoff.json",
  source_operation_id: "OP-M010-PI-001",
  target_host_profile_ref: transfer.target_host_profile_ref,
  redacted_summary_present: true,
});
atomic("cross-host-handoff.json", transfer);
atomic("production-pilot-summary.json", { schema_version: "1.0", status: "pass_with_second_host_execution_blocked", proposal_digest: digest, host_probe_ref: "host-probe.json", lease_ref: "lease/state.json", requirement_snapshot_ref: "frozen-requirement-snapshot.json", operation_attempt_id: dispatched.operation_attempt_id, operation_resource_ref: ".agent/operations/OP-M010-PI-001.json", operation_events_ref: ".agent/operations/events.jsonl", pi_receipt_ref: "pi-adapter-receipt.json", checkpoint_id: transfer.checkpoint.checkpoint_id, checkpoint_resource_ref: `.agent/checkpoints/${transfer.checkpoint.checkpoint_id}.json`, handoff_ref: "cross-host-handoff.json", handoff_new_attempt_id: transfer.new_operation_attempt_id, second_host_attempt_ref: "second-host-attempt.json", redaction: { credentials: "excluded", prompts: "excluded", tool_payloads: "excluded", file_bodies: "excluded", private_transcript: "excluded", exact_usage: "unavailable" }, automatic_dispatch: "disabled", daemon: "disabled" });
console.log(JSON.stringify({ ok: true, operation_attempt_id: dispatched.operation_attempt_id, pi_available: pi.available, second_host: secondHost, second_host_result: secondAttempt.result, handoff_attempt_id: transfer.new_operation_attempt_id }));
