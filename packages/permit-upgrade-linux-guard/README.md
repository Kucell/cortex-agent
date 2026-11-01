# Linux 持续持锁原生核心

本组件实现提案 §4.1 所需的**同进程、目录 FD 持锁作用域**，是可嵌入未来受信控制器的 C 组件。它尚不构成完整阶段 A guard-controller：不提供 `not_configured`、`proved-unregistered`、登记、安装、排空、启动 guard 或生产写入授权。没有生产接线、JS adapter 或可导入的结果票据。

## 可复用合约

`guard.h` / `guard.c` 不依赖 Node。调用方提供受信父目录 FD、父/目标目录精确 dev/ino/owner、相对路径和同步 C 工作函数，调用 `pg_controller_run()`：

1. 重新 `openat2(parent_fd, ".")`，取得独立的 open file description；不使用 `dup` 共享调用方的 flock 状态。再以 `RESOLVE_BENEATH | RESOLVE_NO_SYMLINKS | RESOLVE_NO_MAGICLINKS | RESOLVE_NO_XDEV` 打开目标目录，两个 FD 均为 `O_CLOEXEC`，不向工作函数公开。
2. 核对目录类型、身份、owner 和 group/other 不可写。文件系统仅接受 ext4、XFS、Btrfs、tmpfs；不支持的文件系统、内核调用、路径或身份直接失败，不降级到字符串路径或锁文件。该 allowlist 只限定锁原语，不认证真实部署。
3. 在目标目录自身 FD 上阻塞取得共享或排他 `flock`。锁前不调用工作函数，取得后再次检查绑定。
4. 工作函数在**持锁进程自身的同步调用栈**中完成所有工作，包括其最终验证、写入、收尾和输出。调用方关闭、复用原始父 FD 不影响锁。`pg_check()` 仅检查当前进程和目录绑定，不是业务授权或外部 worker 的探活票据。
5. 工作函数返回 0 且最终绑定检查通过，才开始关闭私有 FD；全部关闭成功才返回 0。工作函数报错或最终检查失败，原线程进入保锁等待，直到进程死亡。没有取消后解锁、超时放行或清除 incomplete 的 API。取得锁但尚未进入工作函数时若绑定检查失败，可进入清理并返回错误，因为尚无本轮工作启动。

`pg_controller_run()` 现在必须传入调用方持有的 `struct pg_result *`。该结构区分 `work_started`、`work_completed`、首个 `error` 和独立的 `check_close_error` / `lock_close_error` / `parent_close_error`。工作已经开始但未返回 0 时也可能已发生发布；`work_completed=1` 只表示同步工作函数返回 0，不代表最终检查和资源释放成功。

每个归属本次调用的 FD 都在唯一一次 `close` 前清除其内部归属；包括 `EINTR` 在内的错误均不重试，也不通过旧 FD 数字探测后重关。`pg_check()` 临时 FD 关闭失败会返回错误并保留首次错误，使后续检查不能恢复成功。清理中锁 FD 关闭失败记为 `PG_RELEASE_UNKNOWN`，即使实际系统已经关闭也不推断成功；父 FD 关闭失败单独记录。成功关闭锁 FD 则可记 `PG_RELEASED`，但父 FD 错误仍使整体返回 -1。关闭前拒绝可能留下 FD/锁到进程退出，关闭后报错可能已经释放锁，两者均不允许自动重试、恢复旧工作或回退已发布内容。

结果结构只是本进程内诊断数据，调用方不得并发读取；不提供线程／信号隔离，也不提供持久错误记录。工作阶段失败的 fail-stop 保持原行为；清理阶段返回 -1 的调用方必须保留已发生的工作事实并处理 unknown，不能将其当作“从未发布”。

调用方和工作函数属于受信基座：仅适用于单线程、无外部写者、无异步任务、无 fork/exec 的同步控制器。不能把异步启动成功、排队完成或 worker 退出通知当作返回 0 的理由。C 无法约束任意调用方代码；恶意回调、原始 syscall、同 UID ptrace/proc-FD 访问和关闭私有 FD 均不在此原语保证内。

编译时直接将 `guard.c` 链入受信原生控制器即可。所有编译输出和编译器临时文件都应位于项目 `.agent/runtime`；原生核心本身不创建任何文件、不读取业务 DB。

## 原生测试控制进程

`lifecycle-peer.c` 是调用上述真实核心的**测试控制器**，不是生产 CLI。它只在测试独占输出目录同步创建四个固定诊断标记：`configuration`、`final-verification`、`stamp-marker`、`report-marker`。后两者不是产品版本 stamp/升级报告；这些标记不能证明真实升级或严格写入器合格。

私有管道会话带随机 incarnation、固定 upgradeId、严格递增序号和不可续期的单调截止时间。`CHECK` 是观察；`STEP` 写下一个固定标记；四阶段完成后 `FINISH` 只结束诊断作用域。在锁内输出 `diagnostic-work-published` / `release:pending`，不再提前宣称整个作用域成功；退出码仍需核对，检查或关闭失败不能由该输出掩盖。JSON 从来不是协议输入，输出始终 `executionAuthorized:false`，发现始终 `discovery-unknown`。`REGISTER`、`AUTHORIZE`、`PROVE_UNREGISTERED` 等请求直接使会话 incomplete。

EOF、输出失败、过期、非法/超长消息、序号重放、旧 incarnation、绑定变化和早到 FINISH 都终结会话：尝试写固定版本的 `upgrade-incomplete` **测试记录**，随后返回错误让核心保锁。记录写失败同样保锁；不因缺记录而恢复成功。测试记录位于 tmpfs，既不是 root 保护控制账，也没有断电耐久性承诺。管道不认证生产请求者或 root endpoint，incarnation 不是授权 secret。

## 必须保留的拒绝边界

- 调用方提供的父 FD/身份只是原语输入，不能认证 root 注册域、canonical project/alias、machine/install 域、固定 discovery endpoint、完整 commit 索引、boot-id 或可信 manifest。传 root UID 或 tmpfs 也不会获得此类认证。
- 原生核心锁住的是 inode；原路径替换后旧 inode 的锁仍在，新 inode 可被单独锁住。检查能识别替换，不能冻结一个可被其他主体修改的路径命名空间。生产父目录保护、安装/登记统一索引身份及排他锁协议仍待实现。
- `SIGKILL` 或其它进程死亡会由内核释放锁。任何旧 JSON、stamp、缓存或 incarnation 都不能恢复该作用域。连接断开但控制器存活时保锁；进程死亡后的恢复必须重新发现。
- **排他 flock 不证明旧写者已退出。** 测试实际保留一个外部写 FD，在控制器死亡、新进程取得 EX 锁后继续写成功。因此本组件拒绝登记与生产授权；systemd/cgroup/pidfd 所有权、完整退出屏障、持久 incomplete/root 启动 guard、旧 writer 隔离、SELinux 等仍需独立实现和实机验收。
- 不支持外包给 worker 发布最终 stamp/report。将同步回调包装成异步 Promise 或为外部写者发票据会违反本组件合约。
- 没有真实产品模板/升级/strict writer 接线，不声称普通项目成功路径或完整 §10 A 已验收。不存在用于伪装这些能力的 adapter。

## 重现真实 Linux 测试

测试文件：`tests/coordination/permit-upgrade-linux-guard.test.js`。非 Linux 默认显式 skip；设置 `PERMIT_LINUX_GUARD_REQUIRE=1` 会让非 Linux 环境失败，防止把 skip 当作通过。

在项目根执行下列命令。仅使用已安装镜像；不 pull、不联网、不使用 `/tmp`、特权容器、宿主权限修改。测试使用容器内 `.agent/runtime` 路径下的 tmpfs 验证内核 flock，避免把宿主共享目录的 virtiofs 语义冒充本地生产文件系统。

```sh
run_dir="$PWD/.agent/runtime/permit-linux-guard-$(date +%Y%m%d%H%M%S)"
mkdir -p "$run_dir/compiler" "$run_dir/linux-fs"
docker run --rm --network none --cap-drop ALL --security-opt no-new-privileges \
  --mount "type=bind,src=$PWD,dst=/work,readonly" \
  --mount "type=bind,src=$run_dir,dst=/work/.agent/runtime/linux-guard-run" \
  --tmpfs /work/.agent/runtime/linux-guard-run/linux-fs:rw,nosuid,nodev,noexec,mode=0700,uid=1000,gid=1000 \
  --workdir /work \
  --env TMPDIR=/work/.agent/runtime/linux-guard-run/compiler \
  --env PERMIT_LINUX_GUARD_REQUIRE=1 \
  --env PERMIT_LINUX_GUARD_BUILD_ROOT=/work/.agent/runtime/linux-guard-run \
  --env PERMIT_LINUX_GUARD_TEST_ROOT=/work/.agent/runtime/linux-guard-run/linux-fs \
  --env PERMIT_LINUX_GUARD_SANITIZE=1 \
  cortex-v116-ci:node24.19.0 \
  sh -c 'node --test --test-reporter=tap tests/coordination/permit-upgrade-linux-guard.test.js > .agent/runtime/linux-guard-run/test.tap 2>&1; result=$?; cat .agent/runtime/linux-guard-run/test.tap; exit "$result"'
```

镜像默认用户为 UID 1000；换镜像时应显式核对用户，不能以改宿主所有权来适配测试。独立运行也可在真实 Linux 本地文件系统上的 `.agent/runtime` 设置两个 ROOT 环境变量。每轮保留独立 build 目录、二进制、源文件 SHA-256 和 `/proc/locks` 证据；临时测试文件在进程退出后清理。编译使用 `-Wall -Wextra -Werror -Wpedantic`，可选 UBSan。

验证覆盖共享/排他两种顺序、两个共享持有者、util-linux 独立争锁、四阶段实际同步写入及每阶段内核阻塞者、原 FD 关闭/复用、CLOEXEC 标志、SIGKILL、旧结果/伪造 JSON/重放/过期拒绝、输入/输出中断、取得锁之前断连、记录失败保锁、路径替换/逃逸/权限/身份/文件系统拒绝，以及残留写者真实反例。未验证磁盘断电、持久 root 索引、完整安装/登记、跨重启恢复、实际业务文件和生产 x86_64 平台隔离。

close 失败测试将 `guard.c` 单独编译为仅测试的替换符号对象，再链接 `close-fault-peer.c`；生产对象不存在注入开关。实际验证关闭前拒绝，以及真实关闭后用 `/dev/null` 复用同一数字再返回 EINTR；覆盖首次检查、工作内检查、最终检查、锁/父 FD 清理和主错误与清理错误同时出现。用真实 util-linux flock、proc FD 与实际已发布标记交叉检查，不把注入错误冒充真实设备故障。
