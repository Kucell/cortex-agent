## 范围

票据此前只能在签发端进程内铸造、且只发给本机已验证的对端（`tickets.mint(assembly.peerIdentity)`），
端点侧只接受与本机 pin 身份一致的票据。因此**跨机受管对端即使能到达签发端，也永远拿不到票据**。

本 PR 增加**票据代理**：签发端进程内一个独立的回环监听器。

- `lib/coordination/permit-ticket-agent.js`：票据代理。信任根来自部署侧钉住的公钥（`peers` 参数），
  绝不由对端自报；服务端签发一次性挑战，对端用钉住的私钥签名握手事实（字节域前缀
  `cortex.permit-ticket-agent-handshake.v1`），验签通过后为该远端对端铸造一张**绑定其签名身份事实**
  的票据并在握手响应里当场交付。挑战一次性：成功或失败都用掉。
- `lib/coordination/permit-remote-peer-registry.js`：远端对端登记表。本机对端的身份是全生命周期 pin；
  远端对端的身份只在票据可达的窗口内存在，随票据过期一起失效。比较规则复用端点既有的
  `identityMatches`，避免一座桥里出现两套「同一个对端」的定义。
- `lib/coordination/permit-remote-peer-client.js`：远端对端一侧的握手客户端（只用 `node:crypto`）。
- `permit-bridge-host.js`：端点接受「本机 pin 对端 **或** 仍在登记表内的远端对端」的票据；
  配置了 `remotePeers` 时桥内启动票据代理。
- `permit-bridge-service.js` / `permit-bridge-service-cli.js`：配置项 `remotePeerTrustFile`（部署侧
  信任文件）与 `agentPort`；就绪输出**仅在票据代理实际启动时**增加 `agentPort`（未配置信任文件时
  就绪输出逐字不变）。

## 验证

- `node --test tests/coordination/permit-ticket-agent.test.js` → 13/13。
- `node --test tests/coordination/permit-bridge.test.js` → 21/21（未受影响）。
- `node --test tests/coordination/permit-bridge-{host,service,ticket,ticket-binding,bounds}.test.js` → 34/34。
- `node --test tests/commands/permit-bridge-service-cli.test.js` → 8/8（含新增「有代理时报告 agentPort」用例）。
- `node scripts/check-l3-boundary.js` → 0 violations。
- **跨机实测（测试域；Mac 签发端 + Windows 受管对端，经 Mac→Windows 反向通道）**：
  - Windows 侧：握手取票 → 带票 POST 许可端点 ⇒ **200**，返回 16 字段 grant
    （`messageJson` / `signatureBase64` / `fingerprint` / `sequence` / `deadlineMs` / 11 个投影字段 / `permitId`）；
  - 同票重放 ⇒ **401**；无票 POST ⇒ **401**；GET ⇒ **405**（端点无 health 路由）。
  - 签发侧（本机对端，同一座桥）：无票 **401** → 带票 **200** → 同票重放 **401** → 新票同派发 **200**。

## 承载形态：测试域专用（不是生产路径）

- 票据代理只绑回环，因此跨机可达性**依赖承载**。本轮取证用的承载是**既有 SSH 隧道 + 反向转发**
  （`ssh -N -R 127.0.0.1:18080:127.0.0.1:<permitPort> -R 127.0.0.1:18081:127.0.0.1:<agentPort>`）。
- 该承载在契约 D-AUTH-001 **v1.2.1 §9.1.2** 起**显式标注为测试域专用**：其可用性依赖 SSH 会话存活与
  端口转发状态，且对端进程事实的可核实性受限于通道本身。它适合测试域取证，**不适合作为生产准入路径**。
- **生产承载尚未选定**。契约 §9.1.2 列出了候选与各自的待评估项（受管跨机对端通道 / 反向转发以外的
  持久隧道 / 承载与信任解耦）——**候选不是决定**，取舍属 Owner 级书面裁定（§9.1.4「批什么」④⑤）。
- 因此本 PR 的结论上限是：**测试域可签发、可取件、可验签**。不宣称生产可用、不宣称跨机信任成立、
  不宣称受保护身份已验证。
- 「远端对端自报进程事实仅由对端签名担保」这一信任口径**本轮未裁定**，登记在契约 v1.2.1 §9.1.4.1，
  归 Owner 门（INV-13 / G-Q2 未解除）。

## 已知事项

- 信任文件里的公钥是**部署侧**事实；对端自报的 `pid` / `startToken` / `commandDigest` 由对端签名，
  属于「对端对自己身份的承诺」，签发端只能验证签名，不能验证这些进程事实的真实性。
- 跨机受管对端信任的 Owner 门（INV-13 / G-Q2）尚未解除；本 PR 只把「票据可跨机取得」这条路打通，
  不代表跨机信任已被接受。
- 签发端存储的桌面槽是**单例**：同一测试域内第二个不同派发会被拒（`ERR_DESKTOP_NOT_FREE`），
  因此每轮验证用独立测试域。
- 契约 §3.2 字段表未列 `issued_at_ms` 的缺口属另一条线（#177 已记录）；契约侧已由 v1.2.1 回填该字段表，
  本 PR 未改动消息结构。

## 边界

不签发许可、不改许可消息结构、不改票据一次性语义、不开非回环监听、不碰服务/ACL/账号、
不部署共享 broker、不改共享 broker 的服务名与身份配置。
