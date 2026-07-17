---
name: publish-docs
description: 将 .agent/references 与已完成架构提案中的项目知识，脱敏、校验并发布为可独立阅读的 docs/ 开发文档。
---

# 文档发布工作流 (/publish-docs)

## 目标

把 `.agent/` 中已经沉淀的项目知识发布到项目 `docs/`，形成对开发者可读、可链接、可维护的公开开发文档。

`/publish-docs` 是“提炼与发布”，不是复制 `.agent`：

- `.agent/references/` 是内部事实库，由 `/scan-project` 与 `/update-refs` 维护
- `.agent/plans/proposals/` 是架构决策过程，只发布 `status: done` 或用户明确确认完成的结论
- `docs/` 是面向开发者的外部文档，必须脱离 `.agent/` 也能独立阅读

## 使用方式

```text
/publish-docs
/publish-docs <模块名>
/publish-docs <目标 docs 子目录>
/publish-docs --architecture
```

默认只发布当前任务、当前变更或用户指定范围相关的文档。不要无理由全量重写 `docs/`。

## 执行流程

### 第一步：确定发布范围

先输出本次发布计划，包含：

```text
来源文件：
  - .agent/references/<module>.md
  - .agent/plans/proposals/<topic>/<proposal>.md
  - .agent/plans/proposals/projects/<project-slug>/index.md
  - .agent/tasks/<task-id>.json 中引用的 final artifacts
  - <code paths used for verification>

目标文件：
  - docs/<target>/README.md
  - docs/<target>/<topic>.md

不发布范围：
  - task handoff / prompt / model config / temp debug / secrets
```

范围选择规则：

1. 优先读取目标模块对应的 `.agent/references/*.md`
2. 若涉及架构决策，只读取 `.agent/plans/proposals/` 中已完成或用户确认通过的提案
3. 若来源是项目级提案组，以 `projects/<project-slug>/index.md` 为入口：先确认项目或目标 milestone 已定稿，再跟随索引读取相关且已完成或用户确认通过的子提案
4. 必须回到当前代码重新验证路径、接口、命令、依赖和配置
5. 若 `.agent/references/` 不存在或明显过期，先建议运行 `/scan-project` 或 `/update-refs`
6. 若用户没有指定模块，只处理当前任务或 git diff 涉及的模块
7. 若当前任务存在 `.agent/tasks/<task-id>.json`，只消费 `artifacts[]` 中 `status: final` 且引用文件存在的 `architecture`、`validation`、`decision`、`learning`、`release-note` 工件；draft、superseded 或 gate 未通过的工件不得发布

项目级发布顺序：

1. 先从定稿后的 `index.md` 提炼项目目标、范围、里程碑和最终决策，形成可独立阅读的总览
2. 再按需引用已完成子提案的结论，不发布未批准的子提案或过程性讨论
3. 子提案与 `decisions/`、`relations.md` 只作为事实来源，发布到 `docs/` 时不得保留对 `.agent/` 的阅读依赖

### 第二步：选择文档位置

优先复用项目已有 `docs/` 结构。若项目没有明确约定，使用以下通用结构：

```text
docs/
  README.md
  architecture/
    README.md
  modules/
    README.md
    <module>/
      README.md
```

项目可以在本地覆盖目录映射，例如：

- 前端页面项目：`docs/pages/<page>/README.md`
- 微应用项目：`docs/micro-apps/<app>/README.md`
- 包仓库：`docs/packages/<package>/README.md`
- 服务端项目：`docs/services/<service>/README.md`

不要把某个项目的业务目录名写死到框架模板中。

### 第三步：生成文档内容

模块文档建议包含：

1. 模块定位与边界
2. 核心能力
3. 关键架构与组件关系
4. 数据流或调用流
5. 重要代码路径
6. 开发与调试命令
7. 约束、注意事项和常见坑
8. 验证方式

架构文档建议包含：

1. 背景与问题
2. 最终决策
3. 方案对比摘要
4. 关键流程图或结构图
5. 影响范围
6. 迁移与回滚策略
7. 后续任务链接

可使用 `.agent/resources/templates/published-doc.md` 作为初稿结构。

### 第四步：脱敏与边界控制

发布到 `docs/` 的内容必须满足：

- 不出现 `.agent/` 路径作为正文依赖、索引链接或“请阅读”入口
- 不泄漏 prompt、模型配置、agent 分工、任务交接、临时 debug、机器路径、凭证、token、内网地址
- 不把任务过程记录当作文档结论
- 不发布未确认的架构草案，除非文档明确标为草案
- 不复制大段内部笔记；只发布经过整理的结论

### 第五步：维护索引

发布后同步维护相关索引：

- `docs/README.md`：项目文档入口
- `docs/<category>/README.md`：分类索引
- `docs/modules/README.md` 或项目自定义模块索引
- 新增文档之间使用相对链接

### 第六步：验证

至少执行以下检查：

```bash
test -d docs
find docs -name README.md -type f | sort
rg -n "\.agent/" docs && exit 1 || true
git diff --check
```

同时人工确认：

- 所有相对链接都能落到真实文件
- 文档中的代码路径、命令、接口来自当前代码验证
- 本次 diff 没有夹带无关代码改动
- 没有发布 secrets、机器凭证、临时日志或内部治理细节

### 第七步：回填发布工件

若当前任务启用了 task pipeline：

1. 向 `.agent/artifacts/<task-id>/` 追加 envelope `kind: note`、`payload.artifact_kind: published-doc` 的工件，payload 只包含目标文档路径、来源 artifact refs、验证命令摘要和结果。
2. 验证 envelope 文件存在后，只向调用方返回 final `published-doc` ref；不得修改 `.agent/tasks/<task-id>.json`、`.agent/tasks/index.json`、任何 gate `evidence_refs`、gate status 或 task stage。
3. 脱敏或事实校验失败时不得创建或返回 final 工件；只返回失败证据，包括失败检查、命令结果和可恢复建议，不修改 completion gate。
4. `/ship` 接收返回结果：成功时由 `/ship` 验证 ref 文件并回填任务工件与 completion gate；失败时由 `/ship` 决定 gate 状态。修复后追加新的发布工件，不覆盖旧记录。

`/publish-docs` 是证据生产者，不是 completion gate owner。它不能修改任务记录、把任务标为 `done`，也不能通过 Management API 写入任务或 gate。

## 与其他工作流的协作

- `/scan-project`：首次接入时生成 `.agent/references/`，为 `/publish-docs` 提供事实源
- `/update-refs`：功能迭代或重构后刷新事实源，再决定是否发布到 `docs/`
- `/arch-design`：架构提案确认完成后，可调用 `/publish-docs --architecture` 输出开发者可读的架构文档
- `/ship`：交付闭环中完成 `/update-refs` 后，若用户可读文档受影响，进入可选 `PUBLISH_DOCS` 阶段
- `.agent/tasks/`：消费已定稿任务工件，只把 final `published-doc` ref 或失败证据返回给 `/ship`
- `/agent-update`：维护本工作流或项目本地的 docs 目录映射规则
