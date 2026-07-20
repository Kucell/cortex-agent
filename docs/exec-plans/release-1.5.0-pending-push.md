# Release 1.5.0 — Pending External Push

> Created: 2026-07-20
> Status: 本地状态全部就绪，外部 push 因网络问题未完成

## 已完成 ✅

- `package.json` 版本号：`1.4.1` → `1.5.0`（commit `e3353fa`）
- `package-lock.json` 版本号同步：`1.4.1` → `1.5.0`（commit `e3353fa`）
- `.agent/.cortex-version`：`1.4.1` → `1.5.0`（独立仓 `cb868ec`）
- `CHANGELOG.md`：Keep a Changelog 格式 1.5.0 / 1.4.1 / 1.1.0 / 1.0.0（commit `ed850ae`）
- `git tag -a v1.5.0 ed850ae -m "Release 1.5.0: ..."` 已创建
- Communication Runtime release gate 全跑通：
  - `D-release-1.5.0` decision（approved, `--gate user`）
  - `WP-release-1.5.0` waitpoint（released, `--gate owner`）
  - 资源指纹：`release:cortex-agent@ed850ae3ddf02ce5bd2ffdcc31752dca98abecdd`

## 待执行 ⏳

网络问题（curl/SSH 均无法连外网，2026-07-20 当前）：

### 步骤 1：等网络恢复后 push 代码 + tag

```bash
cd /Volumes/workspace/Projects/AI-Tools/cortex-agent
git push origin main --follow-tags
```

预期：8 个 commits + 1 个 annotated tag `v1.5.0` 推送到 origin。

### 步骤 2：登录 npm

```bash
npm login --registry https://registry.npmjs.org/
# 或使用已有 token：
npm set //registry.npmjs.org/:_authToken=<token>
```

验证：
```bash
npm whoami --registry https://registry.npmjs.org/
```

### 步骤 3：dry-run 校验发布物

```bash
npm publish --dry-run --registry https://registry.npmjs.org/
```

预期：484 files, 436.9 kB tarball。

### 步骤 4：正式发布

```bash
npm publish --registry https://registry.npmjs.org/
```

如果开了 2FA：
```bash
npm publish --registry https://registry.npmjs.org/ --otp=<6位验证码>
```

或用 script：
```bash
npm run release:minor
```

### 步骤 5：验证 npm 上 1.5.0 已发布

```bash
npm view cortex-agent@latest version
# 期望：1.5.0

npm view cortex-agent versions
# 期望：["1.0.0", "1.1.0", "1.4.1", "1.5.0"]
```

## 当前本地状态

```text
branch: main
ahead of origin/main: 8 commits
working tree: clean
HEAD: e3353fa
tag: v1.5.0 (annotated, points to ed850ae)
package.json version: 1.5.0
.agent/.cortex-version: 1.5.0
```

## 异常处理

### 如果 push 时遇到 force-push 提示

1.4.1 之前没有 git tag，所以 push 应该不需要 force。如果 origin 那边手动改过，可能需要：
```bash
git push origin main --follow-tags --force-with-lease
```
但**仅在你确认 origin 没有更新的提交时**才用。

### 如果 npm publish 报 409 版本已存在

```bash
npm view cortex-agent versions
```

如果别人已经发过 1.5.0，把 `package.json` + `.agent/.cortex-version` 改成 1.5.1 重走。

### 如果 release gate 因新 commit 失效

如果你在 push 前又 commit 了，跑：
```bash
NEW_HEAD=$(git rev-parse HEAD)
node .agent/skills/management-api/scripts/index.js decisions request \
  --decision-id D-release-1.5.0-rev2 \
  --gate mission --type approval --gate-action release \
  --resource-ref "release:cortex-agent@$NEW_HEAD" \
  --requested-by maintainer \
  --prompt "Release 1.5.0 (rev2): 新 commit $NEW_HEAD" \
  --options '["approve","reject"]'
```

走完 resolve → waitpoint release 链路。