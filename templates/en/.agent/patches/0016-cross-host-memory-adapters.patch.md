---
id: 0016-cross-host-memory-adapters
target: rules/memory-protocol.md
anchor: "### Host-private memory adapters"
insert_after: "memory is **lightweight notes for Agent recall**, not \"long-term archival\"."
---

## 5.1 Cross-Host Handoff

- Global Cortex Agent memory lives in `~/.agent/memory/`; project-shared memory lives in `<project>/.agent/memory/`.
- Codex, Claude, Gemini, Cursor, Cline, Roo, Pi, MiniMax, Qoder, and other hosts use the current project's `.agent/memory/MEMORY.md` as the shared recall index.
- Host-private memory is only a cache; reusable project facts, feedback, and references must be deduplicated and stored in project `.agent/memory/` under this protocol.

### Host-private memory adapters

| Host | User/global memory | Project/runtime memory | Integration boundary |
|---|---|---|---|
| MiniMax | `~/.minimax/memory/user.md`; tracking logs under `~/.minimax/memory/tracking/` | `main` and `topic` targets are runtime-managed; `summary` is a view | Use MiniMax `memory` / `mavis` tools. Do not edit runtime-managed internals directly. Normalize reusable project facts into `<project>/.agent/memory/`. |
| Qoder CN | `~/.qoder-cn/memories/<user-hash>/global/<category>/` | `~/.qoder-cn/memories/<user-hash>/projects/<encoded-project-path>/<category>/` | Discover the account hash and project bucket at runtime; never hardcode them. Treat `SharedClientCache/index/` as an index cache, not memory content. Normalize reusable facts into `<project>/.agent/memory/`. |

Host-private stores remain owned by their host. Cortex Agent reads them only through supported host capabilities or read-only discovery, and never writes directly unless that host explicitly documents the file as user-editable.
