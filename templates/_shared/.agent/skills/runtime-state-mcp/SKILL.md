---
name: runtime-state-mcp
description: Expose one explicit Cortex Agent project through the standard, read-only Management API MCP stdio adapter.
---

# Runtime State MCP

## Start

Use the public CLI and bind exactly one project:

```bash
cortex-agent mcp serve --project /path/to/project
```

Use `cortex-agent help --json` for the machine-readable CLI contract and `cortex-agent help query --json --project <path>` for the target project's real projection capabilities.

## Protocol

- Stdio JSON-RPC only; protocol frames go to stdout and diagnostics go to stderr.
- Resources use `cortex://management/<projection>` and are generated from the real Management API capability registry.
- Every listed resource is readable through `resources/read` and semantically matches the direct Management API projection.
- The only tool is read-only `cortex.query`, with projection filters validated against the same registry.
- Supported protocol versions are negotiated during `initialize`; unknown versions fail closed.

## Boundaries

- The process is bound to the explicit local project passed through `--project`; MCP roots cannot change scope.
- Never parse `.agent` state directly; Management API is the only projection source.
- Writer tools are disabled. Do not add mutation, shell, daemon, dispatch, trigger, credential, or arbitrary path tools.
- Unknown projections, URIs, methods, tools, arguments, malformed API output, and unavailable projects fail closed.
- The internal server script is an implementation/debug entry point, not the standard Agent command.
