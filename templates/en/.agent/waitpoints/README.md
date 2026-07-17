# Waitpoints

Waitpoints suspend an action until explicit evidence satisfies a declared release condition. Stable IDs use the `WP-` prefix. A Waitpoint coordinates work around a Task gate; it never changes the Task gate owner or mutates a Task gate directly.

## Lifecycle

```text
pending -> blocked -> released
   |          |----> canceled
   |          +----> expired
   +---------------> canceled
   +---------------> expired
```

`released`, `canceled`, and `expired` are terminal. Because every supported gate action is high risk, release requires both `decision_id` and non-empty `evidence_refs`, together with the releasing identity and timestamp.

## Write Ownership

- The workflow that detects the unmet condition owns creation and the `pending -> blocked` transition.
- Only the workflow that owns the suspended action may release the Waitpoint after validating its Decision and evidence.
- The creating workflow or a user-directed governance workflow may cancel it; timeout policy may expire it.
- Dashboard and Management query surfaces are read-only. They must never release a Waitpoint or approve its related Decision.

Writers validate the entity and index schemas, write a temporary file in this directory, flush and close it, then atomically rename it over the target. Update `index.json` with the same temp-file-and-rename rule only after the entity write succeeds. Never edit a JSON record in place.

## Release Validation

Before release, the owning writer must verify all of the following:

- The linked Decision exists and has status `approved`.
- `selected_option` is `approve`, or the explicitly standardized approval option declared by the Decision-owning workflow.
- The Decision and Waitpoint `gate.action` values are identical.
- The Decision and Waitpoint `gate.resource_ref` values are identical.
- `evidence_refs` contains the linked Decision file reference in addition to any supporting validation artifacts.

A matching ID alone is not approval evidence. Dashboard and read-only query surfaces may report these fields but cannot perform the release.
