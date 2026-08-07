"use strict";

// ─── M-011 / ARI P-005 — governed-tool adapter gateway tests ───────────────
// Zero external dependencies.

const test = require("node:test");
const assert = require("node:assert/strict");

const cc = require("../../lib/runtime-adapters/minimax-cli-capability-contract");
const gateway = require("../../lib/runtime-adapters/minimax-cli-governed-tool");

function fakeSnapshot() {
  const capabilities = {};
  for (const r of cc.MINIMAX_RESOURCES) {
    capabilities[r] = { level: "explicit", source: "manifest-claim", reason: `${r}_--help_exit_0` };
  }
  return {
    schema_version: cc.MINIMAX_CAPABILITY_SNAPSHOT_SCHEMA_VERSION,
    snapshot_id: "MCAP-test",
    probe_at: "2026-07-29T03:00:00.000Z",
    binary: { available: true, version: "mmx 1.0.18", source: "probe" },
    auth_state: "unknown",
    auth_state_reason: "auth_probing_disabled",
    probe_families: ["version", "help", "resource_help"],
    capabilities,
    no_credential: true,
    probe_command_log: ["mmx --version", "mmx --help"],
  };
}

test("HOST_PROFILE_PREFIX is 'mmx-' and TOOL_NAME_PREFIX is 'mmx.'", () => {
  assert.equal(gateway.HOST_PROFILE_PREFIX, "mmx-");
  assert.equal(gateway.TOOL_NAME_PREFIX, "mmx.");
});

test("buildMinimaxCliRequirement produces the canonical MiniMax shape", () => {
  const req = gateway.buildMinimaxCliRequirement({ resource: "text", subcommand: "chat" });
  assert.equal(req.host, "minimax-cli");
  assert.equal(req.resource, "text");
  assert.equal(req.subcommand, "chat");
  assert.equal(req.host_profile_ref, "mmx-text");
  assert.equal(req.tool_name, "mmx.text.chat");
  assert.equal(req.redacted_inputs, true);
});

test("buildMinimaxCliRequirement rejects unknown resource / missing subcommand", () => {
  assert.throws(() => gateway.buildMinimaxCliRequirement({ resource: "foo", subcommand: "chat" }), (err) => err.code === "ERR_RESOURCE_UNKNOWN");
  assert.throws(() => gateway.buildMinimaxCliRequirement({ resource: "text" }), (err) => err.code === "ERR_SUBCOMMAND_INVALID");
});

test("buildMinimaxCliSnapshot adapts MiniMax probe output into host-snapshot shape", () => {
  const snap = fakeSnapshot();
  const adapted = gateway.buildMinimaxCliSnapshot(snap, { now: "2026-07-29T03:00:00.000Z", resource: "text" });
  assert.equal(adapted.schema_version, "1.0");
  assert.equal(adapted.snapshot_id, snap.snapshot_id);
  assert.equal(adapted.taken_at, "2026-07-29T03:00:00.000Z");
  assert.equal(adapted.governance.approved, false);
  assert.equal(adapted.governance.decision_id, null);
  assert.equal(adapted.host_profile_ref, "mmx-text");
  assert.equal(adapted.minimax_cli.auth_state, "unknown");
  assert.equal(adapted.minimax_cli.binary_available, true);
  assert.equal(adapted.minimax_cli.binary_version, "mmx 1.0.18");
});

test("adaptRequirement converts MiniMax requirement to capability-aware-dispatch shape", () => {
  const mini = gateway.buildMinimaxCliRequirement({ resource: "text", subcommand: "chat" });
  const adapted = gateway.adaptRequirement(mini, { now: "2026-07-29T03:00:00.000Z", taskId: "T-1" });
  assert.equal(adapted.task_id, "T-1");
  assert.deepEqual(adapted.required_capabilities, ["tool.update", "session.boundary"]);
  assert.equal(adapted.minimum_capability_levels["tool.update"], "adapter");
  assert.equal(adapted.governance.approved_decision_id, null);
  assert.equal(adapted.minimax_cli.resource, "text");
});

// ─── dispatchRequirement: arg-order + owner-call + fail-closed tests ─────

test("dispatchRequirement returns unavailable when snapshot is missing", () => {
  const req = gateway.buildMinimaxCliRequirement({ resource: "text", subcommand: "chat" });
  const result = gateway.dispatchRequirement(req, () => ({ operation_attempt_id: "X" }), {
    now: "2026-07-29T03:00:00.000Z",
  });
  assert.equal(result.result, "unavailable");
  assert.equal(result.reason, "snapshot_required");
});

test("dispatchRequirement returns unavailable when auth_state is not 'unknown'", () => {
  const snap = fakeSnapshot();
  snap.auth_state = "ready";
  const req = gateway.buildMinimaxCliRequirement({ resource: "text", subcommand: "chat" });
  const result = gateway.dispatchRequirement(req, () => ({ operation_attempt_id: "X" }), {
    now: "2026-07-29T03:00:00.000Z",
    snapshot: snap,
  });
  assert.equal(result.result, "unavailable");
  assert.equal(result.reason, "auth_disabled");
  assert.equal(result.reason_code, "AUTH_READINESS_DISABLED");
});

test("dispatchRequirement throws when owner is not a function", () => {
  const req = gateway.buildMinimaxCliRequirement({ resource: "text", subcommand: "chat" });
  assert.throws(
    () => gateway.dispatchRequirement(req, null, { now: "2026-07-29T03:00:00.000Z", snapshot: fakeSnapshot() }),
    (err) => err.code === "ERR_OWNER_REQUIRED"
  );
});

test("dispatchRequirement throws when options.now is missing", () => {
  const req = gateway.buildMinimaxCliRequirement({ resource: "text", subcommand: "chat" });
  assert.throws(
    () => gateway.dispatchRequirement(req, () => ({}), { snapshot: fakeSnapshot() }),
    (err) => err.code === "ERR_OPTIONS_NOW_REQUIRED"
  );
});

test("dispatchRequirement routes through capability-aware-dispatch and invokes owner with correct arg shape", () => {
  // Spy owner that records what it received.
  const captured = [];
  const owner = function owner(req) {
    captured.push(req);
    return { operation_attempt_id: "OP-MMX-1" };
  };
  const req = gateway.buildMinimaxCliRequirement({ resource: "text", subcommand: "chat" });
  const result = gateway.dispatchRequirement(req, owner, {
    now: "2026-07-29T03:00:00.000Z",
    snapshot: fakeSnapshot(),
    ownerName: "spy-owner",
  });
  assert.equal(result.result, "allowed");
  assert.equal(result.operation_attempt_id, "OP-MMX-1");
  // Owner was invoked exactly once.
  assert.equal(captured.length, 1);
  // The request seen by the owner must include plan_id, host_profile_ref,
  // snapshot_ids, requirement_id, issued_at, issued_by.
  const seen = captured[0];
  assert.equal(typeof seen.plan_id, "string");
  assert.equal(seen.host_profile_ref, "mmx-text");
  assert.equal(seen.requirement_id, "REQ-MMX-text-chat");
  assert.equal(seen.issued_at, "2026-07-29T03:00:00.000Z");
  assert.equal(seen.issued_by, "spy-owner");
  assert.ok(Array.isArray(seen.snapshot_ids));
  // Boundary event must be recorded.
  assert.ok(result.boundary_event);
  // mmx_invocation must be "none" (this gateway never invokes mmx).
  assert.equal(result.audit.mmx_invocation, "none");
});

test("dispatchRequirement emits a boundary event with type=tool.before", () => {
  const req = gateway.buildMinimaxCliRequirement({ resource: "image", subcommand: "generate" });
  const result = gateway.dispatchRequirement(req, () => ({ operation_attempt_id: "OP-X" }), {
    now: "2026-07-29T03:00:00.000Z",
    snapshot: fakeSnapshot(),
    ownerName: "spy",
  });
  assert.equal(result.result, "allowed");
  assert.ok(result.boundary_event);
  if (!result.boundary_event.error) {
    assert.equal(result.boundary_event.type, "tool.before");
    assert.equal(result.boundary_event.decision.result, "allowed");
    assert.equal(result.boundary_event.capability, "tool.update");
  }
});

test("dispatchRequirement honours Tool Gate fail-closed (decision not approved)", () => {
  const req = gateway.buildMinimaxCliRequirement({ resource: "text", subcommand: "chat" });
  const result = gateway.dispatchRequirement(req, () => ({ operation_attempt_id: "X" }), {
    now: "2026-07-29T03:00:00.000Z",
    snapshot: fakeSnapshot(),
    toolGateInput: {
      operation: { operation_id: "OP-1", status: "open", resource_digest: "sha256:" + "a".repeat(64) },
      resource_digest: "sha256:" + "a".repeat(64),
      attempt: 1,
      tool: "mmx.text.chat",
      decision: { decision_id: "D-NOT-APPROVED", status: "open", operation_id: "OP-1" },
      waitpoint: { waitpoint_id: "WP-1", status: "released", decision_id: "D-NOT-APPROVED" },
      authorization: {
        authorization_ref: "AUTH-1",
        issued_at: "2026-07-29T02:00:00.000Z",
        expires_at: "2026-07-29T04:00:00.000Z",
        attempt_bound: { min: 1, max: 5 },
        issued_by: "ci-bot",
      },
    },
  });
  assert.equal(result.result, "unavailable");
  assert.equal(result.reason, "tool_gate_denied");
  assert.ok(result.gate);
});

// ─── reconcileAsyncJob: durability ────────────────────────────────────────

test("reconcileAsyncJob returns unavailable when root or operationId is missing", () => {
  const job = {
    schema_version: cc.MINIMAX_ASYNC_JOB_SCHEMA_VERSION,
    job_id: "TASK-abc123",
    resource: "video",
    status: "submitted",
    submitted_at: "2026-07-29T03:00:00.000Z",
    last_observed_at: "2026-07-29T03:00:00.000Z",
    output_refs: [{ kind: "url", ref: "https://example.com/asset", redacted: true }],
    cost_status: "unavailable",
    redacted: true,
  };
  assert.throws(() => gateway.reconcileAsyncJob(null, "OP-1", job, { now: "2026-07-29T03:00:00.000Z" }), (err) => err.code === "ERR_ROOT_REQUIRED");
  assert.throws(() => gateway.reconcileAsyncJob("/tmp/root", null, job, { now: "2026-07-29T03:00:00.000Z" }), (err) => err.code === "ERR_OPERATION_ID_REQUIRED");
});

test("reconcileAsyncJob returns unavailable when operation does not exist", () => {
  const job = {
    schema_version: cc.MINIMAX_ASYNC_JOB_SCHEMA_VERSION,
    job_id: "TASK-abc123",
    resource: "video",
    status: "submitted",
    submitted_at: "2026-07-29T03:00:00.000Z",
    last_observed_at: "2026-07-29T03:00:00.000Z",
    output_refs: [{ kind: "url", ref: "https://example.com/asset", redacted: true }],
    cost_status: "unavailable",
    redacted: true,
  };
  const result = gateway.reconcileAsyncJob("/tmp/__nonexistent_root__", "OP-MISSING", job, { now: "2026-07-29T03:00:00.000Z" });
  assert.equal(result.result, "unavailable");
  assert.equal(result.reason, "operation_not_found");
  assert.equal(result.mmx_invocation, "skipped_in_this_mission");
});

test("reconcileAsyncJob rejects tainted descriptor (key in output_ref)", () => {
  const bad = {
    schema_version: cc.MINIMAX_ASYNC_JOB_SCHEMA_VERSION,
    job_id: "TASK-abc123",
    resource: "video",
    status: "submitted",
    submitted_at: "2026-07-29T03:00:00.000Z",
    last_observed_at: "2026-07-29T03:00:00.000Z",
    output_refs: [{ kind: "url", ref: "https://user:sk-c-XYZABCDEF@x", redacted: true }],
    cost_status: "unavailable",
    redacted: true,
  };
  assert.throws(
    () => gateway.reconcileAsyncJob("/tmp/__nonexistent_root__", "OP-X", bad, { now: "2026-07-29T03:00:00.000Z" }),
    (err) => err.code === "ERR_SNAPSHOT_TAINTED"
  );
});

// ─── registerWithInitUpdateDoctor: integration surface ────────────────────

test("registerWithInitUpdateDoctor exposes read-only hooks for init/update/doctor/reconcile", () => {
  const hooks = gateway.registerWithInitUpdateDoctor({ projectRoot: "/tmp/__nonexistent_proj__", templatesRoot: "/tmp/__nonexistent_tpl__" });
  assert.equal(hooks.name, "minimax-cli");
  assert.equal(typeof hooks.capabilitySnapshot, "function");
  assert.equal(typeof hooks.enumerateSkills, "function");
  assert.equal(typeof hooks.onInitComplete, "function");
  assert.equal(typeof hooks.onUpdateComplete, "function");
  assert.equal(typeof hooks.onDoctorRun, "function");
  assert.equal(typeof hooks.onReconcileRun, "function");
  // Hooks are read-only and return frozen objects.
  const post = hooks.onInitComplete({});
  assert.equal(post.event, "post_init");
  assert.equal(post.auth_state, "unknown");
  assert.ok(Object.isFrozen(post));
  const doc = hooks.onDoctorRun({});
  assert.equal(doc.event, "doctor");
  assert.ok(Array.isArray(doc.recommendations));
  assert.ok(doc.recommendations.length > 0);
  const rec = hooks.onReconcileRun({});
  assert.equal(rec.event, "reconcile");
  assert.ok(Object.isFrozen(rec));
});

test("registerWithInitUpdateDoctor hooks never invoke mmx (audit-friendly)", () => {
  // The hooks must call runSafeProbe (3 families only) and discoverSkills
  // (read-only).  We assert by inspecting the probe_families on the snapshot
  // and confirming the skill paths never have present=true (so no files
  // were created).
  const hooks = gateway.registerWithInitUpdateDoctor({ projectRoot: "/tmp/__nonexistent_proj__", templatesRoot: "/tmp/__nonexistent_tpl__" });
  const snap = hooks.capabilitySnapshot();
  assert.deepEqual(snap.probe_families, ["version", "help", "resource_help"]);
  const skills = hooks.enumerateSkills();
  for (const s of skills) {
    assert.equal(s.present, false);
  }
});

// ─── assertNoForbiddenSubcommandInvocation: forbid list ──────────────────

test("assertNoForbiddenSubcommandInvocation catches forbidden command lines", () => {
  const forbidden = [
    "mmx auth status",
    "mmx auth login",
    "mmx auth logout",
    "mmx auth refresh",
    "mmx config show",
    "mmx config set",
    "mmx config export-schema",
    "mmx quota show",
    "mmx update",
    "mmx install",
    "mmx file upload",
    "mmx file list",
    "mmx file delete",
    "mmx text chat",
    "mmx text repl",
    "mmx image generate",
    "mmx video generate",
    "mmx video task get",
    "mmx video download",
    "mmx speech synthesize",
    "mmx speech voices",
    "mmx music generate",
    "mmx music cover",
    "mmx vision describe",
    "mmx search query",
  ];
  for (const cmd of forbidden) {
    assert.throws(
      () => gateway.assertNoForbiddenSubcommandInvocation(cmd),
      (err) => err.code === "ERR_FORBIDDEN_MMX_INVOCATION",
      `expected throw for: ${cmd}`
    );
  }
});

test("assertNoForbiddenSubcommandInvocation regression: paid subcommands by resource", () => {
  const regressions = [
    ["text", "chat"],
    ["text", "repl"],
    ["image", "generate"],
    ["video", "generate"],
    ["video", "task", "get"],
    ["video", "download"],
    ["speech", "synthesize"],
    ["speech", "voices"],
    ["music", "generate"],
    ["music", "cover"],
    ["vision", "describe"],
    ["search", "query"],
  ];
  for (const parts of regressions) {
    const cmd = `mmx ${parts.join(" ")}`;
    assert.throws(
      () => gateway.assertNoForbiddenSubcommandInvocation(cmd),
      (err) => err.code === "ERR_FORBIDDEN_MMX_INVOCATION",
      `regression: expected throw for: ${cmd}`
    );
  }
});

test("assertNoForbiddenSubcommandInvocation allows the three allow-listed families", () => {
  const allowed = [
    "mmx --version",
    "mmx --help",
    "mmx text --help",
    "mmx image --help",
    "mmx video --help",
    "mmx speech --help",
    "mmx music --help",
    "mmx vision --help",
    "mmx search --help",
  ];
  for (const cmd of allowed) {
    gateway.assertNoForbiddenSubcommandInvocation(cmd);
  }
});

test("assertNoForbiddenSubcommandInvocation regression: allow-list stays open for --help", () => {
  for (const r of cc.MINIMAX_RESOURCES) {
    gateway.assertNoForbiddenSubcommandInvocation(`mmx ${r} --help`);
  }
  gateway.assertNoForbiddenSubcommandInvocation("mmx --version");
  gateway.assertNoForbiddenSubcommandInvocation("mmx --help");
});

// ─── probeGateway + discoverSkills delegation ─────────────────────────────

test("probeGateway delegates to probeMod and forces auth_state='unknown'", () => {
  const snap = gateway.probeGateway({ binary: "mmx", exec: () => ({ status: 0, stdout: "mmx 1.0.18\n", stderr: "" }) });
  assert.equal(snap.auth_state, "unknown");
  assert.equal(snap.no_credential, true);
});

test("discoverSkills delegates to skillDiscovery", () => {
  const descriptors = gateway.discoverSkills("/tmp/__nonexistent__");
  // 21 portable paths including both Pi user roots.
  assert.equal(descriptors.length, 21);
});

// ─── GovernedToolError class ──────────────────────────────────────────────

test("GovernedToolError carries code and details", () => {
  try {
    gateway.buildMinimaxCliRequirement({ resource: "text" });
    assert.fail("expected throw");
  } catch (err) {
    assert.equal(err.name, "GovernedToolError");
    assert.equal(err.code, "ERR_SUBCOMMAND_INVALID");
  }
});