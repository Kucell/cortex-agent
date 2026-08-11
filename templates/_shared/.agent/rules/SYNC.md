# L1 Framework Rules — Source of Truth & Publish Boundary

This document explains the **two-location architecture** for L1 framework rules
in the cortex-agent project, and how a rule is **authored, synced, and shipped**
to end users.

## TL;DR

| Concern | Location | Role |
|---|---|---|
| **Authoritative source** | `<repo>/.agent/rules/<name>.md` (state repo) | Mavis / humans edit here. Source of truth. |
| **Publishable copy** | `templates/_shared/.agent/rules/<name>.md` (main repo) | Carried by the npm package. Init copies it to user projects. |
| **User project** | `<user-project>/.agent/rules/<name>.md` | What end users see after running `cortex-agent init`. |

When you change a rule, **edit the state-repo copy first**, then mirror the
change to the template copy. The state-repo copy is the source of truth; the
template copy is a published snapshot.

## Why two locations

The cortex-agent repository has **two git repos** stacked on top of each other:

1. **Main repo** (`cortex-agent.git`) — the npm package source. Published to
   the npm registry as `cortex-agent`. The `package.json` `files` field
   controls what gets packed:

   ```json
   "files": [
     "bin", "lib", "templates", "hooks",
     "agents", "commands", "skills", ".claude-plugin"
   ]
   ```

   **Note:** `.agent/` (the state repo) is **not** in this list, so anything
   under `<repo>/.agent/` is invisible to the published package.

2. **State repo** (`cortex-agent/.agent/`, internally
   `cortex-agent-agent.git`) — runtime-continuity state, plans, decisions,
   runs, and the **authoritative** framework rules. This repo never reaches
   end users.

Because the state repo is not shipped, any L1 rule that lives only in
`.agent/rules/` would be invisible to users installing `cortex-agent` from npm.
That is the bug this document exists to prevent.

## Authoring workflow

When you add a new L1 rule:

1. **Write the rule** under `<repo>/.agent/rules/<name>.md` with the standard
   frontmatter (see `core-principles.md` for the schema reference). Use the
   state repo's git workflow to commit and review.

2. **Mirror to the template** by copying the file to
   `templates/_shared/.agent/rules/<name>.md`. Add a header comment marking
   the file as a published copy and pointing back to the source of truth.
   The file should be byte-identical except for that header comment.

3. **Localised variants** (optional) — if the rule needs Chinese / English
   variants:
   - `templates/zh/.agent/rules/<name>.md`
   - `templates/en/.agent/rules/<name>.md`

   When the init command runs, it first copies `_shared/`, then overlays the
   locale-specific directory. The locale copy wins for matching filenames.

4. **Validate the publish boundary** before releasing:

   ```bash
   # 1. Make sure the file is in the main repo, not the state repo.
   ls templates/_shared/.agent/rules/<name>.md

   # 2. Dry-run the npm pack and confirm the file is inside the tarball.
   npm pack --dry-run 2>&1 | grep -E 'rules/<name>\.md'
   ```

5. **Commit the template change** in the main repo with a Conventional
   Commits message that signals the publish-boundary fix, e.g.
   `fix(rules): ship <name>.md via templates/_shared`.

## Current shipped L1 rules

| Rule | State repo | `_shared` | `zh` | `en` | Notes |
|---|---|---|---|---|---|
| code-standards | ✓ | ✓ | ✓ | ✓ | Bilingual; both `zh/` and `en/` provided |
| commit-standards | ✓ | ✓ | ✓ | ✓ | Bilingual |
| lesson-capture | ✓ | ✓ | ✓ | ✓ | Bilingual |
| submission-workflow | ✓ | ✓ | ✓ | ✓ | Bilingual |
| tech-stack | ✓ | ✓ | ✓ | ✓ | Bilingual |
| llm-coding-behavior | ✓ | ✓ (new) | — | — | English source; Chinese translation is a follow-up |

The five legacy `_shared/` rules are written in Chinese; the `zh/` variants
are full Chinese and the `en/` variants are full English. The new
`llm-coding-behavior` rule ships only the English source for now — the
"shared" directory's contract is **shared across language locales**, and
fallback to the shared copy when no locale-specific override exists is the
correct behavior. The Chinese translation is a planned follow-up.

## Verification (8-11 21:10)

This two-location architecture was introduced to fix the publish-boundary
bug discovered while landing the curated-vendor-skills plan (Layer 1.1
Karpathy). The fix:

- `templates/_shared/.agent/rules/llm-coding-behavior.md` added in the main
  repo, byte-identical to the state-repo source.
- The five legacy `_shared/` rules (code-standards, commit-standards,
  lesson-capture, submission-workflow, tech-stack) were already correctly
  mirrored, so this is a pre-existing convention, not a new pattern.

Verified via `npm pack --dry-run` that the new file lands in the tarball
under `package/templates/_shared/.agent/rules/llm-coding-behavior.md`.
