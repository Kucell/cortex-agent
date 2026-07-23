---
name: release
description: Prepare a SemVer release and protect tagging, pushing, and publishing with resource-bound Decisions and Waitpoints.
---

# Release Workflow (/release)

`/release` owns release candidate preparation, push, and publish coordination. The candidate must exist and pass validation before its exact resource is submitted for approval. Read-only analysis, `status`, `diff`, and local candidate checks do not require approval; push, publish, deploy, credential use, and destructive operations remain separately authorized.

## 1. Select the Candidate Version

Inspect the package metadata, latest tag, commits since that tag, and repository release policy. Infer the SemVer increment and ask the user to confirm the candidate version. Version confirmation chooses a candidate value; it is not release authorization.

## 2. Form the Candidate in the Workspace

1. Verify the working tree and active branch satisfy repository policy.
2. Update the required version files, lockfiles, plugin manifests, and changelog.
3. Build the candidate package or normalized candidate file list with the existing project tooling.
4. Do not commit, tag, push, publish, or deploy at this stage. The candidate must remain inspectable and reproducible.

## 3. Validate and Freeze the Candidate

Run the repository's tests, lint, type checks, build, package checks, and release-specific validation. Inspect `git status`, `git diff`, and the package contents. Calculate `candidate_digest` from the exact package bytes, or from a sorted normalized file list and contents when there is no archive.

Freeze package, version, registry, base commit, candidate digest, and tag as one exact resource:

```text
npm:<package>@<version>#registry:<registry>#base:<sha>#candidate-digest:<sha256>#tag:v<version>
```

Any candidate change requires validation and a new digest.

## 4. Request Candidate Approval

Use the digest prefix in both IDs:

```bash
cortex-agent decisions request --project . \
  --decision-id D-release-<version>-<candidate-digest8> \
  --gate release \
  --payload-json '{"type":"release","requested_by":"/release","prompt":"Approve the exact release candidate?","options":["approve","reject","revise"],"gate":{"action":"release","resource_ref":"<resource-ref>"}}'

cortex-agent waitpoints create --project . \
  --waitpoint-id WP-release-<version>-<candidate-digest8> \
  --gate release \
  --owner-workflow /release \
  --reason "Package, version, registry, base commit, candidate digest and tag require user approval" \
  --action release \
  --resource-ref "<resource-ref>" \
  --decision-id D-release-<version>-<candidate-digest8>
```

Stop and direct the user to `/approve decision D-release-<version>-<candidate-digest8>`. A Dashboard request or `--gate approve` string is not approval.

## 5. Revalidate and Consume the Waitpoint

After approval, rebuild and recompute the resource. Any package, version, registry, base commit, digest, or tag drift invalidates the old Decision. If unchanged, `/release` releases its own Waitpoint:

```bash
cortex-agent waitpoints release --project . \
  --waitpoint-id WP-release-<version>-<candidate-digest8> \
  --gate owner \
  --owner-workflow /release \
  --decision-id D-release-<version>-<candidate-digest8> \
  --released-by /release \
  --release-note "Approved Decision matches package, version, registry, base commit, candidate digest and tag"
```

## 6. Commit and Tag

Use `/commit` for the release candidate. Confirm that the release commit rebuilds to the approved `candidate_digest`. Create a local tag only when repository policy allows it and the tag, commit, and digest all match. Never overwrite or move an existing tag.

## 7. Authorize External Effects Separately

- **Push** requires a separate `action=external_side_effect` Decision/Waitpoint bound to remote URL, branch, tag, release commit, and push mode.
- **Publish** requires a separate `action=release` Decision/Waitpoint bound to package, version, registry, release commit, and candidate digest.
- **Deploy** requires its own `action=external_side_effect` approval.
- **Credentials** require a separate credential Decision/Waitpoint. The user supplies OTP at execution time; never store it in Decisions, logs, command history, or repository files.

Do not run scripts that implicitly chain version updates, commit, tag, push, publish, or deploy. Every protected action is consumed only by its owning workflow for the exact approved resource.
