# Swift Conventions

> Language-specific rules. Supplement `core-principles.md` general principles.

## Naming Conventions

- Types (struct/class/enum/protocol): **PascalCase** (`UserProfile`, `NetworkManager`).
- Methods/variables: **camelCase** (`fetchUser`, `isLoading`).
- Booleans prefixed with `is`/`has`/`can` (`isEnabled`, `hasPermission`).
- Global-scope constants use `let`; module-private constants use `private let`.

## Value Types First

- Prefer `struct` over `class`; use value types for data models.
- Use `class` only when reference semantics, inheritance, or Objective-C interop is required.
- Protocols over inheritance — Protocol-Oriented Programming (POP).

```swift
// Good
struct User {
    let id: UUID
    var name: String
}

// Only use class when reference semantics are needed
final class NetworkSession { ... }
```

## Optionals

- No force-unwrap (`!`) unless there is a compile-time guarantee (IBOutlets, known-non-nil values in tests).
- Use `guard let` for early returns to reduce nesting; `if let` for local optionals.
- Avoid optional chains longer than 3 levels — use intermediate variables instead.

```swift
// Good
guard let user = session.currentUser else { return }
let name = user.profile.displayName

// Bad
let name = session.currentUser?.profile?.displayName ?? ""  // chain too long
```

## Concurrency (Swift 5.5+)

- Use `async/await` instead of callbacks and Combine (new code).
- Use `Actor` to isolate shared mutable state and prevent data races.
- UI updates must run on `@MainActor`.
- No `DispatchQueue.global()` in new code — migrate to structured concurrency.

```swift
// Good
@MainActor
func updateUI(with user: User) {
    nameLabel.text = user.name
}

func loadUser(id: UUID) async throws -> User {
    return try await userRepository.fetch(id: id)
}
```

## Error Handling

- Recoverable errors use `throws`/`try`; unrecoverable use `fatalError` (development-only assertions).
- Custom `Error` enums carry contextual information.
- No `try!` in production code (allowed in tests for known-safe calls).

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

## SwiftUI Conventions (if applicable)

- Views contain only UI description; business logic belongs in ViewModel (`@Observable` or `ObservableObject`).
- `@State` for View-local state; `@Binding` for passing mutable state downward.
- Views must not directly access the network or database — go through ViewModel or Environment.
- Previews cover the main states (loading/success/error).

## Access Control

- Default to `private`; open up to `internal` (module default) or `public` as needed.
- Hide implementation details: `private(set)` for externally read-only, internally writable properties.
- Mark classes that don't need subclassing with `final` (performance + intent).

## Toolchain

- `SwiftLint`: configured via `.swiftlint.yml`; must pass before commit.
- `Swift Package Manager`: dependency management; don't mix CocoaPods/Carthage (unless required).
- `XCTest`: unit tests covering critical business logic; UI tests covering core user flows.
- `swift build && swift test`: must pass before commit.
