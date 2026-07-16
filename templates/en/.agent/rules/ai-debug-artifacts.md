# AI Debug Artifact Rules

AI-generated screenshots, logs, temporary JSON files, and browser debugging output must be kept under `.agent/debug/` unless the user explicitly requests another location.

## Directory Contract

```text
.agent/debug/
├── screenshots/
├── logs/
└── temp/
```

## Rules

- Store Playwright, Browser, Computer Use, and other UI screenshots in `.agent/debug/screenshots/`.
- Store temporary command, server, and browser logs in `.agent/debug/logs/`.
- Store temporary API responses, probes, and scratch JSON/text files in `.agent/debug/temp/`.
- Do not scatter debugging artifacts in the project root.
- Do not treat `.agent/debug/` as release evidence. Long-lived evidence should move to `.agent/missions/<id>/evidence/` or project documentation assets.
- Clean up stale files before handoff or commit when they are no longer useful.

## Naming

Use descriptive names with a feature and timestamp, for example:

```text
login-error-20260716.png
api-response-user-list-20260716.json
dev-server-20260716.log
```
