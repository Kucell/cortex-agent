# Coordination Workflow

1. 通过公共 CLI 创建并分派 Coordination Task。
2. 执行者接受声明的仓库相对 ownership 范围。
3. Heartbeat 与普通 progress 只写 journal。
4. 请求输入、阻塞、失败和待审查事件必须携带结构化 evidence 与正确的通知策略。
5. Coordinator ACK 通知后独立验证 evidence，再由 owning workflow 完成、
   修订、取消或安全接管。

不得根据进程退出或终端静默推断完成；不得把 ACK 当成授权。只读 status、
list、watch、Management API 与 MCP 查询不得修改 stale 状态、lease、
Decision 或 Waitpoint。
