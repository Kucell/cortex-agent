---
title: "知识治理规则 (Knowledge Governance)"
description: "对标 OKF V0.2 可信度机制,定义 cortex-agent 项目级知识层(references / workflows / rules)的生命周期、废弃流程、校验规则、与 decisions 链接以及知识图谱入口。"
type: rule
scope: L1
applicable_to:
  - all
linked_workflows:
  - update-refs
  - scan-project
  - knowledge-lint
  - commit
linked_skills:
  - validate-frontmatter
  - build-references-index
  - knowledge-lint
owner: Kucell
last_verified: 2026-08-06
status: stable
---

# 知识治理规则 (Knowledge Governance)

> **核心原则**:cortex-agent 的 `.agent/references/`、`.agent/workflows/`、`.agent/rules/` 是项目级知识层,对标 Google Cloud 2026-06 发布的 OKF (Open Knowledge Format) V0.2 "陈述性知识的可信度"机制。知识必须有生命周期、可以被验证、可以被废弃、可以追溯到决策。
>
> **背景**:本规则配套 OKF 提案 `.agent/plans/proposals/okf-knowledge-layer/cortex-agent-okf-knowledge-layer-proposal.md` 和 mission M-018。所有 4 个状态机 / 治理机制源自该提案 §3.3 和 §6 决策记录。

## 1. Knowledge Lifecycle (知识生命周期)

每条 reference 经历 4 个状态:

| 状态 | 含义 | 校验 | Agent 消费 |
|---|---|---|---|
| `draft` | 新建/重写中,内容未通过校验 | 缺失字段多 | ⚠️ 不应直接采信 |
| `stable` | 通过校验,内容准确可信 | 必填字段全 | ✅ 可直接采信 |
| `deprecated` | 已过期/不再维护,但保留供历史回溯 | 必填 `deprecation_reason` | ⚠️ 标黄,从 INDEX.md 主列表移到 Archived 分区 |
| (物理删除) | **永不物理删除** | — | 走 git history |

**frontmatter 必填字段**(OKF V0.2 模板,references 类):

- `module` / `module_path` / `module_type` / `keywords` (现有)
- `status` (新增,必填,枚举: `stable` / `draft` / `deprecated`)
- `owner` (新增,知识责任人,**必须 = 主仓 git author 的实名**,禁止填写 `Codex` / `Mavis` 等通用 agent 身份;见 `validate-frontmatter.js` 的 `FORBIDDEN_OWNERS`)
- `last_verified` (新增,最后一次人工/自动校验时间)
- `sources` (新增,至少一条 URL / ADR 引用 / 内部 cross-reference)
- `linked_decisions` (新增,关联 ADR 列表,允许空但 knowledge-lint 警告)

workflows / rules 类见 `validate-frontmatter.js` 的 SCHEMAS 定义。

## 2. 何时必须 update references

**触发条件** (任一满足即触发):

- **模块代码发生结构性变化**:新增/删除/重构文件,触发对应 reference 的 `last_updated` + `last_verified`
- **任何 ADR 在 `.agent/decisions/` 落地** (`status: approved`):必须更新所有 `linked_decisions` 包含该 ADR 的 references 的 `last_verified`
- **任何 proposal 落地**:必须 review 对应 references 的 `status` 和 `linked_decisions`
- **定期 stale check**: 每季度末 (3/6/9/12 月) 跑一次 `/update-refs` 全量扫描

**推荐流程**:

```bash
# 1. 跑 /update-refs 看 stale report
node .agent/workflows/update-refs.md  # 实际由 agent 执行

# 2. 检查 frontmatter 是否需要更新
node .agent/scripts/validate-frontmatter.js

# 3. 提交前 hook 自动跑 (post-F-011)
bash .agent/hooks/pre-commit-check.sh
```

## 3. 如何标 deprecated

**触发条件**:

- 模块已删除
- API 已废弃
- ADR 推翻 (新 ADR 显式 supersede)
- 规则已改,旧内容不再适用

**操作流程**:

1. 修改 `status: stable` → `status: deprecated`
2. **必填** `deprecation_reason: "<具体原因 + 指向新方案>"` (e.g. "replaced by D-FAE-005", "module removed in commit a7d8bf3")
3. 建议: `linked_decisions: [superseding-ADR-id]`
4. 提交时,`/propose-deprecation` workflow (轻量) 走一次 approval (见下方 gate)
5. **不删文件** — 走 git history,`status: deprecated` 标记已足够

**Gate** (轻量 approval):

- 提议者: `owner` 字段对应的人,或显式指定
- 审批: `.agent/decisions/D-deprecate-<reference-path>-<digest8>.json` 一次轻量 approval
- 模板: `{"type": "deprecation", "status": "approved", "rationale": "<reason>"}`
- 触发: `/propose-deprecation <reference-path>` workflow

**效果**:

- `knowledge-lint` 把 deprecated reference 标黄 (但非 fail)
- `build-references-index.js` 把 deprecated 从主列表移到 Archived 分区
- Agent 消费时显示 "⚠️ DEPRECATED" 警告 + 指向新方案

## 4. 如何 verify

**谁可以 verify**:

- `owner` 字段对应的人(默认 = git author,允许显式覆盖)
- `verified_by` 字段显式指定的人
- 自动化: `knowledge-lint` / `validate-frontmatter` 跑过即可(无人工)

**验证什么**:

1. **内容准确**: reference 描述的模块/API 仍然存在且行为一致
2. **linked_decisions 仍 approved**: 关联的 ADR 仍是 `status: approved` (未被 supersede)
3. **sources 链接可访问**: 所有 URL 仍可访问(无 404/timeout)
4. **frontmatter 合规**: 必填字段全,`status` 合法枚举

**何时更新 `last_verified`**:

| 场景 | 更新字段 |
|---|---|
| 任何实质内容修改 | `last_updated` + `last_verified` + `verified_by` |
| 仅 format 修改 | `last_updated` |
| quarterly stale check 通过 | `last_verified` + `verified_by = knowledge-lint` |
| 关联 ADR 状态变化 | `last_verified` + 重新跑 `validate-frontmatter.js` |

## 5. 与 decisions / proposals 的链接

**ADR 落地时** (`.agent/decisions/D-*.json`):

- 必填 `relations.references_affected: [ref-path-1, ref-path-2]`
- 必填 `relations.workflows_affected: [wf-path-1]`
- 必填 `relations.rules_affected: [rule-path-1]`

**proposal 落地时** (`.agent/plans/proposals/<topic>/<name>-proposal.md`):

- 必填 `execution_carrier` 包含「影响的 references 列表」
- 必填 `supersedes_section` (如适用)

**`/update-refs` 自动检测**:

- 任意 ADR 落地后 7 天内,如果 references 的 `last_verified` 未更新,自动报 stale
- stale report 输出到 `.agent/metrics/knowledge-stale-report.json`

## 6. 知识图谱 (Knowledge Graph)

**入口**: `.agent/references/INDEX.md`

**自动生成**: `node .agent/scripts/build-references-index.js` (MS-003 F-008)

**包含内容**:

1. **总览**: 总数 + status 分布表 (stable / draft / deprecated)
2. **Stable References 主列表**: 按模块名排序,每条带 module / module_path / summary / last_verified
3. **Draft References**: 单独章节
4. **Archived References**: 单独章节 (status=deprecated,带 deprecation_reason 提示)
5. **Mermaid 关系图**: 基于 `linked_decisions` 字段,展示 reference ↔ ADR 关系
6. **Generated At**: 自动生成时间戳 (告诉 reader 这是 derived,不要手改)

**Agent 消费**:

- `/start-task` / `/briefing` 必读 `references/INDEX.md` 作为知识入口
- 不读全文(避免 context bloat),按需跳转具体 reference

## 7. 与现有规则的关系

| 现有规则 | 关系 |
|---|---|
| `agent-scope.md` (L1/L2/L3 归属) | 本规则 scope: L1(框架级),所有项目受益。references / workflows / rules 都按 L1 模板下发。 |
| `proposal-structure.md` (提案规范) | 提案落地时必须按 §5 引用本规则,确保知识治理联动 |
| `commit-standards.md` (commit 规范) | 提交 reference / workflow / rule 修改时,按 pre-commit hook case 7 自动跑 validate-frontmatter |
| `architecture-design.md` (零依赖) | 本规则引入的 `build-references-index.js` 必须零依赖(同零依赖原则) |
| `code-standards.md` (代码规范) | 脚本代码遵循 code-standards.md |

## 8. 工具栈 (Tooling)

| 工具 | 路径 | 用途 |
|---|---|---|
| `migrate-references-frontmatter.js` | `.agent/scripts/` | 一次性迁移脚本(MS-001 F-001),支持 --dry-run / --apply |
| `migrate-frontmatter.js` | `.agent/scripts/` | 通用 workflows + rules 升级脚本(MS-002 F-005/F-006) |
| `validate-frontmatter.js` | `.agent/scripts/` | 阻塞校验脚本(MS-002 F-004),支持 --file / --type / --json |
| `build-references-index.js` | `.agent/scripts/` | INDEX.md 自动生成器(MS-003 F-008) |
| `knowledge-lint` | `.agent/skills/knowledge-lint/` | 健康检查 + R-LINT-007/008 |
| `pre-commit-check.sh` | `.agent/hooks/` | 改 .agent/*.md 时自动跑 validate-frontmatter (MS-002 FU-011) |

## 9. 违反处理 (Enforcement)

- **Pre-commit hook**: 改 `.agent/{references,workflows,rules}/*.md` 时,validate-frontmatter exit 1 阻断 commit
- **knowledge-lint**: R-LINT-007 (linked_decisions 空, warning) / R-LINT-008 (status 非法值, warning)
- **validate-frontmatter (CI 模式)**: 必填字段缺失 exit 1
- **`/update-refs` stale check**: 季度跑一次,输出 stale report,人工 follow-up

**非阻塞 warning 不阻断 commit**(鼓励 review 而非强制)  
**阻塞 violation 阻断 commit**(保护知识层底线)
