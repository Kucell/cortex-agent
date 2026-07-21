---
name: vcs-pr
description: VCS Pull Request 创建 / 状态 / 合并 — 通过 secret://<ref> 间接 token,框架代为取 + 注入 Authorization header;agent 永不接触明文。可插拔 backend:gitea / github / gitlab。
---

# vcs-pr (L1 secrets-vcs)

把"创建 PR"做成 framework 一等公民。Agent 说"用 `secret://gitea-pr` 创建 PR",框架负责 token + HTTP + 写 run event。

## When to Use

- Phase 1 session-triage 开启的 mission 干完一轮验证后 → `vcs-pr create --head feat/foo --base main --title "..."`
- 想看 PR 现在 merged/closed 没 → `vcs-pr status --pr-number 5`
- 显式 user gate 合并 PR → `vcs-pr merge --pr-number 5 --gate user`
- 列已开 PR → `vcs-pr list --state open`

## Commands

```bash
node .agent/skills/vcs-pr/scripts/index.js create \
  --backend gitea \
  --head feat/foo --base main \
  --title "feat: ..." \
  [--body-file .agent/pr-bodies/foo.md | --body-from-run R-session-001] \
  --run-id R-session-001 --gate user

node .agent/skills/vcs-pr/scripts/index.js status \
  --pr-number 5 [--backend gitea] --gate agent

node .agent/skills/vcs-pr/scripts/index.js merge \
  --pr-number 5 [--commit-message "..."] --gate user

node .agent/skills/vcs-pr/scripts/index.js list \
  [--state open|merged|closed|all] --gate agent
```

PR 创建后,vcs-pr 自动:
1. 调 `secrets get --ref <cfg.token_ref> --no-mask --gate user` 取 token(只 vcs-pr 自己拿,**不**透传 agent)
2. 调对应 backend 的 `createPR()` — token 注入 `Authorization` header
3. 写 `runs/<run-id>.json#events[]` 一条 `vcs_pr_opened` event(pr_number / url / head / base)
4. 输出 JSON `{ok: true, action: "create", number, url, ...}`,**不含** token

## Configuration

`.agent/config/vcs.yml`:
```yaml
backend: gitea
host: "http://192.168.2.110:3000"
token_ref: gitea-pr
default:
  org: SamkoonHMI
  repo: SamHMI
  base_branch: main
```

无 `config/vcs.yml` → CLI 报 `vcs_config_missing`,host 需 first-time setup。

## Body 模板

默认 body 模板(vcs-pr `defaultBody` 函数):
```
## 提交范围
- branch: <head> → <base>
- repo: <org>/<repo>
- run: runs/<run-id>.json

## 相关功能
- (填写)

## 验证结果
- (填写)

## 已知事项
- (无)
```

`--body-file` / `--body-from-run` 覆盖。

## Backends

| Backend | 协议 | 文件 |
|---|---|---|
| `gitea` | `Authorization: token <hex>` | `backends/gitea.js` |
| `github` | `Authorization: Bearer <token>` | `backends/github.js` |
| `gitlab` | `PRIVATE-TOKEN: <token>` | `backends/gitlab.js` |

每个 backend 暴露相同 interface:
```js
{ async createPR(opts), async getStatus(opts), async merge(opts), async list(opts) }
```

纯 stdlib,用 Node 内置 `https` / `http` 模块。新加 backend(自建 Git 平台)写一个 `.js` 注册到 `BACKENDS`。

## Guarantees

- **零依赖**:纯 stdlib + 3 backend 各 ~80 行
- **不接触 token**:orchestrator 拿 token 后只进 HTTP header,stdout 不输出值(redact.js 二道防护)
- **写 gate**:`merge` 必须 `--gate user`;`create / status / list` 任意 gate
- **可审计**:每条 PR 事件写 `runs/<id>.json#events[]`(Phase 1 基础设施复用)
- **可分发**:L1 双语 template;init/upgrade 自动落用户项目

## Non-Goals

- ❌ 不读 token 给 agent
- ❌ 不主动创建 PR(必须 host 显式调用)
- ❌ 不做 auto-merge 默认 — merge 必须 user gate
- ❌ 不做 review / assign / label(留 v1.1)
- ❌ 不替代项目级 `.agent/workflows/pull-request.md` 工作流(workflow orchestration 在该层,本 skill 是底层)

## Relation

- `secrets` — 取 token(orchestrator 内部,agent 不直接调)
- `management-api runs event` — 通过 `appendRunEvent()` 复用 events 流
- `audit-trail Phase 1` — Run id 通过 `discoverActiveRunId()` 关联
- project `.agent/workflows/pull-request.md` — host 层 orchestration(vcs-pr 是底层)
