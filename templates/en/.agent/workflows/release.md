---
name: release
description: 按语义化版本规范（SemVer）发布新版本。自动分析变更类型、更新版本号、提交、打 tag 并发布到 npm。
---

# 发布工作流 (/release)

## 第一步：分析变更，推断版本号

读取自上次 tag 以来的所有提交记录：

```bash
git log $(git describe --tags --abbrev=0)..HEAD --pretty=format:"%s" --no-merges
```

按 Conventional Commits 规则推断版本号类型：

| 条件 | 版本变更 | 示例 |
| :--- | :--- | :--- |
| 包含 `BREAKING CHANGE` 或 `!:` | **Major** x.0.0 | 破坏性 API 变更 |
| 包含 `feat:` / `feat(*):` | **Minor** x.y.0 | 新增功能 |
| 只有 `fix:` / `chore:` / `docs:` 等 | **Patch** x.y.z | 修复或维护 |

展示推断结果和本次变更摘要，**请用户确认版本号**后再继续。

---

## 第二步：更新版本号

确认版本号后，同步更新以下三处：

1. `package.json` → `"version": "{新版本}"`
2. `.claude-plugin/plugin.json` → `"version": "{新版本}"`
3. `.claude-plugin/marketplace.json` → 两处 `"version": "{新版本}"`（metadata 和 plugin 条目）

---

## 第三步：提交 + 打 Tag

```bash
git add package.json .claude-plugin/plugin.json .claude-plugin/marketplace.json
git commit -m "chore(release): v{新版本}"
git tag v{新版本}
git push && git push --tags
```

---

## 第四步：发布到 npm

```bash
npm publish --registry https://registry.npmjs.org/
```

如果账号开启了 2FA，命令会提示输入 OTP，补充 `--otp=<验证码>` 参数：

```bash
npm publish --registry https://registry.npmjs.org/ --otp=<6位验证码>
```

> 💡 **简便方式**：也可以直接运行 `npm run release` 脚本，它会完成版本号更新和发布，Git 提交和 tag 需手动或由 AI 配合完成。

---

## 完成后输出

- 发布成功：提示 `cortex-agent@{版本} ✅ 已发布到 npm`
- 更新 `.agent/plans/task-progress.md` 中对应任务状态
