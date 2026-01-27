---
name: migrate-rules
description: Interactively migrate and merge legacy AI assistant rules into the Cortex Agent framework.
---

# Rules Migration Workflow (/migrate-rules)

Hello! I'm the Cortex Agent. I will help you safely migrate your existing AI assistant settings into the Cortex Agent framework.

I've found previous configuration files in the `.agent/imported_rules/` directory. Let's review each file together and merge them into the new `.agent/rules/` structure.

---

## Migration Process

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

## 1. File Review

// The agent will list the first file found in `.agent/imported_rules/`
The current file under review is: `[Agent will insert file name here]`

**Legacy Rule Content:**
```
[Agent will insert content of the imported file here]
```

## 2. Specify Merge Target

Which file in the `.agent/rules/` directory would you like to merge these rules into? (e.g., `tech-stack.md`, `architecture-design.md`)

> (Enter your answer here)

## 3. Execute Merge

Okay, let's compare the legacy rules with the existing rules in the target file.

**Legacy Rules (`[imported file]`)**:
```
[Agent will insert content of the imported file here]
```

**Current Rules (`[target file]`)**:
```
[Agent will insert content of the target rule file here]
```

**How would you like to merge them?** (e.g., "Replace all with legacy rules," "Append only the following content: ...," "Merge the content of both files")

> (Enter your answer here)

## 4. Clean Up

The merge was successful! May I now delete the original imported file `[imported file]`?

> (Enter your answer here)

---
I will repeat this process until all imported legacy rule files have been migrated.
