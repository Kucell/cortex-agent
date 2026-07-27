---
name: secrets-usage
description: 凭证使用规范 — 强制走 secret://<ref> 抽象,禁止手调 keychain / secret-tool / env 注入。
---

# Secrets Usage

> **目的**:让 agent 与 host 永远只说 `secret://<ref>`,框架代为取 + 注入明文值。

## 强制规则

1. **永远使用 `secret://<namespace>/<ref>` 引用**,不写明文 token / API key / 密码。
2. **不要手调** `security(1)`、`secret-tool(1)`、`keychain_k2_load.sh`、`keychain_k2_store.sh`、`mkset`、`mkuse`、`model-key get` 等任何直接读 Keychain / Secret Service / 文件的脚本。
3. **不要把明文写到** `.env`、`config/local.yml`、`scripts/*.sh`、`README.md` 或任何 git 可追踪文件;`.env` 与 `.env.local` 已在 `.gitignore` 中。
4. **不要 echo 凭据**;`secrets get --no-mask --gate user` 调用方应**避免**把明文打印到对话或日志。
5. **新增凭证**:在 `.agent/config/secrets.yml` 增加 ref + service + account 字段,然后用 `secrets store --ref <ref> --value "$TOKEN" --gate user`。
6. **轮换凭证**:`secrets rotate --ref <ref> --gate user --reason "expired"`;旧值自动清,新值由 `store` 覆盖。
7. **审计**:`secrets list --gate agent`(只显示 ref + backend + 长度,绝**不**显值);`secrets audit --gate agent`。

## 与外部 CLI 工具的关系

项目可能已有私有的 keychain 工具(如 `model-keychain-cli`、`keychain_k2_load.sh`)。这些工具是**写值**的辅助:

- 第一次注入值用 `model-key set --provider <provider> --name API_KEY --value-env <PROVIDER>_API_KEY`(安全 prompt,无回显,跨平台);
- 之后 agent **不再调用**这些工具,而是走 `secret://<provider>-api-key`(如 `secret://k2-api-key`、`secret://claude-api-key`、`secret://openai-api-key`)让框架从 keychain 取值。

**禁止**在 workflow / skill / hook 脚本里 `source keychain_k2_load.sh` 然后 export 到环境变量。这会让值进入 agent 上下文,违反"agent 永不接触明文"原则。

## Backend 选择

`.agent/config/secrets.yml` 的 `backend` 字段决定实际存储位置:

| backend | 平台 | 适用 |
| :--- | :--- | :--- |
| `keychain` | macOS | 个人开发机默认 |
| `secret-service` | Linux(gnome-keyring 等) | Linux 开发机 |
| `file-gpg` | 跨平台 | 无 keychain / secret-service 时 fallback |
| `env` | CI / 容器 | 只读,值由 `CORTEX_SECRET_<REF_UPPER_SNAKE_CASE>` 注入 |

切换 backend 不影响 `secret://<ref>` 的使用层;只是底层存储迁移。

## 关联

- `secrets` skill(SKILL.md, scripts/index.js, scripts/backends/*)
- `.agent/config/secrets.yml`(项目实例)
- `redact.js`(stdout/stderr 过滤)
- `vcs-pr` skill(创建 PR 时用 `secret://<ref>` 注入 Authorization header,绝不打印)
- `runtime-continuity` skill(归档不携带 hook secrets,re-attach 时用 `secret://<ref>` 重建)

## 违规示例(反模式)

```bash
# ❌ 反模式 1:直接 source keychain_k2_load.sh
source scripts/keychain_k2_load.sh
echo "Using K2 key: $K2_API_KEY"   # 值进了 stdout

# ❌ 反模式 2:明文写到 .env
# echo K2_API_KEY=... > .env.local
# 框架的 secret-scan.js 会立刻 fail-closed 阻断

# ❌ 反模式 3:CI 环境硬编码
# export K2_API_KEY=...    # 进入 process memory 与日志
claude-cli run            # 触发 secret-scan 告警

# ✅ 正模式:用 ref 引用
node .agent/skills/secrets/scripts/index.js get --ref k2-api-key --gate user --no-mask
# 把值传给下游 CLI 而不写入 agent 对话
```

## Non-Goals

- ❌ 不做远端凭证同步(团队内手动分发 service/account)
- ❌ 不自动轮换(rotation 是用户动作)
- ❌ 不在 agent 上下文直接显示明文