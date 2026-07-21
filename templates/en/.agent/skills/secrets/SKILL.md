---
name: secrets
description: 凭据存储抽象 — 用 `secret://<ref>` 语义引用代替明文 token;支持 macOS Keychain、Linux Secret Service、gpg-encrypted file、env 4 个可插拔后端;agent 永不接触明文值,由框架代为取 + 注入。
---

# secrets (L1 secrets-vcs)

把项目里所有 "API token / 私钥 / 密码" 用一个**间接引用**表达,而不是直接出现明文。Agent 与 host 永远只说:

```
请用 secret://gitea-pr 这个引用去创建 PR。
```

具体值从哪来、怎么存,框架负责。`secrets` skill 是这个抽象层的入口。

## When to Use

- 启动新项目时存第一个 token → `secrets store --ref gitea-pr --value "$TOKEN" --gate user`
- 调 VCS / 内部 API / Anthropic / 任何"必须 header"调用 → 用 `secret://<ref>` 让框架注入
- 换 token → `secrets rotate --ref gitea-pr --gate user`,旧值自动清
- 审计"项目有哪些凭证"→ `secrets list --gate agent`(列出 ref + 后端 + 长度,**不**显值)
- log 误进 token → 任何 secret 调用的 stdout 已经过 redact.js 过滤

## Commands

```bash
node .agent/skills/secrets/scripts/index.js get     --ref gitea-pr [--gate user]
node .agent/skills/secrets/scripts/index.js store   --ref gitea-pr --value "$TOKEN" --gate user
node .agent/skills/secrets/scripts/index.js rotate  --ref gitea-pr --gate user --reason "expired"
node .agent/skills/secrets/scripts/index.js delete  --ref gitea-pr --gate user
node .agent/skills/secrets/scripts/index.js list    --gate agent
node .agent/skills/secrets/scripts/index.js audit   --gate agent
```

`get` 默认 `--mask`(只输出 `**********(len=N)` + `secret://<ref>`)。要看值必须 `--no-mask --gate user`,且调用方应**避免**把值打印到对话(框架已用 redact.js 过滤 stdout/stderr,但只防 backend 误打,**不**防业务日志手抄)。

## Backends

| Backend | 平台 | 协议 |
|---|---|---|
| `keychain`(默认) | macOS | `security(1)` |
| `secret-service` | Linux | `secret-tool(1)` |
| `file-gpg` | 跨平台 | gpg-agent 对称加密,AES-256 |
| `env` | CI / 便携 | `process.env[CORTEX_SECRET_*]`,只读 |

每个 backend 是独立 `.sh` 脚本(在 `scripts/backends/`),按 `action` JSON 协议接受输入。新加 backend 写一个 `.sh` + 在 `BACKENDS` set 注册即可。

## Configuration

`.agent/config/secrets.yml` 示例:
```yaml
backend: keychain           # default
namespace: SamHMI
secrets:
  - ref: gitea-pr
    service: gitea-192.168.2.110-codex-samhmi-pr
    account: xueyq
  - ref: github-copilot
    service: github-copilot-xueyq
```

无 `config/secrets.yml` → `secrets list` 提示 host 先 first-time setup。

## Guarantees

- **零依赖**:纯 stdlib + 后端 shell 脚本,**不**绑 npm。
- **可审计**:每条调用经 vcs-pr / 直接 `secrets get` 都写 `runs.events[]`(由其他 skill 集成)。
- **可降级**:本机无 keychain / secret-service → 自动 fallback `file-gpg`(只要 `gpg` 在 PATH);CI 用 `env` 兜底。
- **不泄 stdout**:所有 backend 输出经 `redact.js` 过滤再到达调用方。

## Non-Goals

- ❌ 不直接打印 token 给 agent
- ❌ 不做远端凭证同步
- ❌ 不主动轮换(rotation 是用户动作)
- ❌ 不绑 VCS(host 应跑 `vcs-pr` skill,**不**让 secrets 知道 VCS 长什么样)

## Relation

- `vcs-pr` — 创建 PR 时用它取 token 注入 `Authorization: token ${secret://<ref>}`,**不**让 PR 输出包含 token
- `management-api runs event` — events 框架,future 扩展以写 token 访问审计
- `redact.js` — 同 skill,负责 stdout 防泄漏
