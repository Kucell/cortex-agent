# cortex-agent decisions request

Open a gated Decision that a workflow or the user must resolve before a
gated action may proceed.

## Usage

    cortex-agent decisions request --project <path> --decision-id <id> \
      --gate <workflow> --gate-action <action> --type <type> \
      --requested-by <id> --prompt <text> --resource-ref <ref> --options <json>

## Required

  --project <path>        Project root directory.
  --decision-id <id>      Decision identifier (e.g. D-ARI-P009-cli-runtime-contract).
  --gate <workflow>       Workflow gate: mission | agent | user.
  --gate-action <action>  Decision gate action: architecture | merge | release |
                          destructive | credential | external_side_effect.
  --type <type>           Decision type: approval | architecture | merge | release | risk.
  --requested-by <id>     Requester identity.
  --prompt <text>         Human-readable question being decided.
  --resource-ref <ref>    Gated resource (e.g. proposal:<path>@<digest>).
  --options <json>        JSON array with at least 2 options.

## Deprecated

  --action <action>       Alias of --gate-action. Still accepted through the
                          1.x compatibility window and emits a stderr warning:
                          "warning: --action is deprecated, use --gate-action instead"
                          When both flags are present, --gate-action wins.

## Optional relations

  --task-id <id>         Related task (repeatable).
  --mission-id <id>      Related mission (repeatable).
  --run-id <id>          Related run (repeatable).
  --queue-id <id>        Related queue (repeatable).
  --session-id <id>      Related session (repeatable).
  --artifact-ref <ref>   Related evidence or source (repeatable).
  --worktree-path <path> Related worktree (repeatable).

## Notes

  --gate and --gate-action are distinct concepts. --gate selects the workflow
  allowed to perform the write; --gate-action selects the decision gate being
  requested. Both are required; omitting --gate fails closed with the
  WORKFLOW_GATE_REQUIRED error code.
  --resource-ref binds the gate; relation flags populate the Decision's relations.

## Example

    cortex-agent decisions request --project . \
      --decision-id D-ARI-P009-cli-runtime-contract --gate mission \
      --gate-action architecture --type approval --requested-by arch-design \
      --prompt "Approve P-009?" \
      --resource-ref proposal:.agent/plans/proposals/projects/agent-runtime-interoperability/proposals/P-009-governed-cli-runtime-contract-proposal.md \
      --options '["approve","reject"]'
