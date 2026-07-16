---
id: 0013-agent-dashboard-server
target: workflows/agent-dashboard.md
anchor: "dashboard-manager"
---

---

## 实时 Dashboard 补充

`/agent-dashboard --serve` 应交给 `dashboard-manager` sub-agent 处理，并启动本地 server：

```bash
node .agent/skills/agent-dashboard/scripts/serve.js --port 8787 --interval-ms 3000
```

约束：

- dashboard-manager 只读 `.agent` 协作状态，不写业务代码
- 页面每隔固定时间重新生成，并通过 SSE 自动刷新
- 默认页面地址为 `http://127.0.0.1:8787`
