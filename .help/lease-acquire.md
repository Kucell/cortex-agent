# cortex-agent lease acquire

Acquire an ownership lease over a named resource. Leases are the fencing
primitive used to keep at most one writer per resource.

## Usage

    cortex-agent lease acquire --scope <scope> --owner <owner> [options]

## Required

  --scope <scope>         Resource scope being leased (e.g. pi:M-034).
  --owner <owner>         Owner identity requesting the lease.

## Options

  --actor <actor>         Acting identity when it differs from --owner.
  --ttl <seconds>         Lease time-to-live in seconds.
  --idempotency-key <key> Idempotency key for safe retries.
  --evidence <ref>        Evidence reference (repeatable).
  --project <path>        Target project root (default: cwd).
  --json                  Emit machine-readable JSON.

## Sibling subcommands

  lease renew   --lease-id <id> | --scope <scope> [--owner <owner>] [--ttl <s>]
  lease release --lease-id <id> [--actor <actor>] [--evidence <ref>...]
  lease status  [--lease-id <id> | --scope <scope>]
  lease recover --scope <scope> --new-owner <owner> [--takeover-timeout-ms <ms>]

## Notes

  The CLI is a thin adapter over the audited LeaseManager. Fencing, TTL,
  idempotency and durable state stay owned by LeaseManager; this command
  never creates a task and never starts a host.
  Sensitive evidence strings (API keys, tokens, passwords) are rejected at
  the argument boundary before any audit row is written.
  State persists to .agent-runtime/coordination/leases/{state.json,idempotency.json}.

## Example

    cortex-agent lease acquire --scope pi:M-035 --owner pi --ttl 3600
