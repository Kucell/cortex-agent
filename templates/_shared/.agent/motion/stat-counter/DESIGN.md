# stat-counter — Motion DESIGN.md(最小可溯源)

> P-005 HARD-GATE 产物:调色板 / 字体必须可溯源到 design system。只编辑
> `index.html` 一处;本文件记录视觉意图,不改渲染。

## Visual theme

- 主题:深炭黑底(`#0b0b0f`)+ 冷色点缀(`#7da4ff`),数据 count-up 动效
- 渲染门控:snapshot proof 帧 → 用户确认才 render

## Color roles

| Role | Hex | Usage |
| --- | --- | --- |
| Primary | `#7da4ff` | overline / 数字后缀 |
| Secondary | `#f5f5f7` | 数字主体 |
| Accent | `#7da4ff` | 数据点强调 |
| Background | `#0b0b0f` | 画布底色 |

## Motion and interaction

- Easing: `power2.out`(数字 count-up 与入场)
- Duration: 200ms(fast)/ 400ms(base)/ 1600ms(count-up)
- 数字从 0 数到 `data-target`(`tabular-nums` 防抖动)
- 一个时间线 `window.__timelines["main"]`,stagger 0.12s

## Anti-patterns

- ❌ 不引入 DESIGN.md 未声明的视觉 token
- ❌ 多于 3 种字体 / emoji 作为章节 header
- ❌ 数字抖动(必须 `font-variant-numeric: tabular-nums`)
- ❌ 与品牌色冲突的默认色(#333 / #3b82f6 / Roboto)
