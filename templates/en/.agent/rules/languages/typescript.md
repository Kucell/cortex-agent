# TypeScript Rules

> Language-specific rules to complement `core-principles.md`.

## Type System

- Never use `any`; use `unknown` and narrow the type.
- Prefer `interface` for object shapes, `type` for unions and utility types.
- Use `export type` to export types — avoids issues with `isolatedModules`.
- Annotate all function parameters and return types; don't rely solely on inference.

## Naming Conventions

- Types/interfaces: **PascalCase** — `UserProfile`, `ApiResponse`.
- Enum values: **PascalCase** — `Status.Active`.
- Variables/functions: **camelCase**.
- Module-level constants: **UPPER_SNAKE_CASE**.

## Error Handling

```typescript
// Prefer the Result pattern over wide try/catch blocks
type Result<T, E = Error> = { ok: true; value: T } | { ok: false; error: E };

function parseJson(raw: string): Result<unknown> {
  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch (e) {
    return { ok: false, error: e as Error };
  }
}
```

## Module Design

- One responsibility per file; aim to stay under 200 lines.
- Use barrel files (`index.ts`) to manage the public API.
- Avoid circular dependencies; refactor module boundaries when they appear.

## Async

- Use `async/await` everywhere; avoid Promise chains.
- Parallelize with `Promise.all` / `Promise.allSettled`, not sequential loops.
- Wrap legacy callbacks with `util.promisify` rather than mixing paradigms.

## Toolchain

- Strict mode: `"strict": true` in `tsconfig.json`.
- Linting: ESLint + `@typescript-eslint`; must pass in CI.
- Formatting: Prettier; do not adjust indentation manually.
