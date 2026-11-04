# fix(coordination): 修复有界会话 EOF 清理与强制终止的竞态

子进程在复制 session 失败时先关闭响应管道，父进程把 EOF 当作握手失败立即
SIGKILL；子进程可能尚未执行 finally 中的密钥归零，也来不及写完清理证明。
本次把归零放在管道关闭之前，并仅为实际观察到的 peer EOF 提供最长 300ms、
且不超过原绝对 deadline 剩余时间的退出宽限。父侧仍立即 fail-closed。

## 根因与远端红灯的关系

用户提供的 main@6c313b09 / Actions run 41755766996 在
`real child child-copy-failure clears bootstrap and every owned key copy` 中
因 `key-cleanup.json` 不存在而失败。独立源码复核支持这条竞态链：

1. `acceptBoundedSession` 的第二次 Buffer.from 抛错。
2. 旧 catch 先关闭 read/write fd，旧 finally 才清除 bootstrap/key/session。
3. 父侧 endpoint 的 onEOF 产生 DISCONNECTED，ready 的拒绝处理进入
   cleanFailure 并立即 SIGKILL。
4. 子侧归零和证明文件写入都可能被截断；文件已经创建但未写完时也会留下不完整 JSON。

需要区分版本归因：#162 没有修改本模块、原测试和原夹具；这些文件在该基线的
最后修改是 cc5546f4（#138）。因此证据支持“#162 的 CI 暴露了既有竞态”，
不支持“#162 新写入了这段竞态代码”。本次没有查询或修改远端。

原 child-post-copy-failure 也没有免疫。同步屏障在旧实现上让它同样被
SIGKILL、丢失证明；原先通过只是常见调度下子进程先写完了证明。

## 实现与安全边界

- `permit-witness-bounded-session.js`：accept 的 finally 先擦除自身仍拥有的
  bootstrap/key/session，再关闭启动及业务管道；bootstrap 还在 endpoint
  构造前提前擦除，以覆盖构造期间同步终止的路径。endpoint 自身的 finish
  同样先清 key/session，再关闭 fd。
- EOF 的来源由内部回调明确传递。对外的 session.fail 包装仍只接收错误，不能
  通过伪造错误码或额外实参请求 EOF 宽限；start/accept 没有新增外部配置项。
- parent endpoint 的终止回调接入 cleanFailure，覆盖握手中和握手后失败。
  父侧会话、fd、密钥与 ready/pending 立即完成失败处理；只有 SIGKILL 尝试被延后。
- `graceMs = min(300, floor((deadlineNs - hrtime) / 1ms))`；非正值立即终止。
  原绝对 deadline 不重置，业务 I/O 不继续。spawn、bootstrap 写入、协议/读写错误、
  deadline、握手超时仍立即走原 SIGKILL 回退。宽限中的后续父侧 spawn error
  也会立即抢占宽限。
- 实际 exit 取消宽限计时器；显式 terminate 取消计时器后立即执行原 kill。
  kill 的返回值、会话关闭和 ChildProcess close 都不被提升为退出证明。
- directExit、SessionBudget 的配额和保留计费、retained 的释放条件未改动。
  线协议、key/session 长度、allowedOperations 和外部授权面未改动。

## 确定性回归护栏

新增独立测试文件和真实子进程夹具；原有 45 项测试、所有原断言、原夹具及 IO
模块保持逐字不变，不存在删除或放宽原断言。

真实夹具只观察受控的合成 Buffer，并仅写出副本数量、是否全零等布尔元数据。
它在响应 fd 关闭处记录清零状态，随后停在有限看门狗保护的同步屏障上。
父侧必须先处理 EOF、完成 fail-closed，再写 release 文件允许子侧继续展开调用栈
并写最终证明。因此这不是依赖几毫秒 sleep 或 Linux 调度的概率性测试。

三条真实路径覆盖复制失败、复制后校验失败、已握手后主动关闭。
另外五项模拟生命周期测试以 fake timer 验证 300ms 上限、50ms 剩余 deadline
截断、kill/close 不构成退出证明，以及自然退出、后续父侧错误、显式终止时的计时器取消。
模拟事件不被声称为原生退出证据；三条真实路径分别观察真实 exit。

复现命令：

```sh
node --test --test-name-pattern='EOF barrier' tests/coordination/permit-witness-bounded-session-cleanup-race.test.js
node --test tests/coordination/permit-witness-bounded-session-cleanup-race.test.js
```

同一屏障在未修改生产文件、HEAD 为 6c313b09 时的负对照：

| 路径 | EOF 时 cleared | terminationAttempted | 实际退出 | 最终证明 |
| --- | --- | --- | --- | --- |
| copy | false | true | SIGKILL | 不存在 |
| post-copy | false | true | SIGKILL | 不存在 |
| established | false | false | code 0 / signal null | 存在 |

旧实现 3/3 失败；修复后三条均在 EOF 时 cleared=true，父侧
terminationAttempted=false，子侧 code=0 / signal=null，最终证明完整且 cleared=true。
新增完整套件 8/8 通过。

## 验证

环境：macOS arm64 / Node v24.19.0。所有命令均在指定修复工作树中运行。

| 命令 | 基线 6c313b09 | 修复后 |
| --- | --- | --- |
| `node --test tests/coordination/permit-witness-bounded-session.test.js` | 45 pass / 0 fail | 45 pass / 0 fail |
| `node --test --test-name-pattern='EOF barrier' tests/coordination/permit-witness-bounded-session-cleanup-race.test.js` | 0 pass / 3 fail | 3 pass / 0 fail |
| `node --test tests/coordination/permit-witness-bounded-session-cleanup-race.test.js` | 未运行完整护栏 | 8 pass / 0 fail |
| `node --test tests/coordination/*.test.js` | 3447 pass / 1 fail / 15 skipped；3463 total | 3455 pass / 1 fail / 15 skipped；3471 total |

聚合前后均以 exit 1 结束，唯一失败都是 `tests/coordination/task-pipeline.test.js`，
错误一致；新增 8 项全部通过，没有新增失败：

```text
Error: ENOENT: no such file or directory, open '<worktree>/.agent/tasks/task.schema.json'
```

该工作树的 `.agent` 是未初始化的 Git 子模块；本次不初始化或修改它。
基线聚合耗时 354447ms，修复后聚合耗时 342402ms。
完整本地输出保存在 `.agent/runtime/cleanup-race-evidence/` 下的
baseline-bounded.log、baseline-coordination.log、old-race.log、fixed-race-probe.log、
fixed-race.log、fixed-bounded.log 和 fixed-coordination.log；日志不纳入提交。

另以 `git diff --exit-code` 核对原测试、原夹具、IO 模块无改动，
并执行 `git diff --check`。

## 残留边界

- “任意调度顺序”下的密钥属性由同步先归零、后关闭 fd 保证；父侧先处理 EOF
  的最不利顺序由屏障强制覆盖。有限宽限无法保证被系统暂停超过 300ms 或剩余
  deadline 的子进程仍写完证明；超限仍 SIGKILL，但受控子侧在 EOF 前已清零。
- 宽限只用于 rawIO 的 onEOF，部分帧 EOF 仍按 TRUNCATED 立即失败；非 EOF
  错误没有新增宽限。此修复不保证所有强制终止路径的子侧清理或磁盘证明持久性。
- JS timer 仍受事件循环/系统调度影响，不提供硬实时杀进程保证；没有新增无界等待。
- 本机未做 Linux 原生复跑，确定性屏障在 macOS 上复现并修复原竞态；Windows
  仍是本模块拒绝的平台，本次未进行任何账号、权限、ACL 或服务操作。
- 这不是整个进程树退出或 V8/操作系统全部密钥副本已擦除的证明；保留原有边界。

仅提交这次修复、独立护栏及本正文；不推送、不创建 PR、不合并。
