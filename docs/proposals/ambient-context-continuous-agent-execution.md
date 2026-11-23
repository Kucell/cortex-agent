# Proposal: Context-Aware Continuous Agent Execution
Status: DRAFT / DESIGN-ONLY / NO IMPLEMENTATION AUTHORIZATION
Date: 2026-10-16
Source inspiration: https://www.ambi.ai/ (product pattern only; no claim about proprietary architecture).

## Problem and boundary
Cortex currently owns durable project governance, Mission/Task/Decision/Waitpoint, Owner/Lease, CAS and cross-device reconciliation. Add proactive **suggestions** from authorized project signals, without inventing a parallel scheduler or bypassing any governance gate. Workbench presents approvals; Autopeer provides secure connectivity, not execution authority.

## Proposed capability slices
1. **ContextEvent**: normalized, consent-scoped metadata (source, project identity, event id, timestamp, provenance, sensitivity, retention, revision); dedupe and explicit ingestion policy. Default to project events (CI, PR, task, health), *not* ambient microphone/desktop recording.
2. **ContextProjection**: bounded retrieval / recent-state projection with provenance, staleness and redaction; never rewrite authoritative Task or Decision from model inference.
3. **ActionCandidate**: Next Action Advisor emits explanation, source evidence, confidence, suggested owner, expiration, cost/risk, action category and required governance gates. Proposal-only; idempotency key; can be rejected/expired.
4. **RoutineDefinition** (future): recurring/conditional goals with schedule/trigger, rate and token budgets, scope, pause/resume, revocation, compensation and durable checkpoint; map executions to existing Mission/Task/Evidence without creating a second authority.
5. **Execution**: only after Decision + released Waitpoint + Owner/Lease + matching ProjectIdentity/plan digest/revision/budget/expiry. CI/tool execution via existing approved RuntimePort; fail-closed on drift, offline, conflicts and revocation. No ambient source may grant permission.
6. **Projection API**: read-only suggestions/routine status shared by CLI/MCP/Dashboard; Workbench may submit governed decision intents using existing APIs; Autopeer remains transport only.

## Phased design requests
- P0: inventory current advisor, L3, self-learning, remote governance contracts and dedupe overlapping proposals; schema + threat model + migration impact, no code.
- P1: testable ContextEvent + ActionCandidate contracts; deterministic fixture-based false-positive/duplicate/no-op tests.
- P2: persistent Routine state machine and recovery, explicit approval UX, cross-session reconciliation.
- P3: optional voice/meeting adapters behind explicit per-source consent, user-controlled retention and third-party processor disclosure.
- L4 is a separate governance approval decision, not implied by this proposal.

## Acceptance / G0 gates
No unapproved side effects; provenance and retention for every stored signal; idempotent candidates; stale revision blocked; revocation stops dispatch; concurrent agent lease collision safe; failed/offline device recovery deterministic; redacted secrets; budget ceilings; metrics: useful suggestion rate, noise rate, task resume success, side-effect escape count (target 0).

## Requested owner deliverable
Architecture decision, delta-vs-existing roadmap, formal G0 review, API/schema, test matrix, phased milestones with estimates, implementation authorization recorded separately in cortex-agent-agent. Do not merge this design PR as an implementation authorization.

## Cross-project
- Governance: https://github.com/Kucell/cortex-agent-agent
- UX: https://github.com/bookmagic-co/platform-ai-workbench
- Network: https://github.com/Kucell/autopeer
