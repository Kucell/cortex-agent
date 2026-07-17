# Decisions

Decision records are durable, user-resolvable choices that authorize or reject sensitive actions. Stable IDs use the `D-` prefix. A caller-provided string such as `--gate approve` is never sufficient evidence: the referenced Decision must exist, match the protected resource, be in an allowed terminal state, and be consumed according to the owning workflow.

## Lifecycle

```text
open -> approved
     -> rejected
     -> revision_requested
     -> canceled
     -> superseded
```

All states after `open` are terminal. A changed choice requires a new Decision; the old record is superseded and linked through `superseded_by_decision_id`.

## Write Ownership

- The workflow that reaches an approval boundary owns creation of an `open` Decision.
- Only an explicit user decision resolver may set `approved`, `rejected`, or `revision_requested` and populate resolution fields.
- The requesting workflow may cancel an unresolved Decision. It may run `decisions supersede --gate requester` to supersede it with a compatible open replacement owned by the same requester.
- Dashboard and Management query surfaces are read-only. They must never select an option or resolve a Decision.

Writers validate the entity and index schemas, write a temporary file in this directory, flush and close it, then atomically rename it over the target. Update `index.json` with the same temp-file-and-rename rule only after the entity write succeeds. Never edit a JSON record in place.

## Gate Evidence

`gate.action` identifies the protected action and `gate.resource_ref` identifies its exact target. Approval consumers must verify both fields, `selected_option`, `resolved_by`, `resolved_at`, and current Decision status. Reuse against a different resource is forbidden.
