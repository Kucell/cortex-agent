# 架构设计原则 (模板)

请根据项目的实际架构模式（如：MVC, MVVM, Clean Architecture, Hexagonal 等）定义核心原则。

## 核心设计理念

### 1. 关注点分离 (Separation of Concerns)
- **[规则描述]**: 例如，UI 与业务逻辑分离，数据访问与服务逻辑分离。

### 2. [架构模式名称] (例如: 六边形架构)
- **[规则描述]**: 说明核心领域、端口和适配器的职责。

### 3. [模块化原则]
- **[规则描述]**: 说明如何划分模块，模块间的依赖关系（例如：禁止循环依赖）。

### 4. [接口与契约]
- **[规则描述]**: 强调面向接口编程而非面向实现。

## 目录与文件规范
- `src/core/`: 存放核心业务逻辑/领域模型。
- `src/api/`: 存放外部接口调用。
- `src/components/`: 存放通用 UI 组件。
- `src/utils/`: 存放工具函数。

## 架构审查检查清单 (Code Review Checklist)
- [ ] 代码是否遵循了预定义的层次结构？
- [ ] 模块间的耦合度是否处于合理水平？
- [ ] 是否存在逻辑越位（例如在 UI 层编写复杂的数据库查询）？
- [ ] 新增功能是否符合现有的扩展模式？
- [ ] 是否有适当的错误处理和日志记录？

---

## 提案生命周期 (Proposal Lifecycle)

### 标准状态机

```
draft → approved → in-progress → done
                              ↘ superseded
```

| 状态 | 含义 | 进入时机 |
| :--- | :--- | :--- |
| `draft` | 草案，尚未评审 | `/arch-design` 产出时 |
| `approved` | 已批准，等待执行 | `/approve <提案>` 运行后自动写入 |
| `in-progress` | 执行中，执行载体已创建 | `/approve` 调度到 `/plan` 或 `/mission` 后自动写入 |
| `done` | 已完成，成果已沉淀 | `/done` 或 `mission COMPLETE` 后自动写入 |
| `superseded` | 已被更新方案取代 | 手动标记，注明取代提案路径 |

### 双轨归档原则

| 目录 | 用途 | 修改时机 |
| :--- | :--- | :--- |
| `.agent/plans/proposals/` | **执行期提案**：含执行细节、待确认问题、Phase 拆分、状态流转 | 从 draft 到 in-progress 持续更新 |
| `docs/architecture/` | **沉淀架构文档**：去掉执行噪音，只留成品架构描述 | 提案状态变为 `done` 后精炼写入 |

> **核心原则**：执行期噪音留在 `.agent/plans/proposals/`，完成后才提炼沉淀。
> `docs/architecture/` 中的文档应是纯净的、可长期查阅的架构描述，而非执行记录。

### 双向链接约定

提案文件头部必须维护以下字段：

```markdown
> **状态**: draft | approved | in-progress | done | superseded
> **执行载体**: 待批准 | T-006~T-008 | M-002（由 /approve 自动回填）
> **沉淀文档**: — | docs/architecture/xxx.md（由 /done 或 mission COMPLETE 自动回填）
```

执行载体（task 或 mission）的头部必须反向引用提案：

```markdown
<!-- task-progress.md 的任务行 -->
| T-006 | 实现 xxx | Proposal: .agent/plans/proposals/xxx-proposal.md |

<!-- mission-plan.md 头部 -->
> **来源提案**: .agent/plans/proposals/xxx-proposal.md
```
