---
name: github-repo-research
description: Research public GitHub repositories efficiently by using DeepWiki as a codebase map, then verify important claims against the repository's current primary sources. Use for architecture research, unfamiliar repository analysis, dependency evaluation, implementation comparisons, or when a user supplies a GitHub or DeepWiki repository URL.
---

# GitHub Repository Research

Use DeepWiki for orientation and cross-file discovery. Treat GitHub and the checked-out source as authoritative.

## Workflow

1. Normalize `https://github.com/<owner>/<repo>` to `https://deepwiki.com/<owner>/<repo>`.
2. Open the DeepWiki overview and record its indexed commit hash and generation time when available.
3. Use the wiki table of contents to identify the architecture, lifecycle, extension, safety, state, and test pages relevant to the question.
4. Capture the source-file and line references behind each important claim.
5. Verify those claims against the same commit or the current GitHub/local source. If the current head differs, report the mismatch and prefer current source behavior.
6. Check the repository README, official docs, license, security notes, and recent changes before recommending adoption.
7. Compare the findings with the target project's constraints. Classify each idea as `adopt`, `adapt`, `defer`, or `reject`.

If DeepWiki has no index, is unavailable, or the repository is private, fall back to GitHub code search, a local clone, official documentation, and repository-native navigation tools.

## Evidence Rules

- Separate verified facts, DeepWiki summaries, and your own inferences.
- Never cite DeepWiki alone for security, privacy, licensing, API compatibility, or current behavior.
- Prefer permalinks pinned to a commit over branch-head links.
- Do not upload or submit private repository content to DeepWiki without explicit authorization.
- Include negative evidence: stale indexes, missing files, contradictory docs, or unverified behavior.

## Output Contract

Return a short conclusion, repository and index revisions, a relevant module map, findings with primary-source evidence, an adoption classification table, risks, and direct navigation/source links.

Keep DeepWiki links as navigation aids; keep source links as the evidence for conclusions.
