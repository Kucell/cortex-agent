---
name: opt-in-runtime-feedback-pilot
description: Deterministic CI flaky-test rate detector and read-only diagnosis / proposal artifact generator for the M-032 MS-003 opt-in runtime feedback pilot. Never authorizes merge, release, push, publish, credential access, deployment, destructive actions, or external side effects.
---

# Opt-In Runtime Feedback Pilot

The pilot is bound to the Mission M-032 MS-003 resource
`mission://M-032/MS-003/runtime-feedback-pilot?signal=ci-flaky-test-rate&scope=non-production&capability=diagnosis-or-proposal-only`
and the corresponding Decision `D-M032-MS003-runtime-pilot-5f9b7e2a` /
Waitpoint `WP-M032-MS003-runtime-pilot-5f9b7e2a`.

## Trigger

1. `node .agent/skills/opt-in-runtime-feedback-pilot/scripts/index.js detect --input <ci-runs.json> --output <trigger.json>`
2. The detector is deterministic: it only reads the provided JSON snapshot of CI runs, never reaches out to the network, and never executes anything. It computes the 7-day rolling flaky-test rate and emits a `trigger.json` artifact only when the threshold is exceeded.
3. The output is a `runtime_feedback_trigger` artifact: `{ "type", "decision_id", "waitpoint_id", "signal", "scope", "capability", "environments", "metrics", "generated_at", "evidence_refs", "authority_boundary" }`.

## Diagnosis / proposal

4. `node .agent/skills/opt-in-runtime-feedback-pilot/scripts/index.js diagnose --trigger <trigger.json> --output <diagnosis.json>`
   produces a `runtime_diagnosis` artifact with `severity`, `affected_tests`, `remediation_options`, and `evidence_refs`. It performs read-only analysis on the provided CI snapshot; it never writes code, edits state, or contacts the network.
5. `node .agent/skills/opt-in-runtime-feedback-pilot/scripts/index.js proposal --diagnosis <diagnosis.json> --output <proposal.json>`
   produces a `runtime_proposal` artifact (a Spec/Task draft) that still must be routed through the existing review/decision gates. It does not call merge/release/push/publish.
6. Every output records `agent_identity`, `allowed_tools = []`, `message_route = none`, `evidence_refs`, `decision_id`, `waitpoint_id`, and an `authority_boundary` field that explicitly denies write or release privilege.

## Authority

- Pilot is fail-closed: it rejects any `decision_id` / `waitpoint_id` other than the bound MS-003 resource, refuses to emit a proposal unless the trigger evidence is present, and refuses to emit a diagnosis unless a trigger exists.
- Any attempt to add a write tool, deployment flag, or credential access path is rejected by the schema (`additionalProperties: false` on the audit record).
- Merging, releasing, publishing, deploying, or contacting production systems is **never** performed by this skill; if the user needs that, they must issue a separate resource-bound Decision/Waitpoint.
