# Python Rules

> Language-specific rules to complement `core-principles.md`.

## Type Annotations

- Annotate all function parameters and return types (Python 3.10+).
- Prefer `X | None` over `Optional[X]`.
- Use `TypeAlias` or `NewType` for complex, reused types.

```python
# Good
def fetch_user(user_id: int) -> User | None: ...

# Bad
def fetch_user(user_id):
    ...
```

## Naming Conventions

- Classes: **PascalCase**.
- Functions/variables: **snake_case**.
- Module-level constants: **UPPER_SNAKE_CASE**.
- Private members: `_single_leading_underscore`.

## Error Handling

- Only catch exceptions you know how to handle; avoid bare `except Exception`.
- Inherit custom exceptions from a project-level base exception class.
- Use `logging`, not `print`, for error output.

## Data Classes

- Use `@dataclass` or `pydantic.BaseModel` for structured data.
- Avoid passing multiple fields as plain dicts; use a dataclass instead.

## Module Design

- Single responsibility per module; consider splitting files over 300 lines.
- Manage public API via `__init__.py`.
- Avoid `from module import *`; list imports explicitly.

## Toolchain

- Ruff: unified linter + formatter, replacing flake8/black/isort.
- mypy or pyright for static type checking; must pass in CI.
- pytest for unit tests, placed in a `tests/` directory.
