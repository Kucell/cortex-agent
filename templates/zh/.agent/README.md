# Cortex Agent Template (.agent)

This directory is the **Single Source of Truth** for all AI governance rules, workflows, and capabilities.

For the full architecture design, see [docs/architecture.md](../../docs/architecture.md).

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
| `/configure` | Interactive project setup: tech stack, language rules, architecture |
| `/agent-update` | Add or modify rules, workflows, or skills |
| `/parallel` | Dispatch independent tasks to sub-agents in parallel |
| `/weekly-report` | Generate weekly report from Git history |
| `/sync-plans` | Align task states across concurrent tasks |
| `/migrate-rules` | Migrate legacy config files (e.g. .cursorrules) to this framework |

## 🤖 Sub-agents

Specialized agents with isolated model, tools, and context boundaries.

| Sub-agent | Model | Skills | Trigger |
| :--- | :--- | :--- | :--- |
| `planner` | haiku | architecture-audit | `/start-task`, `/parallel` |
| `implementer` | sonnet | architecture-audit, code-evaluation | `/parallel` |
| `researcher` | sonnet | — | `/parallel` |
| `code-reviewer` | sonnet | architecture-audit, architecture-check, code-evaluation | `/ship`, `/code-review` |
| `documenter` | haiku | — | `/parallel` |

## 🛠 Skills

Reusable capabilities invoked by workflows or mounted on sub-agents.

| Skill | Description | Used By |
| :--- | :--- | :--- |
| `architecture-audit` | Audit code changes against architecture layer rules | planner, implementer, code-reviewer |
| `architecture-check` | Fine-grained architecture constraint validation | code-reviewer |
| `code-evaluation` | Score code quality: reliability, performance, maintainability | implementer, code-reviewer |
| `agent-visibility` | Manage .agent Git visibility (Private / Ignore / Track) | Direct invocation |
| `sync-global` | Sync workflows and skills from `~/.agent` to current project | Direct invocation |
| `weekly-report` | Fetch and summarize Git logs into a weekly report | `/weekly-report` workflow |
