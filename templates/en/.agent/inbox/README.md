# Inbox Messages

Inbox messages are small, durable coordination records between agents, workflows, and users. Stable IDs use the `IM-` prefix. Large bodies belong in Artifact Bus files and are referenced through `artifact_refs`; inbox records should remain concise and indexable.

## Lifecycle

```text
unread -> read -> acknowledged -> archived
   |        |            |
   +--------+------------+-> archived
```

Archival is terminal. Acknowledgement records that the recipient accepted responsibility; it does not approve a Decision or release a Waitpoint.

## Write Ownership

- The sending workflow owns creation and may only create an `unread` message.
- The addressed recipient or an explicit handoff workflow owns `read` and `acknowledged` transitions.
- The recipient, originating workflow, or a user-directed maintenance workflow may archive a message.
- Dashboard and Management query surfaces are read-only. They must never acknowledge, archive, or otherwise mutate a message.

Writers validate the entity and index schemas, write a temporary file in this directory, flush and close it, then atomically rename it over the target. Update `index.json` with the same temp-file-and-rename rule only after the entity write succeeds. Never edit a JSON record in place.

## Files

- `inbox-message.schema.json`: canonical message contract.
- `index.schema.json`: machine-readable index contract.
- `index.json`: compact discovery index; message bodies remain in `IM-*.json` files.
