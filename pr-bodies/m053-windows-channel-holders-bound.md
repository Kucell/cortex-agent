## 背景

受管会话要判定的不是「协调者与子进程共享了哪些内核对象」——那会把 stdout、
控制台、秘密管道全算进来，于是每个干净会话都被报成有句柄转交。它要判定的是
**一个具体命名管道的某一个端**，由谁持有、有没有第三方。

上一版在真机上根本没跑起来：`Add-Type` 编译失败，调用方只看到一个
`powershell-failed:1`，没有任何 C# 诊断。

## 提交范围

1. **`lib/governed/windows-channel-holders.js`**
   - 新增 `readWindowsChannelHoldersBound()` 与 C# 的 `EnumerateBound()`：按管道全名
     的最后一段**精确**匹配（后缀匹配会让诱饵对象通过）、由 peer-pid API 判定的
     端角色、以及连接状态，三个条件**一起**成立才算命中；
   - 两端是**不同的内核对象**，持有者集合分别审计、从不合并：server 端的持有者集合
     看不到 client 端被转交，client 端单独审计；
   - 修掉两个真实缺陷（见下）。
2. **`lib/governed/windows-identity-facts.js`**：`runPowerShell` / `runPowerShellWithStdin`
   支持 `timeoutMs`，默认上限 120 秒。helper 会即时编译 C# 并遍历整机句柄表，
   不是瞬时的；无界等待会把慢机器变成卡死的协调者（独立复核风险 R11）。
3. **`tests/governed/windows-identity-facts.test.js`**：新增三条回归护栏（见下）。
4. **`pr-bodies/m044-ms004-revocation-issuing-end.md`**：归档 PR #162 的说明正文。

### 缺陷一：C# 源码被 JavaScript 模板字符串损坏

helper 源码是**嵌在 JavaScript 模板字符串里**的 C#。`LastIndexOf('\\')` 里的反斜杠
被模板解析吃掉，到达编译器的是 `LastIndexOf('\')` —— 那根本不是一个字符字面量
（CS1010 / CS1012）。新增的 `EnumerateBound` 还用了 `CultureInfo.InvariantCulture`
却漏了 `using System.Globalization;`（CS0103）。

改用 `Path.DirectorySeparatorChar`，源码里不再有需要转义的反斜杠。

### 缺陷二：client 端的角色判据永远不成立

真机实测：两个 peer-pid API 在**两端都**返回有效值 —— client 端报
`clientPid = 持有者自己`、`serverPid = 服务端 pid`；server 端报
`clientPid = 已连接的客户端`、`serverPid = 自己`。

原判据按「对端 pid」判端，于是只有 server 端能匹配。改为按**谁持有这个句柄**
定端：`serverPid == 持有者` 即 server 端，`clientPid == 持有者` 即 client 端。

## 验证结果

- 真机（Windows 开发机，生产代码路径）：`BOUND_PRODUCTION_OK=true`
  - server 端：5 个同名内核对象中只有 1 个是已连接的 server 端，持有者集合干净，
    第三方持有者 0；
  - client 端：1 个同名内核对象即 client 端，持有者集合干净，第三方持有者 0；
- `node --test tests/governed/windows-identity-facts.test.js`：17 项，15 通过 / 0 失败 / 2 跳过
  （跳过项需要 Windows 原生句柄表）；
- `node --test tests/governed/*.test.js`：310 项，304 通过 / **2 失败** / 4 跳过。
  两项失败都在 `tests/governed/codex-shadow-persist.test.js`，其被测模块与该测试文件
  都不在本次改动范围（`git diff --name-only` 无交集），属分支基线既有问题，未夹带修复。

### 回归护栏

1. 评估后的 C# 源码不得出现被截断的字符字面量；
2. 用到的 BCL 类型必须有对应 `using`；
3. 有 .NET SDK 时**真编译一次**评估后的 C# 源码。

第 3 条把「只有真机才发现」的错误前移到 CI 与本地。

## 边界与风险

- 本 PR 只提供**判定能力**，尚未接入 supervisor / session / executor 的受管通道；
  「句柄转交」目前只在探针里成立，成为运行期可判定的反例是下一步；
- 不新建 / 切换 Windows 账号，不做账号权限切换验证；
- 不把许可明文、私钥、批次密钥写入仓库、日志、证据、命令行或计划任务 Action；
- 不安装 SamHMI 生产服务。

## 相关功能

- 受管会话可以按**通道的一个端**回答「谁持有、有没有第三方」，
  而不再把共享的一切都算成通道；
- helper 运行有界，慢机器不会把协调者卡死。
