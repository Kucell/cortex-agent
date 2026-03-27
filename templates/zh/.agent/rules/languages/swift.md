# Swift 规范

> 语言专属规则，补充 `core-principles.md` 通用原则。

## 命名规范

- 类型（struct/class/enum/protocol）：**PascalCase**（`UserProfile`、`NetworkManager`）。
- 方法/变量：**camelCase**（`fetchUser`、`isLoading`）。
- 布尔值以 `is`/`has`/`can` 开头（`isEnabled`、`hasPermission`）。
- 常量全局作用域用 `let`，模块私有用 `private let`。

## 值类型优先

- 优先用 `struct` 而非 `class`，数据模型用值类型。
- 只在以下场景用 `class`：需要引用语义、继承、Objective-C 互操作。
- 协议优于继承，面向协议编程（POP）。

```swift
// 好
struct User {
    let id: UUID
    var name: String
}

// 只有需要引用语义时才用 class
final class NetworkSession { ... }
```

## 可选值（Optional）

- 不强制解包（`!`），除非有编译时保证（IBOutlet、测试中的已知非空值）。
- 用 `guard let` 提前返回，减少嵌套；用 `if let` 处理局部可选。
- 避免可选链过长（超过 3 级），改用中间变量。

```swift
// 好
guard let user = session.currentUser else { return }
let name = user.profile.displayName

// 差
let name = session.currentUser?.profile?.displayName ?? ""  // 过长链式调用
```

## 并发（Swift 5.5+）

- 用 `async/await` 替代回调和 Combine（新代码）。
- 用 `Actor` 隔离共享可变状态，避免数据竞争。
- UI 更新在 `@MainActor` 上执行。
- 不使用 `DispatchQueue.global()` 做新代码，迁移到 structured concurrency。

```swift
// 好
@MainActor
func updateUI(with user: User) {
    nameLabel.text = user.name
}

func loadUser(id: UUID) async throws -> User {
    return try await userRepository.fetch(id: id)
}
```

## 错误处理

- 可恢复错误用 `throws`/`try`，不可恢复用 `fatalError`（仅开发阶段断言）。
- 自定义 `Error` 枚举携带上下文信息。
- 不用 `try!` 在生产代码中（测试中可用于已知安全调用）。

```swift
enum UserError: LocalizedError {
    case notFound(id: UUID)
    case unauthorized

    var errorDescription: String? {
        switch self {
        case .notFound(let id): return "User \(id) not found"
        case .unauthorized: return "Unauthorized access"
        }
    }
}
```

## SwiftUI 规范（若使用）

- View 只包含 UI 描述，业务逻辑放 ViewModel（`@Observable` 或 `ObservableObject`）。
- 用 `@State` 管理 View 本地状态，用 `@Binding` 向下传递可变状态。
- 避免 View 直接访问网络或数据库，通过 ViewModel 或 Environment。
- Preview 覆盖主要状态（loading/success/error）。

## 访问控制

- 默认 `private`，按需放开到 `internal`（模块内默认）或 `public`。
- 不对外暴露实现细节：`private(set)` 对外只读、内部可写。
- `final` 标记不需要子类化的 class（性能优化 + 意图表达）。

## 工具链

- `SwiftLint`：配置 `.swiftlint.yml`，提交前必须通过。
- `Swift Package Manager`：依赖管理，不混用 CocoaPods/Carthage（除非必要）。
- `XCTest`：单元测试，覆盖关键业务逻辑；UI 测试覆盖核心用户流程。
- `swift build && swift test`：提交前验证通过。
