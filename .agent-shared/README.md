# Cortex Agent 团队包

本目录是可提交的团队交付物；安装或更新时，`team-pack.json` 中声明的文件会合并到本地 `.agent/`。

- 团队目标、共同约束和可复用背景写入 `references/`。
- 具体 Mission、里程碑、交接、收据和运行态保留在各成员本地 `.agent/`，不进入团队包。
- 修改已声明文件后，必须同步更新其 SHA-256 和包版本；提交后再由维护者推送或发起 MR。

可用 `cortex-agent team verify --project . --json` 校验包；首次安装或更新由使用者显式执行 `cortex-agent team install` 或 `cortex-agent team update`。
