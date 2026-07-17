---
name: release
description: 按 SemVer 准备发布，并通过资源绑定的 Decision 与 Waitpoint 控制 tag、push 和 npm 发布。
---

# 发布工作流 (/release)

`/release` 是发布候选、push 和 publish 的 owning workflow。候选必须先在工作区真实形成并完成验证，之后才能冻结摘要并申请批准。分析、普通 `status`/`diff` 和本地候选检查不需要审批；push、publish、deploy、凭证使用和破坏性动作各自保持独立授权。

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

展示推断结果和本次变更摘要。版本号确认只确定候选值，不等于发布授权。

---

## 第二步：在工作区准备发布候选

1. 在修改前记录 `base_commit`。
2. 更新仓库策略要求的版本文件、lockfile、插件清单和 changelog。不得假定每个项目都有同一组文件。
3. 使用项目既有的本地打包流程生成候选包或规范化候选文件清单。
4. 此阶段不得提交、打 tag、push、publish 或 deploy；候选必须保持可检查、可丢弃、可重新生成。

## 第三步：验证并冻结候选

1. 运行发布前测试、构建、lint 和项目要求的包内容检查。
2. 检查 `git status`、`git diff` 和候选包清单。这些是只读检查，不需要 Decision。
3. 对将要发布的确切包字节计算 `candidate_digest`；若项目不产生归档包，则对排序后的规范化文件清单及内容计算摘要。
4. 固定 package、version、registry、base commit、candidate digest 和目标 tag，建立精确资源引用：

```text
npm:<package>@<version>#registry:<registry>#base:<sha>#candidate-digest:<sha256>#tag:v<version>
```

候选验证失败时停在本步骤修复；每次候选内容变化后都必须重新验证并计算新摘要。

## 第四步：创建候选 Decision 与 Waitpoint

Decision 和 Waitpoint ID 必须包含 `candidate_digest` 的前 8-12 位或等价的唯一 request suffix：

```bash
node .agent/skills/management-api/scripts/index.js decisions request \
  --decision-id D-release-<version>-<candidate-digest8> \
  --gate release \
  --type release \
  --requested-by release-coordinator \
  --prompt "Approve this exact package release?" \
  --action release \
  --resource-ref "<resource-ref>"

node .agent/skills/management-api/scripts/index.js waitpoints create \
  --waitpoint-id WP-release-<version>-<candidate-digest8> \
  --gate release \
  --owner-workflow /release \
  --reason "Package, version, registry, base commit, candidate digest and tag require user approval" \
  --action release \
  --resource-ref "<resource-ref>" \
  --decision-id D-release-<version>-<candidate-digest8>
```

创建后停止并提示 `/approve decision D-release-<version>-<candidate-digest8>`。Dashboard 请求或 `--gate approve` 字符串不能代替用户解析。

## 第五步：批准后复验并消费 Waitpoint

用户批准后重新运行候选验证并计算摘要。package、version、registry、base commit、candidate digest 或 tag 任一变化都视为漂移：旧 Decision 不得复用，必须使用新摘要或 request suffix 创建新记录。

确认无漂移后，由 `/release` 消费 Waitpoint：

```bash
node .agent/skills/management-api/scripts/index.js waitpoints release \
  --waitpoint-id WP-release-<version>-<candidate-digest8> \
  --gate owner \
  --owner-workflow /release \
  --decision-id D-release-<version>-<candidate-digest8> \
  --released-by release-coordinator \
  --release-note "Approved Decision matches package, version, registry, base commit, candidate digest and tag"
```

## 第六步：提交候选

提交必须转入 `/commit` 并取得该工作流要求的用户确认。不得直接使用固定提交信息绕过 `/commit`。

提交后验证 release commit 的树能够重建出相同 `candidate_digest`。不一致时停止，不得 tag 或继续使用旧批准。

## 第七步：创建本地 Tag

只有仓库策略允许本地 tag，且 tag 名、release commit 和候选摘要均与批准资源一致时才创建。tag 已存在或指向其他 commit 时立即阻塞，不覆盖、不移动 tag。

## 第八步：分别审批 Push 与 Publish

候选批准不自动授权 push 或 publish：

- **Push**：创建 `action=external_side_effect` 的独立 Decision/Waitpoint，资源包含 remote URL、branch、tag、release commit 和 push mode。使用 `D-release-push-<resource-digest8>` 与对应 `WP-` ID。批准并由 `/release` 消费后，只执行该精确 push。
- **Publish**：重新从 release commit 构建并验证相同候选，创建 `action=release` 的独立 Decision/Waitpoint，资源包含 package、version、registry、release commit 和 candidate digest。使用 `D-release-publish-<version>-<resource-digest8>` 与对应 `WP-` ID。批准并由 `/release` 消费后，只发布该精确包。
- **Deploy**：不属于 npm publish 的隐含步骤，必须以 `action=external_side_effect` 单独审批。

如果账号开启 2FA，credential 使用必须建立独立 Decision/Waitpoint，资源绑定到 registry、账号标识和包作用域。OTP 只能由用户在执行时提供，不写入 Decision、日志、命令历史或仓库文件。禁止自动运行会把版本更新、push、tag、publish 或 deploy 串联起来的脚本。

---

## 完成后输出

- 发布成功：提示 `cortex-agent@{版本} ✅ 已发布到 npm`
- 更新 `.agent/plans/task-progress.md` 中对应任务状态

## 统一安全边界

- destructive、credential、external_side_effect 一律创建匹配的 Decision 与 Waitpoint，由 owning workflow 消费后才可继续。
- 不自动 reset、revert、push、deploy、publish 或强推。
- 失败只记录证据与建议回退点；任何 revert/reset 必须另行取得资源绑定批准。
