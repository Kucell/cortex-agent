---
title: 提案目录结构规范
description: "`.agent/plans/proposals/` 需要同时支持小型单点提案、大项目提案组、以及多个关联项目之间的架构演进。目录结构必须让人一眼看出： - 提案属于哪个项目或主题"
type: rule
scope: L1
applicable_to:
  - all
linked_workflows: []
linked_skills: []
owner: Kucell
last_verified: 2026-08-06
status: stable
---
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

适用于一个模块、一个 workflow、一个 skill、一个局部架构调整。

```text
.agent/plans/proposals/<topic>/<short-name>-proposal.md
```

示例：

```text
.agent/plans/proposals/agent-management-api/cortex-agent-management-api-proposal.md
.agent/plans/proposals/prd-visualization/openpencil-prd-visualization-proposal.md
```

规则：

- `topic` 使用 kebab-case。
- `topic` 表示核心模块、业务域或能力域。
- 禁止把提案直接放在 `.agent/plans/proposals/` 根目录。

### 2. 项目级提案组

适用于大项目、跨多个模块的计划、需要多个子提案分阶段落地的架构方向。

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

规则：

- `project-slug` 使用 kebab-case。
- `index.md` 是项目提案组入口，必须存在。
- `proposals/` 存放子提案。
- `decisions/` 存放跨子提案的关键决策。
- `references.md` 记录外部参考、实战项目反馈、调研资料。
- `relations.md` 记录与其他项目或提案组的依赖关系。

### 3. 关联项目提案组

适用于多个项目共享同一架构方向，例如 cortex-agent、SamHMI、csm-view-1 共同验证一套协作运行时。

推荐结构仍使用项目级提案组，但在 `relations.md` 中维护关联：

```text
.agent/plans/proposals/projects/agent-collaboration-runtime/
  index.md
  relations.md
  proposals/
    P-001-management-query-proposal.md
    P-002-dashboard-prd-workspace-proposal.md
```

`relations.md` 应包含：

- 上游项目
- 下游实战项目
- 共享 `.agent` 能力
- 需要同步升级的模板
- 不同项目的差异点
- 已验证项目和待验证项目

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

## 命名规范

- 项目文件夹：`projects/<project-slug>/`
- 子提案：`P-001-<short-name>-proposal.md`
- 决策记录：`D-001-<short-name>.md`
- 入口：`index.md`
- 关系：`relations.md`
- 参考：`references.md`

## 兼容规则

- 已存在的单点提案不用强制迁移。
- 当一个 topic 变成长期项目时，可以新增 `projects/<project-slug>/`，并在 `index.md` 中链接旧提案。
- `/publish-docs` 读取项目级提案时，应以 `index.md` 为入口，再跟随子提案。
- `/approve` 批准项目级提案时，应明确批准的是整个项目、某个 milestone，还是某个子提案。

## 跨仓库 / 跨开发者共享

项目级提案组（`projects/<project-slug>/`）是自包含目录，可以整体共享给另一个开发者或仓库：
把目录放到对方的 `.agent/plans/proposals/projects/<slug>/` 标准路径后，`/approve`、`/plan`、
`/mission`、`/publish-docs` 都能直接识别。

注意事项（双仓联合提案尤其重要）：

- `.agent/` 通常被 gitignore，**不能靠 git clone/push 传递**；用 tar/zip 打包或直接复制目录。
- 双仓联合提案必须把两侧分册（后台仓 + 移动端仓的 `projects/<slug>/`）一起共享。
- `cross_project_peers`、`relations.md`、`index.md`、topology `host_root` 中的绝对路径
  在新机器上要改写为本地路径。
- 用符号链接镜像的共享决策（如 `decisions/D-xxx`）打包后会打散，接手后要重建链接。

一键打包 / 导入请使用 `/proposal-share`（`.agent/workflows/proposal-share.md`）：自动收集
proposals + missions + validation-contract + topology + peer 分册，做绝对路径 token 化与符号链接
重建；运行时状态（锁、分支、未合并 commit、Decision/Waitpoint/Run）走 `/handoff` 双格式产物。

## 禁止事项

- 禁止把提案直接放在 `.agent/plans/proposals/` 根目录。
- 禁止在 proposals 目录提交 `.DS_Store`、临时文件或导出缓存。
- 禁止用含糊目录名，例如 `new`、`misc`、`test`、`temp`。
- 禁止一个大型项目只靠单个超长 proposal 文件承载所有上下文。