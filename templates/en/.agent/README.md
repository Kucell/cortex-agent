# Cortex Agent Template (.agent)

This directory is the **Single Source of Truth** for all AI governance rules, workflows, and capabilities.

For the full architecture design, see [docs/architecture.md](../docs/architecture.md).

## 🚀 Workflows

| Workflow | Description |
| :--- | :--- |
| `/arch-design` | Design new features, output architecture diagrams |
| `/plan` | Convert confirmed proposals into structured task lists |
| `/briefing` | Daily standup: current phase, active tasks, recommended entry points |
| `/start-task` | Load context, architecture pre-audit, delegate to planner |
| `/ship` | One-click delivery: code-review → commit → done → sync-plans |
| `/done` | Lightweight task completion: update task-progress.md |
| `/commit` | Conventional Commits with AI-generated messages (no AI attribution) |
| `/code-review` | In-depth review of current changes |
| `/bug-fix` | Structured bug analysis and fix workflow |
| `/handoff` | Create or resume a compact task handoff |
| `/mission` | Orchestrate long-running multi-milestone work |
| `/configure` | Interactive project setup: tech stack, language rules, architecture |
| `/agent-update` | Add or modify rules, workflows, or skills |
| `/scan-project` | Scan existing project, auto-generate module reference docs in `.agent/references/` |
| `/update-refs` | After iterations, detect changed modules and incrementally update reference docs |
| `/publish-docs` | Publish verified project knowledge into standalone developer docs under `docs/` |
| `/parallel` | Dispatch independent tasks to sub-agents in parallel |
| `/release` | SemVer release: analyze commits → bump version → commit + tag → npm publish |
| `/weekly-report` | Generate weekly report from Git history |
| `/sync-plans` | Align task states across concurrent tasks |
| `/migrate-rules` | Migrate legacy config files (e.g. .cursorrules) to this framework |
| `/sync-master` | Sync with default branch: fetch + rebase (stash-safe), no casual merge |

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
| `coordinator` | sonnet | context-budget, phase-gate, handoff, validation-contract, maturity-tracker | `/mission`, `/handoff`, `/parallel`, `/briefing` |

## 📜 Rules (selected)

| Rule | Role |
| :--- | :--- |
| `ai-behavior.md` | Git safety, minimal edits, plan-before-act, design confirmation, staged commits + `task-progress.md` resume |
| `integration-safety.md` | Cross-module calls: verify signatures, payload vs schema, avoid swapped args |
| `refactoring-safety.md` | Refactor without behavior change; don’t blindly “fix” all lints |
| `task-decomposition.md` | Large-requirement breakdown, multi-agent parallel judgment, task boundaries, and closure rules |

## 🛠 Skills

Reusable capabilities invoked by workflows or mounted on sub-agents.

| Skill | Description | Used By |
| :--- | :--- | :--- |
| `architecture-guard` | Guards architecture through automated audits and manual reviews | planner, implementer, code-reviewer |
| `code-evaluation` | Score code quality: reliability, performance, maintainability | implementer, code-reviewer |
| `security-scan` | Dependency vulnerabilities, dangerous APIs, supply chain risks | code-reviewer |
| `changelog-generator` | Auto-generate CHANGELOG from git commits (Conventional Commits) | documenter |
| `superpowers` | TDD workflow, debugging strategies, refactoring & git techniques | implementer |
| `handoff` | Compact task transfer between agents, sessions, or sub-agents | `/handoff` |
| `validation-contract` | Create and check executable validation contracts before implementation | Mission Lite, high-risk tasks |
| `agent-visibility` | Manage .agent Git visibility (Private / Ignore / Track) | Direct invocation |
| `sync-global` | Sync workflows and skills from `~/.agent` to current project | Direct invocation |
| `weekly-report` | Fetch and summarize Git logs into a weekly report | `/weekly-report` workflow |
| `cleanup-debug` | Prune old files under `.agent/debug` (optional `.playwright-mcp/`) | Direct invocation |
| `knowledge-lint` | Deterministic checks for knowledge structure and documentation integrity | Direct invocation |
| `doc-gardening` | Turn knowledge lint findings into low-risk maintenance recommendations | Direct invocation |
