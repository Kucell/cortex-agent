# Grok Build 对 Cortex Agent 的可借鉴设计

> 调研日期：2026-07-18  
> DeepWiki 索引：`c1b5909e`，生成于 2026-07-15  
> 结论依据：DeepWiki 用于建立地图，关键判断已回查 `xai-org/grok-build` 源码与官方仓库文档。

## 结论

Grok Build 最值得 Cortex Agent 借鉴的不是其 Rust/TUI 实现，而是四类 Harness 机制：**生命周期状态的统一所有权、按需暴露且有预算的 skill、可归因的变更证据、以及贴近真实交互的端到端验证**。这些方向与 Cortex Agent 现有 management-api、context-budget、worktree、runtime-evidence 和 PTY/CLI 测试能力同向，适合增量吸收。

不建议照搬其完整运行时、远程 workspace 或上传/遥测链路。Cortex Agent 的定位是模板驱动、平台无关的治理层；把这些能力硬编码进新 runtime 会扩大维护面，也会引入不必要的隐私风险。

## 系统地图

| Grok Build 机制 | 关键模块 | Cortex Agent 对应面 |
|---|---|---|
| Session actor 与 ACP | `xai-grok-shell`、`xai-acp-lib` | management-api、runs/sessions、工作流状态 |
| Subagent coordinator | `agent/subagent/`、worktree isolation | coordinator、worktree、branch namespace |
| Skill lifecycle | `SkillManager`、动态发现、预算投影 | skills、context-budget、平台适配 |
| Hunk tracker | `xai-hunk-tracker` | Artifact Bus、runtime-evidence、review/handoff |
| Hooks 与权限 | `xai-grok-hooks`、workspace permission policy | phase-gate、validation-contract、安全规则 |
| PTY E2E | pager PTY harness 与交互场景测试 | CLI/workflow 的真实终端验证 |
| Compaction prefire | session compaction、阈值分层 | context-budget、session-continuity |

## 建议清单

| 分类 | 建议 | 原因与落点 |
|---|---|---|
| 采纳 | 为 Run/Session/Agent 状态定义单一 owner 与事件化转换 | Grok Build 把 subagent 生命周期集中到 coordinator，并明确 active/completed/cancelled 等状态；Cortex 可继续收敛 management-api 写入 gate，避免 workflow 直接散写状态文件。 |
| 采纳 | 让 skill 列表进入上下文预算核算 | Grok Build 的 `SkillManager` 同时负责发现、去重、投影、公告和 compaction listing，且限制 listing 预算；Cortex 的 `context-budget` 应把 skill 元数据视为显式预算项。 |
| 改造后采纳 | 路径触发的按需 skill 发现 | 只在 agent 接触相关目录后暴露 skill，可减少启动上下文；Cortex 先在规则层支持 `paths`/关键词门控，不必立即增加常驻文件监听 runtime。 |
| 改造后采纳 | 变更归因，而不只是最终 diff | Hunk tracker 将 agent 操作与具体修改关联。Cortex 可在 Artifact Bus/Run journal 中记录 `actor + tool/action + file + revision`，先做低成本事件归因。 |
| 改造后采纳 | compaction prefire | 在达到硬阈值前后台准备摘要可降低长任务中断；Cortex 可先在 session-continuity/context-budget 中增加“接近阈值时预生成 handoff”规则。 |
| 采纳 | PTY 级交互回归测试 | Grok Build 测试排队消息、取消并发送、bash promotion 等真实终端状态机。Cortex 的 CLI、dashboard server 和长任务控制也应覆盖信号、队列、终端宽度和中断恢复。 |
| 延后 | ACP/远程 workspace/tool hub | 能力强，但属于产品 runtime；与 Cortex 当前模板治理定位不匹配，除非后续明确建设常驻协调服务。 |
| 不采纳 | 默认或隐式的代码库上传/集中式 trace 上传 | 方案调研和运行证据必须坚持本地优先、显式授权、最小披露；任何远端上传都应独立审批并可审计。 |

## 优先级

1. **P0：skill 预算与按需发现规则**。这是最低风险、最符合现有架构的改进。
2. **P0：Run/Session/Agent 状态单一 owner 审计**。继续消除 workflow 绕过 management-api 的直接写入。
3. **P1：文件变更归因事件**。先扩展 journal/Artifact Bus schema，再考虑自动 hunk 追踪。
4. **P1：PTY 场景矩阵**。覆盖 pause/resume/cancel、队列和异常退出。
5. **P2：compaction prefire/handoff 预热**。先以规则与指标验证收益。

## DeepWiki 是否更方便

是，尤其对大仓库。它把目录结构、概念解释、调用关系图和源码行引用组合成可检索 wiki，通常比在 GitHub 页面逐层点文件更快形成心智模型。对本次调研，DeepWiki 很快暴露了 compaction、subagent、skill lifecycle、hunk tracker、权限、遥测和 PTY 测试等主题页。

但它不是源码替代品：索引对应固定 commit，可能落后于 HEAD；页面是二次生成内容，也可能误解实现。因此标准流程应是：

DeepWiki 只做导航层；源码与官方文档才是结论证据层。

```text
GitHub URL → DeepWiki 建图/定位 → 记录索引 commit → 源码/官方文档核验 → 面向本项目做采纳判断
```

该流程已经沉淀为 `github-repo-research` skill，并接入 researcher 与 `/arch-design`。

## 参考

- [Grok Build GitHub](https://github.com/xai-org/grok-build)
- [Grok Build DeepWiki 总览](https://deepwiki.com/xai-org/grok-build)
- [核心架构](https://deepwiki.com/xai-org/grok-build/2-core-architecture)
- [会话压缩](https://deepwiki.com/xai-org/grok-build/2.3-conversation-compaction)
- [Subagent 编排](https://deepwiki.com/xai-org/grok-build/4.3-subagent-orchestration)
- [Skills 与 Plugins](https://deepwiki.com/xai-org/grok-build/4.2-skills-and-plugins)
- [Hunk Tracker](https://deepwiki.com/xai-org/grok-build/5.4-hunk-tracker-and-file-change-tracking)
- [权限与安全](https://deepwiki.com/xai-org/grok-build/5.3-permission-and-safety-system)
- [PTY 端到端测试](https://deepwiki.com/xai-org/grok-build/9.1-pty-end-to-end-test-harness)
