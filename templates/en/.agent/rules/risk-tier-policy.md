# Risk Tier Policy

## Purpose

Classify task risk before automation or review so the existing Task Pipeline, Validation Contract, Decision/Waitpoint, and owning workflow select an appropriate evidence threshold. This policy adds no state machine and grants no execution authority.

## Tiers

| Tier | Default controls | Prohibited until a separate resource-bound Decision, Waitpoint, and owning-workflow/environment gate exist |
| :--- | :--- | :--- |
| low | Scope and validation evidence; normal project review policy | Bypassing protected branches, host or environment permissions. |
| medium | Final plan, validation evidence and independent review | Expanding writable scope without recorded deviation. |
| high | Owner architecture Decision, enhanced validation and independent or human review | Merge, release, high-impact action or external side effect. |
| critical | Named human Decision, environment gate and manual or pre-approved runbook | Direct agent execution, agent-to-agent privilege transfer, production deployment. |

Unknown, cross-environment, sensitive-path, external-side-effect, or unclear agent-to-agent authority is high until an owner records a narrower classification.

## Artifact Contract

- Spec records intent summary, constraints, non-goals, open questions and risk tier.
- Plan records spec reference, writable scope, validation commands, risk rationale and deviation policy.
- Review records risk tier, independent reviewer evidence, proof-carrying findings and verdict.
- Learning records source event, confirmer, destination rule/fixture/task or bounded waiver, and a verification plan.

Risk tier must appear in a Spec or Plan artifact; a missing or unknown tier is treated as high before execution. These fields are payload/template conventions first. Promote them to a cross-host schema requirement only after fixture and pilot evidence demonstrates interoperability need.

## Authority Boundary

A trigger is a condition, not approval. A risk tier selects required evidence and gates; it never replaces the owning workflow, a resource-bound Decision, Waitpoint, environment control, or human authorization.
