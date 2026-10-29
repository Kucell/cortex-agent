---
title: "Framework Generality"
description: "> cortex-agent is a generic agent-management framework. Code, config, rules and docs that ship to managed projects must not be bound to one field project: no project name, no project mission id, no private host, no personal account. Enforced by check-framework-generality.js."
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
# Framework Generality

> **Core rule**: cortex-agent is a *generic* agent-management framework.
> Everything it ships to a managed project must work for a project the
> framework has never heard of. A field project's identity — its name, its
> mission id, its host, its owner's account — has no meaning outside that
> project, so binding one into the framework is a defect, not a style
> preference.

---

## Why this is not fastidiousness

The distribution surface is every user's project. A field-project binding
in a distributed file fails in three ways, and **the third is the dangerous
one**:

1. **It is obviously wrong** — the example config names a repo that does not
   exist for the reader. Easy to notice.
2. **It resolves to something else** — the reader has a project with the
   same slug, or a host on the same address. The example silently points at
   the wrong thing.
3. **It appears to work** — the reader copies the example, it runs, and the
   framework's default quietly points at somebody else's repository. Nothing
   fails loudly. This is the worst case, because the reader has no signal
   that anything is wrong.

The third case is why a distributed config example is the most dangerous
place for a project name to appear: examples are *meant* to be copied.

---

## What must not be bound

| Category | Example | Write instead |
| :--- | :--- | :--- |
| Project name / slug | `repo: SamHMI` | `repo: your-repo` |
| Organisation | `org: SamkoonHMI` | `org: your-org` |
| Mission identifier | `M-053` | a generic term, or the traceable id in the governance repo |
| Private host | `http://192.168.2.110:3000` | `https://vcs.example.com` |
| Personal account | `account: xueyq` | `account: your-account`, or derive it at runtime |
| Keychain namespace | `namespace: SamHMI` | `namespace: your-project` |

**Derive, don't hardcode.** A default account is better computed than
guessed: `${ACCOUNT:-${USER:-$(id -un)}}` gives every user their own
account without the framework naming one.

---

## What is allowed, and why

Not every mention of a project is a binding. These are legitimate:

- **The framework's own identifiers.** Cortex-agent's `M-0xx`, `MS-0xx`,
  `VC-xxx-xxx` and `P-0xx` are its own traceability. They belong in the
  governance repository, and a commit body may reference them.
- **A field project's identifier inside a decision trail.** "Verified
  against `<project>`" is a fact worth keeping. Rewriting it would falsify
  the record of what was actually tested.
- **A document's *body* naming a project.** Same reason. The *title* is
  different: a framework document named after a field project reads as a
  component of that project, and that is policed.
- **Historical release notes and completed execution plans.** They record
  what shipped. A changelog rewritten to remove history is worse than one
  that names a project.

---

## Commit and branch hygiene

The same reasoning applies to the framework's own commits and branches:

- The **scope** of a commit is a stable module name (`coordination`,
  `runtime-layout`), never a mission or task id. See
  `commit-standards.md`.
- A **branch name** describes the change, not the project it was verified
  against.
- A commit **body** may reference a mission id — that is traceability, and
  traceability is the point of the governance repository.

---

## Enforcement

Prose does not stop a project name from reaching a distributed file, so the
rule is enforced mechanically:

| Rule | How it is obtained | Gate |
| :--- | :--- | :--- |
| `framework-generality.md` (this one) | **whether** a binding is allowed | `check-framework-generality.js` |

```bash
pnpm check:framework-generality
```

The gate scans the template tree, the framework's own source, and the
architecture documents. It reports a field project's identity, a field
mission id, a private host address, a personal account, and a field project
named in a document title or file name.

A file may be exempted, but an exemption must carry a reason: an exemption
without a reason is just a hole in the gate.

---

## Checklist

- [ ] Does this file ship to a managed project?
- [ ] Does it name a project, an org, a host, an account, or a mission id
      that only makes sense for one field project?
- [ ] Is the value the reader is meant to replace anyway?
- [ ] Would a reader on another machine, in another org, get a *working but
      wrong* default?
