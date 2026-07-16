---
name: plan
description: 将已确认的方案或需求转化为结构化任务清单，写入 task-progress.md，衔接 /arch-design 与 /start-task。
---

# 方案落地工作流 (/plan)

当你和 AI 确认了一个设计方案或需求后，执行此流程将其转化为可执行的任务计划。

## 使用方式

```
/plan
/plan "实现用户登录功能"
/plan --from-proposal <提案路径>   （读取单点提案、项目级 index.md 或子提案，推荐）
/plan --from arch-proposal         （读取空白模板，已弃用 deprecated）
```

## 执行步骤

### 第一步：读取上下文

按顺序读取以下文件（存在才读）：

1. `.agent/plans/task-progress.md` — 了解当前进度和已有任务 ID
2. 若 `--from-proposal <路径>`：读取指定提案文件
   - 单点提案或项目级子提案：读取该文件；若是子提案，同时读取同项目的 `index.md`
   - 项目级 `index.md`：先读取入口，再根据已批准范围读取相关 milestone 和子提案；不要默认展开未批准的子提案
3. 若 `--from arch-proposal`（已弃用）：读取 `.agent/resources/templates/arch-proposal.md`
4. `.agent/rules/architecture-design.md` — 确认架构约束
5. `.agent/rules/task-decomposition.md` — 判断拆分粒度、依赖和并行机会
6. `.agent/resources/templates/task-breakdown.md` — 用作拆分预览格式

若用户直接描述了需求（无方案文件），则基于对话上下文进行拆解。

### 第二步：任务拆解

将方案拆解为独立、可验证的任务单元，每个任务需包含：

- **任务 ID**：延续现有最大 ID 递增（如当前最大 T-005，则新建从 T-006 开始）
- **优先级**：P0（阻塞）/ P1（核心）/ P2（增强）/ P3（可选）
- **描述**：一句话说清楚做什么
- **验收标准**：至少 1 条可验证的 Done Condition
- **依赖**：是否依赖其他任务先完成
- **并行判断**：是否可与其他任务同批执行，以及原因
- **推荐 Agent**：planner / researcher / implementer / code-reviewer / documenter / coordinator
- **提案来源**：项目级输入保留 `index.md`、milestone 和子提案 ID，确保任务可追溯到批准范围

若需求适合多 Agent 协作，先用 `.agent/resources/templates/task-breakdown.md` 输出拆分预览，再询问用户是否写入计划。

输出拆解结果供用户确认，格式如下：

```
📋 任务拆解预览（共 N 个任务）：

T-006  [P1]  实现 JWT token 生成与验证
       验收：POST /auth/token 返回有效 JWT；单元测试覆盖

T-007  [P1]  实现登录接口 /auth/login
       验收：用户名密码正确时返回 token；错误时返回 401
       依赖：T-006

T-008  [P2]  添加登录限流（5次/分钟）
       验收：第 6 次请求返回 429

---
是否将以上任务写入计划？(y / 调整 / 取消)
```

### 第三步：写入 task-progress.md

用户确认后：

1. 在 **路线图** 中新增对应 Phase（若属于新功能模块）或追加到已有 Phase
2. 在 **活跃任务表** 中追加新任务行（进度默认 0%）；若来自提案，每行带 `Proposal: <路径>` 引用；若来自项目级入口，同时记录 milestone 与子提案 ID
3. 更新文件头部的 `最后更新` 日期

### 第四步：回填提案（若来自 --from-proposal）

若本次 `/plan` 由 `/approve` 调度（或用户手动传入 `--from-proposal`），只回填本次批准范围：

- 单点提案或子提案：回填文件头部的执行载体与状态；子提案还要同步 `index.md` 中对应行
- 整个项目或 milestone：在 `index.md` 回填对应范围的执行载体与状态，不修改范围外的子提案

```markdown
> **状态**: in-progress
> **执行载体**: T-006~T-008
```

### 第五步：输出行动建议

```
✅ 已写入 3 个任务（T-006 ~ T-008）
🔗 提案执行载体已回填：T-006~T-008
📌 建议下一步：/start-task T-006
```
