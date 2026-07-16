---
id: 0013-agent-dashboard-server
target: workflows/agent-dashboard.md
anchor: "dashboard-manager"
---

---

## Live Dashboard Addendum

`/agent-dashboard --serve` should be handled by the `dashboard-manager` sub-agent and start the local server:

```bash
node .agent/skills/agent-dashboard/scripts/serve.js --port 8787 --interval-ms 3000
```

Constraints:

- dashboard-manager reads `.agent` coordination state only and does not edit product code
- the page regenerates on an interval and auto-refreshes through SSE
- default URL is `http://127.0.0.1:8787`
