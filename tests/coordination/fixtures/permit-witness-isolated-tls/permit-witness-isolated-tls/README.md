# 本机隔离真实 TLS 夹具

在支持相应 API 的 macOS 主机上运行：

```sh
node tests/coordination/fixtures/permit-witness-isolated-tls/run.cjs
```

`run.cjs` 创建独立 `.agent/runtime/permit-witness-isolated-tls/run-*`，编译并在强制 sandbox 下执行 `IsolatedTLS.swift`，输出 `summary.json` 及原始编译/TLS 日志。源码、日志、密钥属性、容器归属或清理检查不通过即失败，不自动改用可导出密钥、现有身份或放宽 sandbox。该夹具须显式运行，没有修改现有 CI、入口或实现。

## 安全边界

- 新建带进程内随机口令的专用 Keychain 文件，路径固定在本次 runtime；不传入口令参数或环境变量。使用 `SecKeyGeneratePair`，同时要求并验证 `extractable=false`、`permanent=true`，再通过该新密钥的 `SecKeychainItemCopyKeychain` 验证容器身份。这是 OS 容器内持久密钥，结束时删除容器；不是瞬态 Secure Enclave 方案，也不是私钥 PEM/P12 文件导出。
- 只导出新公钥点以构造证书，私钥仅交给 `SecKeyCreateSignature` 和 TLS；不导出或记录私钥、包装 key blob、容器口令。证书、SecIdentity 都只在进程内存中构造，不导入证书存储。
- 不查询、枚举、解锁现有 Keychain 或证书；不调用 `SecTrustEvaluate`，不修改默认 Keychain、搜索列表或信任设置。明确禁止交互提示及 core dump；缺失身份用 challenge callback 显式返回 nil。
- sandbox 仅允许 localhost 网络；监听端显式绑定 `127.0.0.1`，客户端使用该数值地址且要求 loopback 接口，不走 DNS。进程文件写入限定本次 runtime，并拒绝直接读写用户、系统和机器 Keychain 路径。OS 安全服务负责新容器操作；该 sandbox 不被宣称为对系统守护进程所有内部 I/O 的审计证明。
- 子进程环境由 `runtime.cjs` 构造固定白名单：PATH、LANG、LC_ALL 及本次 runtime 的 TMPDIR/TMP/TEMP、CLANG_MODULE_CACHE_PATH、XDG_CACHE_HOME；不继承父进程的凭据、代理、动态加载器、NODE_OPTIONS、DEVELOPER_DIR、SSLKEYLOGFILE 或其他变量。CoreFoundation 在子进程内部添加的 `__CF_USER_TEXT_ENCODING` 是唯一额外兼容项，runner 不从父环境传入它。编译和 TLS 子进程均使用相同环境策略。
- 用户 Keychain 禁止路径通过 `os.userInfo()` 的 OS 有效用户记录解析，不使用受 HOME 影响的 `os.homedir()`。在启动任何编译/TLS 子进程之前，要求 real UID、effective UID 与用户记录 UID 一致，主目录为规范绝对非根路径、由该 UID 拥有的真实目录且没有路径重定向。查询异常或校验失败直接拒绝，无 HOME/USERPROFILE 回退；只检查主目录元数据和 sandbox 规则，不读取现有 Keychain。
- Swift 在调用 `SecKeychainCreate` **之前**建立 defer 清理责任，并安装 SIGTERM/SIGINT 的协作式记录器。信号回调只记录终止，不并发删除正在创建的容器；创建返回后检查终止并执行 `SecKeychainDelete`。runner 转发终止到本次子进程组，等待退出/管道关闭后再检查残留；10 秒协作窗口耗尽才升级 SIGKILL，随后才做文件处理。终止不报告 TLS PASS，SIGTERM/SIGINT 分别以 143/130 退出。
- 父进程只处理本次 mkdtemp 目录内的 `test-only.keychain-db` 及严格匹配 `.sb-*` 的 sidecar：核对目录 dev/ino、真实路径、文件类型、所有者和单链接数，不递归、不跟随链接、不调用真实 Keychain 查询，也不扫描其他运行目录。未知后缀或不安全文件保留并报清理失败。正常退出仍必须有 OS 删除返回 0 的证据；异常退出后的 unlink 只证明本目录文件残留已处理，不等同于 OS Keychain 元数据已注销。
- 父进程在子进程退出后作最多 2 秒、至少 500ms 安静窗口的残留核查。它不能抵御父进程 SIGKILL、断电、系统创建调用无限挂起，或超出该窗口的安全守护进程迟到写入；这些情况下不能承诺无残留。不会自动清理旧运行或其他钥匙串，也不把同 UID 任意代码并发替换文件的攻击视为文件系统隔离已证明。

## 环境和终止回归

```sh
node --test tests/coordination/fixtures/permit-witness-isolated-tls/safety.test.cjs
```

该专用测试覆盖 OS 用户记录解析失败关闭、伪造父 HOME/USERPROFILE 时真实 Keychain 禁止路径仍存在、环境哨兵及完整 4 项 TLS、直接在 create-start 事件发送 SIGTERM、首次观察到容器文件时终止 runner、子进程 SIGKILL 后的本目录残留处理，以及符号链接/硬链接/未知后缀/其他运行目录保护。HOME 回归只检查规则字符串和子进程环境，不尝试访问真实 Keychain。创建中测试验证的是系统调用入口及首次文件出现的可观察窗口，不宣称测得 Security 守护进程内部指令位置。`--test-hold-after-create` 仅为独立夹具的确定性终止屏障，不用于正常运行；所有证据保留在 `.agent/runtime`。

## 4 项真实握手与应用数据检查

1. TLS 1.3 双向精确临时证书认证，服务端收到 24 字节固定测试请求，客户端收到 25 字节固定响应。请求发送使用 `.defaultMessage`；服务端不等 EOF，客户端不先半关闭。
2. 服务端证书不匹配：客户端 verifier 明确拒绝，握手失败/等待状态随后取消，无服务端应用输入。
3. 客户端证书不匹配：服务端 verifier 明确拒绝，无服务端应用输入。
4. 缺失客户端身份：显式返回 nil，服务端 `-9863 certificate required`，无服务端应用输入。

负例不能仅凭计时结束通过；必须观察明确 verifier 拒绝，或缺失证书对应 TLS 错误。TLS 1.3 客户端可能先于服务端认证结果进入 ready 并发送数据，因此负例的“无应用输入”指服务端未向应用层交付请求，不声称客户端没有发出 TLS 数据。

## 可宣称与不可宣称

通过仅证明 **单机 Network.framework ↔ Network.framework、受管测试密钥和本次证书白名单策略下的真实 TLS 1.3**。精确证书策略完全隔离于候选原生实现：不调用其信任评估，也不改变其链、吊销或授权策略。没有证明正式 PKI/吊销、证书轮换、跨实现、跨主机、独立见证、Windows Schannel、host/wire 整合、事务或安全恢复。

新证书带 server/client EKU 和 `.invalid` SAN，生成时验证自签名；握手 verifier 只匹配本次新证书的完整 DER，不执行一般用途 PKI 信任评估。原生候选中系统信任评估可能搜索现有证书存储，因此不能将本夹具等同于原生策略验收。

当前实现使用已弃用但本机仍支持的 Keychain 隔离 API，编译会有弃用警告。初步实验中 Secure Enclave 的永久性属性与瞬态要求不符，`SecKeyCreateRandomKey` 的 Keychain 路径又返回可导出属性，两者都在握手前停止；最终夹具只保留通过属性及容器验证的显式 Keychain 生成路径。其他机器若不支持该路径，报告阻碍，不放宽条件。
