---
id: 0002-core-principles-behavior-rules
target: rules/core-principles.md
anchor: "**行为规则**"
---

在 `rules/core-principles.md` 第 2 条后追加第 3 条「行为规则」，使 ai-behavior.md 在会话开始时被明确引用。
此 patch 由 upgrade 自动追加，如文件已包含「行为规则」则跳过。

3.  **行为规则**: 会话开始时读取 `.agent/rules/ai-behavior.md` —— 它管理 Git 纪律、编辑范围、代码探索策略（含 `graphify-out/graph.json` 存在时优先使用 Graphify）以及分阶段提交协议。
