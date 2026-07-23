---
name: runtime-state-mcp
description: 通过标准、只读的 Management API MCP stdio adapter 暴露一个明确的 Cortex Agent 项目。
---

# Runtime State MCP

## 启动

使用公开 CLI，并且只绑定一个明确项目：

```bash
cortex-agent mcp serve --project /path/to/project
```

使用 `cortex-agent help --json` 获取机器可读 CLI 契约；使用 `cortex-agent help query --json --project <path>` 获取目标项目真实支持的 projection。

## 协议

- 仅支持 stdio JSON-RPC；协议帧写 stdout，诊断写 stderr。
- Resource URI 使用 `cortex://management/<projection>`，列表由真实 Management API capability registry 动态生成。
- `resources/list` 中每个 resource 都能通过 `resources/read` 读取，并与直接 Management API projection 语义一致。
- 唯一 Tool 是只读 `cortex.query`，projection filter 继续由同一 registry 校验。
- `initialize` 阶段协商支持的 protocol version；未知版本 fail closed。

## 边界

- 进程只绑定 `--project` 指定的本地项目；MCP roots 不得改变 scope。
- 禁止直接解析 `.agent` 状态；Management API 是唯一 projection 来源。
- Writer tools 默认并持续禁用。禁止增加 mutation、shell、daemon、dispatch、trigger、credential 或任意路径工具。
- 未知 projection、URI、method、tool、参数、畸形 API 输出和不可用项目都必须 fail closed。
- 内部 server 脚本只作为实现/调试入口，不是 Agent 标准命令。
