---
name: cleanup-debug
description: 清理 .agent/debug 下的临时调试产物（截图、日志等），可按保留天数与类型筛选；可选清理本机 Playwright MCP 缓存目录。
---

# 清理调试文件技能 (Cleanup Debug)

## 目标

按策略清理 `.agent/debug/` 中积累的临时文件，释放磁盘空间，避免交接或 CI 时带入无关产物。

## 默认策略（可按项目调整）

| 目录 | 默认保留 | 说明 |
|------|----------|------|
| `.agent/debug/screenshots/` | 最近 7 天 | 截图（png/jpg） |
| `.agent/debug/logs/` | 最近 3 天 | `*.log` |
| `.agent/debug/temp/` | 最近 1 天 | 任意临时文件 |
| `.playwright-mcp/`（可选） | 最近 3 天 | 若存在且使用 Playwright MCP |

## 一键清理示例（macOS / Linux）

在仓库根目录执行前，建议先 **预览** 再删除：

```bash
# 预览：7 天前的截图
find .agent/debug/screenshots -type f \( -name "*.png" -o -name "*.jpg" \) -mtime +7 2>/dev/null

# 执行：删除 7 天前截图（确认后再跑）
find .agent/debug/screenshots -type f \( -name "*.png" -o -name "*.jpg" \) -mtime +7 -delete 2>/dev/null

# 日志：删除 3 天前 *.log
find .agent/debug/logs -type f -name "*.log" -mtime +3 -delete 2>/dev/null

# 临时：删除 1 天前文件
find .agent/debug/temp -type f -mtime +1 -delete 2>/dev/null
```

### 可选：Playwright MCP 缓存

若项目使用 `.playwright-mcp/` 且体积过大：

```bash
find .playwright-mcp -type f -mtime +3 -delete 2>/dev/null || true
```

**若未使用该目录，可跳过整段。**

## 调用方式

- 用户在对话中请求「清理调试文件」「cleanup debug」时，按上表执行或仅删除用户指定类型。
- 参数约定（可与项目约定对齐）：
  - `--all`：忽略天数，清空上述目录中对应类型（慎用）
  - `--screenshots` / `--logs` / `--temp`：只清理一类
  - `--days N`：统一保留天数为 N

## 安全提示

- 删除前尽量 **预览** `find` 结果；重要截图请先拷贝到文档目录。
- 删除操作不可恢复。

## 语言

说明与输出遵循 `.agent/rules/language.md`（默认中文）。
