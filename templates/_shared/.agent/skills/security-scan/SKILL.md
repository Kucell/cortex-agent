---
name: security-scan
description: 对代码变更进行安全扫描，覆盖依赖漏洞、危险 API 使用、供应链风险和常见安全反模式。由 code-reviewer 在 /code-review 和 /ship 流程中自动调用。
---

# 安全扫描技能 (security-scan)

灵感来源：[Snyk Security Skills](https://claudeskills.info/skill/snyk-security/) + [Trail of Bits Security Research](https://claudeskills.info/skill/trailofbits-security/)

## 触发时机

- `/code-review` 和 `/ship` 流程中由 `code-reviewer` 自动调用
- 手动触发：在 AI 助手中输入「安全扫描」或「security scan」

---

## 扫描维度

### 1. 依赖漏洞 (Dependency Vulnerabilities)

检查 `package.json` / `requirements.txt` / `go.mod` / `pom.xml` 等依赖文件：

```bash
# Node.js
npm audit --audit-level=moderate

# Python
pip-audit  # 或 safety check

# Go
govulncheck ./...
```

- 列出高危 (High/Critical) CVE，给出修复版本
- 标记不再维护的依赖

### 2. 危险 API 与反模式 (Dangerous APIs)

检查以下高风险代码模式：

| 风险类型 | 检查目标 | 说明 |
| :--- | :--- | :--- |
| 命令注入 | `exec()`, `eval()`, `shell=True` | 用户输入未过滤直接拼接命令 |
| SQL 注入 | 字符串拼接 SQL | 应使用参数化查询 |
| 路径遍历 | `../` 路径未过滤 | 可能逃逸到根目录 |
| 硬编码密钥 | `password=`, `api_key=`, `secret=` 出现在代码中 | 应使用环境变量或密钥管理服务 |
| 不安全反序列化 | `pickle.loads()`, `yaml.load()` (无 Loader) | 使用 `yaml.safe_load()` 替代 |
| 弱加密 | `MD5`, `SHA1`, `DES`, `RC4` | 改用 SHA-256+、AES-GCM |
| 明文传输 | `http://` 请求、禁用 TLS 验证 | 强制 HTTPS，验证证书 |

### 3. 认证与授权 (Auth)

- 是否存在缺少鉴权保护的 API 端点？
- JWT 是否验证签名？是否检查 `exp`？
- 是否存在权限越界（普通用户能访问管理接口）？

### 4. 输入验证 (Input Validation)

- 用户输入是否在进入业务逻辑前完成过滤和校验？
- XSS：前端是否使用 `innerHTML`、`dangerouslySetInnerHTML` 插入未转义内容？
- 文件上传：是否限制文件类型、大小和存储路径？

### 5. 供应链安全 (Supply Chain)

- 新增依赖是否来自知名、活跃维护的仓库？
- 是否存在拼写相似的包名（typosquatting）？
- 锁文件（`package-lock.json` / `poetry.lock`）是否随代码一起提交？

---

## 输出格式

```
## 🔒 安全扫描报告

### 🚨 高危（必须修复）
- [问题描述] → [修复方案]

### ⚠️ 中危（建议修复）
- [问题描述] → [修复方案]

### ℹ️ 低危（知悉即可）
- [问题描述]

### ✅ 通过项
- [已满足的安全检查项]
```

---

## 与其他技能的协作

- 先于 `code-evaluation` 运行：安全问题优先于质量问题修复
- 发现高危问题时，**阻断** `/ship` 流程，要求修复后重新运行
