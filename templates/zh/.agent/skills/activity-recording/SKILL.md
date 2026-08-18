---
name: activity-recording
description: Validate and atomically store immutable project activity events and receipts, then rebuild the derived activity index.
area: aiapp
summary: Validate and atomically store immutable project activity events and receipts, then rebuild the derived activity index.
---

# Activity Recording

Use the zero-dependency storage script through an owning workflow:

```bash
node .agent/skills/activity-recording/scripts/index.js init
node .agent/skills/activity-recording/scripts/index.js event append --payload-json '<json>'
node .agent/skills/activity-recording/scripts/index.js receipt append --payload-json '<json>'
node .agent/skills/activity-recording/scripts/index.js record-event \
  --kind <intent|execution|change|validation|decision|coordination|runtime|knowledge|external> \
  --source </workflow> \
  --summary "<text>" \
  --actor-type <user|agent|workflow|system|external> \
  --actor-id </workflow> \
  --dedupe-key <stable-key>
node .agent/skills/activity-recording/scripts/index.js record-receipt \
  --kind <capture|import|reconciliation|delivery|commit_intent|commit_result> \
  --source </workflow> \
  --activity-refs ACT-1,ACT-2 \
  --availability <available|unavailable|failed|stale> \
  --redaction <passed|failed|not_applicable> \
  --dedupe-key <stable-key>
node .agent/skills/activity-recording/scripts/index.js rebuild-index
node .agent/skills/activity-recording/scripts/index.js validate
```

The event and receipt files are immutable facts. `index.json` is derived and rebuildable. A failed index update never deletes a successfully written fact.

Workflows that own activity (`/start-task`, `/mission`, `/ship`, `/commit`, `/handoff`) should prefer `record-event` and `record-receipt` over raw payload JSON. The helpers derive `activity_id`, `observed_at`, `occurred_at`, `project_id`, and the immutable payload scaffold; pass only semantic flags.
