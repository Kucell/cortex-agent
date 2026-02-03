---
name: migrate-rules
description: Interactively migrate and merge legacy AI assistant rules into the Cortex Agent framework.
---

# 规则迁移工作流 (/migrate-rules)

你好！我是 Cortex Agent。我将帮助你把旧的 AI 助手配置，安全地迁移到 Cortex Agent 框架中。

我在 `.agent/imported_rules/` 目录下找到了之前导入的旧配置文件。现在，让我们一起来审查这些文件，并将它们合并到新的 `.agent/rules/` 结构中吧。

---

## 迁移流程

// For each file `F` in `.agent/imported_rules/`
// 1. Read the content of `F`
// 2. Present the content to the user
// 3. Ask the user which rule file in `.agent/rules/` this content should be merged into (e.g., `tech-stack.md`, `architecture-design.md`, `core-principles.md`).
// 4. Read the content of the target rule file `T`.
// 5. Show both the content of `F` (legacy rules) and `T` (current rules) to the user.
// 6. Ask the user for instructions on how to merge them. For example: "Replace all", "Append legacy rules", "Keep only the following rules from legacy: ...".
// 7. Based on the instructions, update the content of the target file `T`.
// 8. After a successful merge, ask the user for confirmation to delete the original file `F` from `.agent/imported_rules/`.
// End loop

## 1. 文件审查 (File Review)

// The agent will list the first file found in `.agent/imported_rules/`
当前审查的文件是： `[Agent will insert file name here]`

**旧规则内容:**
```
[Agent will insert content of the imported file here]
```

## 2. 指定合并目标 (Specify Merge Target)

你希望将这些规则合并到 `.agent/rules/` 目录下的哪个文件中？ (例如: `tech-stack.md`, `architecture-design.md`)

> (请在此处输入你的回答)

## 3. 执行合并 (Execute Merge)

好的，现在我们来比较一下旧规则和目标文件中的现有规则。

**旧规则 (`[imported file]`)**:
```
[Agent will insert content of the imported file here]
```

**当前规则 (`[target file]`)**:
```
[Agent will insert content of the target rule file here]
```

**你希望如何合并它们？** (例如: "用旧规则完全替换", "仅追加以下内容: ...", "将两个文件的内容合并")

> (请在此处输入你的回答)

## 4. 清理 (Clean Up)

合并成功！现在可以删除原始的导入文件 `[imported file]` 了吗？

> (请在此处输入你的回答)

---
我将重复此过程，直到所有导入的旧规则文件都被迁移完毕。
