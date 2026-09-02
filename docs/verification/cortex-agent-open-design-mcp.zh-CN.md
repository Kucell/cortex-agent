# cortex-agent × open-design MCP 连接验证报告

> 验证日期：2026-09-01
> 宿主 agent：Claude Code 2.0.28 / Pi 0.82.1
> open-design：Docker 容器（ghcr.io/nexu-io/od:latest），daemon 0.21.1，127.0.0.1:7456，OD_API_TOKEN 已启用

## TL;DR

| 环节 | 状态 | 说明 |
| --- | --- | --- |
| MCP server 注册到 claude | 通过 | claude mcp add-json --scope user open-design 成功 |
| MCP 握手 + tools/list | 通过 | claude mcp list 显示 open-design Connected，21 个工具就位 |
| MCP tools/call 穿透到 daemon | 失败 401 | daemon 开了 token 鉴权，MCP 调用没带凭证 |
| 设计系统流程（读 DESIGN.md 等） | 受阻 | 因 401 无法读取任何项目/设计系统数据 |

结论：MCP 传输层（stdio 握手、工具发现）完全正常；但应用层调用被 daemon 的 token 鉴权挡住。这是 Docker 部署形态与 open-design MCP 鉴权假设不匹配所致，可修复。

## 已修复：用户原始命令的两处错误

用户最初给的注册命令里：
1. args 指向 /app/apps/daemon/dist/cli.js —— 这是容器内路径，宿主机不存在（claude 一启动就 ENOENT）。宿主机真实路径是 /Users/xueyq/myworks/open-design/apps/daemon/dist/cli.js。
2. env.OD_DATA_DIR=/app/.od —— 也是容器路径，且 MCP server 不直接读数据目录（它经 HTTP 连 daemon），该 env 无意义。
3. /usr/local/bin/node 是 v22；open-design daemon 的 better-sqlite3 需要 Node 24（NODE_MODULE_VERSION 137），应使用 Node 24。

该配置实为 daemon /api/mcp/install-info 的返回值——但 daemon 跑在容器里，报告的是容器视角（platform linux、/app/...），只对容器内的 MCP 客户端有效，不适用于宿主机 claude。

修正后（已应用并验证 Connected）：
  command = /Users/xueyq/.volta/tools/image/node/24.11.0/bin/node
  args    = [<host>/apps/daemon/dist/cli.js, mcp, --daemon-url, http://127.0.0.1:7456]

## 核心根因：MCP 鉴权与 Docker 部署形态不匹配

### MCP server 如何调 daemon
apps/daemon/src/mcp.ts 中，所有工具最终 getJson(baseUrl + /api/..., headers)，其中 headers 只含 x-od-workspace-id / x-od-workspace-member-id（来自 resolveMcpWorkspaceContext，经 headerless GET /api/workspace/directory 解析）。从不注入 Authorization / token 头（getJson 定义见 mcp.ts:3049）。

### daemon 的鉴权设计（apps/daemon/src/server.ts:2940）
开了 OD_API_TOKEN 后，/api/* 中间件对非白名单路径要求鉴权，但有一条 loopback 短路：
  if (isLoopbackPeerAddress(req.socket?.remoteAddress)) return next();  // 本机桌面 UI 免鉴权
  if (apiTokenAuthorizationMatches(req.get('authorization'), apiToken)) return next();
  return res.status(401).json({ error: { code: 'API_TOKEN_REQUIRED' } });
即：open-design 假设 MCP 配对的是宿主机本地 daemon——MCP 从 127.0.0.1 直连，peer 是 loopback → 免鉴权 → 通。这是本机 Electron/desktop 场景的正确设计。

### 为什么我们这里 401
我们的 daemon 跑在 Docker 容器。宿主机 MCP 经 127.0.0.1:7456（Docker 端口映射）连入，daemon 看到的 peer 是 Docker 网桥 IP（非 loopback）→ 不触发短路 → 要 token → MCP 没带 → 401。

实测证据：
  GET /api/projects             无Authorization → 401
  GET /api/workspace/directory  无Authorization → 401
  GET /api/workspace/directory  + Bearer token  → 200
  容器内 127.0.0.1 直连(loopback)             → 200(免鉴权)

### 为什么握手却成功
initialize / tools/list 是 MCP 层的本地应答（工具 schema 是静态的），不穿透到 daemon 鉴权；只有 tools/call / resources/read 才真正调 daemon /api/...。所以 claude mcp list 显示 Connected（握手 OK），但一调工具就 401。

## 修复路径（择一）

1. 让 MCP 给 daemon 调用带上 token（最贴合现状，推荐）。需 open-design 支持：MCP server 读取某 env（如 OD_DAEMON_TOKEN）并在 getJson/postJson 注入 Authorization: Bearer <token>。当前 mcp.ts 无此逻辑，属 open-design 侧功能缺口。
2. daemon 跑在宿主机（非 Docker）。MCP 127.0.0.1 直连 → peer=loopback → 免鉴权 → 即通。但这放弃了本次 Docker 部署。
3. daemon 对来自 Docker 网桥的 MCP 调用做受控豁免。风险较高，不推荐（会放宽整个 /api 的攻击面）。

注：这与上一轮 AI 网关打通是两个独立问题。网关打通解决的是 open-design 使用自己的 Key 连本地 opencodex；本报告是 cortex-agent/Claude 经 MCP 读 open-design 项目/设计系统数据。两者鉴权链路不同。

## 复现
  1. 注册(宿主机路径修正版) claude mcp add-json --scope user open-design '{...host paths...}'
  2. 握手/工具发现 OK：claude mcp list → open-design Connected
  3. 应用层调用 401：claude -p 'call list_projects' --allowedTools 'mcp__open-design__*' → 401 API_TOKEN_REQUIRED
