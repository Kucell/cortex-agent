---
name: update-refs
description: 检测项目中自上次扫描以来发生变更的模块，增量更新 .agent/references/ 中对应的架构参考文档。在每次功能迭代或重构后运行，保持 AI 知识库与代码同步。
---

# 文档同步工作流 (/update-refs)

## 目标

检测哪些模块发生了结构性变更，只重新扫描和更新**受影响的文档**，避免每次都全量重扫。

---

## 执行流程

### 第一步：读取上次扫描基线

// 读取 .agent/references/README.md 中的「最后更新」commit hash
// 如果没有基线（首次使用），提示用户先运行 /scan-project

```bash
# 获取自上次扫描以来变更的文件
git diff --name-only {上次 commit hash} HEAD
```

### 第二步：识别受影响模块

// 将变更文件路径映射到对应模块：
// - packages/module-a/src/... → module-a
// - micro-applications/home/... → home
// - src/features/user/... → user 功能模块

输出受影响模块列表，并说明变更原因：

```
受影响的模块：
  - home（3 个文件变更：pages/Dashboard.tsx, api/metrics.ts, package.json）
  - user-management（1 个文件变更：types/user.ts）
```

### 第三步：判断变更类型

对每个受影响模块，分析变更文件，判断是否需要更新文档：

| 变更类型 | 是否更新文档 | 更新哪些部分 |
| :--- | :--- | :--- |
| package.json 变更 | ✅ 必须 | 技术栈、依赖、开发命令 |
| 新增路由/页面 | ✅ 必须 | 路由结构 |
| 新增 API 文件 | ✅ 必须 | 关键文件路径 |
| 目录结构变化 | ✅ 必须 | 核心架构 |
| 仅样式/逻辑修改 | ⚠️ 可选 | 关键约束（如有破坏性变更） |
| 仅测试文件 | ❌ 跳过 | — |

### 第四步：增量更新文档

// 对每个需要更新的模块：
// 1. 读取现有的 .agent/references/{模块}.md
// 2. 只重新扫描该模块（与 /scan-project 单模块逻辑相同）
// 3. 对比差异，更新变更的章节
// 4. 更新文件顶部的「文档生成时间」和「对应 git commit」

**保留规则**：
- 用户手动补充的「关键约束与注意事项」内容不自动覆盖，追加而非替换
- 如有冲突，在文档末尾标注 `> ⚠️ 待人工确认：{描述}`

### 第五步：更新全局索引

// 更新 .agent/references/README.md 中的「最后更新」时间和 commit hash
// 如有新增模块，在索引表格中追加

---

## 使用时机建议

| 时机 | 推荐操作 |
| :--- | :--- |
| 新功能上线后 | `/update-refs` 更新受影响模块 |
| 依赖升级（npm update）后 | `/update-refs` 更新技术栈描述 |
| 目录重构后 | `/update-refs` 更新架构章节 |
| 月度维护 | `/scan-project` 全量重扫，重建基线 |
| 新成员加入 | 直接读 `.agent/references/` 快速上手 |

---

## 与其他工作流的协作

- **`/ship` 流程结束后**：可选择性触发 `/update-refs`，保持文档随交付同步
- **`/start-task` 开始前**：AI 自动读取 `.agent/references/` 中相关模块文档作为上下文
- **`/scan-project`**：全量重扫，适合大版本重构后重建基线
