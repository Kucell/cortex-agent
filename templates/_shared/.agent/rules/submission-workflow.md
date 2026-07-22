# 提交流程规范 — 双仓同步 + Pre-Commit 门禁

> cortex-agent 本地一次功能改动通常会**两个嵌套 Git 仓**都同步变化:
>
> | 仓 | 路径 | Remote |
> |---|---|---|
> | 外(framework 源码) | `<repo>/` | `github.com/Kucell/cortex-agent.git` |
> | 内(L3 工作实例) | `<repo>/.agent/` | `github.com/Kucell/cortex-agent-agent.git` |
>
> 当一个仓处理,另一个会漂移。本规则定义顺序、门禁、故障处理。

---

## 1. 顺序(MUST 按此顺序)

```
   ┌─────────────────────────────────────────────────────────┐
   │  1. 先内仓 commit + push  (.agent-level 改动)             │
   │  2. 后外仓 commit + push  (./templates + L1 同步)        │
   │  3. (可选) 同步 manifest 刷新 + pcm 维护                │
   └─────────────────────────────────────────────────────────┘
```

| 步骤 | 位置 | 原因 |
|---|---|---|
| 1 | 内仓(`cd .agent && git …`) | 方便独立 review;外仓 templates 引用内仓的形状,先推内让外仓 diff 显示从上次同步至今的差异清晰 |
| 2 | 外仓(`git …` from `<repo>/`) | 外仓是 npm 包面,从此发版。先内后外,旁观 `origin/main` 时永远看到完整链路 |
| 3 | `pc m`(post-commit maintenance) | 双向 commit 后,把新 commit 反映到 `graphify-out/graph.json` 并清理 `context-index.json` 中的 orphan 条目 |

> 顺序倒过来是 **禁止** 的:外仓 commit 引用的 inner 状态如果还没 ship,在新 clone 的项目里 upgrade 会找不到路径。

## 2. Pre-Commit 门禁栈(每次 commit 前按此顺序)

| 层 | 工具 | 失败 → 处置 |
|---|---|---|
| 1 | `.claude/hooks/pre-commit-check.sh` | 硬编码密钥 grep、JS/TS lint 等。**绝不**用 `--no-verify` 跳过 hook。常见 false-positive:默认 mask 字符串 `"**********"` 命中 `token = "..."` 模式 — rename 为 `[REDACTED]` 规避 |
| 2 | `script-manifest reconcile --apply=false` | 报告 L1 managed-script drift。**新增 `.js` 加进白名单** —— templates/.../skills/ 下任何新脚本必须出现在 `lib/script-manifest.js` |
| 3 | `self-check check` (L1 只读) | 暴露 L0/L1 drift 在内仓 L3 实例上的反映。失败时改完再提交 |
| 4 | 真项目 dry-run upgrade | 改 L1(rules/skills/workflows)时,`cd` 到现有用户项目(例 HMI/SamHMI),跑 `cortex-agent upgrade --dry-run`,确认 diff 集合对得上你的意图。**提交前**跑,不要提交后 |

Hook 1–3 自动跑(`.git/hooks/pre-commit`)。Hook 4 手动,**不可跳过**(对 templates/ 下的任何改动)。

## 3. Commit Message 卫生(扩展 commit-standards.md)

| 规则 | 原因 |
|---|---|
| **subject** 命名**外仓侧**改动。内仓 commit 是 *原因*;外仓 commit 是 *可见产物*。读者先看外仓 `git log` |
| **body** 显式链内仓 commit SHA:`Inner mirror: <sha>.` 便于以后 squash / rebase 后仍能还原链路 |
| **footer** 涉及用户侧动作时(config 变更、breaking、license)用 "User action required" 段,不要埋 body |
| **不要 `$` 字符** 当交互跑在 zsh($ 会被展开)。 用 `git commit -F <file>` 走多行 + `$` / 反引号 |
| **不要 `**********` mask 字符串** 见 §2 layer 1 |

## 4. Push 卫生

- **先内后外** —— 见 §1
- push 后跑 `git log --oneline origin/main -3` **在两个仓**,目视确认 cross-reference 对得上
- `git push origin main` 失败(non-fast-forward)**停下**,代表有人在你之前推过。`git fetch && git rebase origin/main` —— 永远不用 `--force`(用 `--force-with-lease` 也不行,除非你真的知道)
- 内仓出现 `AM` 或嵌套路径(`cp -r` shim 副作用),**commit 之前** `git rm -r` 它,否则历史带一具需要 amend 才能清掉的幻影

## 5. 我们都踩过的失败模式

- **`cp -r templates/X templates/Y` 产生 phantom nested** — zsh 把源**复进** `Y/X` 而不是覆盖。永远按显式路径 cp,或 per-file wildcard。如果已 staged,amend 走前。
- **mask 字符串被 hook 误报** —— 见 §3
- **`script-manifest` 忘加新 skill** —— L1 templates 是 schema source-of-truth,parser 必须同步
- **skill 名撞** —— 加新 skill 时别用另一 L1 skill 目录已有过的名字,即便文件不同;`walkAndAdd` 会 silent leave 重复项。新 skill 必 dry-run upgrade

## 6. 推送后验证

```bash
# 1. 外仓 HEAD 匹配你 commit 的
git -C <repo> log --oneline origin/main -1
# 2. 内仓 HEAD 匹配
git -C <repo>/.agent log --oneline origin/main -1
# 3. 外仓 "Inner mirror: <sha>" 中的 SHA = 内仓实际 HEAD
git -C <repo>/.agent rev-parse HEAD
# 4. (如果改 L1)真项目 dry-run upgrade
cd /Users/workspace/code/HMI/SamHMI && node /Users/xueyq/myworks/cortex-agent/bin/cli.js upgrade --dry-run
# 5. (如果改 proposal)lint 提案文本
```

干净结果:真项目 dry-run 报 `Would add (0)` + 0 候选脚本更新。

## 7. 故障恢复

| 症状 | 恢复 |
|---|---|
| 先推外后推内 | revert 外(`git revert -n HEAD && git commit -m "revert: pull inner first"`),推内,cherry-pick 父回 |
| 内 commit 带幻影 nested dir | `git commit --amend -F msg.txt`,只在该 commit 还没推远端时使用 `git push origin main --force-with-lease`(`--force` 绝不用) |
| pre-commit 报假 secret 警报 | `git diff --staged -U0 \| grep -nE 'token\s*=\s*' \| head`,rename / 移动该 literal。**不用** `--no-verify` |
| outer script-manifest 缺新 skill | 把脚本路径加进 `lib/script-manifest.js` 白名单,重跑 `script-manifest reconcile --apply=false`,然后 commit 两者 |

> **永远不用** `--no-verify` 跳过 hook。hook 抓的是人肉 review 抓不到的,跳过省一时,还一组未来的 debug session。

## 8. 反模式

- ❌ "内仓小不显眼"就先推外 —— 让 `origin/main` 引用未 ship 的 inner 状态
- ❌ "为整洁"把内+外 auto-squash 成一个 commit —— 废掉 cross-reference
- ❌ 重用 `**********` literal 当 mask,本地 grep 没抓到,但 commit 一刻 hook 必抓
- ❌ `cp -r templates/.../skills/X` 到另一 template 不验证目录内容
- ❌ "因为 templates 看着对"就跳过真项目 dry-run upgrade
