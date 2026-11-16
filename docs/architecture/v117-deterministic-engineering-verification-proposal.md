# Cortex Agent v1.17 提案：确定性工程与验证框架

> 状态：PROPOSED / DESIGN_ONLY；版本归属：v1.17（核心）→ v1.17.x（扩展）→ L4 Full Automation（受控自治）。
> 日期：2026-11-16。此文是规划和审查输入，不是正式 Decision、released Waitpoint、Owner/Lease 或生产授权。

## 1. 背景和依据

借鉴 Lauren Tan 在 AI Engineer Code Summit 2026 的 “All Code Is Slop (Except Mine)” 工程分享，以及相关开源 pstack 工具：约束优先于提示词、运行时功能地图、模型检查与 UI 属性验证、库外黑盒测试。与此前 Cortex v1.17 多层 AI Review 思路合并：**预防错误 → 自证 → 独立审查 → 受控合并 → 发布后观察**。分享中的发布频率、回退率属于团队自报案例，非 Cortex 的目标值或验收标准。

参考：
- https://ai.engineer/code/2026/talks/lauren-tan
- https://www.youtube.com/watch?v=O_zcc6Xl12g
- https://github.com/cursor/plugins/tree/main/pstack

## 2. 定位及已有能力复用

Cortex 是跨语言、跨项目、跨宿主的治理框架，不复制 Dune 成产品专用硬编码规则。复用现有 architecture-guard、validation-contract、self-check、knowledge-lint、/ship、project-health、Git-backed GovernanceStore、Decision/Waitpoint、Evidence、Owner/Lease 和 Chat/GitHub Review Bridge；对不同语言以 project profile 注册检查器。

禁止将 PR comment、CI PASS、测试报告、Agent 的“批准”或通知回执解释为 Execution authorization。所有 mutating actions 继续受 Decision + released Waitpoint 双 Gate、真实 Owner/Lease、CAS/Revision 与风险分级约束。

## 3. 新增模块（建议契约）

### A. Architecture Policy-as-Code（P0，v1.17）
- 项目级 architecture manifest：受限依赖方向、分层及主/渲染进程边界、禁用 API 与例外白名单、适用语言和路径。
- 可插拔 ESLint/TypeScript、Go、Rust、Python 等检查器；Cortex 核心只定义稳定检测结果 schema，不依赖特定运行时或 LLM SDK。
- 问题应指出实际违反的规则和可修复根因。注释政策是项目可选规则，**不**采用全局“禁用 99% 注释”。

### B. Verification Contract / Feature Map（P0，v1.17）
- 按用户任务建立功能地图：entrypoint、preconditions、actions、observable outcome、negative path、platform matrix、evidence artifact、timestamp、commit SHA。
- 要求 Agent 在隔离沙盒运行真实软件，记录构建、测试、截图/trace、失败与 NOT_RUN。不能用虚构 Host/截图替代。
- 阶段结论必须区分 PASS、FAIL、NOT_RUN、BLOCKED、INCONCLUSIVE；未知事实不得推断通过。

### C. Evidence-based Review Gate（P0，v1.17）
- 与既有 /ship 的自检、CI、安全、AI Review、人工 Review、合并审批串接。
- 验证来源可追溯到 PR HEAD、工具版本、环境、执行命令、产物 digest，支持差异审查和过期判定。
- 失败同类问题归并呈现，自动修复最多三轮；三轮后进入重新设计/人工确认，不允许无限循环。
- Risk: low/normal/high/critical；AI 审查不能代替高风险人工授权；风险分级必须由项目政策声明并由独立验证校验。

### D. Formal Verification Adapter（P1，v1.17）
- 先对 Cortex 自身的 Mission/Task、Owner/Lease、Decision+Waitpoint、撤销、并发抢占、超时和恢复建 TLA+ 参考模型，输出反例轨迹。
- Lean 用于适合的数学性质与不变量证明；不得宣称 Lean 可以直接证明任意 UI 无闪烁；UI 流畅性仍需运行时指标及视觉/交互测试。
- 形式化工具是可选适配器，无安装或模型覆盖时显示 NOT_RUN，不阻塞不适用的低风险项目。

### E. UI Property Testing（P1，v1.17.x）
- 借鉴 Bombadil 的常驻条件思路，项目声明 UI invariants：关键按钮可达、长列表滚动连续性、导航无死循环、错误提示可见。
- 浏览器、桌面、移动端由插件提供可执行宿主与真实观察证据；无支持宿主时 fail closed，不编造结果。

### F. External Black-box Release Agent（P1，v1.17.x）
- 在代码库外创建一次性消费项目，模拟全新用户安装、升级、卸载、恶意顺序点击、跨平台兼容、权限撤销及断网重试。
- 外部 Agent 独立于实现 Agent；可自动创建 bug issue、提出修复 Draft PR，**不得默认自动合并或发布**。
- 自动合并仅作为后续 L4 Full Automation 的独立提案，由治理决策和权限审查批准具体仓库/分支/风险级别后才可开放。

## 4. 生命周期与治理状态

```text
Proposal/Mission
 → architecture manifest + validation contract
 → scoped implementation
 → static policy / build / unit / security
 → real runtime feature map
 → optional model check & UI invariant check
 → independent review / evidence bundle
 → risk policy + Owner/Lease + Decision + released Waitpoint
 → merge / release
 → external black-box verification / rollback signals
```

生成证据与实施授权分离：Evidence 证明观察事实，不证明主体权限。Review 分支不能成为权威治理写入桥；跨设备操作先 reconcile Git-backed governance revision 和 workspace HEAD。环境不支持某项验证时明确 NOT_RUN，不能用降级模拟的 PASS 取代。

## 5. 版本路线与验收

| 版本 | 交付边界 | 最低验收 |
| --- | --- | --- |
| v1.16.x | 稳定已有 L3 授权/连续执行 Gate 和真实宿主验收 | 不因本文扩大现有 scope |
| v1.17.0 P0 | Policy-as-Code、Feature Map、Evidence Review Gate、review 流程融合 | 违规依赖真实拦截；运行验证可复现；PR SHA 与证据强绑定；FAIL/NOT_RUN 不可变 PASS |
| v1.17.x P1 | TLA+ 适配器、UI 属性测试、外围黑盒验收 | 至少覆盖并发授权反例、撤销/过期和恢复；UI/外部 Agent 有真实独立执行证据 |
| L4 后续提案 | 高自治调度、受控自动修复合并/发布 | 独立授权、风险域限制、撤销/回滚、人工高危门禁及发布证据 |

## 6. 建议实施任务

1. A Governance Owner：登记提案、冻结文件归属与设计审查范围，不越过 G0/Owner/Lease。
2. B Architecture/Policy：制定 manifest schema、检查器插件接口、异常授权记录。
3. C Runtime/Evidence：建立 Feature Map + receipt schema，接入现有 validation-contract。
4. D Formal/Release：TLA+ 参考状态机与外部测试沙盒设计，保留双 Gate。
5. E Independent QA：定义正例、负例、NOT_RUN、跨平台、权限撤销和合并审批矩阵；审查后方可 implementation。

设计通过不等于授权实施、合并或发布。后续所有实现须新开任务、独立 Review PR 并绑定明确 commit 的验证证据。

## 7. 风险与决策待定项

- 检查器及 UI driver 的平台/语言适用范围，避免强制依赖 Electron、TypeScript 或某一 Agent 厂商；
- 形式化验证的维护成本与模型和真实实现的偏差；
- 黑盒消费项目的沙盒权限、密钥隔离、云资源成本与可清理性；
- 修复三轮上限的计数作用域、风险例外和升级治理流程；
- 指标基线：逃逸缺陷、回退率、验证时长、误报率、NOT_RUN 比率、CI 成本；不承诺沿用外部团队的 0.5% 数据。
