# Go 规范

> 语言专属规则，补充 `core-principles.md` 通用原则。

## 错误处理

- 永远不忽略 error，用 `_` 丢弃 error 是代码坏味道。
- 用 `fmt.Errorf("context: %w", err)` 包装错误，保留调用链。
- 只在顶层（handler/main）调用 `log.Fatal` 或 `panic`，底层始终返回 error。

```go
// 好
if err := doSomething(); err != nil {
    return fmt.Errorf("doSomething failed: %w", err)
}

// 差
doSomething() // 忽略 error
```

## 命名规范

- 包名：全小写，简短，单词，不用下划线。
- 接口名：动词 + `-er` 后缀（`Reader`、`Stringer`、`Handler`）。
- 导出符号：**PascalCase**；未导出：**camelCase**。
- 常量组用 `iota`，有意义的常量用描述性名称。

## 并发

- 用 context 传递取消信号和超时，不要全局状态。
- goroutine 必须有退出条件，避免泄漏。
- 共享数据用 `sync.Mutex` 或 channel，不要裸访问。
- 优先用 channel 传值，sync 保护状态。

## 接口设计

- 接口越小越好，通常只有 1-3 个方法。
- 接口定义在消费方，不在提供方。
- 用接口隔离测试依赖（依赖注入）。

## 项目结构

```
cmd/          # 各可执行程序入口
internal/     # 私有业务逻辑（外部不可引用）
pkg/          # 可复用的公共包
```

## 工具链

- `gofmt` / `goimports`：提交前必须格式化。
- `golangci-lint`：CI 集成，配置 `.golangci.yml`。
- `go test ./...`：所有测试必须通过，覆盖率保持 70% 以上。
- `go vet`：CI 必须通过。
