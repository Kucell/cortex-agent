# Project Activity Records

This directory stores immutable activity events and receipts.

- `events/`: observed or workflow-owned activity facts.
- `receipts/`: capture, import, reconciliation, delivery, and commit receipts.
- `index.json`: rebuildable lookup index; it is not the source of truth.
- `activity-recording-profile.schema.json`: static project recording policy contract.

Large or sensitive payloads stay outside these records. Store redacted summaries and stable evidence or log-cursor references instead.
