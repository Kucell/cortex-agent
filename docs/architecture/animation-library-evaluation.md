# Animation Library Evaluation · README / Docs 演示增强

> 状态：正式候选设计 · v0.2
> 触发：用户调研了"AI 对接的动画库"，询问后续用哪个库
> 范围：cortex-agent 自身的 README / docs / 架构演示 / 视频化说明场景

## 0. 结论先行

| 场景 | 推荐 | 备选 | 不推荐 |
|---|---|---|---|
| 静态演示（终端、流程、循环动画） | **CSS keyframes + SVG**（现状） | — | Motion、Framer Motion（框架耦合） |
| 代码驱动的轻量 Web 动画 | **Anime.js** | CSS keyframes | GSAP（License / 体积） |
| 高保真交互动画（可重放、状态切换） | **Rive（`.riv` + `rive.js`）** | Lottie（Bodymovin JSON） | 自研状态机动画 |
| 视频化教程 / 发布素材 | **Remotion** | 手工录屏、GIF | 传统剪辑工具作为主流程 |
| 架构图 / 状态机 | **Mermaid（已有 11 处）** | Mermaid + ELKjs 后端布局 | 自研 |
| 视频 / 3D 角色 | ❌ 与场景错位 | — | Uthana / Meshy / Live2D / EasyAnimate |

**一句话**：现状（CSS + SVG + Mermaid）仍是 README 主路径；Anime.js、Rive、Remotion 都值得保留为正式候选，但用途不同：

- **Anime.js**：代码驱动的轻量动画原型，适合 docs site、交互 demo、导出前的快速验证。
- **Rive**：状态机式交互动画，适合 Coordinator 调度、workflow 状态切换等可视化。
- **Remotion**：用 React 程序化生成视频，适合 README GIF/MP4、发布演示、教程素材。

GitHub README 不应依赖自定义 JS 或 canvas 运行时；动态资产进入 README 时应导出为 SVG / GIF / MP4 / PNG fallback。

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
| 发布 / 教程素材 | 无统一生成流程 | 用 Remotion 生成可复现视频或 GIF |

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

#### Anime.js（推荐：轻量代码动画）

- **定位**：JavaScript animation engine，适合 CSS properties、SVG、DOM attributes 和 JavaScript objects 的动画。
- **依赖形态**：可通过 `animejs` npm 包安装，也可使用 ESM / UMD 构建产物。
- **能力**：
  - timeline、stagger、easing、SVG 动画
  - 对现有 SVG 演示做局部增强
  - 快速实现可交互的 docs demo
- **适合 cortex-agent 的场景**：
  - 快速验证 `quick-start.svg` 的动画节奏，再固化为 SVG/GIF
  - 给 Coordinator 调度图做 docs site 交互原型
  - 为 `/ship` 状态机演示做轻量 Web 版本
- **不适合**：
  - 直接作为 GitHub README 的运行时依赖
  - 长视频生成
  - 需要设计师维护的高保真状态机动画

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
- **README 注意事项**：
  - `.riv` 适合 docs site 或独立演示页
  - README 中应使用导出的 GIF/MP4/PNG fallback，而不是依赖 `rive.js`

#### Remotion（推荐：视频化资产生成）

- **定位**：使用 React 程序化创建视频，可用 CSS、Canvas、SVG、WebGL 和算法生成可复现的视频资产。
- **能力**：
  - 把 workflow、terminal、architecture animation 做成可参数化视频
  - 使用同一套 React 组件生成不同语言、不同版本的教程素材
  - 适合 AI coding agent 协作生成视频工程
- **适合 cortex-agent 的场景**：
  - README quick-start 的 GIF/MP4 版本
  - Coordinator 调度流程讲解视频
  - release notes / npm package 页面使用的短视频素材
  - 将 docs 中的状态机变成可复现的动画片段
- **不适合**：
  - 作为 cortex-agent CLI runtime 依赖
  - 简单 SVG 循环动画
  - 在 README 内直接运行 React/JS

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
- **CSS/SVG/Anime.js/Rive 管"怎么动"**（动画、交互）
- **Remotion 管"怎么发布成视频"**（GIF/MP4/教程片段）
- 它们**不冲突**：Mermaid 图通常不会被替换为 Rive；Rive 用于"原本就该是状态机动画"的位置；Remotion 用于把演示生成可发布资产。

### 与 SVG 现状的演进路径

```
现状：                                      目标：
docs/assets/quick-start.svg (CSS)           docs/assets/quick-start.svg / .gif / .mp4
- 单循环                                    - README 保持静态兼容
- 无交互                                    - docs site 可提供交互版
- 改文案需手改 SVG                          - Remotion / Anime.js 原型可辅助生成
```

迁移策略：README 资产保持静态或视频导出；交互版放到 docs site 或独立 demo 页面。

### 与 multi-agent-coordinator 的衔接

Coordinator 设计（T-C02~T-C10）里需要一个 **agent 调度可视化**（agent / lock / artifact 三方流转动画）。推荐分三层：

| 层级 | 工具 | 用途 |
|---|---|---|
| 快速原型 | Anime.js | 验证 agent / lock / artifact 流转节奏 |
| 高保真交互 | Rive | 表现并发、抢占、handoff、resume 状态机 |
| 发布素材 | Remotion | 生成 README / release / docs 视频资产 |

示例：

- Agent Registry 里 4 个 agent 同时跑 → Rive 或 Anime.js 表现"并发"
- Artifact Bus append → Rive 或 Anime.js 表现"数据流动"
- Progress Lock 抢占 → Rive 表现"切换"
- Claude → Codex E2E 交接 → Remotion 生成发布演示视频

## 4. 决策矩阵（按"投入产出比"排序）

| 候选 | 引入成本 | 价值 | 风险 | 决策 |
|---|---|---|---|---|
| **保持现状（CSS + Mermaid）** | 0 | 当前 100 分 | 无 | ✅ 立即可走 |
| **引入 Anime.js** | 低（小型 JS 原型） | 中高（快速试动画节奏） | 中（README 不能直接跑 JS） | ✅ 作为 docs/demo 原型工具 |
| **引入 Remotion** | 中（React 视频工程） | 高（可复现教程/发布视频） | 中（不应进入 CLI runtime） | ✅ 作为资产生成工具 |
| **引入 Rive** | 中（学 Rive Editor、产 1-2 个 .riv 资产） | 高（解决交互/状态切换） | 中（资产需人维护） | ✅ Coordinator 可视化候选 |
| **引入 Lottie** | 高（需 AE 设计师） | 中 | 高（缺人） | ❌ 暂不 |
| **引入 GSAP** | 低 | 低 | 中（License） | ❌ 暂不 |
| **引入 Motion** | 中 | 0（不能用） | — | ❌ 不适用 |
| **引入 3D / 视频** | 极高 | 0（错位） | — | ❌ 不适用 |

## 5. 落地建议

### 阶段 1（保留现状，但承认该方向）

- README 现状 SVG 演示**足够**——CSS keyframes 已达到演示目的
- 所有 Mermaid 架构图**保持现状**
- T-005 任务**不重新打开**
- Animation 方向保留为正式候选，不降级为"可有可无"

### 阶段 2（工具试点）

未来若出现"必须交互式动画或视频化说明"的需求，按以下顺序考虑：

1. **Anime.js**：先做轻量 Web 原型，验证节奏和状态表达。
2. **Remotion**：把稳定原型生成 GIF/MP4，用于 README、release 和教程。
3. **Rive**：当需要用户可交互的状态机时，再做 `.riv` 资产。
4. **Lottie**：仅当已有 AE 资产可用。
5. **不引入 GSAP / Motion / 3D**。

### 阶段 3（C 模式后，与 Coordinator 同步）

- T-C02~T-C10 启动时，把 Animation 作为**协调层可视化与传播资产**同步考虑。
- 先用 Anime.js 做 agent 调度节奏原型。
- 再用 Remotion 生成 Claude → Codex E2E 演示视频。
- 如需要交互式状态机，再用 Rive 做 docs site 版本。

## 6. 子任务（待启动时按此推进）

| ID | 任务 | 估时 | 优先级 |
|---|---|---|---|
| T-A01 | 试用 Rive Editor（Web），产 1 个 5 分钟教程 | 2h | P2 |
| T-A02 | 把 `quick-start.svg` 升级为 `quick-start.riv`（hover 重放 + 跳步） | 4h | P2 |
| T-A03 | 产出 agent 调度演示原型（Coordinator 状态机） | 6h | P2（依赖 T-C02~C10） |
| T-A04 | docs/assets/ 加入 Rive 加载说明 + cspell 加 `rive` 等词 | 1h | P2 |
| T-A05 | Anime.js 试点：产出 Coordinator 调度 Web 原型 | 3h | P2（依赖 T-C02） |
| T-A06 | Remotion 试点：生成 Claude → Codex handoff 演示视频 | 6h | P2（依赖 T-C09） |

**总估时**：~22 小时

## 7. 风险

| 风险 | 缓解 |
|---|---|
| 动画工具链污染 CLI 零依赖原则 | 只放在 docs/assets 或独立 demo，不进入 `bin/cli.js` / `lib/` runtime |
| GitHub README 不执行自定义 JS | README 只引用导出的 SVG/GIF/MP4/PNG fallback |
| Anime.js 原型无法直接用于 README | 将其定位为 docs site / demo / 资产生成前置原型 |
| Remotion 引入 React 视频工程复杂度 | 只在需要可复现视频资产时启动，作为可选工具链 |
| Rive 资产维护成本 | 文档示范用 1-2 个即可，不滥用 |
| 浏览器对 .riv 渲染兼容性 | `rive.js` 兼容所有 evergreen 浏览器 |
| cspell 误报动画术语 | cspell.json 已支持扩展，加 `rive`、`animejs`、`remotion` 等词即可 |

## 8. 参考

- 资料来源（用户提供）：AI 对接动画库全指南
- `docs/assets/quick-start.svg`——现状 SVG 演示
- `docs/architecture/multi-agent-coordinator.md`——Coordinator 设计
- Rive 官网：https://rive.app
- Anime.js 官网：https://animejs.com/
- Remotion 官网：https://www.remotion.dev/
- Lottie 官网：https://lottiefiles.com
