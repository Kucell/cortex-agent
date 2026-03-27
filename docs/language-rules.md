# 语言规范规则 (Language Rules)

> `.agent/rules/languages/` 目录下包含各主流语言的规范文件，通过 `/configure` 工作流激活后自动追加到 `.agent/rules/tech-stack.md`。

---

## 支持的语言

| 语言 | 规则文件 | 覆盖内容 |
| :--- | :--- | :--- |
| TypeScript / JS | `rules/languages/typescript.md` | 类型系统、命名规范、async/await、ESLint 配置 |
| Python | `rules/languages/python.md` | 类型注解、dataclass、Ruff 检查、mypy 配置 |
| Go | `rules/languages/golang.md` | 错误处理、并发模式、接口设计、golangci-lint |
| Java | `rules/languages/java.md` | 命名规范、异常处理、构造器注入、Spring Boot 分层、Checkstyle/SpotBugs |
| Swift | `rules/languages/swift.md` | 值类型优先、Optional 安全、async/await/Actor、SwiftUI ViewModel 分离、SwiftLint |

---

## 激活方式

### 方式一：通过 /configure 自动激活（推荐）

```
/configure
  → 步骤 3：选择主力编程语言
  → 自动读取对应规则文件，追加到 .agent/rules/tech-stack.md
```

追加格式：
```markdown
---
<!-- 以下由 /configure 自动注入：{语言} 语言规范 -->
{语言规则文件完整内容}
```

### 方式二：手动追加

直接将规则文件内容复制粘贴到 `.agent/rules/tech-stack.md` 末尾。

---

## Pre-commit 自动检查

语言规范与 `.agent/hooks/pre-commit-check.sh` 联动，每次文件编写后自动触发对应的 Lint 检查：

| 语言 | 检查工具 | 触发条件 |
|------|---------|---------|
| TypeScript / JS | ESLint | `*.ts`、`*.tsx`、`*.js`、`*.jsx` 文件编辑后 |
| Python | Ruff | `*.py` 文件编辑后 |
| Go | `go vet` | `*.go` 文件编辑后 |
| Java | Checkstyle | `*.java` 文件编辑后（需 `checkstyle.xml` 存在）|
| Swift | SwiftLint | `*.swift` 文件编辑后 |

所有 Lint 工具均为**可选**——未安装时跳过，不影响正常流程。

---

## 新增语言规则

1. 在 `.agent/rules/languages/` 新增 `{language}.md` 文件
2. 在 `pre-commit-check.sh` 中添加对应的 Lint 检查段
3. 在 `configure.md` 的语言选择列表中添加新条目

> 返回：[快速上手](./getting-started.md) | [自定义与演进](./customization.md)
