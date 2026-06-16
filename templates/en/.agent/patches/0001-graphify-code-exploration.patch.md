---
id: 0001-graphify-code-exploration
target: rules/ai-behavior.md
anchor: "## 8. Prefer Graphify for Code Exploration"
---

---

## 8. Prefer Graphify for Code Exploration

**Trigger**: understanding an unfamiliar module, tracing call chains, or mapping relationships across multiple files.

**Steps**:

1. **Check whether the graph exists first**:
   ```bash
   test -f graphify-out/graph.json && echo "available"
   ```
2. **If available, query Graphify before resorting to grep or file-by-file reads**:
   - Module relationships / call chains → `/graphify query "<keyword>"`
   - Connection path between two files/modules → `/graphify path "<file-a>" "<file-b>"`
   - Role and upstream/downstream of a node → `/graphify explain "<node-name>"`
3. **Read source files only as needed**: use the graph for orientation, then deep-read only the files that actually matter.

> **Why**: `graphify-out/graph.json` contains AST-level nodes and relationships for the whole project. A single query locates cross-file dependencies faster and cheaper than grep or sequential reads. Falls back gracefully to normal exploration when Graphify is not installed.
