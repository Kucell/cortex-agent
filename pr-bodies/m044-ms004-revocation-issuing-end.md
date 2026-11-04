feat(coordination): 接通撤销列表的签发端

Windows 侧的撤销接线（拉取/验签/提交）此前已落地并合入，真机读回却是
HOST_REVOCATION_SOURCE=absent —— 撤销通道实际是断的。核实到的根因是
**签发侧根本没有权威撤销状态源**：signRevocationList 需要一个 state，
而签发侧没有自己的撤销集合，也没有公开的读写接口。

两侧线格式逐字对齐（revocation_sequence / revoked_fingerprints /
issued_at_ms / prev_revocation_sequence / batch_public_key_fingerprint /
signature），验签公钥从 pin 取而不从列表取 ⇒ 不需要新协议，缺的只是
「谁持有权威撤销集合并签出它」。

本次接通的是签发侧，六个落点：

1. protected-permit-store.js 新增签发侧自有 revocationState() /
   commitRevocation()：与目标侧 pin store 的同名接口**同名不同物** ——
   目标侧的 pin 说「这些钥匙不属于我」，签发侧的记录说「这些钥匙已被
   撤销、不许再签」。读目标侧的 pin 当签发侧的事实来源会把两侧信任边界
   合并、方向反了，所以不复用。
   撤销集合**只增不减**：缩水会产生目标侧按非单调拒绝的列表。
   该字段只存在于签发侧 —— admission/signing-gate 是目标侧的形态，其
   字段集被 assertAdmissionMetadata 精确锁定，多加一个字段就破坏已签认
   的 schema 契约。

2. permit-bridge-policy.js：ISSUER_ACTIONS 扩为 issue + revocation-list。
   该动作的请求形态是**空**（REQUEST_FIELDS["revocation-list"] = []）——
   列表由签发侧自有状态派生，能指定指纹的请求就是管理动作而不是读取。

3. permit-authority-service.js：dispatch 增分支，读签发侧撤销状态 →
   batchSession.signRevocation() → 返回列表。

4. permit-bridge-endpoint.js：新增 buildRevocationList（与 buildGrant **并列**，
   不是替换）。响应形态按**目标侧的消费方式**定：信封字段在**顶层**、
   signature 与之并列 —— 目标侧的 applyRevocationList 直接读
   list.revocation_sequence 等字段，不看嵌套信封；套一层信封会得到一个
   目标侧判为不可解析的合法 JSON 文档。

5. permit-bridge-host.js：perform 按动作分派，并**开第二个端点**。许可与
   撤销走两个独立 URL（产品侧读两个不同的环境变量），响应形态也不同，
   由请求方选择响应形态是错的。

6. permit-bridge-assembly.js / permit-bridge-service.js：签发侧持有**两个**
   批次会话。撤销列表由**第二个**批次签 —— 用许可批次签就等于允许列表
   撤销它自己的签名者，signRevocationList 会以
   ERR_REVOCATION_SIGNER_INVALID 拒绝，单批次下第一次撤销就死锁。

permit-batch-session.js 顺带暴露 publicKeyPem / fingerprint（**公钥**，
本就是公开的，目标侧要 pin 它才能验签；私钥仍不可达，close() 丢弃唯一
引用）。permit-managed-session.js 的 OPERATIONS 增 permit.revocation-list，
否则受管会话会拒掉这个操作。

验证（node --test）：
- tests/coordination/permit-revocation-issuing-end.test.js（新增 8 项）全绿
- tests/coordination/permit-bridge.test.js 19/19
- tests/coordination/permit-bridge-host.test.js 10/10
- tests/coordination/permit-bridge-ticket-binding.test.js + permit-bridge-ticket.test.js 9/9
- tests/coordination/permit-batch-session.test.js + permit-revocation-signing.test.js 9/9
- tests/coordination/permit-managed-session.test.js + permit-managed-flow.test.js
  + protected-permit-store.test.js 76/76
- tests/coordination/permit-witness-admission-host.test.js 82/82
  （这一项先红后绿：新增字段一度破坏了 admission schema 的字段集契约）

新增用例里最关键的一条把签发侧的响应体**直接喂给目标侧自己的
applyRevocationList**，用目标侧的验签路径确认形状正确 —— 这是单机上能
拿到的最强证据。它**不**证明跨机通道可用：跨机承载是另一条已裁定的
路线（cortex 新增通用跨机受管对端通道）。

硬边界不变：不新建/切换 Windows 账号、不做账号权限切换验证；
不把许可明文、私钥、批次密钥写入仓库、日志、证据、命令行或计划任务
Action；不安装 SamHMI 生产服务。

