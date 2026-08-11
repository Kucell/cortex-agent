# global-shared-skills/

Cortex Agent 框架收录的**第三方 vendor skills** 模板目录。
每个项目 init 时,这些模板会被复制到项目 `~/.agent/global-shared-skills/`(由 `sync-global` skill 同步到项目 `.agent/skills/`)。

## 跟其他 skill 来源的关系

| 来源 | 路径 | 作用 |
|------|------|------|
| **框架自研 skill** (145+ files) | `templates/_shared/.agent/skills/` | 框架基础设施(activity-recording/agent-dashboard 等) |
| **L1 framework rule** | `.agent/rules/` (state repo) | 框架级行为规则,所有项目必须遵守(如 `llm-coding-behavior.md`) |
| **Vendor skill** (本目录) | `templates/_shared/.agent/global-shared-skills/<name>/` | 第三方精选 skills,MIT/Apache 友好 license |
| **Project-level skill** | `<project>/.agents/skills/` | 项目自己定制的 skill(不进入框架) |

**判断标准**:
- 跟 **framework 行为/治理** 强相关 → `.agent/rules/`(L1 rule)
- 跟 **framework 基础设施** 强相关(状态/事件/任务/Dashboard)→ `templates/_shared/.agent/skills/`(自研)
- 是**外部成熟方案**,MIT license,跨项目受益 → `templates/_shared/.agent/global-shared-skills/`(本目录)

## 当前收录

| Name | Source | Category | License | Status |
|------|--------|----------|---------|--------|
| `karpathy-guidelines` | multica-ai/andrej-karpathy-skills | llm-behavior | MIT | ✅ Layer 1.1 (2026-08-11) |

后续 Layer 1.3+ 待收:`superpowers`, `caveman`, `addyosmani/agent-skills`, `affaan-m/ECC` (子集)。

## 添加新 vendor skill

1. **拉上游代码**(只复制 SKILL.md + 必要 assets,**不复制** scripts/ 之外的运行时文件):
   ```bash
   mkdir -p templates/_shared/.agent/global-shared-skills/<name>
   # 复制 SKILL.md(必要时带 references/ 或 assets/)
   ```
2. **写 `vendor.json`**(参考 `_schema/vendor.schema.json`):
   ```bash
   cp templates/_shared/.agent/global-shared-skills/karpathy-guidelines/vendor.json \
      templates/_shared/.agent/global-shared-skills/<new-skill>/vendor.json
   # 改 name/display_name/source.repo/source.ref/version
   ```
3. **跑 validator**:
   ```bash
   node templates/_shared/.agent/global-shared-skills/_schema/validate.js
   ```
4. **写 license 文件**(如果上游仓库没带 LICENSE):
   ```bash
   # 把 upstream LICENSE 拷过来
   ```
5. **commit 到主仓**(1 commit 1 skill):
   ```bash
   git add templates/_shared/.agent/global-shared-skills/<name>
   git commit -m "feat(vendor): add <name> from <upstream-repo>@<ref>"
   ```

## Validator

```bash
node templates/_shared/.agent/global-shared-skills/_schema/validate.js
node templates/_shared/.agent/global-shared-skills/_schema/validate.js <explicit-root>
node templates/_shared/.agent/global-shared-skills/_schema/validate.js --resolve <sha40> <root>
```

零依赖,纯 node 内置模块。CI 应该在 `templates/_shared/.agent/global-shared-skills/` 改动时跑。

## 同步链(用户视角)

```
cortex-agent 框架 templates/  ────(项目 init)────>  ~/.agent/global-shared-skills/
                                                              │
                                                              │ sync-global/sync.sh
                                                              ▼
                                                      <project>/.agent/skills/
```

- 状态仓 `.agent/global-shared-skills` symlink → `~/.agent/global-shared-skills/`(用户机器全局)
- `sync-global` skill 把全局 skills 软链接到项目 `.agent/skills/`
- 同一个 vendor skill 多项目共享,只升级一份

## 同步上游

每个季度 review 一次:
- 看 upstream 是否有 breaking change
- 更新 `vendor.json` 的 `source.ref` 和 `version`(锁定 SHA)
- 重跑 validator
- 1 commit 1 vendor(避免污染)
