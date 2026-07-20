---
name: runtime-state-mcp
description: Expose Cortex Agent runtime-state projections through an optional, read-only MCP stdio adapter. Use when a local MCP client needs the same Management API state used by CLI and Dashboard without reading .agent state directly.
---

# Runtime State MCP

Start the optional adapter with a configured Management API script:

```bash
CORTEX_MANAGEMENT_API_SCRIPT=.agent/skills/management-api/scripts/index.js \
  node .agent/skills/runtime-state-mcp/scripts/server.js
```

The server implements `initialize`, `resources/list`, and `resources/read`. Resource URIs use `cortex://runtime-state/<query>`, where `<query>` is one of the frozen projection queries.

## Boundaries

- Treat the Management API projection as the only data source. Never parse `.agent/` state files here.
- Keep the adapter read-only. Do not add mutation methods or MCP tools.
- Send protocol frames only to stdout and diagnostics only to stderr.
- Fail closed for unknown URIs, unsupported methods, malformed Management API output, or an unavailable API.
- Keep this server optional: nothing invokes it unless an MCP client starts it.

