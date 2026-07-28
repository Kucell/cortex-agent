# Team Agent Pack(用户文档)

> **Status**: 已批准,MS-001～MS-004 完成
> **Scope**: L1 Provider + L2 Team Pack + L3 Local 三层模型
> **关联提案**: `.agent/plans/proposals/projects/team-agent-pack/`

Team Pack 是 Cortex Agent 的 L2 能力:让团队实践(规则、工作流、技能、项目知识)可评审、可安装、可升级,而不泄露 `.agent/` 的运行态、个人覆盖或凭证。本文档是用户层速查,完整规范见 P-001 / P-002 / D-001。

## 1. 三层模型

| 层 | Owner | 位置 | 是否提交 | 用途 |
| :--- | :--- | :--- | :--- | :--- |
| L1 Provider | Cortex Agent | npm templates | 是 | 通用规则、工作流、技能 |
| **L2 Team Pack** | 项目团队 | `.agent-shared/` | 是 | 项目级公共规则、工作流、知识 |
| L3 Local | 单个开发者 | `.agent/` | 否 | 安装后的有效工作区与个人覆盖 |
| Runtime | Cortex Agent runtime | `.agent/runs/` 等 | 否 | 状态、指标、锁、会话 |

`.agent/` 仍是 Agent 运行时唯一读取入口;`.agent-shared/` 是可分发输入,不成为第二套事实来源。安装或更新后,内容必须合并进 `.agent/` 并记录 receipt。

## 2. 目录契约

```text
.agent-shared/
├── team-pack.json          # manifest(schema_version=1)
├── README.md
├── rules/                  # 允许
├── workflows/              # 允许
├── skills/                 # 允许
├── references/             # 允许
└── schemas/                # 允许
```

**禁止**携带:`hooks/`、`runs/`、`sessions/`、`metrics/`、`locks/`、`artifacts/`、`screenshots/`、`.env`、Token、私钥、本机绝对路径。

**显式排除**宿主入口文件:`.claude/settings.json`、`AGENTS.md`、`CLAUDE.md`、`GEMINI.md`。

## 3. CLI 速查

| 命令 | 默认行为 |
| :--- | :--- |
| `cortex-agent team init [--name <name>] [--team]` | 创建 `.agent-shared/` skeleton;`--team` 强制 install,非交互默认不 install |
| `cortex-agent team status [--json]` | 对比 pack / receipt / `.agent/`,报告 ahead / behind / conflict |
| `cortex-agent team install [--dry-run] [--report text\|json]` | 首次安装;cold-start base 固定为空 |
| `cortex-agent team update [--dry-run] [--report text\|json]` | 基于 receipt baseline 执行三方合并 |
| `cortex-agent team publish --paths <path...> [--dry-run]` | 显式发布到 `.agent-shared/`,重建 manifest；dry-run 保证零写入 |
| `cortex-agent team verify [--strict] [--json]` | CI 友好的只读检查 |

所有命令支持 `--project <path>` 跨项目。

## 4. 与现有命令的集成

| 命令 | Team Pack 行为 |
| :--- | :--- |
| `cortex-agent init` | L1 初始化后探测 `.agent-shared/`;非交互默认不 install,除非 `--team` |
| `cortex-agent update` | L1 apply 成功后,只有 `--team` 才进入 Team Pack apply;两层报告独立 namespace |
| `cortex-agent update --team` | 串联 L1 apply → Team Pack apply |
| `cortex-agent upgrade --team` | **直接报错退出**(exit=3),`upgrade` 是 additive-only,不接触 Team Pack |
| `cortex-agent doctor --fix` | 只允许创建 receipt 骨架,绝不触碰 `.agent-shared/` |

## 5. manifest 字段

```json
{
  "schema_version": 1,
  "name": "<pack-name>",
  "version": "<semver>",
  "requires": { "cortex_agent": ">=1.6.0" },
  "signers": {
    "mode": "git_committers",
    "allowed_committers": ["alice@example.com"],
    "fallback": "reject"
  },
  "includes": ["rules/**/*.md", "workflows/**/*.md", "skills/**", "references/**/*.md", "schemas/**/*.json"],
  "excludes": ["**/.DS_Store", "**/*.local.*", "**/*secret*", "**/*token*", "**/.claude/settings.json", "**/AGENTS.md", "**/CLAUDE.md", "**/GEMINI.md"],
  "files": [
    { "path": "rules/foo.md", "sha256": "<hex>", "mode": "add" }
  ]
}
```

约束:

- `schema_version` 当前固定为 1;`version` 使用 SemVer。
- `files[].mode` 首版只允许 `add` 或 `merge`,禁止无条件 `replace`。
- `signers.mode = "disabled"` 仅在 fork / 私有项目显式接受风险时使用;首版 CI 一律 `git_committers` + `fallback=reject`。

## 6. 三方合并

| Base → Local | Base → Incoming | 动作 |
| :--- | :--- | :--- |
| 未变 | 未变 | unchanged |
| 未变 | 已变 | apply(更新为 incoming) |
| 已变 | 未变 | unchanged(保留 local) |
| 已变 | 已变且相同 | apply |
| 已变 | 已变且不同 | **conflict**(保留 local + 写 conflict artifact) |
| 文件不存在 | 新增 | add |

冲突文件不会把 baseline 推进到 incoming；原 baseline 会保留供下一次三方比较。
冲突详情写入 `.agent/team-sync/conflicts/<timestamp>-<n>-conflict.json`。

## 7. 安全不变量

- 所有写入限制在项目根目录内;
- 默认拒绝符号链接和 hard-link 异常目标;
- 写入使用同目录临时文件 + 原子 rename;
- `install/update` 在替换已有文件前写入 `.agent/team-sync/backups/`,任一写入失败时回滚本次事务;
- 检测到私钥头、Token 前缀、URL 用户信息、`.env` 全文、本机绝对路径时 fail closed;
- 扫描日志只报告规则与位置,不回显 secret value;
- `.agent-shared/` 中的脚本不是授权;执行外部副作用仍遵循 Decision / Waitpoint;
- `verify` 可在 CI 只读运行;`publish` 必须由用户或受保护的维护流程显式触发;
- signer 校验绑定最后修改 `.agent-shared/team-pack.json` 的提交者,不使用仓库无关的最新提交。

## 8. v1.7.0 已知缺陷修复

v1.7.0 的 `team publish --dry-run` 曾复用 apply 写入函数，导致目标规则提前
落入 `.agent-shared/` 而 manifest 未更新。修复后 publish 先执行纯校验，
dry-run 在校验后直接返回；CLI 回归测试会比较命令前后的完整项目树摘要。

## 9. 实战回流(SamHMI 边界)

允许回流到 Cortex Agent L1:

- 团队共享 `.agent` 分层模型;
- PR、CI、监控等可跨项目复用的工作流结构;
- allowlist、receipt、冲突与验证经验。

禁止回流:

- 业务语义、产品专属配置;
- Windows 主机、GitLab 地址、Runner 标签等环境值;
- API Token、MCP 凭证、SSH / GPG 信息;
- 构建制成品、运行日志和个人路径。

回流路径:在 Cortex Agent 主仓库 `/agent-update` 工作流,而不是直接在 SamHMI Team Pack 内。

## 10. 相关资产

- 提案:`.agent/plans/proposals/projects/team-agent-pack/proposals/P-001-team-pack-contract-proposal.md`
- CLI 生命周期:`.agent/plans/proposals/projects/team-agent-pack/proposals/P-002-team-pack-cli-lifecycle-proposal.md`
- 决策:`.agent/plans/proposals/projects/team-agent-pack/decisions/D-001-private-agent-and-team-pack-boundary.md`
- Mission:`.agent/missions/M-TAP/`
- 评估:`.agent/plans/proposals/projects/team-agent-pack/decisions/REVIEW-L1-team-agent-pack-evaluation.md`
- 共享 secret-scan:`lib/secret-scan.js`
- 共享 manifest 模块:`lib/team-pack.js`
- 命令机器契约:`lib/cli-contract.js` 的 `team` section
