---
description: 经验捕获规则——何时记录、记录什么、记录在哪里
---

# 经验捕获规则 (Lesson Capture)

## 核心原则

> **经验必须在修正完成的同一次 commit 内捕获，而不是事后补录。**

事后补录的经验缺乏上下文，且容易被遗忘。

---

## 触发条件

满足以下任一条件时，**必须**创建经验记录：

| 触发类型 | 判断依据 | 经验分类 |
|---------|---------|---------|
| Bug fix / revert / rollback | commit message 以 `fix:` / `revert:` / `rollback` 开头 | PRACT-EXP |
| 新规则文件首次创建 | 在 `rules/` 目录新增 `.md` 文件 | RULE-EXP |
| 重大设计修正 | commit message 类型为 `refactor:` 且修改了 rules/ 或 workflows/ | RULE-EXP |
| 显式标记 | commit message 包含 `experience:` 前缀 | 按内容分类 |
| 用户主动要求 | 用户调用 `/experience-capture` | 按内容分类 |

---

## 不需要记录的场景

- 常规功能新增（`feat:`）
- 文档更新（`docs:`）
- 格式调整、拼写修正
- 测试补充（无 bug 背景）

---

## 经验分类规则

| 分类 | 标识 | 何时使用 | 生命周期 |
|------|------|---------|---------|
| **规则型** | `RULE-EXP` | 教训已沉淀为永久规则（rules/ 有对应文件） | 永久 |
| **实践型** | `PRACT-EXP` | 短期避坑，已修复不会再发生 | 180 天后归档 |
| **事件型** | `INCIDENT-EXP` | 重大故障，需长期追踪 | 365 天后归档 |

---

## 记录操作

1. 复制模板：`cp .agent/experiences/TEMPLATE.md .agent/experiences/EXP-NNN.md`
2. 填写所有字段（`id`、`title`、`type`、`severity`、`category`、`tags`、`related_files`）
3. 填写 4 个核心章节：错误 / 触发 / 修正 / 教训
4. 填写"防复发检查"清单（至少 3 项）
5. 更新 `experiences/index.json`（追加新条目，递增 `total`，更新 `last_updated`）

---

## 经验 ID 分配

- 格式：`EXP-NNN`（三位数字，从 001 开始）
- 查询当前最大 ID：`cat .agent/experiences/index.json | grep '"id"'`
- 新 ID = 当前最大 + 1

---

## 与 agent-update 的关系

`agent-update` 工作流的 **Step 4（Experience Capture）** 是本规则的执行节点。本规则定义"何时触发"，`agent-update` 定义"如何执行"。

---

## 禁止行为

- ❌ 在 commit 之后隔天补录经验（上下文已丢失）
- ❌ 一条经验记录多个不相关的教训（一事一记）
- ❌ RULE-EXP 没有对应的 rules/ 文件（必须先有规则，再标记经验）
- ❌ 省略"防复发检查"清单（这是最重要的字段）
