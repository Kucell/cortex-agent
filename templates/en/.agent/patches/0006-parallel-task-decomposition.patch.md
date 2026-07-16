---
id: 0006-parallel-task-decomposition
target: workflows/parallel.md
anchor: ".agent/rules/task-decomposition.md"
---

---

## Task Decomposition Rule Integration

Before scheduling, read `.agent/rules/task-decomposition.md` and use its rules to decide batches:

- Tasks editing the same file, config, shared type, database migration, or interface contract are serial by default
- Read-only research, validation, and documentation may run alongside implementation
- If the upstream interface contract is not confirmed, do not run multiple implementation tasks against guessed interfaces
- Each sub-agent context package must include acceptance criteria, writable scope, non-writable scope, and conflict checkpoints
