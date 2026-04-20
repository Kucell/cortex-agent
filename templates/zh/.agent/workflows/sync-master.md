---
description: 向主干同步：fetch + rebase，禁止日常 merge；含脏工作区保护与可选构建校验。默认主干名支持 main 或 master。
---

# 分支同步工作流 (/sync-master)

当用户请求与**主分支**同步（拉取最新、变基当前分支）时执行本流程。

## 主干名约定

- 常见为 **`main`** 或 **`master`**。若项目使用其他默认分支名，将下文中的 `main` 替换为实际名称（或先执行 `git symbolic-ref refs/remotes/origin/HEAD` / `git branch -r` 确认 `origin/默认分支`）。
- 下文以 **`origin/main`** 为例；若你的仓库是 `origin/master`，把所有 `main` 改为 `master` 即可。

## 1. 状态检查与安全区保护

- 运行 `git status` 检查当前工作区。
- 若有未提交修改，**必须先** `git stash push -m "sync-master wip"`（或等价方式）保存，再执行 fetch/rebase，避免丢失本地改动。

## 2. 抓取远端变更

- 运行 `git fetch origin`（或 `git fetch origin main`），将远端最新提交取回本地。

## 3. Rebase（日常同步禁止 merge）

- 在当前分支上执行：`git rebase origin/main`（若主干为 `master` 则为 `origin/master`）。
- **禁止**用 `git merge` 做日常「把主干合进特性分支」类同步；仅在极少数发布/合并节点且团队明确约定时使用 merge。

## 4. 冲突处理

- 若产生冲突：列出冲突文件，说明解决思路，**暂停自动化**；待用户解决后执行 `git rebase --continue`。

## 5. 恢复 stash 与可选校验

- Rebase 成功后：若第 1 步曾 stash，执行 `git stash pop`（若有冲突再人工处理）。
- 建议运行项目约定的快速校验（如 `npm test`、`npm run build` 或 `tsc --noEmit`），确认通过。
- 用 1～2 句话向用户汇报结果。

## 参考

- Git 纪律与最小破坏原则见 `.agent/rules/ai-behavior.md`。
- 提交信息规范见 `.agent/rules/commit-standards.md`。
