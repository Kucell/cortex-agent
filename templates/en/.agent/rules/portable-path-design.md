---
title: "Portable Path Design"
description: '> cortex-agent ships to every managed project, so every path must hold on a machine that is not the author''s — a different home directory, a different package-manager layout, a different platform. Pinning a path to one machine is a defect, enforced by `check-portable-paths.js`.'
type: rule
scope: L1
applicable_to:
  - all
linked_workflows: []
linked_skills: []
owner: Kucell
last_verified: 2026-10-29
status: stable
---

# Portable Path Design

> **Core rule**: cortex-agent is a *generic framework*. The code, rules and
> workflows it installs into every managed project must work on a machine
> that is not the author's. Any absolute path that names one machine is a
> defect, not a style preference.

---

## Why this is not fastidiousness

The distribution surface of the framework is every user. A path pinned to one
machine fails in three ways, and **the third is the dangerous one**:

1. **It crashes elsewhere** — the path does not exist. Easy to notice.
2. **It resolves to something else** — the path happens to exist but is not
   what you meant. A `.volta` package root on another machine may point at an
   *older version* of the package.
3. **It appears to pass while verifying the wrong code** — hardest to notice,
   and the worst. A verification script that pins the package directory will
   verify an old version on another machine and still report success.

The third case is what this rule exists to stop: **the gate is not broken, the
verified subject is wrong.**

---

## The test

Before writing a path, ask: **does this path still mean anything on someone
else's machine?**

| Need | Portable spelling | Counter-example |
|---|---|---|
| The user's home | ``os.homedir()`` | `"/Users/<you>/.agent"` |
| An environment location | ``process.env.HOME`` / ``process.env.USERPROFILE`` | `"/home/<you>"` |
| The package's own location | `path.resolve(`__dirname`, "..", "..")` | `"/opt/app/lib/node_modules/cortex-agent"` |
| An installed package | ``require.resolve`("cortex-agent/package.json")` | a hardcoded prefix joined to the package name |
| A path inside the repo | derived from ``__dirname`` | `"/Users/<you>/myworks/cortex-agent"` |
| A version-manager directory | detected at runtime | `"/Users/<you>/.volta/tools/image/packages/..."` |
| The user's project | `--project` argument / cwd | a pinned demo project path |

### Allowed

- **Placeholders and examples** — `/Users/<you>/myproject`, `/Users/.../myproj`
  in documentation are templates, not bound paths.
- **Paths in comments** — naming a location to explain a lookup order is fine.
- **Runtime derivation** — ``os.homedir()``, ``__dirname``, ``require.resolve`()`,
  environment variables and arguments are portable by construction. Prefer them.

---

## The gate

The rule is prose, and prose does not stop code. The mechanical gate:

```bash
node scripts/`check-portable-paths.js`
```

Scanned trees: `templates/` (what reaches every project), the framework's own
governance tree `.agent/{skills,scripts,workflows,rules}`, and
`.agent/runtime-evidence/` (where reusable verification scripts actually live).

Three classes of violation:

| Rule | Meaning |
|---|---|
| `machine-specific-home-path` | a home directory with a real user name, written literally in code |
| `machine-specific-manager-root` | a version-manager install root spelled out (`.volta/`, `.nvm/`, …) |
| `machine-specific-windows-path` | a Windows directory pinned to one machine |

Documents are judged more conservatively: fenced code blocks and lines carrying
an example marker are treated as documentation and are not reported.

**The gate runs in CI** (`.github/workflows/full-test.yml`), so a regression is
blocked at PR time instead of surfacing when a user hits it on their machine.

---

## How this differs from runtime-artifacts-location

The two rules cover **different things**. Do not use one in place of the other.

| Rule | What it governs | Gate |
|---|---|---|
| ``runtime-artifacts-location.md`` | **where** an artifact lands (`.agent/`, not `/tmp`) | ``check-runtime-artifact-location.js`` |
| ``portable-path-design.md`` (this one) | **how** a path is obtained (derived at runtime, not pinned) | ``check-portable-paths.js`` |

One artifact can break both: writing to `/tmp` is a wrong landing place, and
writing to a literal `/tmp/some-specific-dir` is also a portability problem.

---

## Self-check

- [ ] Does the path hold on **someone else's** machine?
- [ ] Is the author's home directory, version-manager directory or repo path
      baked in?
- [ ] Does the verification script verify **the version it claims to**, or
      whatever happens to sit at that path?
- [ ] Are documented example paths placeholders (`<you>`, `...`) rather than
      real user names?
- [ ] Did you run `pnpm check:portable-paths`?

---

## Fixing a violation

1. Replace the literal with runtime derivation (see the table above).
2. If a root genuinely must be overridable, add an **environment variable** or
   a **CLI argument** with a derived default — do not hardcode it.
3. Run `node scripts/`check-portable-paths.js`` and confirm it is clean.
4. Run the script once and confirm it resolves to **the intended version** in a
   clean environment.

Do not work around it with an exemption. An exemption needs a reason, and the
reason is "this is not a bound path" — not "this one is inconvenient today".
