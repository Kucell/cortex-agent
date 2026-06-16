# AI Behavior Guardrails

These rules reduce destructive edits, scope drift, and half-finished work across sessions.

## 1. Git discipline

- **Prefer rebase for branch sync**: use `git rebase`, not `git merge`, for everyday sync with the mainline. (Align with `/sync-master` when applicable.)
- **Never discard uncommitted work silently**: before `git reset --hard`, checkout overwrites, or other destructive commands, run `git status`. If there are local changes, `git stash` or warn the user first.

## 2. No surprise deletes or wide refactors

- **Do not delete files/folders** just because they look unused. Wait for an explicit “clean up” request and user confirmation.
- **Minimal edits**: fix the reported issue without rewriting unrelated, working code.

## 3. Avoid over-engineering

- **No extra UI/config/features** the user did not ask for.
- **Simplest fix first** (e.g. env vars locally) before large config or infra changes.

## 4. Plan before big moves

- For **large refactors, moves, complex integrations, or deep Git recovery**, give a **2–3 line outline** and wait for approval before coding.
- **Split huge asks** into smaller verifiable steps to avoid truncation mid-task.

## 5. Architecture awareness

- Read `.agent/rules/tech-stack.md` and `.agent/rules/architecture-design.md` before guessing stack or layout.

---

## 6. Two-step design confirmation

**When**: design docs, architecture notes, requirements, or `.agent/plans/*` are in play.

**Process**:

1. **Read fully** — no partial reads; load plan files with Read before acting.
2. **Play back** in three bullets: **goal**, **files/modules touched**, **out of scope**.
3. **Wait** for explicit OK before coding.

---

## 7. Staged commits and resume

**When**: multi-phase work (e.g. under `.agent/plans/`).

**Rules**:

1. **Commit after each phase** (see `commit-standards.md`), not only at the end.
2. **Update** `.agent/plans/task-progress.md` (active tasks table and/or a “resume” section), e.g.:
   ```
   ## Resume checkpoint (YYYY-MM-DD)
   - [x] Phase 1: ... (done, commit: abcdef)
   - [ ] Phase 2: ... (in progress)
   Blocker: none / ...
   ```
3. On **“continue”**, **read** `task-progress.md` first—do not restart from scratch.

> **Why**: limits blast radius on interrupts; `task-progress.md` is the cross-session handoff.

---

## 8. Prefer Graphify for Code Exploration

**Trigger**: understanding an unfamiliar module, tracing call chains, or mapping relationships across multiple files.

**Steps**:

1. **Check whether the graph exists first**:
   ```bash
   test -f graphify-out/graph.json && echo "available"
   ```
2. **If available, query Graphify before resorting to grep or file-by-file reads**:
   - Module relationships / call chains → `/graphify query "<keyword>"`
   - Connection path between two files/modules → `/graphify path "<file-a>" "<file-b>"`
   - Role and upstream/downstream of a node → `/graphify explain "<node-name>"`
3. **Read source files only as needed**: use the graph for orientation, then deep-read only the files that actually matter.

> **Why**: `graphify-out/graph.json` contains AST-level nodes and relationships for the whole project. A single query locates cross-file dependencies faster and cheaper than grep or sequential reads. Falls back gracefully to normal exploration when Graphify is not installed.
