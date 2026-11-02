# 阶段 A / R3 §7、8、10 C：真实版本对 SQLite 副本演练

仅测试 fixture，未接入 updater、宿主或生产迁移。所有构造、备份、工作副本、控制轨迹和证据均在 `.agent/runtime/permit-legacy-sqlite-*`。不调用业务、signer、全局安装、服务控制或 N-API 任务。

`manifest.json` 固定 1.15.7 store（复用相邻 v1 fixture）与本地 v1.16.0 tag 的 store（复用相邻 v2 fixture）、anchor、authorization、scope、coordination lock。编译时检查每个文件 SHA-256，只允许清单内相对依赖及固定 Node 内建模块，不读取全局安装，不依赖 CI 的 Git tag。当前只核验源码闭包，**没有候选 npm tar 的验收证据**；依赖文件冻结自候选 tag，其中 anchor/authorization/scope 与本轮已安装旧包逐文件摘要相同。

精确支持的旧格式：

- `application_id=0`，`user_version=1`；唯一 SQL 对象必须精确等于 `CREATE TABLE protected_state (id INTEGER PRIMARY KEY CHECK (id = 1), body TEXT NOT NULL, sha256 TEXT NOT NULL)`；仅 id=1 一行。额外表、索引、view、trigger、虚表及修改过的 DDL 都在 integrity_check / UPDATE 之前拒绝。
- 完整 JSON 形状、重复键、摘要、幂等及历史关系由复用的纯转换器检查。支持其已闭合 attempt=1 子集；对 reserved/consumed/unknown、draining 或不完整见证拒绝转换，原历史仍保留在副本。
- anchor 为 schema1 逐文件 intent/commit；文件名绑定 sequence、attempt、类型及整行 hash 前16位；entry_digest 绑定六字段。high-water 为逐行四字段摘要记录；audit 为 transaction 记录。高水位必须从 sequence=1 连续到 DB 的 anchor_sequence，源读取及 prepared 输入重验均拒绝缺首部、缺中段或只剩末条。旧版存在压缩逻辑，但现有记录无法证明缺失来自合法压缩，本演练也拒绝该格式，不把截短输入当完整来源。转换仅追加下一序号。
- WAL/SHM 先逐字节备份，再仅在工作副本由 SQLite 读取/恢复。测试使用旧版进程实际提交后直接退出留下的非空 WAL/SHM。拒绝未知 sidecar、截断 WAL、rollback journal（其恢复适配器未实现），不删除源 sidecar。WAL 校验只有格式头和帧长度加 SQLite 校验，未实现独立完整 WAL checksum/所有损坏类型验证。

真实演练：新建副本协调锁；BEGIN IMMEDIATE；事务内重验源行及见证，CAS 必须更新一行；更新 body/hash、user_version；写本地 db-commit-possible 轨迹，再 COMMIT；追加既有 anchor 格式的 commit/high-water/audit。关闭 writer 后，完整校验 DB/journal/high-water/audit、目标前缀及冻结 v1.16.0 public open/snapshot；全部成功才记录 witnessed，失败保持 unknown，不记录转换成功或激活。测试另以新进程使用未改写的冻结 reader 重开验证。body 仅 schema_version 和 anchor_sequence 改变。源字节、文件身份、权限、目录项、mtime/ctime 对比；不声称 atime 不变。

故障覆盖：真实零行 CAS、intent 后退出分支、SQLite authorizer 拒绝 COMMIT/ROLLBACK、COMMIT 后抛错，以及真实子进程 COMMIT 前/后退出。未闭合 intent 或 COMMIT 结果不明保持 unknown，保存主错误及 cleanupError，关闭连接；不重试、补见证或恢复激活。SQLITE_AUTH 只证明授权拒绝，不证明磁盘/断电行为。测试不是生产跨域恢复协议；副本内控制 JSON/hash 不提供可信控制域、旧 writer fencing 或持久能力。原失败清理及多域锁边界尚未覆盖全部生产 E 类故障。

本轮使用已有 Docker 镜像 `cortex-v116-ci:node24.19.0`，`--pull=never --network none --read-only --cap-drop ALL --security-opt no-new-privileges`；源码只读挂载，只有 `.agent/runtime` 可写，TMPDIR 指向该目录。重现入口：`node --test --test-reporter=tap tests/coordination/permit-legacy-sqlite-rehearsal.test.js`。运行环境证据记录 Node/SQLite 版本、Node 可执行文件 hash 和源码 manifest。

始终返回 `executionAuthorized=false`、`activation=blocked`。ordinary 迁移持久 cap、真实平台 gate、旧 handle/旧 writer 失权、外部 pin/撤销历史、候选 npm tar、真实项目自动迁移及生产恢复均未验收。fixture 的 permissive anchor 是开发历史格式，不证明 strict 部署权限或平台支持；旧 reader 拒绝 schema2 仅是格式回归。

并发与收尾：崩溃测试由父进程预先创建空的独占 `runParent`，子进程只创建其固定 `rehearsal/`，不扫描共享 runtime 目录推断归属。无 stdout/回执也能定位，但提前退出只留下实际写入的事实，不能当作 durable unknown 或成功回执。真实并行子进程覆盖 COMMIT 前后退出；源不变性及 cleanup 全部完成后才发布 witnessed/成功。源变动拒绝并保持 unknown；unknown 控制记录写失败保留主错及独立 recordError，不声称 unknown 已持久。cleanupError、sourceCheckError、recordError 分开记录，不用次级失败覆盖主事务错误。
