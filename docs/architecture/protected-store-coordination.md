# Protected permit store 的跨存储提交协调

业务 SQLite 的 COMMIT 会先于外部 journal commit/high-water 完成。v2 在受保护的 anchor 域内保留一个固定的 `protected-store-coordination.sqlite`，以独立 SQLite 连接的 `BEGIN IMMEDIATE` 覆盖这段窗口。顺序固定为协调锁、业务事务、外部见证；initialize、open、snapshot、写入及三个受管恢复入口均遵循。

锁等待固定最多 5 秒，忙错误不触发业务重试或恢复。进程死亡由 SQLite/OS 释放锁，真正的 DB 已提交而 journal 未提交仍须原有受管恢复和审计。回滚、摘要、身份、权限、最低 epoch 检查保持不变。reset 不移动、删除或重建协调文件，避免不同进程锁住不同 inode。

业务 body schema_version 和 SQLite user_version 同时为 2。旧 v1 的 open 和已打开句柄后续写入均拒绝 v2；新实现拒绝 v1，没有在线升级入口。缺失、损坏、替换或不安全的协调锁均失败关闭，不能通过删除锁、自动补锁、chmod 或更换身份修复。包括协调文件的整域丢失不再属于 witness-only reset 的适用范围；需要另行设计并批准离线重建，不能继续使用旧授权状态。

本次只实现新的隔离 store 协议及合成验收，不部署服务、不修改 ACL/身份、不迁移已有 store 或用户项目。旧代码对照保存在测试 fixture，来源为提交 `31ffc2f7f49271fa5ae055d4202fb71230645fd9` 的原始 store 文件。
