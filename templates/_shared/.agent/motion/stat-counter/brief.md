# Motion brief — stat-counter

> P-005 / MS-005 生成的确定性 brief。编辑 `index.html` 一处即可调整效果;
> 本文件由系统生成,改它不会影响渲染(只影响记录)。

## 意图(用户品牌语言描述)

- 目标 motion id:`stat-counter`
- 起始模板:`stat-counter`(count-up 数据动效)
- 时长:由 `index.html` 根元素 `data-duration` 决定(默认 7s)
- 效果:深炭黑底 + 冷色点缀,3 个指标数字从 0 数到目标值,克制渐入

## 3 个情绪问题(HARD-GATE,渲染前必须回答)

1. 这支动效想让观众**感觉**什么?(克制 / 兴奋 / 信任 / 惊喜 …)
2. 画面应该是**明亮 / 暗调 / 中间调**?
3. 只允许出现**一个品牌色**,它是什么?

回答后,把答案写进 `.agent/motion/stat-counter/DESIGN.md`,再跑
`cortex-agent motion style-tokens --motion-id stat-counter` 重新编译 tokens。
