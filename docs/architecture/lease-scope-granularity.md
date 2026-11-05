# 租约作用域粒度应与真实资源隔离粒度对齐（提案）

- 状态：Draft，待 Owner 审议；不构成 Decision，不改任何现有规则或 CLI 行为。
- 来源：SamHMI M-053 现场反馈（并行实例被粗粒度 scope 卡住）。

## 问题

框架的租约 scope 是精确字符串键：`lib/coordination/lease.js` 以 scope 原文作 Map 键，
acquire 的冲突判定是「同串 + 不同 owner」，父子作用域之间没有任何关系。
而同一模块的保护域判定（`lib/coordination/protected-scope.js`）用的是 `startsWith`
前缀匹配——框架已经承认「作用域可以有子命名空间」，只是这个关系只用于保护，不用于互斥。

`lib/coordination/lease-cli.js` 对 scope 只做非空字符串校验，没有粒度或命名约束。

后果：各工作线会自行发明「整机独占」的粗粒度 scope。一旦有人先取了它，其他线按
「共享设备不抢占」的通行处置直接判 NOT_RUN/BLOCKED，而环境其实已具备实例级隔离。
可并行的工作被治理层挡住。

## 三层资源模型

| 层 | 覆盖对象 | 并行性 |
| --- | --- | --- |
| L1 实例作用域 | 实例工作区、身份目录、端口、隧道 | 可并行，一实例一份 |
| L2 共享单例资源 | 交互桌面：前台、焦点、DPI、截图、输入、窗口生命周期 | 串行，全机唯一 |
| L3 整机 | 机器级配置与共享服务安装/卸载 | 串行，且只在真实整机动作时使用 |

关键结论：**实例 scope 并行不等于共享资源可并发**。工作区/端口/隧道的隔离不能顶替
单例物理资源（最典型是交互桌面）的串行 scope。

## 建议（阶段 1：治理规则，不涉及代码）

1. 作用域必须命名「本次动作真正会写到的、最小的共享资源」。
2. 设备或环境级 scope 只允许用于真实作用于整机的动作。
3. 环境已提供实例级隔离时，默认写成 `<class>:<device>:<instance>`，并在项目规则里登记实例名来源。
4. 冲突处置收紧为：只有（a）scope 完全相同，（b）动作会触达对方实例，或（c）双方都要占用同一个
   单例物理资源时，才判 BLOCKED。
5. 实例的启动、停止、清理只作用于本实例；整机 scope 的持有者负责跨实例动作。

## 建议（阶段 2：可选代码，需单独 Decision）

- 做法 A（推荐，向后兼容）：显式「作用域树」语义（`--tree` 或配置项），使 `A` 与 `A:<child>` 互斥；
  不启用时保持现行精确键行为。
- 做法 B：`lease acquire` 检测到同前缀下已有活跃子作用域时只给 advisory，不阻断。
- 需要 Owner 裁定：是否引入父子互斥、默认是否开启、保护域是否强制走树语义。

## 不改变

fencing 单调性、同 scope 冲突 fail-closed、takeover 流程与审计事件、protected scope 命名。

## 现场证据（2026-11-05）

- `samhmi:windows`（整机）被其他线持有期间，另一线以 `samhmi:windows:<instance>` 取得独立租约并并行运行，
  两者互不冲突——正是精确键语义的结果。
- 复读 `lease status` 可见细粒度写法已在实践中自然出现
  （`resource:windows-isolated-instance:<instance>-01` 与 `samhmi:windows` 并存）。
- SamHMI 侧已有产品级先例：`SharedDesktopLeaseStore` 把交互桌面 Lease 落在跨实例共享状态
  （`automation/instances/_desktop/desktop-lease.json`，短时 owner+token），并对未进并行只读白名单的
  操作 fail-closed。说明「单例资源单独串行」在实现层成立，缺的是框架层把它写成通用约定。

## 验收

1. 规则落地并被 `/coordination` 工作流引用。
2. 消费方在不申请整机 scope 的前提下并行完成各自实例验证且互不阻断；已在 SamHMI M-053 上复现。
3. 若采纳阶段 2：补 CLI 单测覆盖父子互斥、跨实例不互斥、保护域不受影响。
