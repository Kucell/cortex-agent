---
name: activity-recording
description: Validate and atomically store immutable project activity events and receipts, then rebuild the derived activity index.
---

# Activity Recording

Use the zero-dependency storage script through an owning workflow:

```bash
node .agent/skills/activity-recording/scripts/index.js init
node .agent/skills/activity-recording/scripts/index.js event append --payload-json '<json>'
node .agent/skills/activity-recording/scripts/index.js receipt append --payload-json '<json>'
node .agent/skills/activity-recording/scripts/index.js rebuild-index
node .agent/skills/activity-recording/scripts/index.js validate
```

The event and receipt files are immutable facts. `index.json` is derived and rebuildable. A failed index update never deletes a successfully written fact.
