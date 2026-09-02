## Summary

Publish the locally-ahead commits on the `templates/en` directory plus a working-dir cleanup, so other project clones and `cortex-agent` consumers can pick up the L1 vcs-pr / secrets / marker fixes authored during the **M-024 MS-007 closeout**.

## Origin Story

The MS-007 DPI-MCP merge (MR !105) was previously blocked because `vcs-pr` did not forward `--sha` and the GitLab backend did not include `sha` in the merge payload. Two patches landed on `templates/en` to fix that, plus a `chore(templates): pre-push cleanups` commit bundles two working-dir edits that were pending on the same sub-tree.

## Commits in this PR (oldest first)

| sha | subject | lineage |
|---|---|---|
| `5ba340e` | chore(workspace): 同步工作区治理与验证修复 | cortex-agent governance |
| `ef512c5` | fix(memory): 修复反馈索引完整性 | cortex-agent governance |
| `5be32fc` | fix(governed): 禁止 Pi 派生 Host 注入 add-dir | cortex-agent governance |
| `557f2bf` | feat(mission-progress): 分发标准进度报告 | cortex-agent governance |
| `8c29cc2` | fix(vcs-pr): forward --sha on gitlab merge (GitLab 18+ mandatory) | M-024 / MS-007 closeout |
| `efa883a` | fix(vcs-pr): infer --squash from MR state on merge | M-024 / MS-007 closeout |
| NEW | chore(templates): pre-push cleanups for secrets generate + vcs-pr SKILL body template | M-024 / scope artifact |

The first 4 commits predate this PR scope and were authored in earlier sessions. They are included only because they are locally-ahead on `templates/en` and would otherwise block a fast-forward. This PR **does not amend their content**.

The last 2 commits (and the new cleanup commit) are the M-024 contribution.

## Validation

- Local smoke checks confirmed the patched `vcs-pr` skill still returns `ok: true` on `status` and `delivery-status` for MR !105.
- MR !105 was squash-merged into SamHMI main using the patched wrapper (merge commit `945ebaf`, squash commit `52f54dd`).
- The two new commits (`8c29cc2`, `efa883a`) and the cleanup commit are byte-identical between the `SamHMI/.agent/skills/vcs-pr/` L2 mirror and the `templates/en/.agent/skills/vcs-pr/` L1 template.

## Boundary

- Branch: `chore/templates-en-m024-and-cleanup-push`
- Base: `main`
- No direct push to `main`. Review and merge remain with the cortex-agent maintainers.
- No SamHMI / hmi-platform product code touched.
- No external runtime executed by this PR.

## Related

- MS-007 closeout evidence: `hmi-platform/.agent/missions/M-024-ai-native-hmi-unified/evidence/ms007-vcs-pr-merge-patch-20260902.md`
- Decision: `D-M024-TEMPLATES-EN-PUSH-6833347c` (in HMI `hmi-platform/.agent/decisions/`)
