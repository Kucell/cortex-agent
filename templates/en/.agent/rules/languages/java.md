# Java Conventions

> Language-specific rules. Supplement `core-principles.md` general principles.

## Naming Conventions

- Class names: **PascalCase** (`UserService`, `OrderRepository`).
- Methods/variables: **camelCase** (`getUserById`, `orderCount`).
- Constants: **UPPER_SNAKE_CASE** (`MAX_RETRY_COUNT`).
- Package names: all lowercase, reverse domain notation (`com.company.module`).

## Exception Handling

- Never catch `Exception` or `Throwable`; catch specific exception types only.
- Empty catch blocks are forbidden — at minimum log or rethrow.
- Business exceptions extend `RuntimeException`; checked exceptions are reserved for external-system interaction.
- Use custom exceptions with context (error code, message); avoid bare `new RuntimeException("message")`.

```java
// Good
} catch (DataAccessException e) {
    log.error("DB query failed for userId={}", userId, e);
    throw new UserNotFoundException("User not found: " + userId, e);
}

// Bad
} catch (Exception e) {
    // empty catch
}
```

## Dependency Injection

- Prefer constructor injection over `@Autowired` field injection — easier to test and makes dependencies explicit.
- Service dependencies reference interfaces, not concrete implementations.
- Configuration values via `@Value` or `@ConfigurationProperties` — no hardcoding.

```java
// Good
@Service
public class OrderService {
    private final OrderRepository repo;
    public OrderService(OrderRepository repo) { this.repo = repo; }
}

// Bad
@Autowired
private OrderRepository repo;
```

## Collections & Streams

- Prefer immutable collections: `List.of()`, `Map.of()` (Java 9+).
- Stream pipelines capped at 5 steps; split complex logic into named intermediate variables.
- Avoid nested Streams — readability first.
- Use `Optional` for potentially absent values; never return `null`.

## Concurrency

- No raw `Thread` usage; use `ExecutorService` or `CompletableFuture`.
- Shared state via `java.util.concurrent` utilities (`AtomicXxx`, `ConcurrentHashMap`).
- Keep `synchronized` blocks small — lock only the critical section.

## Spring Boot Conventions (if applicable)

- Controllers handle only parameter validation and Service delegation — no business logic.
- Service layer must not touch HTTP Request/Response directly.
- Repositories perform data access only — no business decisions.
- DTO and Entity are strictly separated; never expose Entity at the API layer.

## Toolchain

- `mvn verify` or `./gradlew check`: must pass before commit.
- `Checkstyle`: code-style enforcement configured via `checkstyle.xml`.
- `SpotBugs`: static analysis integrated in CI.
- Unit tests with JUnit 5 + Mockito; maintain ≥70% coverage.
