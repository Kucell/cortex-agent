# Windows 原生见证传输候选

状态：**可编译、默认拒绝的研究接线，不能用于生产或作为执行授权。**

仅新增本目录；没有修改 Node 适配器、协议、受保护存储或交付流程。
`src/Program.cs` 不读取 stdin、配置、环境凭据、服务身份或证书存储，
不连接网络。无参数时 Windows 退出码为 78，其他系统为 69；任何参数退出码为 64。
入口不写 stdout 或 stderr：拒绝只通过进程退出码表达，避免 stdout 满管道阻塞。
不承诺进程启动或系统调度一定在 1 秒内完成。不存在启用开关。
**该分帧为跨平台候选；业务协议和端到端互通尚未验证，禁止生产接入。**

## 目标与范围

用户选择两端使用 OS 证书存储和服务身份保护机器外见证凭据。本候选仅针对
Windows，采用 .NET 10 的 `SslStream`、`X509Store` 和 Windows CNG 密钥句柄。
程序集目标为 `net10.0-windows`；在其他系统可以执行隔离检查和拒绝入口，
原生传输有运行时 Windows 检查。不依赖第三方 NuGet 包。

| 文件 | 已实现的候选机制 | 边界 |
| --- | --- | --- |
| `WindowsCertificates.cs` | 只读打开 `LocalMachine/My`，SHA-256 完整证书指纹精确唯一选择；明确 EKU、签名 KU、有效期；仅持久机器 CNG 密钥，拒绝任何非 None 导出策略，仅允许微软软件或平台 KSP | 不证明实际服务身份、密钥 ACL、硬件不可克隆或管理员隔离；代码不执行私钥导出 |
| `NativeTls.cs` | 客户端与接受套接字的服务端接线；TLS 1.2/1.3、加密、禁用恢复和重协商；双方链检查、在线吊销、固定对端证书、明确角色 EKU；客户端额外验证 DNS 名称 | 没有监听器，入口不调用；旧帧接口始终拒绝，尚未接入新分帧 |
| `Frames.cs` | 二进制版本、操作、UUID 和长度校验；请求首字节、响应状态、关联信息及双向单帧 EOF 检查；取消传递 | 只检查请求载荷首字节，不验证 UTF-8、完整 JSON 或业务 schema；帧本身不构成 IPC 认证 |
| `Program.cs` | 在访问任何原生凭据或传输之前拒绝 | 有意不接入候选传输 |

TLS 验证保留平台链校验结果，要求 `SslPolicyErrors.None` 且链状态为空；
固定证书身份不能覆盖链、名称或吊销错误。链策略是系统信任、全链在线吊销、
无放宽标志、禁用 AIA 证书下载，单次 URL 获取时限为 2 秒。
缺失客户端证书、用途不符、过期、不可信、吊销状态未知及握手失败均不能返回数据。
服务端按客户端证书固定身份验证，不将客户端声明的 DNS 名称当作身份。
系统信任根及 DNS/时钟仍是部署可信计算基的一部分；本次未验证。

所有本地/对端证书指纹、DNS 和端口均只存在于未来受信启动流程构造的
`ProvisionedEndpoint` 中，本候选不提供外部加载入口。它不是受保护配置已实现的证据。
指纹格式是 64 位大写十六进制 SHA-256，未采用 SHA-1 存储查询或模糊名称匹配。
轮换需要受控修改注册信息，不能通过忽略旧指纹错误自动恢复。

## IPC 与远端消息草案

未来 Node 宿主应通过受保护的继承双工通道调用原生服务；必须验证服务实际
令牌、宿主身份、通道 ACL、继承句柄来源和句柄泄漏边界。任意进程可启动的
stdin/stdout 以及命名管道名称均不能证明宿主身份。仅限相同用户的权限也不能
替代服务 SID 及指定宿主绑定。本次没有开启命名管道、回环端口或 IPC 分发。

候选二进制帧以 4 字节无符号大端 body 长度开头。body 依次为版本 `01`、
操作 `01`（checkpoint）或 `02`（transition）、RFC 4122 顺序的 16 字节请求 UUID，
然后是载荷。请求载荷为 1–1,048,576 字节，首字节必须是 `{`（`0x7b`）。
业务层要求规范 JSON 对象，但此编解码层只检查首字节，并不验证 JSON 语法、
规范化、UTF-8、重复键或业务 schema；业务层必须独立完成这些验证。

响应在 UUID 后增加状态字节 `00..03`，之后是 1–1,048,576 字节的响应载荷，
因此状态加响应载荷最多为 1,048,577 字节。响应操作和 UUID 必须与请求匹配，
请求和响应都只允许一帧完整消息，并在其后要求 EOF；尾字节或第二帧均被拒绝。
请求首字节 `7b` 与合法状态不重叠，请求反射不能作为有效响应。读取 EOF 的等待
必须由宿主设置取消和超时；未来接线须验证真实 TLS 传输能够表达这一结束边界，
避免双方等待死锁。

固定 checkpoint 请求向量（UUID `00112233-4455-6677-8899-aabbccddeeff`、载荷 `{}`）：

```text
00000014010100112233445566778899aabbccddeeff7b7d
```

Windows 已验证该向量的编解码；尚未验证 macOS/JS 端到端互通、业务语义和授权。
候选编码器未连接到原生 TLS 接线，旧帧入口仍默认拒绝。

未来的传输不能将原始响应字节当作已认证主体或执行授权。
未来必须在原生验证后映射服务端注册主体，并将结果绑定到受保护 IPC 会话和
精确请求；不能由请求 JSON 提供映射事实。mTLS 认证不等于业务授权。

## 超时和不确定结果

候选传输创建 1 ms–30 s 的总截止令牌，覆盖连接、握手、写入、读取，外部取消
与其联动，并在取消时关闭套接字。帧读写每次传递令牌，没有自动重试。
同步的证书存储/密钥提供程序调用、DNS、CRL/OCSP 和 Schannel 原生工作不一定能被
托管令牌严格中断；2 秒 URL 策略也不是总时限证明。必须在真实 Windows 上测量，
必要时由可信宿主强制终止专用子进程，在确认退出前不得开启替代请求。
取消后的异常可以表现为取消、I/O、socket 或 disposed 错误；它们都不是成功。

发送后超时或断连不能证明远端未提交。未来业务必须以权威历史恢复，不能自动
重发消费或再次执行。状态查询只能返回历史，不能返回可重复执行授权。

## 启用前必备条件

1. 独立主机/回滚域上的见证服务及受保护信任根、配置和备份；两端服务 SID 和
   实际令牌验证；只授予对应服务的 CNG 密钥 ACL、证书存储/配置/二进制/父目录 ACL。
   目前 `ExportPolicy.None` 是提供程序策略检查，不证明 ACL 或恶意管理员防护。
2. 无人值守服务启动、受保护 IPC 宿主绑定与父进程退出清理、部署完整性验证。
   不得以 caller 声明、可猜测管道名、同用户身份、父 PID 或 `verified:true` 代替。
3. 真实 Windows 双机正向 mTLS 及负向矩阵：缺失/错误/过期证书、错误 DNS/EKU、
   不可信根、吊销、吊销服务不可达、错误服务身份/ACL、可导出密钥、重复证书、
   提供程序故障、轮换/替换、克隆及恢复后的历史保留。
4. connect/握手/吊销/半帧读取/阻塞写入的截止时间与取消测量，服务进程退出清理，
   并发/资源耗尽限制，禁止跨请求响应混淆和网络故障后的自动授权重试。
5. 权威注册、身份到目标/代际映射和按操作/资源授权；租约、围栏、吊销、消费及
   完整 checkpoint 在同一权威串行事务内提交。传输不能解决跨库原子性。
6. 完成 Windows、macOS、JS 的候选分帧互通验证，以及消息、业务协议、规范编码、
   历史兼容和共享测试向量；不得截断历史或把缺失水位当作零。上述验证及可信
   边界未完成前，禁止生产接入任何见证或 pin store。

此前版本的测试调用 `CreateSelfSigned`，在 macOS 上会创建临时 Keychain；原先
“只在内存中生成证书”的描述错误。本次已移除证书和密钥生成，不访问或清理
本机 Keychain，因此不能确认此前临时 Keychain 的清理状态。本次没有进行真实
Windows、服务账户、证书存储或双机 TLS 验证。

## 验证与复现

构建与运行输出、NuGet 缓存、CLI 首次运行文件和临时目录全部定向至
`.agent/runtime/permit-witness-windows/`。以下命令从仓库根运行；需要预装 .NET 10 SDK。
禁用 SDK 自动生成 ASP.NET 开发证书；`NuGet.Config` 清空源，项目无包依赖。
不要移除运行时目录重定向后直接 build。

```sh
mkdir -p .agent/runtime/permit-witness-windows/{dotnet-home,nuget,tmp}
export DOTNET_CLI_HOME="$PWD/.agent/runtime/permit-witness-windows/dotnet-home"
export NUGET_PACKAGES="$PWD/.agent/runtime/permit-witness-windows/nuget"
export TMPDIR="$PWD/.agent/runtime/permit-witness-windows/tmp"
export TMP="$TMPDIR" TEMP="$TMPDIR"
export PYTHONPYCACHEPREFIX="$PWD/.agent/runtime/permit-witness-windows/pycache"
export DOTNET_GENERATE_ASPNET_CERTIFICATE=false
export DOTNET_SKIP_FIRST_TIME_EXPERIENCE=1
export DOTNET_CLI_TELEMETRY_OPTOUT=1
export DOTNET_CLI_WORKLOAD_UPDATE_NOTIFY_DISABLE=true
export DOTNET_NOLOGO=1
dotnet build packages/permit-witness-windows/tests/PermitWitness.Windows.Tests.csproj \
  --configfile packages/permit-witness-windows/NuGet.Config --disable-build-servers \
  -p:NuGetAudit=false -p:UseSharedCompilation=false \
  > .agent/runtime/permit-witness-windows/build-request-eof.log 2>&1
dotnet .agent/runtime/permit-witness-windows/artifacts/bin/PermitWitness.Windows.Tests/Debug/net10.0-windows/PermitWitness.Windows.Tests.dll \
  > .agent/runtime/permit-witness-windows/tests-request-eof.log 2>&1
python3 -B packages/permit-witness-windows/tests/test_backpressure.py \
  > .agent/runtime/permit-witness-windows/backpressure-review-fixes.log 2>&1
```

本次在 macOS/.NET SDK 10.0.301 上编译：0 警告、0 错误，14 组隔离检查通过。
证书用途测试只构造 KU/EKU 扩展数据，不创建证书、密钥或 Keychain；测试不调用
`OpenLocal`、`chain.Build`、`WindowsIdentity` 或网络。

真实管道测试用非阻塞写入填满匿名管道，然后恢复阻塞写端，在父进程保持读取端
打开且不读取的情况下启动实际 helper；默认和伪造参数两种情况分别验证退出码、
1 秒内退出及没有额外写入。macOS 实测管道填入 65536 字节，退出耗时分别约为
0.020 和 0.018 秒。Windows 尚未运行该测试（Windows 需要 Python 3.12+ 的非阻塞
管道支持），实测结果不能证明任意系统的 1 秒硬实时保证。这些检查也不能证明
成功 mTLS 握手、密钥 ACL 或原生 TLS 的严格超时。
