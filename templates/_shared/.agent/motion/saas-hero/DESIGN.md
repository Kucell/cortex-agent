# saas-hero — Motion DESIGN.md(最小可溯源)

> P-005 HARD-GATE 产物:调色板 / 字体必须可溯源到 design system。只编辑
> `index.html` 一处;本文件记录视觉意图,不改渲染。

## Visual theme

- 主题:浅色画布(`#f7f7f5`)+ 单一品牌强调色(`#ff5c1f`),SaaS 产品发布 hero
- 渲染门控:snapshot proof 帧 → 用户确认才 render

## Color roles

| Role | Hex | Usage |
| --- | --- | --- |
| Primary | `#ff5c1f` | logo 点 / eyebrow / CTA |
| Secondary | `#1a1a1a` | 标题 / logo 主体 |
| Accent | `#ff5c1f` | 关键 CTA |
| Background | `#f7f7f5` | 画布底色 |

## Motion and interaction

- Easing: `power2.out`(进入);CTA 用 `back.out(1.4)` 轻弹
- Duration: 200ms(fast)/ 400ms(base)/ 800ms(slow)
- 入场用 `gsap.from()`,出场用 `gsap.to()`(Layout Before Animation 硬规则)
- 一个时间线 `window.__timelines["main"]`,4 个 clip 元素

## Anti-patterns

- ❌ 不引入 DESIGN.md 未声明的视觉 token
- ❌ 多于 3 种字体 / emoji 作为章节 header
- ❌ 动效时长 > 800ms(除非 brief 明确要求)
- ❌ 与品牌色冲突的默认色(#333 / #3b82f6 / Roboto)
