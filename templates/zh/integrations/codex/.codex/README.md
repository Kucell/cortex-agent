# Cortex Agent + OpenAI Codex

本目录由 `cortex-agent add codex`（或在 `init` 时勾选）生成。

## 内容说明

- **`config.toml`** — 项目级 Codex 配置（与用户目录 `~/.codex/config.toml` 合并）。
- **`prompts/`** — 指向 `.agent/workflows/` 的符号链接。每个 Markdown 对应一条工作流；Codex **不会像 Cursor 那样**自动注册为 `/斜杠命令`。请使用 **`/mention 某文件路径`**（或在界面中附加该文件），再让 Codex 按该工作流执行。
- **仓库根目录 `AGENTS.md`** — 由 Cortex 的 `init` / `upgrade` 生成；Codex 会自动加载。其中应继续指向 `.agent/rules/` 与 `.agent/workflows/`。

## 参考

- [Custom instructions with AGENTS.md](https://developers.openai.com/codex/guides/agents-md)
- [Slash commands in Codex CLI](https://developers.openai.com/codex/cli/slash-commands)
