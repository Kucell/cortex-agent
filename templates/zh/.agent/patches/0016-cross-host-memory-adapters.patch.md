---
id: 0016-cross-host-memory-adapters
target: rules/memory-protocol.md
anchor: "### 宿主私有记忆适配"
insert_after: "memory 是**被 Agent recall 的轻量笔记**，不是\"长期归档\"。"
---

## 5.1 跨 Agent 工具交接

- Cortex Agent 全局记忆位于 `~/.agent/memory/`，项目共享记忆位于 `<project>/.agent/memory/`。
- Codex、Claude、Gemini、Cursor、Cline、Roo、Pi、MiniMax、Qoder 等宿主统一使用当前项目的 `.agent/memory/MEMORY.md` 作为共享召回索引。
- 宿主私有记忆只能作为缓存；可复用的项目事实、反馈和引用必须按本协议去重并写入项目 `.agent/memory/`。

### 宿主私有记忆适配

| 宿主 | 用户/全局记忆 | 项目/运行时记忆 | 接入边界 |
|---|---|---|---|
| MiniMax | `~/.minimax/memory/user.md`；跟踪日志位于 `~/.minimax/memory/tracking/` | `main`、`topic` target 由 runtime 托管，`summary` 是摘要视图 | 使用 MiniMax `memory` / `mavis` 工具，不直接编辑运行时内部存储；可复用项目事实归一化到 `<project>/.agent/memory/`。 |
| Qoder CN | `~/.qoder-cn/memories/<user-hash>/global/<category>/` | `~/.qoder-cn/memories/<user-hash>/projects/<encoded-project-path>/<category>/` | 运行时发现账号 hash 和项目桶，不得硬编码；`SharedClientCache/index/` 是索引缓存，不是记忆正文；可复用事实归一化到 `<project>/.agent/memory/`。 |

宿主私有存储仍由对应宿主管理。Cortex Agent 只通过受支持的宿主能力或只读发现来读取；除非宿主明确声明文件可由用户编辑，否则不得直接写入。
