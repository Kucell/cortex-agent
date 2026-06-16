# Architectural Design Principles (Template)

Please define core principles according to the project's actual architectural patterns (e.g., MVC, MVVM, Clean Architecture, Hexagonal, etc.).

## Core Design Philosophy

### 1. Separation of Concerns

- **[Rule Description]**: For example, UI separation from business logic, data access separation from service logic.

### 2. [Architectural Pattern Name] (e.g., Hexagonal Architecture)

- **[Rule Description]**: Explain responsibilities of core domain, ports, and adapters.

### 3. [Modularity Principles]

- **[Rule Description]**: Explain how to divide modules and their dependencies (e.g., prohibiting circular dependencies).

### 4. [Interfaces and Contracts]

- **[Rule Description]**: Emphasize programming to interfaces rather than implementations.

## Directory and File Standards

- `src/core/`: Core business logic/domain models.
- `src/api/`: External API calls.
- `src/components/`: Shared UI components.
- `src/utils/`: Utility functions.

## Architecture Review Checklist

- [ ] Does the code follow the predefined hierarchical structure?
- [ ] Is the coupling between modules at a reasonable level?
- [ ] Is there logical overreach (e.g., complex database queries in the UI layer)?
- [ ] Does the new feature follow existing extension patterns?
- [ ] Is there appropriate error handling and logging?

---

## Proposal Lifecycle

### Standard State Machine

```
draft → approved → in-progress → done
                              ↘ superseded
```

| Status | Meaning | When Entered |
| :----- | :------ | :----------- |
| `draft` | Working draft, not yet reviewed | When `/arch-design` produces output |
| `approved` | Approved, waiting for execution | Written automatically by `/approve <proposal>` |
| `in-progress` | Executing; vehicle created | Written automatically after `/approve` dispatches to `/plan` or `/mission` |
| `done` | Complete; output archived | Written automatically by `/done` or `mission COMPLETE` |
| `superseded` | Replaced by a newer proposal | Set manually; note the replacement proposal path |

### Dual-Track Archiving Principle

| Directory | Purpose | When Modified |
| :-------- | :------ | :------------ |
| `.agent/plans/proposals/` | **Active proposal**: contains execution details, open questions, Phase breakdown, and status transitions | Updated continuously from draft to in-progress |
| `docs/architecture/` | **Archived architecture doc**: stripped of execution noise; pure architecture description only | Written once the proposal reaches `done` |

> **Core principle**: Execution noise stays in `.agent/plans/proposals/`. Only after completion is the essence distilled into `docs/architecture/`.
> Documents in `docs/architecture/` should be clean, long-lasting architecture references — not execution logs.

### Bidirectional Link Convention

The proposal file header must maintain these fields:

```markdown
> **Status**: draft | approved | in-progress | done | superseded
> **Execution Vehicle**: pending approval | T-006~T-008 | M-002  (auto-filled by /approve)
> **Archived Doc**: — | docs/architecture/xxx.md  (auto-filled by /done or mission COMPLETE)
```

The execution vehicle (task or mission) must back-reference the proposal:

```markdown
<!-- task-progress.md task row -->
| T-006 | Implement xxx | Proposal: .agent/plans/proposals/xxx-proposal.md |

<!-- mission-plan.md header -->
> **Source Proposal**: .agent/plans/proposals/xxx-proposal.md
```
