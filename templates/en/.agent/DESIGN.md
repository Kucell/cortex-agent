# <Project Name> Design System

> 视觉规范 — 任何 AI agent(Claude Code / Codex / Cursor / 等)生成 UI、前端代码、dashboard、设计稿时必须遵循。
>
> 格式参考:[open-design upstream `DESIGN.md`](https://github.com/nexu-io/open-design/tree/main/design-systems) — 至少 7 个 substantive H2 section,字段名可自定义。
> 集成上下文:由 `cortex-agent design resolved` 自动发现本文件(4 级 cascade 优先级:项目根 > `.agent/` > 已 install system LIFO > starter)。
> 上游 license:本 starter 由 cortex-agent 维护(Apache-2.0)。安装上游 system 后 license 详见 `.agent/design-systems.lock`。

---

## Visual theme

<!-- 一句话描述项目视觉主题(温暖 / 冷静 / 极简 / 复古 / 编辑风 / 数据密集...) -->

(占位 — 示例:`warm-editorial: parchment-toned background, dark ink, single accent color`)

## Color roles

<!-- 主色 / 辅色 / 强调色 / 语义色(success / warning / error / info)+ 中性灰阶 -->

| Role | Hex | Usage |
|---|---|---|
| Primary | `#000000` | 主交互 / 标题 / 强调 |
| Secondary | `#666666` | 次要交互 / 副标题 |
| Accent | `#3b82f6` | 强提示 / 关键 CTA |
| Success | `#22c55e` | 成功反馈 |
| Warning | `#f59e0b` | 警告 |
| Error | `#ef4444` | 错误 |
| Info | `#3b82f6` | 信息提示 |
| Surface | `#ffffff` | 背景 |
| Text | `#1a1a1a` | 正文 |
| Muted | `#6b7280` | 辅助说明 |

(占位 — 替换为项目实际色板)

## Typography

<!-- 字体族(标题/正文/代码)、字号层级、字重、行高、letter-spacing -->

- **Heading**: `<heading-font>`, weight 600, line-height 1.2
- **Body**: `<body-font>`, weight 400, line-height 1.6
- **Code**: `<mono-font>`, weight 400, line-height 1.5
- **Type scale**: heading-1 32px / heading-2 24px / heading-3 20px / body 16px / caption 14px
- **Letter-spacing**: heading -0.02em / body 0

(占位 — 替换为项目实际字体)

## Layout and spacing

<!-- 网格系统、间距 scale、断点 -->

- **Grid**: 12 列,gutter 24px,max-width 1280px
- **Spacing scale**(8 进制):4 / 8 / 12 / 16 / 24 / 32 / 48 / 64 / 96 px
- **Container padding**: 16px (mobile) / 24px (tablet) / 32px (desktop)
- **Breakpoints**: 640 / 768 / 1024 / 1280 / 1536 px
- **Border radius**: 0 (square) / 4 / 8 / 12 / 16 / 9999 (pill)

(占位 — 替换为项目实际布局规范)

## Components and states

<!-- 核心组件清单 + 主要状态 -->

| Component | States (default / hover / active / disabled / error) |
|---|---|
| Button | default / hover(轻微变深)/ active(按下)/ disabled(灰 50% opacity)/ error(红色边框) |
| Input | default / focus(2px ring)/ error(红色 + helper text)/ disabled |
| Card | default / hover(轻微 lift)/ selected(2px accent border) |
| Modal | closed / open(背景遮罩 50% opacity)/ loading |
| Toast | success / warning / error / info — 4s 自动消失 |

(占位 — 补充项目实际组件)

## Motion and interaction

<!-- 动效原则:缓动函数 / 时长 / stagger / 缓入缓出 -->

- **Easing**: `cubic-bezier(0.16, 1, 0.3, 1)` (进入) / `cubic-bezier(0.7, 0, 0.84, 0)` (退出)
- **Duration**: 150ms(微交互)/ 250ms(常规)/ 400ms(强调)
- **Stagger**: list 项间隔 30ms
- **Hover**: 100ms scale 1.02 + shadow 增强
- **Page transition**: 200ms fade + 8px slide
- **Reduced motion**: `prefers-reduced-motion: reduce` 时全部动效缩为 50ms fade-only

(占位 — 替换为项目实际动效规范)

## Accessibility

<!-- WCAG 等级 / 对比度 / 键盘导航 / 屏幕阅读器 / reduced-motion / 颜色独立性 -->

- **WCAG level**: AA(目标 AAA)
- **Contrast minimum**: 正文 4.5:1 / 大字号 3:1 / UI 组件 3:1
- **Keyboard**: 所有交互元素 Tab 可达,focus ring 2px 强对比
- **Screen reader**: 语义化 HTML + ARIA 仅在必要时
- **Reduced motion**: 尊重 `prefers-reduced-motion` 媒体查询
- **Color independence**: 不依赖颜色单独传递信息(配 icon / text)
- **Touch target**: 最小 44×44 px

(占位 — 替换为项目实际可访问性承诺)

## Anti-patterns

<!-- 必须避免的视觉决策 -->

- ❌ 纯黑底 + 纯白字(对比过强,容易疲劳)
- ❌ 居中堆叠大段文字(阅读体验差)
- ❌ emoji-only 作为章节 header(渲染不稳定)
- ❌ 多于 3 种字体(视觉混乱)
- ❌ 渐变滥用(尤其在文字上)
- ❌ 动画时长 > 600ms(用户等待感强)
- ❌ 浅灰文字 on 浅灰背景(对比度 < 3:1)
- ❌ 红色单独表达 error(配 icon)
- ❌ "Lorem ipsum" placeholder 出现在产品截图
- ❌ auto-play 视频 / 音频
- ❌ 浮动弹窗遮挡主体内容
- ❌ disabled 状态不显示原因

(占位 — 补充项目特定的 anti-patterns)

---

## Verification checklist

任何 agent 生成 UI / 前端代码 / 文档后,自查:

- [ ] 色彩 / 字体 / 间距值在本文档中有明确依据
- [ ] 未引入本文档未声明的视觉 token
- [ ] anti-patterns section 无违规
- [ ] 通过键盘导航测试
- [ ] 屏幕阅读器能正常朗读核心交互
- [ ] 对比度通过 WCAG AA

## How to update this file

1. 修改 H2 sections 中的占位内容
2. `cortex-agent design resolved` 重新打印 cascade
3. 提交 PR:在 commit message 中说明 "DESIGN.md change" + 影响范围
4. AI agent 下次会话自动消费新内容

## Related

- 上游:https://github.com/nexu-io/open-design
- 集成提案:`.agent/plans/proposals/design-system/cortex-agent-open-design-integration-proposal.md`
- 任务:`.agent/tasks/T-OD-001.json`
- 架构文档:`docs/architecture/design-system.md`
- 安装 system:`cortex-agent design install <id>`(详见 `.agent/design-systems/README.md`)
