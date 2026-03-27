# Java 规范

> 语言专属规则，补充 `core-principles.md` 通用原则。

## 命名规范

- 类名：**PascalCase**（`UserService`、`OrderRepository`）。
- 方法/变量：**camelCase**（`getUserById`、`orderCount`）。
- 常量：**UPPER_SNAKE_CASE**（`MAX_RETRY_COUNT`）。
- 包名：全小写，反向域名（`com.company.module`）。

## 异常处理

- 不捕获 `Exception` 或 `Throwable`，只捕获具体异常类型。
- catch 块不能为空，至少记录日志或重新抛出。
- 业务异常继承 `RuntimeException`，检查型异常仅用于外部系统交互。
- 用自定义异常携带上下文（错误码、消息），不要裸抛 `new RuntimeException("message")`。

```java
// 好
} catch (DataAccessException e) {
    log.error("DB query failed for userId={}", userId, e);
    throw new UserNotFoundException("User not found: " + userId, e);
}

// 差
} catch (Exception e) {
    // 空 catch
}
```

## 依赖注入

- 优先构造器注入（不用 `@Autowired` 字段注入），便于测试和明确依赖。
- Service 依赖只通过接口引用，不直接依赖实现类。
- 配置值用 `@Value` 或 `@ConfigurationProperties`，不硬编码。

```java
// 好
@Service
public class OrderService {
    private final OrderRepository repo;
    public OrderService(OrderRepository repo) { this.repo = repo; }
}

// 差
@Autowired
private OrderRepository repo;
```

## 集合与 Stream

- 优先不可变集合：`List.of()`、`Map.of()`（Java 9+）。
- Stream 流水线不超过 5 步，复杂逻辑拆成具名中间变量。
- 避免嵌套 Stream，可读性优先。
- 处理可能为空的值用 `Optional`，不返回 `null`。

## 并发

- 不使用裸 `Thread`，用 `ExecutorService` 或 `CompletableFuture`。
- 共享状态用 `java.util.concurrent` 工具类（`AtomicXxx`、`ConcurrentHashMap`）。
- `synchronized` 块尽量小，只锁必要的临界区。

## Spring Boot 规范（若使用）

- Controller 只做参数验证和调用 Service，不包含业务逻辑。
- Service 层不直接操作 HTTP Request/Response。
- Repository 只做数据访问，不包含业务判断。
- DTO 和 Entity 严格分离，不在接口层暴露 Entity。

## 工具链

- `mvn verify` 或 `./gradlew check`：提交前必须通过。
- `Checkstyle`：代码风格检查，配置 `checkstyle.xml`。
- `SpotBugs`：静态分析，CI 集成。
- 单元测试用 JUnit 5 + Mockito，覆盖率保持 70% 以上。
