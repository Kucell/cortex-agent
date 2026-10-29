# npm Release Workflow

Cortex Agent publishes the root `cortex-agent` package through GitHub Actions using npm Trusted Publishing (OIDC).

Workflow:

`.github/workflows/npm-release.yml`

The workflow publishes only from an explicit owner `workflow_dispatch` that carries the canonical private Decision/Waitpoint authorization as inputs. Merging to `main` only starts automatic read-only preflight; it never publishes by itself.

npm Trusted Publishing rejects OIDC tokens minted for `issue_comment` runs (`pull_request_target` is rejected as well), so a pull-request comment can no longer carry the publication itself. The human intent is still recorded by the canonical private governance records; the publish is always the dispatched run.

## Owner dispatch release (governed)

Publication has a single path: the repository owner runs `npm-release.yml` from
`main` and supplies the canonical private governance authorization for that
exact commit. The owner identity check and the Decision/Waitpoint gate both
run; neither replaces the other.

1. Finish and merge version metadata changes to `main` as usual.
2. Create the live release Decision and the owner-released Waitpoint for the
   exact current `main` through the authoritative `/release` owner.
3. Go to **Actions → npm Release → Run workflow**, select `main`, and provide:

   | Input | Value |
   | --- | --- |
   | `publish` | `true` to release, `false` for a read-only dry run |
   | `release_type` | `current` |
   | `dist_tag` | `latest` |
   | `release_pr` | the merged release-preparation PR number |
   | `expected_sha` | the exact current `main` commit SHA |
   | `decision_id` | the live release Decision ID |
   | `waitpoint_id` | the released Waitpoint ID |

   The equivalent command line is:

   ```bash
   gh workflow run npm-release.yml --repo Kucell/cortex-agent --ref main \
     -f publish=true -f release_type=current -f dist_tag=latest \
     -f release_pr=<PR> -f expected_sha=<mainSHA> \
     -f decision_id=D-release-... -f waitpoint_id=WP-release-...
   ```

4. GitHub Actions verifies the trusted event actor is the repository owner
   (`Kucell`), confirms checkout is exact remote `main`, reads package
   name/version from the checked-out commit, runs frozen install, architecture
   guard, product+CLI tests and npm package validation, and checks tag/registry
   conflicts. It repeats the owner and Decision/Waitpoint authorization before
   Git tagging and before npm publishing.
5. The only publish credential remains npm Trusted Publishing OIDC in
   `npm-release.yml`. The workflow saves an owner-dispatch receipt with
   repository, actor, version, exact commit and GitHub Actions run ID alongside
   release evidence. It never embeds a PAT or npm token in that artifact.
   Canonical governance may subsequently ingest this GitHub-native evidence;
   it must not mislabel it as a resolved Decision or released Waitpoint.
6. Direct GitHub-native publication is owner-only, and the canonical private
   Decision + released Waitpoint bound to the exact commit are mandatory in
   every dispatch. The repo variable `CORTEX_AUTO_RELEASE_ENABLED=false` must
   stay `false`; the read-only preflight fails closed when it is not.

**Safety note:** Selecting "Publish" is the deliberate public release action.
If the commit or version changes, the job stops and must be started again.
A GitHub Actions success alone from an unchecked run is a dry-run, not
evidence of npm publication.

## Single-maintainer exception — v1.15.6 only

A project with one authorized repository maintainer may release **v1.15.6 only**
without inventing a second GitHub reviewer, but this is **not** an implicit
override of CI or governance approvals:

1. The canonical private governance `/release` Decision must be genuinely
   `approved`, `resolved_by=interactive-user`, `workflow_gate=user`,
   `type=approval`, selected option **`approve-single-maintainer`**, and
   `options` must explicitly include that option. Its `rationale` must mention
   `single-maintainer` and `v1.15.6`.
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

## Approval-driven release

- **Automatic preflight:** `.github/workflows/npm-release-preflight.yml` runs after version-file changes land on `main`. This workflow has read-only permissions, runs architecture/contract tests and `npm pack --dry-run`, and never publishes.
- **Publish trigger:** the owner dispatches `npm-release.yml` from `main` with `publish=true` and the governance inputs listed above. Publication always runs under the `workflow_dispatch` event, because npm Trusted Publishing rejects OIDC tokens minted for `issue_comment` runs.
- **Credential prerequisite:** configure a read-only credential in secret `CORTEX_GOVERNANCE_READ_TOKEN` capable of reading the private `Kucell/cortex-agent-agent` Decision/Waitpoint files. Prefer a short-lived GitHub App installation token; do not use npm tokens or put credentials in versioned files.
- The release gate must verify the exact main commit, actual merged release-preparation PR (matching main or an ancestor in the explicitly approved v1.15.6 single-maintainer mode), accepted file scope, private interactive-user-approved Decision and owner-released Waitpoint for the exact main, and current package version. An ordinary approval requires a distinct write-authorized reviewer; the explicit v1.15.6 `approve-single-maintainer` mode waives only this reviewer identity requirement. Active `CHANGES_REQUESTED` is never waived.
- **Input format:** `release_pr` is the merged release-preparation PR number, `expected_sha` is the exact current `main` SHA, and `decision_id` / `waitpoint_id` are the IDs created by the authoritative `/release` owner after the exact-commit dry-run / approval process. Do not confuse a GitHub PR comment with the authoritative Cortex Decision/Waitpoint itself.
- Failure to verify anything (including unavailable private governance credential) blocks publication; no fallback to simulated approvals or `--force`.
- Publisher remains `npm-release.yml` with npm Trusted Publishing/OIDC. Publication uses `release_type=current`, `dist_tag=latest` and the existing validations/retry logic. **Manual dispatch is the only publication path; `publish=true` is not an authorization bypass.** It requires the same live private Decision + released Waitpoint, independent write-authorized review, and exact-head verification.

**Important:** A pull request that adds this automation cannot activate the trigger until it is separately reviewed and merged. The publish path is owner-dispatched and fail-closed; do not weaken the gate without a separately reviewed policy.


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

The release-preparation PR must already carry the intended version, so `current`
is the only accepted value; the workflow never bumps the version during a
governed publication.

### `dist_tag`

- `latest` — the only accepted value.

Prerelease publishing is not part of the governed path and requires a separate
reviewed policy.

### `publish`

Default: `false`.

When `false`, the workflow performs validation and release planning only. It does not change Git, npm, tags, or GitHub Releases.

When `true`, the workflow publishes only **after the Cortex release gate passes** for the exact current main commit. On manual `workflow_dispatch`, provide `release_pr` (merged metadata PR), `expected_sha` (current main SHA), `decision_id` and `waitpoint_id` (live canonical private governance records). Only the owner may publish, with `release_type=current` and `dist_tag=latest`. `publish=false` remains a safe dry-run and does not require Decision/Waitpoint inputs; it does not release anything. Configure `CORTEX_GOVERNANCE_READ_TOKEN` for the publication path.

Do **not** use manual `publish=true` to avoid an unmet review or governance requirement. If the private-governance read token is absent, all publication attempts fail closed.

## Release sequence

```text
workflow_dispatch
  ↓
main-branch guard
  ↓
owner identity + Decision/Waitpoint authorization
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

Re-dispatch from the updated `main` with the same governed inputs:

- `release_type=current`
- `dist_tag=latest`
- `publish=true`
- the same `release_pr`, `decision_id` and `waitpoint_id`
- `expected_sha` = the current `main` SHA

The existing tag is accepted only when it points to the current `HEAD`.

### npm package already published, GitHub Release failed

Re-dispatch with `release_type=current`, `dist_tag=latest`, `publish=true` and
the same governed inputs.

The workflow detects that the exact npm version already exists, skips duplicate `npm publish`, and continues to GitHub Release creation.

### Main changed during validation

The push is expected to fail rather than force-update `main`. Re-dispatch from
the new `main` with `expected_sha` set to the new commit. The Decision and
Waitpoint must be bound to that new `main` commit, so a stale pair fails
closed instead of publishing a different candidate.

## Release invariants

- Never force-push `main`.
- Never overwrite an existing npm version.
- Never reuse a tag that points at a different commit.
- Never publish from a non-`main` ref.
- Never place npm credentials in repository files, logs, governance state, or release evidence.
- Validation must pass before any Git or registry write occurs.
- The checked-in cross-tool anchor (`docs/cortex-agent/anchor.md`) must state the current version. It is a generated file: the release bump re-renders it from the anchor template, and the release consistency gate rejects a stale copy.

## Evidence

Every workflow run uploads:

`npm-release-pack-dry-run.json`

as the `npm-release-evidence` artifact for 30 days.

For a real release, the npm package/version, Git tag, release commit, workflow run, and GitHub Release together form the release evidence chain.
