# Runtime Continuity

Runtime Continuity stores transferable agent work state inside `.agent/` so
different host tools can resume the same project without access to each
other's private chat transcript.

Authoritative workflow:

```bash
node .agent/skills/runtime-continuity/scripts/index.js log --project <project> ...
node .agent/skills/runtime-continuity/scripts/index.js checkpoint --project <project> ...
node .agent/skills/runtime-continuity/scripts/index.js archive --project <project> --gate user --full
node .agent/skills/runtime-continuity/scripts/index.js resume-bundle --project <project>
```

Files:

- `events/*.json` — append-only transferable work log events.
- `archives/*.json` — structured restore snapshots.
- `archives/latest.json` — copy of the latest structured archive.
- `state.json` — latest archive pointer and summary.

The user-level Markdown archive still lives in `~/.agent/contexts/<project>/`.
Do not store secrets, OAuth tokens, browser cookies, full private transcripts,
or bulky diffs here. Store references to existing artifacts instead.

