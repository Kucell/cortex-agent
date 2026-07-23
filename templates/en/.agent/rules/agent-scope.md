# Agent Capability Scope

This rule determines where a new or changed Rule, Workflow, Skill, or other agent capability is distributed and maintained. Classification is based on intended users, distribution scope, and maintenance ownership, not on where the first implementation happens to live.

## Three-Layer Model

| Layer | Scope | Classification criteria | Typical content |
|---|---|---|---|
| L1 | General Distribution | Included in project templates, distributed to all ordinary projects, and directly usable by them | General engineering principles, standard workflows, portable skills |
| L2 | Project Instance | Maintained and used only by the current project, with dependencies on its structure, technology stack, delivery process, or domain constraints | Project workflows, repository conventions, project-specific skills |
| L3 | Capability-Provider Self-Maintenance | Used only to develop, maintain, and release the framework or capability provider itself and never distributed to ordinary projects | Provider-internal maintenance rules, bootstrap workflows, capability release tools |

L1 is the general distribution surface, L2 is the local extension surface of a project instance, and L3 is the capability provider's self-maintenance surface. L2 may constrain or extend L1 but must not silently change its general semantics. L3 may maintain and produce L1 capabilities, but L3 maintenance rules must not be distributed to ordinary projects through templates.

One-off tasks, proposals, Missions, experiment records, and temporary collaboration notes are temporary artifacts, not L1, L2, or L3 capability layers. Store them in the corresponding task or planning area; do not package them as long-lived Rules, Workflows, or Skills merely because they might be reused.

## Decision Process

Classify the capability before writing files:

1. **Identify the capability boundary**: state the problem, intended users, dependencies, and expected lifetime.
2. **Exclude temporary artifacts**: if the content serves only a one-off task, proposal, Mission, experiment, or temporary collaboration, keep it as a temporary artifact and do not create a long-lived agent capability.
3. **Check general distribution value**: if ordinary projects can use the capability directly after project names, directory layouts, domain terms, and organization policies are removed, classify it as L1 and include it in templates.
4. **Check project-instance dependencies**: if the capability depends on and serves only the current project's structure, technology stack, release policy, or team convention, classify it as L2 and do not distribute it to other projects.
5. **Check provider self-maintenance**: if the capability is used only to develop, maintain, bootstrap, or release a framework or capability provider, classify it as L3 and exclude it from ordinary project templates.
6. **Record and verify**: record the selected layer, rationale, target path, and distribution scope in the change summary; verify that references resolve, template boundaries are correct, and higher-priority rules are not overwritten.

## Boundaries And Promotion

- When content combines a general mechanism with project policy, split it into an L1 mechanism and L2 configuration or extension.
- When content combines a distributable capability with provider maintenance logic, split it into an L1 capability and L3 self-maintenance rules; include only the L1 part in templates.
- Before promoting L2 or L3 content to L1, remove project- or provider-specific identifiers, private state, and environment paths, then add cross-project validation.
- When long-term ownership is uncertain, keep the content as a temporary artifact and request a maintainer decision; do not default it to L3.
- When rules conflict, follow the priority declared by the current project and preserve the boundaries among L1 distribution, L2 instance customization, and L3 provider self-maintenance.

## Storage Location

- L1: write to the general capability source and project templates so every ordinary project receives it during initialization or update.
- L2: write to the corresponding directory under the current project's `.agent/` and do not flow it back into general templates.
- L3: write to the framework or capability provider's self-maintenance area and ensure it never enters ordinary project templates.
- Temporary artifacts: write to the corresponding task, proposal, Mission, experiment, or temporary-collaboration area and state completion or cleanup conditions.

## New Capability Bootstrap Verification Order

When a framework or capability provider promotes a new capability through `/agent-update` into reusable templates, it must verify the capability in the provider's own `.agent/` before syncing it to templates or downstream projects.

Standard order:

1. **Update the provider instance first**: land or complete the rule in the provider repository's `.agent/` and confirm it can govern the current session.
2. **Verify by self-use**: run the capability once through a real or dry-run path and leave reviewable evidence such as the command, exit code, generated report, artifact path, or workflow check record.
3. **Then sync templates**: sync to general templates or shared capability sources only after provider-side bootstrap verification passes.
4. **Finally sync downstream projects**: use update/upgrade flows for real projects only after template semantics are stable.
5. **Report evidence**: final summaries must include the provider-side `.agent` verification result, not only state that templates were updated.

Pure typo fixes, link fixes, or explanatory changes with no behavior change may skip a bootstrap run, but the summary must explicitly state that there was no behavior change and therefore no bootstrap verification was run.

`/agent-update` must complete this scope classification before creating or changing an agent capability.
