# Go Rules

> Language-specific rules to complement `core-principles.md`.

## Error Handling

- Never ignore an error; discarding with `_` is a code smell.
- Wrap errors with `fmt.Errorf("context: %w", err)` to preserve the call chain.
- Only call `log.Fatal` or `panic` at the top level (handler/main); return errors from lower layers.

```go
// Good
if err := doSomething(); err != nil {
    return fmt.Errorf("doSomething failed: %w", err)
}

// Bad
doSomething() // error ignored
```

## Naming Conventions

- Package names: all lowercase, short, single word, no underscores.
- Interfaces: verb + `-er` suffix (`Reader`, `Stringer`, `Handler`).
- Exported symbols: **PascalCase**; unexported: **camelCase**.
- Use `iota` for constant groups.

## Concurrency

- Pass cancellation and timeouts via context, not global state.
- Every goroutine must have a defined exit condition to prevent leaks.
- Protect shared data with `sync.Mutex` or channels.
- Prefer channels for communication, `sync` primitives for state protection.

## Interface Design

- Keep interfaces small — typically 1–3 methods.
- Define interfaces at the consumer site, not the provider.
- Use interfaces for dependency injection to simplify testing.

## Project Layout

```
cmd/          # Executable entry points
internal/     # Private business logic (not importable externally)
pkg/          # Reusable public packages
```

## Toolchain

- `gofmt` / `goimports`: format before every commit.
- `golangci-lint`: CI integration with `.golangci.yml`.
- `go test ./...`: all tests must pass; aim for 70%+ coverage.
- `go vet`: must pass in CI.
