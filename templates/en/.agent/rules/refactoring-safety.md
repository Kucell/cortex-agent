# Refactoring safety

When renaming, cleaning, or auto-fixing lints, **preserve behavior**.

## 1. Don’t blindly “fix” every lint

Linters sometimes conflict with **intentional** code. Turning everything green can change behavior (extra deps → extra runs, loops, side effects).

**Before applying a fix, ask**:

1. What is the rule guarding against? Is the code **deliberately** different?
2. Could the suggested change add side effects, loops, or perf issues?
3. If we must suppress, is there a **short comment** explaining why?

If there is a **feedback loop** (state → rerender → dep change → same logic again), don’t “fix” blindly—keep intent and document suppressions per project standards.

### Appendix: hook dependency arrays (e.g. React)

Effect deps are sometimes **intentionally incomplete** to control frequency or break cycles. Adding unstable references can cause infinite loops. **Understand first**, then change; keep incomplete deps with a comment when required.

---

## 2. What “refactor” means + matrix

- **Refactor** = structure only, **same behavior**.
- After renames/extracts/type tweaks, re-check **null / undefined / empty / edge** cases.
- For branchy logic, use a small matrix: **input → expected behavior**.

If you change comparison style (e.g. number vs string), re-validate **null/undefined** behavior.

---

## 3. Isolate refactors from features

- Don’t mix **pure refactor**, **behavior fix**, and **new feature** in one commit.
- **Checklist**:
  - [ ] Call sites updated
  - [ ] Edge behavior unchanged
  - [ ] No drive-by “lint-only” behavior changes
  - [ ] Key paths tested

---

## 4. Takeaway

“Fixing” lints without understanding original ordering/deps is a common regression source. Tool hints are not mandatory commands—align with intent first.
