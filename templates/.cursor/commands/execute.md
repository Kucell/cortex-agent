---
description: Universal router for execution of .agent workflows
globs: *
---
# Universal Workflow Router
**Trigger**: When the user types ANY command starting with `/` (e.g. `/start-task`, `/deploy`, `/custom-flow`), CHECK if a corresponding file exists in `.agent/workflows/`.
**Execution Protocol**:
1. **Dynamic Lookup**: Look for `.agent/workflows/[command-name].md`.
2. **Hit**: If the file exists, immediately READ IT and EXECUTE IT as the primary procedure.
3. **Miss**: If the file doesn't exist, inform the user "Workflow [command-name] not found in .agent/workflows/".
