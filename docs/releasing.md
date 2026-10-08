# npm Release Workflow

Cortex Agent publishes the root `cortex-agent` package through GitHub Actions using npm Trusted Publishing (OIDC).

Workflow:

`.github/workflows/npm-release.yml`

The workflow is manual-only (`workflow_dispatch`). Merging to `main` never publishes npm automatically.

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

When `true`, the workflow performs the real release.

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
