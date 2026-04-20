# Integration & cross-module call safety

Reduce bugs from **wrong argument order**, **type mismatches**, and **misread contracts** when calling across layers, packages, or service boundaries.

## 1. Verify signatures

- **Read the callee first** — open the target function/source before editing call sites.
- **Match argument order** — never guess when multiple parameters share types (`string`, `object`, …).
- **Optional defaults** — note defaults and `undefined` branches.

## 2. Align payloads with contracts

- **Put fields in the right carrier** — body vs query vs headers vs path; don’t mix when proxying.
- **Minimize fields** — send only what the downstream contract allows; extra fields can break validation or behavior.
- **Prefer schemas** — Joi / Zod / OpenAPI win over naming guesses.

## 3. Log-based checks

- Log key inputs/outputs at boundaries (redact secrets).
- On vague errors (“bad request”, “validation failed”), compare **actual payload** to the expected model.

## 4. Anti-patterns

- **Swapped arguments** — `(ctx, id, body)` vs `(ctx, body, id)`.
- **Wrong carrier** — JSON in query string or the reverse.
- **Crypto/encoding assumptions** — plaintext vs encoded vs expected decoding step.
