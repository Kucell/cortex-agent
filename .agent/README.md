# Cortex Agent 框架 (.agent)

> 这是 **Cortex Agent 框架** 项目开发的配置中心，包含所有 AI 治理规则、工作流和扩展能力。

**GitHub 仓库**: https://github.com/Kucell/cortex-agent-agent

完整架构设计请查看 [docs/architecture.md](../docs/architecture.md)。

> **注意**: 本仓库是 cortex-agent 框架的 `.agent` 配置独立仓库，主项目位于 [cortex-agent](https://github.com/Kucell/cortex-agent)

## 🚀 工作流

### 核心工作流

| 工作流 | 描述 | 优先级 |
| :--- | :--- | :--- |
| `/start-task` | 加载上下文、架构预审、分发给 planner | ⭐ 核心 |
| `/ship` | **状态机交付**: PLAN → EXECUTE → LINT → REVIEW → COMMIT → DONE | ⭐ 核心 |
| `/arch-design` | 设计新功能，输出架构图 | ⭐ 核心 |
| `/plan` | 将确认的提案转换为结构化任务列表 | ⭐ 核心 |
| `/briefing` | 每日站会：当前阶段、活跃任务、推荐入口点 | ⭐ 核心 |
| `/configure` | 交互式项目配置：技术栈、语言规则、架构 | ⭐ 核心 |
| `/parallel` | 并行分发独立任务给子 agent | ⭐ 核心 |
| `/agent-update` | 添加或修改规则、工作流、技能 | ⭐ 核心 |
| `/migrate-rules` | 迁移旧配置文件（如 .cursorrules）到本框架 | ⭐ 核心 |

### 内部步骤（已降级为 /ship 内部阶段）

| 工作流 | 现在属于 | 阶段 |
| :--- | :--- | :--- |
| `/code-review` | `/ship` | Phase 3: REVIEW |
| `/commit` | `/ship` | Phase 4: COMMIT |
| `/done` | `/ship` | Phase 5: DONE |
| `/sync-plans` | `/ship` | Phase 5: DONE (自动同步) |

### 可选工作流（低频使用）

| 工作流 | 描述 | 使用场景 |
| :--- | :--- | :--- |
| `/bug-fix` | 结构化 bug 分析和修复流程 | Bug 分诊 |
| `/handoff` | 创建或恢复紧凑的任务交接 | Agent/会话转移 |
| `/mission` | 编排长期多里程碑工作 | 长期特性项目 |
| `/weekly-report` | 从 Git 历史生成周报 | 周会 |
| `/release` | SemVer 发布：分析提交 → 升级版本 → 提交 + 标签 → npm 发布 | 发布管理 |
| `/scan-project` | 扫描项目，自动生成模块参考文档 | 初始设置 |
| `/update-refs` | 增量更新参考文档 | 重大变更后 |
| `/sync-master` | 与默认分支同步：fetch + rebase（stash 安全） | 分支同步 |

## 🤖 子 Agent

具有隔离的模型、工具和上下文边界的专用 agent。

| 子 Agent | 模型 | 技能 | 触发方式 |
| :--- | :--- | :--- | :--- |
| `planner` | sonnet | architecture-guard | `/start-task`, `/parallel` |
| `implementer` | sonnet | architecture-guard, code-evaluation, superpowers | `/parallel` |
| `researcher` | sonnet | — | `/parallel` |
| `code-reviewer` | sonnet | architecture-guard, code-evaluation, security-scan | `/ship`, `/code-review` |
| `documenter` | haiku | changelog-generator | `/parallel`, `/ship` |
| `session-manager` | haiku | — | 长期会话；`session assess` / `archive` / `restore` / `status` / `warm` |
| `coordinator` | sonnet | context-budget, phase-gate, handoff, validation-contract, maturity-tracker | `/mission`, `/handoff`, `/parallel`, `/briefing` |

## 📜 规则（精选）

| 规则 | 作用 |
| :--- | :--- |
| `ai-behavior.md` | Git 安全、最小修改、先计划后行动、设计确认、分阶段提交 + `task-progress.md` 恢复 |
| `integration-safety.md` | 跨模块调用：验证签名、payload vs schema、避免参数互换 |
| `refactoring-safety.md` | 重构不改变行为；不盲目”修复”所有 lint |

## 🛠 技能

可被工作流调用或挂载到子 agent 的复用能力。

| 技能 | 描述 | 使用者 |
| :--- | :--- | :--- |
| `architecture-guard` | 通过自动审计和人工审查保护架构 | planner, implementer, code-reviewer |
| `code-evaluation` | 代码质量评分：可靠性、性能、可维护性 | implementer, code-reviewer |
| `security-scan` | 依赖漏洞、危险 API、供应链风险 | code-reviewer |
| `changelog-generator` | 从 git 提交自动生成 CHANGELOG（Conventional Commits） | documenter |
| `superpowers` | TDD 工作流、调试策略、重构 & git 技巧 | implementer |
| `handoff` | 在 agent、会话或子 agent 之间紧凑传递任务 | `/handoff` |
| `validation-contract` | 在实现前创建和检查可执行的验证契约 | Mission Lite、高风险任务 |
| `agent-visibility` | 管理 .agent Git 可见性（私有/忽略/追踪） | 直接调用 |
| `sync-global` | 从 `~/.agent` 同步工作流和技能到当前项目 | 直接调用 |
| `weekly-report` | 获取并汇总 Git 日志生成周报 | `/weekly-report` 工作流 |
| `cleanup-debug` | 清理 `.agent/debug` 下的旧文件 | 直接调用 |
| `knowledge-lint` | 对知识结构和文档完整性进行确定性检查 | 直接调用 |
| `doc-gardening` | 将知识 lint 发现转化为低风险维护建议 | 直接调用 |
