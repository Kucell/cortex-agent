# Coordination Workflow

1. 通过公共 CLI 创建并分派 Coordination Task。
2. 执行者接受声明的仓库相对 ownership 范围。
3. Heartbeat 与普通 progress 只写 journal。
4. 请求输入、阻塞、失败和待审查事件必须携带结构化 evidence 与正确的通知策略。
5. Coordinator ACK 通知后独立验证 evidence，再由 owning workflow 完成、
   修订、取消或安全接管。
6. 需要低延迟通知时显式启动 `cortex-agent notification pump ... --watch`；
   用同一 consumer/target/adapter 执行 `--status` 或幂等 `--stop`。

不得根据进程退出或终端静默推断完成；不得把 ACK 当成授权。只读 status、
list、watch、Management API 与 MCP 查询不得修改 stale 状态、lease、
Decision 或 Waitpoint。

租约作用域必须命名「本次动作真正会写到的、最小的共享资源」。设备级 scope
只用于真实整机动作；环境已提供实例级隔离时用 `<class>:<device>:instance:<id>`，
并让所有触碰同一台物理单例资源（例如交互桌面）的工作共用同一串 scope，
由该串自身完成串行。需要父子作用域互斥时，在 acquire 上显式加 `--scope-tree`；
默认仍是精确键，同名不同串互不相干。

Codex 宿主唤醒通过官方 App Server 的 `thread/resume` + `turn/start` 完成。
缺少 `CODEX_THREAD_ID` / `CORTEX_CODEX_THREAD_ID` 或宿主不可用时，继续以
journal 恢复为可靠路径并保留 pending。
