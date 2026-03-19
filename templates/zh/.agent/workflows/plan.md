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
/plan --from arch-proposal   （从 .agent/resources/templates/arch-proposal.md 读取方案）
```

## 执行步骤

### 第一步：读取上下文

按顺序读取以下文件（存在才读）：

1. `.agent/plans/task-progress.md` — 了解当前进度和已有任务 ID
2. `.agent/resources/templates/arch-proposal.md` — 若 `--from arch-proposal` 则加载方案
3. `.agent/rules/architecture-design.md` — 确认架构约束

若用户直接描述了需求（无方案文件），则基于对话上下文进行拆解。

### 第二步：任务拆解

将方案拆解为独立、可验证的任务单元，每个任务需包含：

- **任务 ID**：延续现有最大 ID 递增（如当前最大 T-005，则新建从 T-006 开始）
- **优先级**：P0（阻塞）/ P1（核心）/ P2（增强）/ P3（可选）
- **描述**：一句话说清楚做什么
- **验收标准**：至少 1 条可验证的 Done Condition
- **依赖**：是否依赖其他任务先完成

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
2. 在 **活跃任务表** 中追加新任务行（进度默认 0%）
3. 更新文件头部的 `最后更新` 日期

### 第四步：输出行动建议

```
✅ 已写入 3 个任务（T-006 ~ T-008）
📌 建议下一步：/start-task T-006
```
