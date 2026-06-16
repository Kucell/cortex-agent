---
id: 0001-graphify-code-exploration
target: rules/ai-behavior.md
anchor: "## 8. 代码探索优先使用 Graphify"
---

---

## 8. 代码探索优先使用 Graphify（Code Exploration via Knowledge Graph）

**触发条件**：需要理解陌生模块的职责、追踪调用链、或探索多个文件之间的关系时。

**执行顺序**：

1. **先检查图谱是否存在**：
   ```bash
   test -f graphify-out/graph.json && echo "available"
   ```
2. **若存在，优先使用 `/graphify` 查询**，而非盲目 `grep` 或逐文件 `Read`：
   - 模块关系、调用链 → `/graphify query "<关键词>"`
   - 两文件/模块间的连接路径 → `/graphify path "<file-a>" "<file-b>"`
   - 某节点的职责与上下游 → `/graphify explain "<节点名>"`
3. **再按需深入源文件**：图谱给出全景后，只 `Read` 真正需要细读的文件，避免逐文件盲扫。

> **原因**：`graphify-out/graph.json` 包含全项目 AST 级节点与关系，一次查询即可定位跨文件依赖，比 grep 更准、比逐文件 Read 成本更低。未安装 Graphify 时自动降级为常规探索。
