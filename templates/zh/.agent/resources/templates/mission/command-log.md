# Command Log: M-xxx

记录关键命令、exit code 和后续动作。如果必需命令没有运行，必须记录原因。

| Time | Role | Milestone | Command | Exit Code | Result | Follow-up |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| {YYYY-MM-DD HH:mm} | Orchestrator | MS-001 | `{command}` | {0/1/not-run} | {summary} | {next action or none} |

## Notes

- 命令被有意跳过时，使用 `not-run`。
- 阻断性 validation assertion 缺少证据时，必须记录 follow-up。
- 不在这里粘贴长日志。尽量通过路径引用日志文件或终端摘要。

