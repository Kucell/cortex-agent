# cortex-agent agent adapter list

List the runtime adapters discovered for the target project together with
their declared capabilities and health state.

## Usage

    cortex-agent agent adapter list [options]

## Options

  --project <path>        Target project root (default: cwd).
  --output json|human     Output format (default: human).
  --json                  Shortcut for --output json.

## Sibling subcommands

  agent adapter health <adapter_id>          Probe a single adapter.
  agent dispatch-execute <id> <task>         Execute a dispatched task (M-003).

## Notes

  Adapter discovery reads the M-002 static capability registry; it does not
  spawn host processes. Dispatch-execute is the only subcommand that performs
  real work and it defaults to the M-001 adapter.invoke path unless a
  transport protocol is selected explicitly.
  The frozen capability vocabulary is owned by the registry and is not
  extended by CLI flags.

## Example

    cortex-agent agent adapter list --project . --json
