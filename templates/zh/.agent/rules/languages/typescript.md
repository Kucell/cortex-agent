# TypeScript 规范

> 语言专属规则，补充 `core-principles.md` 通用原则。

## 类型系统

- 永远不用 `any`，用 `unknown` 然后做类型缩窄（narrowing）。
- 优先用 `interface` 描述对象形状，用 `type` 处理联合/工具类型。
- 导出类型时，用 `export type` 而不是 `export`，避免 isolatedModules 报错。
- 函数参数和返回值都必须写类型注解，不要依赖推断（入口函数除外）。

## 命名规范

- 类型/接口用 **PascalCase**：`UserProfile`, `ApiResponse`。
- 枚举值用 **PascalCase**：`Status.Active`。
- 普通变量/函数用 **camelCase**。
- 常量用 **UPPER_SNAKE_CASE**。

## 错误处理

```typescript
// 优先使用 Result 模式，避免大范围 try/catch
type Result<T, E = Error> = { ok: true; value: T } | { ok: false; error: E };

function parseJson(raw: string): Result<unknown> {
  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch (e) {
    return { ok: false, error: e as Error };
  }
}
```

## 模块设计

- 一个文件只做一件事，尽量保持在 200 行以内。
- 用 barrel 文件（`index.ts`）管理公开 API，内部实现不暴露。
- 避免循环依赖，遇到时重新考虑模块边界。

## 异步

- 全部用 `async/await`，不写 Promise chain。
- 并行操作用 `Promise.all` / `Promise.allSettled`，不要 for-loop 串行。
- 不要混用 callback 和 Promise，用 `util.promisify` 包装旧 API。

## 工具链

- 严格模式：`"strict": true` 在 `tsconfig.json`。
- Linting：ESLint + `@typescript-eslint`，CI 必须通过。
- 格式：Prettier，不要手动调整缩进。
