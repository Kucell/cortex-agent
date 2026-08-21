# Motion brief — saas-hero

> P-005 / MS-005 生成的确定性 brief。编辑 `index.html` 一处即可调整效果;
> 本文件由系统生成,改它不会影响渲染(只影响记录)。

## 意图(用户品牌语言描述)

- 目标 motion id:`saas-hero`
- 起始模板:`saas-hero`(产品发布 hero)
- 时长:由 `index.html` 根元素 `data-duration` 决定(默认 8s)
- 效果:浅色画布 + 单一品牌强调色,logo → eyebrow → headline → tagline → CTA 克制动效

## 3 个情绪问题(HARD-GATE,渲染前必须回答)

1. 这支动效想让观众**感觉**什么?(克制 / 兴奋 / 信任 / 惊喜 …)
2. 画面应该是**明亮 / 暗调 / 中间调**?
3. 只允许出现**一个品牌色**,它是什么?

回答后,把答案写进 `.agent/motion/saas-hero/DESIGN.md`,再跑
`cortex-agent motion style-tokens --motion-id saas-hero` 重新编译 tokens。
