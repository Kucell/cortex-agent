# Cortex Agent Template (.agent)

This directory is the **Single Source of Truth** for all AI governance rules, workflows, and capabilities.

For the full architecture design, see [docs/architecture.md](../../docs/architecture.md).

## 🚀 Workflows

### Core Workflows (Phase 1 精简后)

| Workflow | Description | Priority |
| :--- | :--- | :--- |
| `/start-task` | Load context, architecture pre-audit, delegate to planner | ⭐ Core |
| `/ship` | **State machine delivery**: PLAN → EXECUTE → LINT → REVIEW → COMMIT → DONE | ⭐ Core |
| `/arch-design` | Design new features, output architecture diagrams | ⭐ Core |
| `/plan` | Convert confirmed proposals into structured task lists | ⭐ Core |
| `/briefing` | Daily standup: current phase, active tasks, recommended entry points | ⭐ Core |
| `/configure` | Interactive project setup: tech stack, language rules, architecture | ⭐ Core |
| `/parallel` | Dispatch independent tasks to sub-agents in parallel | ⭐ Core |
| `/agent-update` | Add or modify rules, workflows, or skills | ⭐ Core |
| `/migrate-rules` | Migrate legacy config files (e.g. .cursorrules) to this framework | ⭐ Core |

### Internal Steps (降级为 /ship 内部阶段)

| Workflow | Now Part Of | Phase |
| :--- | :--- | :--- |
| `/code-review` | `/ship` | Phase 3: REVIEW |
| `/commit` | `/ship` | Phase 4: COMMIT |
| `/done` | `/ship` | Phase 5: DONE |
| `/sync-plans` | `/ship` | Phase 5: DONE (auto-sync) |

### Optional Workflows (低频使用)

| Workflow | Description | When to Use |
| :--- | :--- | :--- |
| `/bug-fix` | Structured bug analysis and fix workflow | Bug triage scenarios |
| `/weekly-report` | Generate weekly report from Git history | Weekly reviews |
| `/release` | SemVer release: analyze commits → bump version → commit + tag → npm publish | Release management |
| `/scan-project` | Scan existing project, auto-generate module reference docs | Initial setup |
| `/update-refs` | Incrementally update reference docs | After major changes |
| `/sync-master` | Sync with default branch: fetch + rebase (stash-safe) | Branch sync with main/master |

## 🤖 Sub-agents

Specialized agents with isolated model, tools, and context boundaries.

| Sub-agent | Model | Skills | Trigger |
| :--- | :--- | :--- | :--- |
| `planner` | sonnet | architecture-guard | `/start-task`, `/parallel` |
| `implementer` | sonnet | architecture-guard, code-evaluation, superpowers | `/parallel` |
| `researcher` | sonnet | — | `/parallel` |
| `code-reviewer` | sonnet | architecture-guard, code-evaluation, security-scan | `/ship`, `/code-review` |
| `documenter` | haiku | changelog-generator | `/parallel`, `/ship` |
| `session-manager` | haiku | — | Long sessions; `session assess` / `archive` / `restore` / `status` / `warm` |

## 📜 Rules (selected)

| Rule | Role |
| :--- | :--- |
| `ai-behavior.md` | Git safety, minimal edits, plan-before-act, design confirmation, staged commits + `task-progress.md` resume |
| `integration-safety.md` | Cross-module calls: verify signatures, payload vs schema, avoid swapped args |
| `refactoring-safety.md` | Refactor without behavior change; don’t blindly “fix” all lints |

## 🛠 Skills

Reusable capabilities invoked by workflows or mounted on sub-agents.

| Skill | Description | Used By |
| :--- | :--- | :--- |
| `architecture-guard` | Guards architecture through automated audits and manual reviews | planner, implementer, code-reviewer |
| `code-evaluation` | Score code quality: reliability, performance, maintainability | implementer, code-reviewer |
| `security-scan` | Dependency vulnerabilities, dangerous APIs, supply chain risks | code-reviewer |
| `changelog-generator` | Auto-generate CHANGELOG from git commits (Conventional Commits) | documenter |
| `superpowers` | TDD workflow, debugging strategies, refactoring & git techniques | implementer |
| `agent-visibility` | Manage .agent Git visibility (Private / Ignore / Track) | Direct invocation |
| `sync-global` | Sync workflows and skills from `~/.agent` to current project | Direct invocation |
| `weekly-report` | Fetch and summarize Git logs into a weekly report | `/weekly-report` workflow |
| `cleanup-debug` | Prune old files under `.agent/debug` (optional `.playwright-mcp/`) | Direct invocation |
