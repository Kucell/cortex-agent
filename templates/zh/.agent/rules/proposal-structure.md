# 提案目录结构规范

## 目标

`.agent/plans/proposals/` 需要同时支持小型单点提案、大项目提案组、以及多个关联项目之间的架构演进。目录结构必须让人一眼看出：

- 提案属于哪个项目或主题
- 是否是单点变更还是项目级计划
- 子提案之间是什么关系
- 哪些提案已批准、执行中或完成
- 后续 `/approve`、`/plan`、`/mission`、`/publish-docs` 应该读取哪个入口

## 目录模式

### 1. 单点提案

```text
.agent/plans/proposals/<topic>/<short-name>-proposal.md
```

### 2. 项目级提案组

```text
.agent/plans/proposals/projects/<project-slug>/
  index.md
  proposals/
    P-001-<short-name>-proposal.md
    P-002-<short-name>-proposal.md
  decisions/
    D-001-<short-name>.md
  references.md
  relations.md
```

### 3. 关联项目提案组

继续使用 `projects/<project-slug>/`，并在 `relations.md` 中记录上游项目、下游实战项目、共享能力、同步升级范围、差异点、已验证项目和待验证项目。

## 何时升级为项目文件夹

满足任一条件时，应使用 `projects/<project-slug>/`：

- 提案会拆成 3 个以上 Phase。
- 涉及 2 个以上 workflow、skill 或 CLI 能力。
- 涉及 2 个以上实战项目回流。
- 需要维护多个子提案。
- 需要跨项目追踪验证状态。
- 需要独立 dashboard、PRD、runtime 或任务组。

## 入口文件 index.md

项目级 `index.md` 应至少包含：

```text
# <Project Name>

## 状态
## 目标
## 范围
## 子提案
## 关联项目
## 里程碑
## 当前决策
## 下一步
```

## 禁止事项

- 禁止把提案直接放在 `.agent/plans/proposals/` 根目录。
- 禁止在 proposals 目录提交 `.DS_Store`、临时文件或导出缓存。
- 禁止用含糊目录名，例如 `new`、`misc`、`test`、`temp`。
- 禁止一个大型项目只靠单个超长 proposal 文件承载所有上下文。
