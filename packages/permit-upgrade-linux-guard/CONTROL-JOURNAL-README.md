# 控制 journal 原语与尚未完成的恢复边界

本次先审查 guard.c/h 与 strict writer：guard 只提供同进程目录锁，死亡会释放；strict writer 依赖受信平台、调用前持久 call-possible 及调用后控制器确认，没有已认证的平台适配器。新增 control-journal.c/h 提供真实 Linux 文件存储原语，没有修改这三份文件，没有产品入口、N-API 或真实 stamp 接线。不是阶段 A 或完整自动恢复验收。

## 已实现

- 使用既有目录 FD，经 openat2 相对打开独立描述，核对 dev/ino/owner/0700、文件系统，目录本身非阻塞 EX flock。控制账应是独立专用目录，不能拿共享 discovery index 当 journal；本组件不创建锁文件或注册根。
- 固定版本、固定 1024 字节 LE 记录，单 journal 绑定 upgradeId、受信上下文摘要、旧 stamp 是否存在及精确旧/目标字节，限制 stamp 最多 256 字节、4096 条记录。摘要不是认证；上下文摘要应绑定项目/声明/部署/候选包及其完整控制证据，具体证据由外部控制域保存。
- O_EXCL 不可覆盖创建，短写/EINTR 循环，精确 FD/命名字节与元数据复核，文件和目录 fsync。创建尝试后的任何错误为 unknown，毒化句柄、保留文件，不自动 unlink/覆盖/修复；close 单次，原错与 close 错误分开。
- OWNER 严格换代，重新打开必须先登记更高 OWNER，重放历史不恢复进程的 live ownership。OWNER 即持久未完成；eligible、call-possible、stamp-confirmed、report-confirmed、complete 和响应交付 unknown 分开。call-possible 后 unknown 在接管/重新验证时保留，直到独立核验确认。仅 complete 清除 incomplete；交付 unknown 默认保留，不声称客户端收到。
- 同一个 upgradeId/目标字节下，已获外部检查点确认的 call-possible 可提高 owner 世代，记录 revalidated，再记新 attempt 或确认实际目标。这些事件仅记录受信控制器决议，不验证决议真假。

## 必要前置约束与 R3 缺口

1. 固定受信 controller/bootstrap 必须认证控制域、目录 FD、外部检查点来源，保证目录命名空间/权限/ACL/mount 不被参与方替换、删除或恢复。model=0 只检查 root owner 和 ext4/XFS/Btrfs，绝不认证控制器、LSM 或硬件持久性；model=1 是显式测试模型，允许 caller-owned/tmpfs。不能由项目内摘要或 root 容器自证平台资格。
2. 完整协议必须在业务启动前重放 incomplete 并安装启动 guard，覆盖 systemd/cgroup/pidfd 旧写者排空、迟到 rename 排除、固定启动权、持续 discovery guard 与独立升级 owner。flock 不撤销外部旧 FD，进程死亡不代表业务未发生。当前没有这些能力。
3. 每次 pcj_record 成功后，受信控制域必须确认其 head 检查点，之后才允许依赖它的外部动作。调用方内存/测试 checkpoint 文件只是模型。控制账/检查点不得与项目/DB 备份同时回滚；所有域同时回滚无法由本组件检测。不声称整机防回滚。
4. `pcj_open` 仍要求可信 head 与磁盘尾严格相同。新增的受限恢复接口能够分类和导出有界完整尾，但默认构建没有见证验证器，接受收据时返回 `EOPNOTSUPP`；签名见证仅在显式测试构建中使用。生产尚缺独立认证的见证适配器、旧写者排空证明和 CAS 重启协调，因而 R3 的自动恢复尚未完成。撕裂、损坏或超界尾保持原位阻断，不能从目录自行提取 head 自证，或通过删除尾记录、换 upgradeId 绕过。
5. 没有连接真实 strict writer、报告历史/latest 或 CLI；confirmation/evidence digest 是受信调用方声明，不是写入器收据核验。完整组事务、索引发现、eligible 证据真伪及平台生命周期由未来控制器负责。不得将 snapshot 当写入授权；poison 后需由控制器 fail-stop，核心不会杀死调用者。

## 测试

Linux 故障与重启行为测试位于 `tests/coordination/permit-upgrade-linux-journal.test.js`。测试使用显式的测试信任模型，不能作为生产资格或外部可信检查点的证明。
