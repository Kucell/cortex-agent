# 跨机许可交付 —— 接线指南（登记与取钥）

> **Status**: 跨机许可交付「登记与取钥」环节的接线方操作指南
> **Date**: 2026-10-28
> **Audience**: 部署与接线方（把跨机许可交付接到真实受保护部署的人）
> **Binding**: 跨机许可交付设计文档（框架治理仓内，见对应 mission 的 evidence 目录）

本文件是**接线方的操作契约**。下面每一条「必须」都是复核方在签发 / 验签环节独立复核中
明确要求的接线约束，缺一条即视为接线不合规。

## 1. 本文档覆盖什么

| 文件 | 角色 |
|---|---|
| `lib/coordination/protected-pin-store.js` | 登记型锚点域（批次公钥 pin 的受保护存储） |
| `lib/coordination/bootstrap-snapshot.js` | bootstrap 快照（唯一身份写入、原子创建） |
| `lib/coordination/cross-machine-permit.js` | 跨机登记、取钥、撤销拉取与验签接线 |
| `lib/coordination/permit-delivery.js` | 核心签发 / 验签（**本文档不改动其语义**） |

**边界**：登记型锚点域复用许可存储的**权限判定面**（可写身份集合枚举与比较、
`null` fail-closed、服务身份强制声明），**不搬运**见证型锚点域实现、
不重做该契约。

## 2. 接线流程

```js
const { ProtectedPinStore } = require("../lib/coordination/protected-pin-store");
const crossMachine = require("../lib/coordination/cross-machine-permit");
const delivery = require("../lib/coordination/permit-delivery");

// 1. 打开登记型锚点域。权限契约在读写任何状态之前就被检查。
const pinStore = ProtectedPinStore.open(pinDir, {
  decisionId,
  anchorMode: "strict",
  platform: "windows",
  serviceIdentity,   // 见 §3.1
});

// 2. 目标侧登记（独占性保证 VC-044-015）。判定与写入同临界区。
crossMachine.registerOnTarget({
  pinStore,
  batchIdentity: { decision_id, instance_id, fingerprint },
  publicKeyPem,
  targetHasProcess,
  targetHasPriorRun,
  write,
  nowMs,
  // 登记动作携带的字段（设计 §2.2 字段表）。全部必填，缺一即拒绝。
  // run_id / generation 是签名绑定值（原样透传，不是新造字段）；
  // source_digest / deployment_digest / valid_from / valid_until 是本次
  // 登记的记录。
  sourceDigest,
  deploymentDigest,
  runId,
  generation,
  validFrom,
  validUntil,
  // bootstrap 快照目录。给了它，登记路径会在受保护临界区内**创建**快照
  // （O_EXCL），再把状态推进到 "registered"；不给它就没有快照，
  // 「崩溃残留 vs 正常重连」的区分也就无从谈起。
  bootstrap: { snapshotDir: bootstrapSnapshotDir },
});

// 3. 验签侧：先拉撤销列表，再取钥验签。
crossMachine.pullAndApplyRevocation({ pinStore, pull, nowMs });
crossMachine.verifyWithPinnedKey({
  pinStore,
  fingerprint,
  message,
  signature,
  expectedDeadlineMs,
  nowMs,
  skewToleranceMs,   // 见 §4
});
```

**登记路径只有一个入口**：`registerOnTarget`。只读判定 `assertPinExclusive`
**不得**用于登记路径——它不提供保证，在登记路径上用它会留下 TOCTOU 窗口，
而这种误用**在代码审查中看起来完全正常**。

### 2.0.1 登记动作携带的字段（设计 §2.2 字段表）

`registerOnTarget` 必须携带设计 §2.2 字段表里的全部内容。字段分两类，
**两者的义务不同**：

| 字段 | 类别 | 说明 |
| :--- | :--- | :--- |
| `run_id` / `generation` | **签名绑定值** | 原样透传签发环节的绑定值。**不是**新造字段 |
| `source_digest` / `deployment_digest` | **记录** | 两仓源码摘要与受保护部署快照摘要 |
| `valid_from` / `valid_until` | **记录** | 本次登记的有效期窗口（毫秒时间戳） |

**`run_id` / `generation` 的取值形态**：原样透传意味着**形态也不变**。
许可存储的 `acquire()` / `reserve()` 用 `requireText` 校验 `generation`，
签名层把它原样带进签名报文 —— 所以 `generation` 在上游是**字符串**
（如 `"1"`）。登记动作必须能接受**这个形态**：直接把许可上的 `generation`
原样交给 `registerOnTarget` 就应当被接受，而不是因为它是字符串就被拒。

（早期实现把 `generation` 写成「必须是安全整数」，结果接线方照文档原样
透传时被 `ERR_PERMIT_INPUT_INVALID` 拒绝 —— 被拒的是**正确的调用方式**。
现在 `generation` 接受上游的文本形态；整数形态也接受，并归一为十进制文本，
因此条目与快照记录的值始终是同一个 run 的同一个形态。）

**携带 ≠ 判据。** 这六项都会被记进 pin 条目，但**都不参与批次身份比较**——
批次身份仍是三元组 `(decision_id, instance_id, fingerprint)`。原因是设计
§2.2.3 R3-B3 修订 (1) 的逐字段排除：用 `run_id` / `generation` 会误杀正常重连，
有效期窗口续期后会变，而两个 digest 同批次与跨批次可能相同。

因此：一次重连**可以**携带与首次登记不同的 `run_id` / 有效期，pin 仍然复用。
若看到这些字段进了比较逻辑，那是回归。

### 2.0.2 bootstrap 快照由登记路径创建

快照的 `created` 初态**必须**由登记路径创建，不是由调用方预先建好再传给登记。
设计 §2.2.3 把快照的创建交给「登记 pin 的那个唯一身份」，用 `O_EXCL` 保证唯一，
并要求创建与 pin 写入在**同一个受保护临界区**内。

顺序是：**独占性检查通过 → 创建快照 → 断言快照可推进 → 写 pin → 推进快照到
`registered`**。快照先于 pin 创建，所以中断时留下的是「`created` 且无 pin」——
目标侧能判定它（登记没落地，可以重试）。反过来会留下「有 pin 无快照」，
那是设计所说的**不可判定**状态。

接线方**不要**自己调 `createSnapshot` 再把快照目录交给登记：那会让快照的创建
发生在临界区之外，且由「谁写的」与「谁登记的」分离——受保护身份保证就落空了。

### 2.0 验签必须在 `consume()` **之前**（时序契约，不可颠倒）

**`consume()` 本身不验签。** 许可存储的 `consume()` 绑定的是**存储层事实**
（`CONSUME_BINDING_FIELDS` 的 14 个字段），它不知道签名的存在。
**验签是验签方（Windows 侧 Worker）在调用 `consume()` 之前必须自己做的动作。**

接线顺序**必须**是：

```js
// ① 先拉撤销列表并应用（拿钥与验签都依赖本地撤销状态）
crossMachine.pullAndApplyRevocation({ pinStore, pull, nowMs });

// ② 再验签（失败即拒绝，本次动作不发生）
crossMachine.verifyWithPinnedKey({
  pinStore, fingerprint, message, signature,
  expectedDeadlineMs, nowMs, skewToleranceMs,
});

// ③ 最后才 consume
permitStore.consume(consumeFields);
```

**颠倒顺序的后果**：先 `consume()` 后验签，意味着许可**已经被消费**
（状态已转为 `consumed`、副作用可能已经发生）才发现签名无效——
「拒绝」发生得太晚，VC-044-014 的「每次 consume 之前验签」被违反。
这种误用在代码审查中**看起来完全正常**（都是调用了两个函数），
所以它必须被写成契约。

**哪些形态必须被拒**（VC-044-014 明列，逐条都要有反例）：

| 形态 | 结果 |
| :--- | :--- |
| 旧公钥（不在 pin 中） | 拒 |
| 旧 run / 旧 generation / 旧 fencing | 拒（签名覆盖这些字段） |
| 重复序号 | 拒（单调序号高水位） |
| **同账号非 Host 进程持有效 MCP Bearer 但无有效签名** | 拒（验签不看 Bearer，只看签名） |
| 已撤销的签名方 | 拒（撤销集合） |

**签名消息不得含明文 token**——签名只带摘要，不带凭据。

### 2.2 `targetHasProcess` / `targetHasPriorRun` **必须由目标侧自行判定**

这两个入参决定「目标实例是不是全新部署」——**只有全新部署**（无进程、无既有 run）
才允许钉住公钥（VC-044-013）。它们的**取值来源**是有安全含义的：

| 取值来源 | 是否可接受 |
| :--- | :--- |
| **目标侧在受保护临界区内自己查出来**（查本机进程表 / 本机 run 状态） | 可接受 |
| **由远端（发起侧）报告后原样传入** | **不可接受** |
| 查不出来（无法判定） | 按**不满足**处理——登记被拒 |

**为什么**：反例 21 明列「攻击者伪造『无进程 / 无旧 run』的检查结果」必须被拒绝。
若这两个值来自跨机自报，攻击者只要能让远端**声称**「目标侧没有进程」，
就能在一个**正在运行**的实例上钉住自己的公钥——公钥钉住的前提就废了。
设计对此的表述是「检查必须由**目标侧**在受保护临界区内自行判定，
**不接受跨机自报结论**」。

**实现上的表现**（`assertPinExclusive` 已实现这三态）：

| 传入值 | 判定 |
| :--- | :--- |
| `true` | 「目标有进程 / 有旧 run」→ 登记被拒 |
| `false` | 「目标确实没有」→ 允许继续 |
| `null` / `undefined` | **不可判定** → 按不满足处理，登记被拒 |

所以接线方**不能**把「查不到」写成 `false`。查不到就传 `null`，
让判定落到 fail-closed 一侧。

### 2.1 `write` 回调的契约（**必须**是原子 create-if-absent）

`registerOnTarget()` 与 `registerPin()` 不自己写 pin 文件——它们把写入
委托给接线方传入的 `write` 回调。**独占性保证要求这个回调是原子的**：

| 契约 | 要求 |
| :--- | :--- |
| 创建方式 | **原子 create-if-absent**：`O_EXCL` / `wx`（`fs.openSync(path, "wx", 0o600)`） |
| EEXIST | 返回 `false`（表示「已存在」），**不得覆盖**已有内容 |
| 成功 | 返回 `true` |
| 其它错误 | 抛出（让登记整体失败） |
| 权限 | 文件模式 `0600` |

**为什么必须是原子的**：独占性保证（VC-044-015）依赖「后到者不覆盖先到者」。
若 `write` 是**覆盖式**的，两个并发登记者都可能「成功」，
后到者会覆盖先到者的 pin——竞态的失败方会被告知成功，
**独占性保证就不再是保证**。

**实测事实（如实记录）**：受保护临界区的**锁文件**已经能兜住并发
（即便注入覆盖式回调，两个并发登记者中也只有一个成功）。
因此这不是「当前会失效」的缺陷，而是**契约必须被书面化**的部分——
接线方按本节实现即满足要求，不依赖锁文件兜底。

## 3. 接线验收判据（逐条必须满足）

### 3.1 服务身份必须显式声明

在 Windows 上，**服务身份的声明是强制的**。原因是那台机器上的调用账号
不一定就是服务本身：不声明就退化成「拿调用方和它自己比」，判定变成恒真的废话。

- 声明的**必须**是该服务虚拟账号的 SID（形如 `S-1-5-80-…`），
  即 Owner 已裁定的 A 方案；
- **不得**新建可登录用户账号，**不得**切换登录用户，**不得**做账号权限切换验证；
- 声明的身份必须**就是**调用方的身份，否则以
  `ERR_ANCHOR_SERVICE_IDENTITY_MISMATCH` 拒绝；
- 锚点域的**可写身份集合必须恰为该服务身份**。集合无法枚举时按 `null`
  fail-closed 拒绝（`ERR_ANCHOR_AUTHORIZATION_UNKNOWN`），**不得**猜测；
- pin 目录与许可存储的数据库目录域**必须互相不包含**，并由
  `assertSeparateFromPermitDatabase()` 显式检查。

### 3.2 撤销集合、期望指纹、验签时钟必须「读出后传入」

这是复核方在签发 / 验签环节给出的**硬约束**（§10.3.3 第 3 项、§10.9.3 第 5 条）。

`verifyPermitSignature()` 的 `revokedFingerprints`、`expectedFingerprint`、
`nowMs` 三个参数**必须**由验签方从**受保护的登记型锚点域**读出后传入。

**不得**由调用方传入一个「自认为空 / 自认为对」的值来代替真实状态。
典型的错误接线是「取不到撤销集合 → 传空集」：那会把 fail-closed 语义
重新打开——通道故障被读成「没有撤销」，撤销窗口变成无界。

`cross-machine-permit.js` 的 `verifyWithPinnedKey()` 就是这条约束的实现形态：
它自己从 `pinStore` 读出撤销集合与指纹再传入，接线方**不应**绕过它直接调
`delivery.verifyPermitSignature()`。

### 3.3 验签时钟必须来自真实时钟读数

`nowMs` **必须**来自单调可信的时钟读数，且**不得**为 `0` 或负数。
`0` 会被 `ERR_PERMIT_INPUT_INVALID` 拒绝：一张几十年前就过期的许可
在 `nowMs = 0` 下会通过过期判定——那是同一个恒真判定的另一种写法。

同仓的 `protected-permit-store.js` 对同类输入使用 `ERR_CLOCK_INVALID`。
本文档已把该码**登记进** `lib/coordination/errors.js`（此前它只在
`protected-permit-store.js` 内部使用、从未进过稳定码表）。接线方若在
本文档的调用面上遇到时钟取值非法，**必须**如实上报，不得静默改成合法值。

### 3.4 撤销通道不可用时拒绝本次验签

拉取失败（通道不可用）或拉取超时（超过 `revocation_pull_timeout_ms`，
默认 5000ms）→ **本次验签拒绝**，并释放本地临界区。

**不得**以上次拉到的列表继续接受。

### 3.5 私钥边界不变

私钥只在进程内存中以 KeyObject 句柄持有，进程内**永不** export。
陈述覆盖率时，「JS 可见内存已覆盖」与「进程 native 内存（含 core dump）
不覆盖」必须**分开**陈述，不得混用；V8 heap snapshot 对私钥是**假阴性**检出面，
**不得**记为已覆盖。

### 3.6 时钟毒化的域必须拒绝一切

受保护锚点域里存着**时钟毒化标记**。它标记的是「这个域的时钟不可信」。

**标记为毒化时，该域拒绝签发新许可、拒绝拉取撤销列表、拒绝一切取钥后的授权。**
错误码 `ERR_CLOCK_INVALID`（1077）。

清除标记**必须**走设计定义的显式受管恢复流程，**不得**在接线代码里直接调
`setClockPoisoned(false)` 把标记抹掉——那等于把一个 fail-closed 开关变成一个
随手可关的旁路。清除流程还必须**同时重新锚定单调时钟基线**，且基线的绝对时刻
不得小于最后可信绝对时刻；清除为一次性原子操作，中断即保持毒化。

### 3.7 重连（reconnect）必须带 bootstrap 快照

「既有 pin 的批次三元组与本次**逐字段全等**」**只是**允许复用 pin 的必要条件，
**不是**充分条件。

**登记入口 `registerOnTarget()` 的重连分支只在以下条件同时成立时才走**：

1. 既有 pin 的三元组与本次批次**逐字段全等**（任一字段不等 →
   `ERR_PIN_BATCH_MISMATCH`，停止整条路线，**不得**以新批次覆盖旧 pin）；
2. 调用方**传入了** `bootstrap.snapshotDir`；
3. `classifySnapshot()` 判定该快照属于本批次、处于允许重连的状态，
   且目标侧能**独立复验**该 pin 确属本批次 → 判定为**正常重连**，
   **复用 pin**（不重新写入、不覆盖），推进快照状态并继续清理。

**不满足时**（无快照 / 快照属别的批次 / 快照处于 `created` 且无法复验 /
快照处于 `registered` 而目标侧无复验能力）→ 走独占性子句 →
`ERR_PIN_NOT_EXCLUSIVE`，**停止整条路线**。

**为什么不能只看三元组**：同一个批次的两个**并发**首次登记者，三元组也全等。
若三元组相等就复用 pin，竞态的失败方会被告知「成功」，独占性保证就失效了——
而独占性正是 VC-044-015 的核心。快照是重连的**证据**；没有证据时，
「同批次」既可能是重连、也可能是竞争者，**不可判定按不满足处理**
（设计 §2.2.2）。

接线方**必须**为重连路径提供 `bootstrap.snapshotDir`，否则重连会被拒。

**终态下的重连（复用 pin 但不推进快照）**：快照走到生命周期的终点后，
设计仍然允许重连——

| 快照状态 | 含义 | 重连 |
| :--- | :--- | :--- |
| `created` | 尚未写回回执 | 可重连（按 `ours-not-receipted` / `not-registered` 分流） |
| `registered` | 已写回回执，**清理窗口内** | 可重连（主路线） |
| `consumed` | 已消费，可清理 | 可重连——**复用 pin，但不推进快照** |
| `absent`（清理完成后） | **正常终态** | 可重连——**复用 pin，但不推进快照** |

`consumed` / `absent` 之下再推进 `registered` 是**状态倒退**，
状态机禁止它。因此终态下的重连**只复用 pin，不动快照**。
可判定性要求仍然全部适用：快照**可读**、身份**逐字段全等**、
目标侧能**独立复验** pin 确属本批次、回执摘要**一致**。

**不带** `snapshotDir` 的同批次重连**仍按竞争者拒绝**
（`ERR_PIN_NOT_EXCLUSIVE`）——终态的接纳不放宽这一条。

### 3.8 快照「不可读」与快照「不存在」是两种事实

快照文件**不存在**是正常终态（没有可重连的东西，路线可以继续）。
快照文件**存在但读不出来**（`EACCES` / `EPERM` / 同账号普通进程 chmod 000
或删除等）是**不可判定**，按**不满足**处理，**停止整条路线**
（设计 §2.2.2「不可判定不等于通过」）。

实现上的对应关系：

- `readSnapshot()` 区分 `ENOENT`（返回 `null`，即「无快照」）与其他读失败
  （抛 `ERR_BOOTSTRAP_STATE_INVALID`）；
- `classifySnapshot()` 把读失败表达为 `classification="undecidable"`、
  `reconnectAllowed=false`，**不是** `"absent"`；
- 登记路径因此以 `ERR_BOOTSTRAP_UNVERIFIABLE` 拒绝，**且拒绝发生在写入 pin 之前**。

**为什么这一条是硬要求**：若「读不出来」被当作「无快照」，闸门会放行，
**别的批次**的公钥会被写进 pin 集合，并因此获得签发许可的能力——
这正是「公钥钉住」要防的授权绕过。触发条件只需要同账号普通进程删一个
0600 文件，而设计把这类进程列为明确的攻击者。

### 3.9 快照推进的可判定性必须先于 pin 写入

「写 pin」与「推进快照状态」是**同一次受保护临界区内的两半**，
设计要求二者**不得**分裂为两次独立动作——否则复验通过后、推进前的崩溃会留下
「`created` + pin 在」的**不可判定**状态。

因此登记路径在**写 pin 之前**先判定快照**可推进**（`assertSnapshotAdvanceable()`）：

1. 快照**可读**（读不出来 → `ERR_BOOTSTRAP_UNVERIFIABLE`，停止）；
2. 快照状态**允许**前进到 `registered`（倒退 → `ERR_BOOTSTRAP_STATE_INVALID`）；
3. 回执摘要与目标状态**一致**（同状态但回执不同 → `ERR_BOOTSTRAP_STATE_INVALID`）；
4. `registered` 状态必须**带**回执摘要。

任一条不满足，路线在**写入任何 pin 之前**停止，域中不会留下
「`created` + pin 在」的残留状态。

## 4. 时钟偏差裕量（`skewToleranceMs`）—— 接线方必须知道的三件事

### 4.1 裕量必须来自显式配置，并被记录

设计 §2.3.3 要求裕量「**须显式配置并记录**」，且**不参与签名**。

- 裕量**不得**由代码里的隐式常量决定；接线方**必须**显式配置它；
- 配置值**必须被记录**（进部署记录 / 审计日志），否则事后无法解释
  「这次为什么被接受」；
- 裕量**不得超过** `MAX_SKEW_TOLERANCE_MS`（5 分钟）。超过时
  `verifyPermitSignature()` 以 `ERR_PERMIT_INPUT_INVALID` 拒绝；
- 接线侧**必须引用导出的常量** `delivery.MAX_SKEW_TOLERANCE_MS`，
  **不得**另立一个会漂移的字面量；
- 省略裕量等价于 `0`，即「验签方时钟不得落后于签发时刻」。

### 4.2 「裕量 > 寿命」会被裁剪 —— 裕量不是绝对的偏差容忍

这是接线方**最容易误读**的一点，所以显式写在这里。

裕量**会被许可自身的有效期裁剪**：

```text
实际生效的容差 = min(skewToleranceMs, lifetimeMs)
其中 lifetimeMs = deadline_ms - issued_at_ms
```

换言之，**裕量不是绝对的偏差容忍**。在一张一秒寿命的许可上，配置 5 分钟裕量
不会得到 5 分钟的容忍——实际容差是 1 秒。原因是：若不裁剪，一张一秒的许可会
接受「签发前 5 分钟」到「签发时刻」之间的**任意**时钟读数，签发时刻判定
对这张许可就变成了恒真，裕量事实上取代了有效期本身。

裁剪（而不是拒绝）保住了短许可：许可存储只给 `ttlMs` 规定下界，
一秒寿命是真实的，拒绝它会破坏设计自己的短 lease 必测场景。

**接线方应当据此配置裕量**：按两台机器的**实际**时钟偏差配置，
而不是「配大一点保险」。配得越大，对短许可越无效。

### 4.3 裕量**不延长**许可的有效期限

到期判定**不**被裕量放宽：有效期限**严格等于**签发方授予的窗口
（`issued_at_ms` → `deadline_ms`）。裕量只吸收**一件事**——
验签方时钟**落后于**签发时刻的偏移（跨机时钟差）。

它**不是**让许可活过自己 deadline 的手段，也**不是**让验签方重新解释
签发方授予窗口的手段。

## 5. 反例与必测项

本文档覆盖设计反例矩阵中的 4 / 13 / 14 / 15 / 17 / 22 / 23 / 24 / 29 / 30。
接线时必须保证下列形态**可构造**，不得因实现缺失而放宽：

| 形态 | 期望 |
|---|---|
| 目标侧不能独立复验 pin 归属本批次 | `ERR_BOOTSTRAP_UNVERIFIABLE`（不可判定按不满足处理） |
| 既有 pin 属于**另一个**批次 | `ERR_PIN_BATCH_MISMATCH`，停止整条路线，**不得**覆盖旧 pin |
| 批次身份声明的指纹与公钥派生指纹不等 | `ERR_PIN_FINGERPRINT_MISMATCH`（指纹不得自报） |
| 撤销列表的签名公钥不在 pin 中 | 拒绝，**不推进**任何高水位 |
| 撤销列表的 `revoked_fingerprints` 不是本地已应用集合的超集 | 拒绝，**不推进**高水位 |
| 撤销列表 `revocation_sequence` ≠ 本地高水位 + 1，或 `prev_revocation_sequence` 不匹配 | 拒绝（链断裂） |
| 通道不可用 / 拉取超时 | 本次验签拒绝（`ERR_REVOCATION_PULL_FAILED` / `ERR_REVOCATION_PULL_TIMEOUT`） |
| 短 lease（`ttlMs` 极小） | **必须可用**：裕量按寿命裁剪后仍可验签 |

## 6. 仍然禁止的动作

- 不授权在受保护部署上**启用签发**——core dump 实测门独立于本文档，
  在真机实测确认 `LocalDumps` 与服务崩溃转储禁用（或补偿控制之一成立、
  或 Owner 书面接受）之前，**不得**在受保护部署上启用签发；
  开发 / 测试环境可用来自测与回归；
- 不改 Windows 系统 ACL、不安装 / 提权、不创建服务或计划任务；
- 不新建 Windows 账号、不切换登录用户、不做账号权限切换验证；
- 不改 `lib/coordination/protected-anchor.js`、`anchor-authorization.js`、
  `protected-permit-store.js` 的既有语义（只允许必要的导出追加）；
- **不**引入第二把密钥：撤销列表由 pin 中批次公钥对应的私钥签发；
- **不**用撤销移除 pin 条目：pin 条目只增不减，撤销语义只由指纹级撤销集合承担。

## 7. 状态声明

**代码层通过不等于 VC-044-013 / 014 / 015 成立。** 这三条断言必须在
**真实受保护部署**上实测后才可转 PASS；下游项目的产品安全门禁在此之前
**未解除**。

## 8. 未决项（如实记录）

1. **裕量在真实部署中的实际取值**——本文档只规定上界与裁剪，部署侧配多少
   裕量（0 / 1000 / MAX）属部署方选择，尚未在真实部署上取值；
2. **存量 pin 的指纹迁移**——指纹已改为密钥材料规范编码（SPKI DER）的摘要，
   **已登记 pin 的指纹值随之改变**。当前无生产 pin 数据，迁移行为与存量兼容性
   **未核实**，须在接线前裁定；
3. **跨机短 lease 的真实端到端场景**——回归用例已覆盖，真实跨机场景未实测；
4. **Windows / Linux 上的 SPKI-DER 与时钟行为**——未在这些平台上实测。
