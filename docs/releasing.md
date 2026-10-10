# npm Release Workflow

Cortex Agent publishes the root `cortex-agent` package through GitHub Actions using npm Trusted Publishing (OIDC).

Workflow:

`.github/workflows/npm-release.yml`

The existing workflow supports manual `workflow_dispatch` **and** a strictly gated owner-command trigger (`issue_comment`). Merging to `main` only starts automatic read-only preflight; it never publishes by itself.

## One-click GitHub Owner release (proposed streamlined mode)

For the single-maintainer `Kucell/cortex-agent` release path, the product
may use **GitHub-native owner dispatch as the explicit release authorization**.
It is an alternative authorization surface, **not a fabricated Cortex
Decision/Waitpoint**, and must be accepted by the separate project's governance
policy before the code is merged and used.

1. Finish and merge version metadata changes to `main` as usual.
2. Go to **Actions → npm Release → Run workflow** and select `main`.
3. Leave **Publish the prepared current version** unchecked to run the complete
   read-only release preflight; check it to deliberately release the committed
   version to npm `latest` and create the matching GitHub Tag and Release.
   There are **no PR number, SHA, Decision ID or Waitpoint ID form inputs**.
4. GitHub Actions verifies the trusted event actor is the repository owner
   (`Kucell`), confirms checkout is exact remote `main`, reads package
   name/version from the checked-out commit, runs frozen install, architecture
   guard, product+CLI tests and npm package validation, and checks tag/registry
   conflicts. It repeats exact-main+actor authorization before Git tagging
   and before npm publishing.
5. The only publish credential remains npm Trusted Publishing OIDC in
   `npm-release.yml`. The workflow saves an owner-dispatch receipt with
   repository, actor, version, exact commit and GitHub Actions run ID alongside
   release evidence. It never embeds a PAT or npm token in that artifact.
   Canonical governance may subsequently ingest this GitHub-native evidence;
   it must not mislabel it as a resolved Decision or released Waitpoint.
6. Direct GitHub-native publication is owner-only. Other projects and the
   existing optional owner-comment automation retain the strict separate
   governance Decision + Waitpoint approval verifier. The repo variable
   `CORTEX_AUTO_RELEASE_ENABLED=false` still disables comment automation,
   but does **not** prevent an explicit owner click on Run workflow.

**Safety note:** Selecting "Publish" is the deliberate public release action.
If the commit or version changes, the job stops and must be started again.
A GitHub Actions success alone from an unchecked run is a dry-run, not
evidence of npm publication. This change is a governance policy alteration,
not merely a form redesign.

## Single-maintainer exception — v1.15.4 only

A project with one authorized repository maintainer may release **v1.15.4 only**
without inventing a second GitHub reviewer, but this is **not** an implicit
override of CI or governance approvals:

1. The canonical private governance `/release` Decision must be genuinely
   `approved`, `resolved_by=interactive-user`, `workflow_gate=user`,
   `type=approval`, selected option **`approve-single-maintainer`**, and
   `options` must explicitly include that option. Its `rationale` must mention
   `single-maintainer` and `v1.15.4`.
2. A matching `released` Waitpoint must be released by `/release` with
   `workflow_gate=owner`. Both records must bind to the **actual current main**
   using `release:cortex-agent@<mainSHA>`; prior 1.15.0 release records are invalid
   for this candidate.
3. The release-preparation PR must really have merged, modify only reviewed
   metadata/verification paths, and its merge SHA must be an ancestor of current
   main. It need not equal current main when later safe fixes landed. Any
   `CHANGES_REQUESTED` review blocks the waiver.
4. The release-workflow preflight, exact-head tests, packaging, npm/tag
   collision checks and effect-time authority checks remain mandatory.
   This exception does not change GitHub permissions, npm Trusted Publishing
   or the Auto Release opt-in variable.
5. Future versions require independent reviewer approval unless a separately
   reviewed policy explicitly extends this exception. A chat message or PR
   comment does not create authoritative Decision/Waitpoint records.

The existing independent-review path remains the default when selected option
is `approve`. **Do not falsify an APPROVED GitHub Review to activate this mode.**

## Approval-driven release automation (opt-in)

- **Automatic preflight:** `.github/workflows/npm-release-preflight.yml` runs after version-file changes land on `main`. This workflow has read-only permissions, runs architecture/contract tests and `npm pack --dry-run`, and never publishes.
- **Publish trigger:** After release-preparation PR merges, the project owner posts the exact command below as a new comment **on the merged release-preparation PR**. The existing trusted workflow `npm-release.yml` then runs without clicking Actions / Run workflow.
- **Activation prerequisite:** configure repository variable `CORTEX_AUTO_RELEASE_ENABLED=true` **only after** configuring a read-only credential in secret `CORTEX_GOVERNANCE_READ_TOKEN` capable of reading the private `Kucell/cortex-agent-agent` Decision/Waitpoint files. Prefer a short-lived GitHub App installation token; do not use npm tokens or put credentials in versioned files.
- The release gate must verify the exact main commit, actual merged release-preparation PR (matching main or an ancestor in the explicitly approved v1.15.4 single-maintainer mode), accepted file scope, private interactive-user-approved Decision and owner-released Waitpoint for the exact main, and current package version. An ordinary approval requires a distinct write-authorized reviewer; the explicit v1.15.4 `approve-single-maintainer` mode waives only this reviewer identity requirement. Active `CHANGES_REQUESTED` is never waived.
- **Command format:** `/cortex-release publish v1.15.4 decision=D-release-... waitpoint=WP-release-...`. Substitute the actual IDs created by the authoritative `/release` owner after the exact-commit dry-run / approval process.
- Failure to verify anything (including unavailable private governance credential) blocks publication; no fallback to simulated approvals or `--force`.
- Publisher remains `npm-release.yml` with npm Trusted Publishing/OIDC. Automatic approvals use `release_type=current`, `dist_tag=latest` and the existing validations/retry logic. **Manual dispatch remains available for validation and governed publication; `publish=true` is no longer an authorization bypass.** Both manual publish and owner-comment publish require the same live private Decision + released Waitpoint, independent write-authorized review, and exact-head verification.
- PR #48 (CLI hotfix) and PR #51 (v1.15.4 release-preparation metadata) require independent Review and merge in that order before an automatic approval comment can succeed. Do not confuse a GitHub PR comment with the authoritative Cortex Decision/Waitpoint itself.

**Important:** A pull request that adds this automation cannot activate the trigger until it is separately reviewed and merged. The automatic publish path is disabled by default. Do not enable it without verified private-governance read access and a live review/approval process.


## Security model

The release job uses:

- GitHub-hosted `ubuntu-latest`;
- Node `24.19.0`;
- npm 11 with an explicit `>= 11.5.1` preflight;
- `permissions.id-token: write` for npm OIDC;
- `permissions.contents: write` only for the release commit/tag and GitHub Release;
- no long-lived npm write token;
- no `NPM_TOKEN` / `NODE_AUTH_TOKEN` publish secret.

Trusted Publishing authentication is detected by npm automatically in GitHub Actions.

## One-time npmjs.com setup

Before the first real publish:

1. Open the `cortex-agent` package on npmjs.com.
2. Open package settings → Trusted Publisher.
3. Select **GitHub Actions**.
4. Configure:
   - Organization or user: `Kucell`
   - Repository: `cortex-agent`
   - Workflow filename: `npm-release.yml`
5. Allow direct **npm publish** for this trusted publisher.
6. Save the configuration.
7. Run the first real release before the npm trusted-publisher setup expires.

The workflow filename is part of the npm OIDC trust relationship. Renaming the workflow requires updating the Trusted Publisher configuration on npmjs.com.

After Trusted Publishing is verified, traditional automation publish tokens should not be required.

## Running a release

Open GitHub Actions → **npm Release** → **Run workflow**.

The workflow must run from `main`.

Inputs:

### `release_type`

- `current` — publish the version already present in `package.json`.
- `patch` — bump the repository version before publishing.
- `minor` — bump the repository version before publishing.
- `major` — bump the repository version before publishing.

Use `current` when the repository already contains the intended release version.

### `dist_tag`

Default: `latest`.

Examples:

- stable: `latest`
- prerelease: `next`

### `publish`

Default: `false`.

When `false`, the workflow performs validation and release planning only. It does not change Git, npm, tags, or GitHub Releases.

When `true`, the workflow publishes only **after the Cortex release gate passes** for the exact current main commit. On manual `workflow_dispatch`, provide `release_pr` (merged metadata PR), `expected_sha` (current main SHA), `decision_id` and `waitpoint_id` (live canonical private governance records). Only the owner may publish, with `release_type=current` and `dist_tag=latest`. `publish=false` remains a safe dry-run and does not require Decision/Waitpoint inputs; it does not release anything. Configure `CORTEX_GOVERNANCE_READ_TOKEN` for both publication methods.

Do **not** use manual `publish=true` to avoid an unmet review or governance requirement. If the private-governance read token is absent, all publication attempts fail closed.

## Release sequence

```text
workflow_dispatch
  ↓
main-branch guard
  ↓
Node/npm/pnpm setup
  ↓
architecture guard
  ↓
focused product validation
  ↓
npm pack --dry-run
  ↓
resolve target version
  ↓
registry/tag conflict checks
  ↓
publish=false?
  ├── yes → report only
  └── no
       ↓
     version commit if needed
       ↓
     annotated vX.Y.Z tag
       ↓
     push main + tag
       ↓
     npm publish through OIDC
       ↓
     GitHub Release
       ↓
     evidence artifact
```

## Retry behavior

The release workflow is deliberately resumable.

### Version commit/tag pushed, npm publish failed

Re-run from the updated `main` with:

- `release_type=current`
- the same `dist_tag`
- `publish=true`

The existing tag is accepted only when it points to the current `HEAD`.

### npm package already published, GitHub Release failed

Re-run with `release_type=current` and `publish=true`.

The workflow detects that the exact npm version already exists, skips duplicate `npm publish`, and continues to GitHub Release creation.

### Main changed during validation

The push is expected to fail rather than force-update `main`. Re-run the release from the new `main`.

## Release invariants

- Never force-push `main`.
- Never overwrite an existing npm version.
- Never reuse a tag that points at a different commit.
- Never publish from a non-`main` ref.
- Never place npm credentials in repository files, logs, governance state, or release evidence.
- Validation must pass before any Git or registry write occurs.

## Evidence

Every workflow run uploads:

`npm-release-pack-dry-run.json`

as the `npm-release-evidence` artifact for 30 days.

For a real release, the npm package/version, Git tag, release commit, workflow run, and GitHub Release together form the release evidence chain.
