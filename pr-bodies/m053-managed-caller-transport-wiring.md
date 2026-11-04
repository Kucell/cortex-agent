## 背景与结果

Windows 受管调用原先仍依赖 Node inherited IPC。此变更把生产 supervisor、session、executor 及直接调用方接到按名连接的 Windows transport：先 listen、固定 Node spawn、fd4 一次性 bootstrap、唯一 accept、双端 OS 事实审计、原 HELLO/HMAC，最后才 established。POSIX 保留原 fork/layout、secret 行格式及身份原语，既有测试没有修改。

## 实施范围（逐行对应实施复核 §2.2）

| 规格行 | 状态与实现 |
| --- | --- |
| supervisor begin/register/start | 已改：Windows listen 成功后才 spawn；同步票据、directExit 和 spawn 内异常不确定语义保留 |
| supervisor 启动选项/bootstrap/清理 | 已改：固定 process.execPath、reviewed execArgv、shell:false、detached:false、fd3 ignore/fd4 pipe；失败释放 listener/socket/引导端并仅终止登记 child |
| supervisor readSessionSecret/createExecutorEndpoint | 已改：Windows 共用 transport 模块 WeakMap 中的单次 bootstrap Promise；endpoint 用真实 transport，无 monkey-patch |
| managed-caller-transport | 已改：复用既有未提交实现；4 字节 BE + UTF-8 JSON、4 MiB、背压/队列界限/幂等关闭；新增有界严格 bootstrap 和私有绑定 |
| session constructor/handshake/auditChannelHolders | 已改：child 与 transport 分离，HELLO 前后审计三判据、双端唯一集合及连续性；对象/原句柄代际私有固定，成功后 established |
| session request/continuity/close/exchange/dispatch/teardown | 已改：Windows pre/post 审计、同一剩余 deadline、EOF/断连锁存失效、BYE 有界冲刷；两个公开 audit 仍同步返回对象 |
| identity endpoint/holders/collect | 已改：Windows pid 不产生已知通道；只接 supervisor 私有 binding；不把未知折叠成干净集合；公开 identity 无完整名称/对象/句柄 |
| windows-channel-holders | 已改：复用 readWindowsChannelHoldersBound，补私有参数、严格唯一结果、对象/原句柄标识及复制后复查；唯一性先于 holder 清洁性；native 资源 finally 释放 |
| windows-identity-facts | 已改：bound 动态参数走 STDIN JSON，argv 只含固定 driver；helper 有限 timeout/maxBuffer，CIM 接剩余预算 |
| permit-bridge-executor | 已改：HELLO/BYE/start/collect 用 transport；Windows collect 转发前验证原 HMAC/seq/digest，签名种类和输入不变 |
| permit-managed-cli | 已改：transport message/send/connected/close；result-ready 和等待 supervisor 关闭走同一通道 |
| permit-witness-isolated-worker | 已改：同一 bootstrap/transport，保留 provider 加载前 MAC/seq 校验 |
| permit-witness-managed-host | 已改：Windows 以 session.connected 判活并订阅 transport disconnect，继续检查真实 child exit |
| permit-witness-isolated-adapter | 已改：Windows 在 transport prependListener 做消息计数和准入，派发前拒绝，direct exit 后解除监听 |
| permit-bridge-host | 已改：保持装配/许可/撤销逻辑，流清理另关闭 Windows transport |

`permit-managed-session` 无需业务修改，继续原样转发 runtime。bounded-session、权限动作集合、签名模块、票据与撤销存储、服务账号及 SamHMI 产品源码均未改。

## 本机验证

运行环境：macOS / Node v24.19.0。初始 `.agent` 未初始化引发 shadow-persist 等缺模块失败；在本工作树内恢复产品 gitlink 固定的治理提交 `52f4c15627ebedaf13e2b4e8bd611cf2d9a0beb2` 后重跑，gitlink 未改。冲突文件已保全于 `.agent/evidence/pre-bootstrap-runtime/` 并记录 SHA-256。

- `node scripts/test-runner.cjs --scope governed --workers 2 --timeout 120 --max-time 300`：相同治理版本、相同命令，基线 `ec55c72f` **21/21 文件通过**，改后 **23/23 文件通过**。
- `node --test tests/governed/managed-caller-transport.test.js tests/governed/windows-managed-wiring.test.js`：73 项，72 通过、0 失败、1 跳过（需真实 Windows）。
- `node scripts/test-runner.cjs --module <name> --workers 2 --timeout 120 --max-time 400`：`permit-managed-cli`、`permit-bridge-host`、`permit-managed-flow`、`permit-witness-isolated-adapter`、`permit-witness-managed-host`，基线/改后各 1/1 文件通过。
- `windows-identity-facts.test.js` 包含实际 .NET C# 编译，已通过。
- `git diff --check` 通过；所有既有测试断言未改。

原始日志：当前工作树 `.agent/missions/M-053-managed-caller-transport-wiring/evidence/logs/`，最终记录以 `pinned-*`、`p2-logic-counts.log`、`before-permit-*`、`after-permit-*` 和 `p2-full-suite-pinned.log` 为准。初次未初始化依赖/日志直接重定向触发的 NON-HERMETIC 告警保留；最终 runner 日志在进程完成后写入，未放行 hermetic 门禁。

## Windows 验证及验收边界

**BLOCKED，未发起 Windows 执行。** 因用户规定须先本机全绿，最终全仓命令
`node scripts/test-runner.cjs --workers 6 --timeout 120 --max-time 600`
实际为 **638/643 文件通过，5 失败，369234ms，exit 1**。

四个失败文件为 `governance/github-control-store.test.js`、`governance/git-transaction-store.test.js`、`runtime-port/strict-entry.test.js`、`runtime-state/runtime-admission.test.js`。
它们在未修改的 `ec55c72f` 源码基线也分别失败；共同原因是 `lib/governance/git-transaction-store.js:111` 明确只支持 Linux，macOS 返回 `UNSUPPORTED_CONFIGURATION`。没有改这些测试、降低断言或放宽平台边界。

第五个为 `event-bus/event-bus-perf-bench.test.js`：并发批次 fan-out 为 132 events/s，低于 200 阈值；基线和改后均用
`node scripts/test-runner.cjs --file event-bus/event-bus-perf-bench.test.js --timeout 120 --max-time 180`
单独复跑，均 1/1 文件通过。原始并发失败没有隐去。

精确缺失输入：上述四个 Linux 专属文件的受支持环境通过证据（本机仅有 Docker CLI，daemon 不可连接），以及满足用户“本机全绿”门槛的验收结果。需要 Linux runner/可用 Linux 容器，或 Owner 明确调整这些已确认基线平台限制的前置验收口径。没有通过旁路脚本跳过该前置，也没有把问题归因为未验证的 Windows 凭据/授权不足。

W1 生产链路探针已在本工作树 `.agent/missions/M-053-managed-caller-transport-wiring/scripts/probe/` 准备，源码包带 SHA-256 校验；尚未 scp、SSH 或触发远端执行。Windows W1–W9 均为 **NOT RUN / BLOCKED**：W1 完整生产正例、W2 抢先连接、W3 唯一实例、W4 双端转交、W5 fd4 生命周期、W6 无关对象、W7 退化/超时、W8 代际重放、W9 七项阶段 C 负例。不得将本机模型或历史 BOUND_PRODUCTION_OK 代作本轮新结果。

VC-044-004 等效性：真实 child handle + accepted socket 的 OS peer、双端唯一对象和连续性绑定；不接受自报 pid，退出/断连/代际变化后永久失效。VC-044-005 等效性：双端分别审计，转交在 pre-send 拒绝；即使知道完整名称也不能越过 peer/HMAC。最终原契约签认仍由 Owner 完成。

风险：Windows 原生布局、受限权限和预算尚需实测；快照审计不提供全时原子保证；同账号抢先连接仍可造成 DoS；Windows 单 session 同时只允许一个 outbound exchange（inbound collect relay 仍可往返）；最低 Node 16 未实测，不能把开发 Node 24 结果外推。没有推送、创建 PR 或合并。


## 提交与审阅顺序

分支：`feat/m053-managed-caller-transport-wiring`，基线 `ec55c72f56606791dd2b78cde45c51ec64f930fb`。

1. P0 `f55abb08`：核心传输、bootstrap、双端私有身份绑定及 executor。
2. P1 `9e0de35b`：CLI、worker、host、adapter 和清理接线。
3. P2（本提交）：保留原 42 项 transport 测试，新增 31 项 Windows 控制流/安全边界测试及本说明；负例验证同时补齐 Windows inbound 统一 deadline 和 collect 转发前的原 MAC/seq/digest 检查。

仅提交外仓；固定的 `.agent` gitlink 未改、内仓无 tracked 语义修改。原始日志、只读基线源码快照和未执行的探针保留在本工作树 `.agent/`，未将它们提交进产品仓库。原仓库内的初始四个冲突文件已逐文件保全并记录 SHA-256，没有覆盖原文。未 push、未创建 PR、未合并。
