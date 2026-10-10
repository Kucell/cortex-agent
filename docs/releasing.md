# npm Release Workflow

Cortex Agent publishes the root `cortex-agent` package through GitHub Actions using npm Trusted Publishing (OIDC).

Workflow:

`.github/workflows/npm-release.yml`

The existing workflow supports manual `workflow_dispatch` **and** a strictly gated owner-command trigger (`issue_comment`). Merging to `main` only starts automatic read-only preflight; it never publishes by itself.

## Approval-driven release automation (opt-in)

- **Automatic preflight:** `.github/workflows/npm-release-preflight.yml` runs after version-file changes land on `main`. This workflow has read-only permissions, runs architecture/contract tests and `npm pack --dry-run`, and never publishes.
- **Publish trigger:** After release-preparation PR merges, the project owner posts the exact command below as a new comment **on the merged release-preparation PR**. The existing trusted workflow `npm-release.yml` then runs without clicking Actions / Run workflow.
- **Activation prerequisite:** configure repository variable `CORTEX_AUTO_RELEASE_ENABLED=true` **only after** configuring a read-only credential in secret `CORTEX_GOVERNANCE_READ_TOKEN` capable of reading the private `Kucell/cortex-agent-agent` Decision/Waitpoint files. Prefer a short-lived GitHub App installation token; do not use npm tokens or put credentials in versioned files.
- The release gate must verify: repository owner as commenter, merged release-prep PR, PR merged commit equals current `main`, strictly allowed metadata/test files, distinct independently approving reviewer **with repository write/maintain/admin access** on the exact source PR SHA and no outstanding change request, matching **interactive-user-approved release Decision** and **Owner-released Waitpoint** in the canonical private governance main bound to `release:cortex-agent@<actual-main-commit>`, non-expired gate, and the package version matching the requested version. Recheck Git main, release tag and private governance approval immediately before the npm publish side effect.
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
