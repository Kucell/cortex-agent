# 架构设计

本目录用于沉淀 Cortex Agent 的架构决策、闭环治理协议、能力分层与对外边界。

## 作用

- 记录治理协议与运行时能力的边界（Cortex 是治理协议，不是 Agent Runtime 或部署控制面）。
- 记录风险分层、决策/等待点绑定、独立审查与运行证据回灌的关系。
- 承接后续架构提案、架构 guard 审计、闭环治理迭代。

## 当前范围

- 治理协议定位：闭环 contract、风险矩阵、决策/等待点、运行证据回灌。
- 工作空间与多仓治理：worktree、跨仓合并边界、复合工作空间、Guided Review 与本地 Benchmark。
- 适配层与宿主集成：Host Adapter、DSH 集成、跨宿主能力契约。
- 集成评估：动画库评估、上下文优化、Token 节省。

## 后续计划

- 把架构 guard 输出与本目录文档的覆盖度纳入定期维护。
- 持续把已交付的架构提案迁入本目录，标注状态（proposed / approved / done）。
- 跟踪已落地的协议（risk-tier、independent reviewer、opt-in runtime feedback）的扩展边界。

## 当前架构文档

- [AI-Native SDLC 闭环治理](./ai-native-sdlc-governance.md)
- [Agent Workspace Orchestration](./agent-workspace-orchestration.md)
- [Agent Runtime Continuity](./agent-runtime-continuity.md)
- [Branch Management Design](./branch-management-design.md)
- [Catalog Bridge](./catalog-bridge.md)
- [Context Optimization v2](./context-optimization-v2.md)
- [Cross-Project Coordination](./cross-project-coordination/)
- [Deck Workflow Design](./deck-workflow-design.md)
- [Design System](./design-system.md)
- [DSH Host Adapter](./dsh-host-adapter.md)
- [Experience Recursion](./experience-recursion.md)
- [Framework Event Bus Design](./framework-event-bus-design.md)
- [Framework Event Bus Quickstart](./framework-event-bus-quickstart.md)
- [General Mode Design](./general-mode-design.md)
- [Graphify Integration Proposal](./graphify-integration-proposal.md)
- [Grok Build Research](./grok-build-research.md)
- [Harness Optimization Design](./harness-optimization-design.md)
- [Host Adapter](./host-adapter/)
- [MCP Bridge](./mcp-bridge.md)