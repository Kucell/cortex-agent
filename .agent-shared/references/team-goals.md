---
module: team-goals
module_path: .agent/references/team-goals.md
module_type: 团队目标与 Mission 映射
keywords:
  - team-pack
  - team-goals
  - mission
  - milestones
  - validation
  - collaboration
estimated_tokens: 450
last_updated: 2026-09-04
summary: 团队包分发稳定目标定义，本地 Mission 承担实际计划、里程碑、交接和验证运行态。
status: stable
owner: Kucell
last_verified: 2026-09-04
verified_by: Kucell
sources:
  - .agent/workflows/mission.md
  - docs/architecture/team-agent-pack.md
  - lib/team-pack/index.js
linked_decisions: []
---

# 团队目标与 Mission 映射

## 结论

Cortex Agent 可以把跨成员、跨里程碑的工作组织成 Mission，但 Mission 是每个项目实例的执行状态，不能直接作为 Team Pack 的内容分发。团队包应分发目标定义；成员安装后，以该参考创建或更新本地 Mission。

## 应放入团队包的内容

放在本文件或其他 `references/*.md` 中：

- 目标：要共同达成的可验证结果。
- 范围与非目标：避免各成员把目标扩展成不同工作。
- 完成标准：必须满足的验收证据或指标。
- 协作约定：责任角色、依赖关系与需要人工决策的边界。
- 来源：关联需求、提案或已批准决策的相对引用。

这些内容安装后会进入 `.agent/references/`，普通克隆用户也可直接阅读。

## 不应放入团队包的内容

以下内容属于成员本地执行或运行态，继续保留在 `.agent/`：

- `.agent/plans/**`：计划草稿与任务进度。
- `.agent/missions/**`：Mission 计划、里程碑、验证契约和命令日志。
- `.agent/handoffs/**`、`.agent/runs/**`、锁、会话、收据与任何凭证。

## 从团队目标到本地执行

1. 团队维护者在 `references/` 更新目标定义，并更新 `team-pack.json` 的文件哈希和版本。
2. 成员通过 `cortex-agent team update` 合并该参考到本地 `.agent/references/`；三方合并冲突保留本地内容，需人工处理。
3. 当目标需要多功能、多天或多里程碑推进时，成员按 `/mission` 工作流创建本地 `.agent/missions/M-xxx/`，并在 Mission 的 Goal、Non-Goals、Milestones 与 Validation Contract 中引用该团队目标。
4. 具体执行、交接和验证证据记录在本地 Mission；对团队可复用的稳定结论再提炼回 `references/`。

## 何时使用 Mission

适合：目标需要多个里程碑、多人或跨会话交接，并要求每个里程碑有独立验证契约。

不适合：单文件修正、一次性文档调整或无需跨成员协调的日常任务；此类任务使用普通任务工作流即可。

## 当前团队目标模板

在新增具体目标时，以如下结构追加到本文件或单独的参考文档：

```text
## <目标名称>

- 目标：<可验证的共同结果>
- 范围：<覆盖的模块或流程>
- 非目标：<明确排除项>
- 完成标准：<验收证据>
- 责任角色：<维护者、执行者、验证者>
- 本地执行：<成员创建的 Mission 或普通任务>
- 关联：<相对路径引用>
```
