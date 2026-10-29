---
title: "模板分层去重"
description: '> 模板树分三层：`_shared` 是语言无关的主副本，`zh` 和 `en` 是只做覆盖的语言层。upgrade 按「先 _shared 再语言层」的顺序铺开，因此语言层里逐字节相同的副本是纯冗余——维护两份却悄悄漂移。一个模板文件只属于一层。'
type: rule
scope: L1
applicable_to:
  - all
linked_workflows: []
linked_skills: []
owner: Kucell
last_verified: 2026-10-29
status: stable
---

# 模板分层去重 — 一个文件只属于一层

> **核心规则**：一个模板文件**只属于一层**。
> 语言无关的内容放 `_shared`；只有确实按语言不同的内容才放 `zh` / `en`。

---

## 三层如何叠加

`cortex-agent upgrade` 按固定顺序铺层：

```
1. templates/_shared/.agent/   ← 主副本（语言无关）
2. templates/{zh,en}/.agent/   ← 语言覆盖层（只在需要时存在）
```

语言层**只做覆盖**。它存在的唯一理由是：这个文件的内容按语言不同。

---

## 文件该放哪

| 内容性质 | 归属层 | 理由 |
|---|---|---|
| 代码、脚本、schema、config | `_shared` | 语言无关，各种语言下行为一致 |
| 文档 / SKILL / rule / workflow 的**正文** | `_shared` | 除非正文本身按语言不同 |
| 面向用户的说明文字、报错文案、示例 | `zh` / `en` | 这才是真正需要语言区分的部分 |
| 按语言填写的 frontmatter 字段 | `zh` / `en` | 同上 |

**关键区分**：一个 `SKILL.md` 的正文可以是语言无关的（→ `_shared`），
而它的 frontmatter 里某个字段可能需要按语言填（→ 语言层覆盖）。
这是**两个维度**，不要混为一谈。

---

## 为什么重复副本是缺陷

同一份内容在 `_shared` 和 `zh` 各存一份，看起来无害，实际有三个代价：

1. **改一处漏一处**——最常见的失败。改了 `_shared` 忘了改 `zh`，
   下游项目拿到的是两个版本中的旧那个；而门禁只在**层间不一致**时才报警，
   于是直到差异影响到事情才有人发现。
2. **分发体积翻倍**——npm 包里每份冗余都是实打实的体积。
3. **漂移报告变得难读**——`check:l1-distribution` 报漂移时，
   你分不清是语言层旧了还是 `_shared` 旧了。

第 1 条最要命：本仓库 `check:l1-distribution` 报出的 5 处漂移，
根因都是 L3 演进后分发面没跟上——而其中 3 处文件在三层里**内容完全相同**，
说明「复制一份」这个动作本身没有产生任何隔离价值，只增加了同步负担。

---

## 门禁

```bash
node scripts/check-template-dedup.js
```

判定：同一相对路径出现在**多层**，且各层内容**逐字节相同** → 报冗余。

内容**不同**的语言层副本不是冗余——那是合法的覆盖，门禁不报。

**门禁在 CI 中执行**（`.github/workflows/full-test.yml`）。

---

## 三个门禁的分工

| 门禁 | 管什么 |
|---|---|
| `check:parity` | 指定的路径在各层出现时内容一致 |
| `check:l1-distribution` | 分发面完整、且未与 L3 漂移 |
| `check:template-dedup`（本文） | 分层结构本身健康——没有文件被维护两份 |

三者互补：`parity` 看一致性，`l1-distribution` 看完整性与漂移，
`template-dedup` 看结构。

---

## 修复路径

1. 确认内容确实语言无关（用上面的判定表）。
2. **删掉语言层的副本**，保留 `_shared` 一份。upgrade 的铺层顺序
   保证用户仍会拿到相同内容。
3. 如果内容**其实需要**语言区分——那就让语言层真正不同，
   而不是复制一份占位。
4. 跑 `node scripts/check-template-dedup.js` 确认清零。
5. 跑 `node scripts/check-l1-distribution.js` 确认没有引入新漂移。

---

## 自检清单

- [ ] 这个文件真的按语言不同吗？还是只是「顺手也放了一份」？
- [ ] 放 `_shared` 够不够？（代码 / schema / config 一律够）
- [ ] 改了 `_shared` 之后，需要同步的语言层文件是不是只有那几个？
- [ ] 跑过 `pnpm check:template-dedup` 吗？
