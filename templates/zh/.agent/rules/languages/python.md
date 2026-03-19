# Python 规范

> 语言专属规则，补充 `core-principles.md` 通用原则。

## 类型标注

- 所有函数参数和返回值都用类型注解（Python 3.10+）。
- 优先用 `X | None` 代替 `Optional[X]`。
- 复杂类型用 `TypeAlias` 或 `NewType` 定义，方便复用和追踪。

```python
# 好
def fetch_user(user_id: int) -> User | None: ...

# 差
def fetch_user(user_id):
    ...
```

## 命名规范

- 类名：**PascalCase**。
- 函数/变量：**snake_case**。
- 模块级常量：**UPPER_SNAKE_CASE**。
- 私有方法/属性：`_single_leading_underscore`。

## 错误处理

- 只捕获你知道如何处理的异常，不要裸露的 `except Exception`。
- 自定义异常继承项目基础异常类，而不是直接继承 `Exception`。
- 用 `logging` 记录错误，不要 `print`。

## 数据类

- 推荐 `@dataclass` 或 `pydantic.BaseModel` 管理结构化数据。
- 避免用字典传递多个字段，改用 dataclass。

## 模块设计

- 每个模块职责单一，超过 300 行考虑拆分。
- 用 `__init__.py` 管理公开 API。
- 避免 `from module import *`，明确列出导入名称。

## 工具链

- Ruff：统一的 linter + formatter，取代 flake8/black/isort 三件套。
- mypy 或 pyright 做静态类型检查，CI 必须通过。
- pytest 做单测，测试文件放 `tests/` 目录。
