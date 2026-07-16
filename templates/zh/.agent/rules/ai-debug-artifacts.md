# AI 调试产物管理规范

AI 生成的截图、日志、临时 JSON、浏览器调试输出等产物，默认统一放入 `.agent/debug/`，除非用户明确指定其他位置。

## 目录约定

```text
.agent/debug/
├── screenshots/
├── logs/
└── temp/
```

## 规则

- UI 截图、浏览器截图、视觉验证截图放入 `.agent/debug/screenshots/`。
- 临时命令输出、服务日志、浏览器日志放入 `.agent/debug/logs/`。
- API 响应、探针结果、临时 JSON/text 文件放入 `.agent/debug/temp/`。
- 禁止把调试产物散落在项目根目录。
- `.agent/debug/` 不是长期发布证据目录；长期证据应迁移到 `.agent/missions/<id>/evidence/` 或项目文档资产目录。
- handoff 或提交前，应清理已经无用的旧调试产物。

## 命名建议

使用“功能 + 状态 + 日期/时间”的描述性名称，例如：

```text
login-error-20260716.png
api-response-user-list-20260716.json
dev-server-20260716.log
```
