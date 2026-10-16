---
name: evolution-pipeline
description: 显式启用的项目内归档接入与不可变学习建议队列，只记录元数据，不自动更新记忆或调用 Host。
area: agent-tuning
summary: 默认关闭的归档建议接线，支持项目隔离、去重与可恢复重放。
---

# 归档学习建议

## 范围

手工会话归档可显式选择加入项目内建议队列。未指定选项时保持原归档行为。
自动连续性守护不会启用此选项。

建议只保存来源引用、归档原始字节的 SHA-256、观察项数量与通用核验提醒，
不复制归档原文。归档仍留在选定项目内。本流程不调用模型、不更新 memory
或索引、不创建 Task，也不授予执行权限。

## 命令

仅在明确选定的项目与范围内运行：

```sh
cortex-agent session archive --project <name> --gate user --queue-learning-proposal
node .agent/skills/evolution-pipeline/scripts/evolve.js --enqueue --archive <archive-id> --project <name> --proposal-only
node .agent/skills/evolution-pipeline/scripts/evolve.js --worker --once --proposal-only
node .agent/skills/evolution-pipeline/scripts/evolve.js --replay <EVO-P-id> --proposal-only
```

proposal-only 的 list/status 只检查保留的 EVO-P- 记录，不读旧队列或 dead-letter。
此模式不支持 --enqueue-from-latest、--dead-letter 或 --loop，须明确指定归档。

建议入队与单次 worker 可加 --dry-run，只读预览不分配队列记录。
重放和轮询不支持 --dry-run；建议专用 worker 必须使用 --once。

CLI 标记只是用户请求入口，不是 owner、consent、审批或 effect admission
的证明。真实项目执行与框架提升仍须各自的治理门禁。

## 持久化与重放

- 输入队列：.agent/tasks/evolution/EVO-P-<digest>.json
- 建议输出：.agent/tasks/evolution/_proposals/EVO-P-<digest>.json
- 去重键包含项目名、当前规范工作区路径的摘要、归档 ID 和归档原始字节摘要。
- 输入与输出均不可变。相同重放只核对既有字节，不重写；冲突时关闭处理。
- 归档变更产生新键。旧任务复制到另一工作区不能复用身份；工作区搬迁后须重新接入。
- 先写完整临时文件，再以 create-if-absent 硬链接发布。发布前进程退出可能留下被忽略的
  .tmp；创建硬链接后、移除临时名之前退出会留下双链记录，必须保留并阻断，等待显式修复。
  重放不猜测所有权、不删除旧临时链接；只有单链记录可正常恢复。这不是分布式 fencing 或断电持久性证明。
- 输入文件保持 pending。list/worker 只读核对建议回执后派生 proposal_only；
  来源变化或冲突派生 blocked。这些状态都不表示验证通过或获得授权。

可选建议入队失败不会回滚成功归档；响应的 learning_proposal.status 为 unavailable，
不会删除归档或悄悄切换项目重试。

## 既有 legacy worker

旧的确定性记忆写入流程仍是独立的显式流程。--worker --once --proposal-only
会排除旧队列项。新归档建议项不能落入旧 memory/index 写入或旧 replay 改写逻辑。
关键词分类不等同于 AI 推理、验证通过的学习结果或受治理的自动效果。

## 证据边界

全新临时目录测试覆盖真实归档 API、lib/commands/session.js 库级 facade、单次 worker、
默认关闭、隔离去重、独立进程竞争、进程退出后的恢复/阻断状态、来源冲突与预览零写。
测试在模块加载前预加载常见 Node 网络 API 拦截与有界子进程 guard；这不是操作系统级网络隔离。
这些仅证明本地文件接线，不证明两个异构 L2、真实 AI Host 或 SelfEvolutionE2E 验收。
