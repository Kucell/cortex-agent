# Cortex Agent Entry for DSH (DeepSeek Harness)

本项目使用 `.agent/` 作为 agent 规则、工作流、技能和项目知识的唯一事实来源。

请优先加载并遵循：

1. `AGENTS.md`（项目根）
2. `.agent/rules/core-principles.md`
3. `.agent/rules/ai-behavior.md`
4. `.agent/rules/code-standards.md`
5. `.agent/workflows/`

跨 Agent 工具切换时，以 `.agent/memory/MEMORY.md` 作为项目共享记忆索引；宿主私有记忆只作为缓存，写入与去重规则见 `.agent/rules/memory-protocol.md`。

项目专属信息请维护在 `.agent/references/` 和 `.agent/rules/tech-stack.md`。
如果存在旧配置导入内容，请检查 `.agent/imported_rules/` 并迁移有价值的信息。

如有冲突，以 `.agent/` 内容为准。

> DSH 是 Cortex Agent 的 first-class dispatch adapter（与 Pi / Claude Code / Codex CLI 同等地位）。
> 安装与使用说明见 `.dsh/README.md`；能力边界见 `cortex-agent agent adapter discover dsh`。
