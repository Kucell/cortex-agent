# Animation Library Evaluation · README 演示增强

> 状态：评估稿 · v0.1
> 触发：用户调研了"AI 对接的动画库"，询问后续用哪个库
> 范围：cortex-agent 自身的 README / docs 演示场景

## 0. 结论先行

| 场景 | 推荐 | 备选 | 不推荐 |
|---|---|---|---|
| 静态演示（终端、流程、循环动画） | **CSS keyframes + SVG**（现状） | — | Motion、Framer Motion（框架耦合） |
| 高保真嵌入动画（可重放、状态切换） | **Rive（`.riv` + `rive.js`）** | Lottie（Bodymovin JSON） | GSAP（License / 体积） |
| 架构图 / 状态机 | **Mermaid（已有 11 处）** | Mermaid + ELKjs 后端布局 | 自研 |
| 视频 / 3D 角色 | ❌ 与场景错位 | — | Uthana / Meshy / Live2D / EasyAnimate |

**一句话**：现状（CSS + SVG + Mermaid）已覆盖 90% 需求；**唯一值得引入的新能力是 Rive**，用于"需要状态切换 / 交互重放"的复杂演示。

## 1. 场景盘点

cortex-agent 文档体系的"动画候选位置"：

| 位置 | 当前形态 | 升级需求 |
|---|---|---|
| `README.md` "快速开始" | `docs/assets/quick-start.svg`（CSS keyframes，5 步循环） | hover 重放、暂停、跳到指定步骤 |
| `README.md` 文档索引 | 纯表格 | 无 |
| `docs/architecture.md` | 6 个 Mermaid 流程图 | 状态转移时高亮 |
| `docs/architecture/mission-lite-design.md` | 4 个 Mermaid 图 | milestone 流转 |
| `docs/architecture/harness-optimization-design.md` | 1 个 Mermaid 图 | 阶段流转 |
| `docs/architecture/multi-agent-coordinator.md` | 1 个 ASCII 状态机 | 状态机可视化、agent 调度动画 |
| `.agent/workflows/ship.md` | 文字状态机 | 实时状态机可视化（运行时，非文档） |

## 2. 库评估

### 2.1 已用且无需替换

#### CSS / SVG keyframes（现状）

- **依赖**：零
- **体积**：纯 inline，~5KB/演示
- **维护**：作者手写 `animation-delay`
- **局限**：无交互、状态切换困难、复用成本高（每个新演示重写一份）
- **适用**：静态、循环、不需交互的演示

#### Mermaid（现状）

- **依赖**：`<script src="https://cdn.jsdelivr.net/npm/mermaid/dist/mermaid.min.js">`（约 600KB gzipped）
- **渲染**：GitHub Markdown、VS Code、绝大多数文档站点原生支持
- **交互**：基础 hover/tooltip，可加 `interaction` 配置
- **局限**：动画能力弱、状态机状态切换是"瞬时"，不能"播放"
- **适用**：架构图、状态机静态图

### 2.2 值得引入

#### Rive（推荐）

- **格式**：`.riv`（二进制，专为动画设计）+ `rive.js` 渲染
- **编辑器**：Rive Editor（Web，免费，可与 Figma 集成）
- **体积**：`rive.js` ~100KB gzip，单个 `.riv` 几 KB 到几十 KB
- **能力**：
  - 状态机（State Machine）：在动画内定义"输入 → 状态"映射
  - 骨骼动画、混合、变形
  - 事件回调（`onStateChange`、`onClick`）
- **集成方式**：
  ```html
  <script src="https://unpkg.com/@rive-app/canvas@2.0.0/rive.min.js"></script>
  <canvas width="800" height="400"></canvas>
  <script>
    new rive.Rive({
      src: "demo.riv",
      canvas: document.querySelector("canvas"),
      autoplay: true,
      stateMachines: "StateMachineName",
      onLoad: () => rive.resizeToCanvas()
    });
  </script>
  ```
- **适合 cortex-agent 的场景**：
  - `docs/assets/quick-start.svg` → 升级为 `.riv`，**支持 hover 暂停、点击跳到第 N 步**
  - 状态机演示（如 `/ship` 11 状态流转）
  - Coordinator 调度动画（agent → lock → artifact bus 流转）

#### Lottie（备选）

- **格式**：JSON（Bodymovin 从 After Effects 导出）
- **编辑器**：After Effects（设计师专用，门槛高）
- **能力**：播放控制（play/pause/seek），状态机能力弱
- **劣势**：本仓库无 AE 设计师；JSON 体积比 .riv 大 30-50%
- **结论**：**仅在已有 AE 资产时考虑**——本仓库无此前提

### 2.3 不推荐引入

| 库 | 不推荐理由 |
|---|---|
| **Motion (Framer Motion)** | React-only，README 是静态 HTML/Markdown，不能用 |
| **GSAP Free** | 免费版够用但商业插件付费；体积 ~80KB；动画能力 CSS 都能模拟 |
| **GSAP 商业版** | 收费，文档站点场景没必要 |
| **Live2D AI** | 角色动画，README 错位 |
| **Uthana / Meshy / Kimodo** | 3D 角色 / 资产，README 错位 |
| **Stable Animation SDK / EasyAnimate** | 视频生成，README 静态不需要 |
| **众影 AI 动画** | 移动端 App，README 错位 |
| **龙骨动画（LoongBones）** | Spine/DragonBones 骨骼动画，游戏向 |
| **ElevenLabs** | 配音，本场景不需要 |
| **OiiOii 社群** | 资源平台，非工具 |

## 3. 与现有体系的关系

### 与 Mermaid 的边界

- **Mermaid 管"是什么"**（架构图、状态机静态图）
- **CSS/SVG/Rive 管"怎么动"**（动画、交互）
- 两者**不冲突**：Mermaid 图通常不会被替换为 Rive，Rive 用于"原本就该是动画"的位置

### 与 SVG 现状的演进路径

```
现状：                                  目标：
docs/assets/quick-start.svg (CSS)       docs/assets/quick-start.riv (Rive)
- 单循环                                - hover 重放
- 无交互                                - 点击跳步
- 改文案需手改 SVG                      - 改文案只需在 Rive Editor 改一次
```

迁移成本：低（Rive Editor 可导入 SVG 后转骨骼）

### 与 multi-agent-coordinator 的衔接

Coordinator 设计（T-C02~T-C10）里需要一个 **agent 调度可视化**（agent / lock / artifact 三方流转动画）——Rive 是这个场景的最佳载体：

- Agent Registry 里 4 个 agent 同时跑 → Rive 表现"并发"
- Artifact Bus append → Rive 表现"数据流动"
- Progress Lock 抢占 → Rive 表现"切换"

## 4. 决策矩阵（按"投入产出比"排序）

| 候选 | 引入成本 | 价值 | 风险 | 决策 |
|---|---|---|---|---|
| **保持现状（CSS + Mermaid）** | 0 | 当前 100 分 | 无 | ✅ 立即可走 |
| **引入 Rive** | 中（学 Rive Editor、产 1-2 个 .riv 资产） | 高（解决交互/状态切换） | 中（资产需人维护） | 🟡 T-005 升级或 T-C02 启动时考虑 |
| **引入 Lottie** | 高（需 AE 设计师） | 中 | 高（缺人） | ❌ 暂不 |
| **引入 GSAP** | 低 | 低 | 中（License） | ❌ 暂不 |
| **引入 Motion** | 中 | 0（不能用） | — | ❌ 不适用 |
| **引入 3D / 视频** | 极高 | 0（错位） | — | ❌ 不适用 |

## 5. 落地建议

### 阶段 1（不动）

- README 现状 SVG 演示**足够**——CSS keyframes 已达到演示目的
- 所有 Mermaid 架构图**保持现状**
- T-005 任务**不重新打开**

### 阶段 2（按需启动）

未来若出现"必须交互式动画"的需求，按以下顺序考虑：

1. **首选 Rive**：写一个 30 分钟的 Rive Editor 教程 → 产 1-2 个 `.riv` 资产 → 嵌入 docs/assets/
2. **次选 Lottie**：仅当已有 AE 资产可用
3. **不引入 GSAP / Motion / 3D**

### 阶段 3（C 模式后，与 Coordinator 同步）

- T-C02~T-C10 启动时，把 Rive 资产设计作为**协调层可视化的载体**
- 建议新增任务：**T-C11 Rive Editor 试用 + 产出 agent 调度演示原型**

## 6. 子任务（待启动时按此推进）

| ID | 任务 | 估时 | 优先级 |
|---|---|---|---|
| T-A01 | 试用 Rive Editor（Web），产 1 个 5 分钟教程 | 2h | P2 |
| T-A02 | 把 `quick-start.svg` 升级为 `quick-start.riv`（hover 重放 + 跳步） | 4h | P2 |
| T-A03 | 产出 agent 调度演示原型（Coordinator 状态机） | 6h | P2（依赖 T-C02~C10） |
| T-A04 | docs/assets/ 加入 Rive 加载说明 + cspell 加 `rive` 等词 | 1h | P2 |

**总估时**：~13 小时

## 7. 风险

| 风险 | 缓解 |
|---|---|
| Rive 资产维护成本 | 文档示范用 1-2 个即可，不滥用 |
| 浏览器对 .riv 渲染兼容性 | `rive.js` 兼容所有 evergreen 浏览器 |
| GitHub README 渲染 | GitHub 已支持 Rive 嵌入（通过 `<canvas>` + JS） |
| cspell 误报 Rive 术语 | cspell.json 已支持扩展，加几个词即可 |

## 8. 参考

- 资料来源（用户提供）：AI 对接动画库全指南
- `docs/assets/quick-start.svg`——现状 SVG 演示
- `docs/architecture/multi-agent-coordinator.md`——Coordinator 设计
- Rive 官网：https://rive.app
- Lottie 官网：https://lottiefiles.com
