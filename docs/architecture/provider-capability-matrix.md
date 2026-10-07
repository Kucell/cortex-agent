# Provider Capability & Validation Matrix

> Status: public capability reference
> Applies to: Remote & Detached Governance

## Principle

Cortex core is provider-neutral.

```text
Cortex Core
  ↓
GovernanceStore
  ↓
GitGovernanceStore
  ↓
RemoteGitProvider
  ↓
GitHub / GitLab / Gitee / Generic Git
```

Provider adapters expose portable capabilities. Provider-native terms remain metadata only.

## Capability matrix

| Capability | GitHub | GitLab | Gitee | Generic Git |
| :--- | :---: | :---: | :---: | :---: |
| `repository.resolve` | ✅ | ✅ | ✅ | ✅ |
| `branch.resolve` | ✅ | ✅ | ✅ | ✅ |
| `revision.read` | ✅ | ✅ | ✅ | ✅ |
| `branch.create` | ✅ | ✅ | ✅ | ✅ |
| `object.read` | ✅ | ✅ | ✅ | ✅ |
| `conditional-write` | ✅ | ✅ | ✅ | ✅ |
| `change-request.read` | ✅ | ✅ | ✅ | — |
| `checks.read` | ✅ | ✅ | ✅ | — |
| `identity.read` | ✅ | ✅ | ✅ | — |

Generic Git is intentionally the lowest common denominator. A missing optional hosted-provider capability is represented as `unavailable`, not fabricated as success or failure.

## Native terminology mapping

| Cortex portable concept | GitHub | GitLab | Gitee | Generic Git |
| :--- | :--- | :--- | :--- | :--- |
| ChangeRequest | Pull Request | Merge Request | Pull Request | unavailable |
| Checks | Checks / Actions | Pipelines | Gitee / third-party CI | unavailable |
| Identity | provider identity | provider identity | provider identity | transport/local identity only |

Core governance objects never depend on the provider-native names.

## Reconciliation behavior

Provider observations use three states:

- `observed`
- `unavailable`
- `unknown`

Policy decides whether an unavailable capability blocks resume.

```text
optional capability unavailable
  → DEGRADED
  → controlled resume may continue

required capability unavailable
  → BLOCKED
```

A failed observed CI/check is a governance gate and blocks resume.

## Validation levels

Cortex distinguishes implementation support from validation evidence.

| Provider | Adapter contract | Conformance suite | Live end-to-end provider pilot |
| :--- | :---: | :---: | :---: |
| GitHub | ✅ | ✅ | ✅ |
| GitLab | ✅ | ✅ | Not currently claimed |
| Gitee | ✅ | ✅ | Not currently claimed |
| Generic Git | ✅ | ✅ | Git protocol/store acceptance |

### What “live end-to-end” means

A provider is described as live validated only when real provider-backed repositories and revisions are observed, and the relevant remote behavior is executed rather than simulated.

GitHub live evidence currently covers the real product/governance topology used by Cortex itself.

GitLab and Gitee are supported through the provider adapter and conformance contract. Optional future live pilots may add stronger evidence without changing the core schema.

## CAS / conflict semantics

The portable concurrency contract is:

```text
read revision R
→ prepare mutation
→ conditional write expected=R
→ success OR RevisionConflict
```

Git-backed local/Generic Git validation also exercises `git update-ref` / `push --force-with-lease` style expected-revision semantics.

The stable Cortex error is `RevisionConflict`; provider-specific error codes do not leak into the core contract.

## Live acceptance tooling

The repository includes:

- `.github/workflows/rdg-ms012-live-provider.yml`
- `scripts/validation/rdg-ms012-live-provider.js`

These can be used for optional GitLab/Gitee live pilots against disposable test governance repositories.

The runner:

1. clones the provider repository as Session A and Session B;
2. records a shared base revision;
3. creates a temporary acceptance branch;
4. lets Session A conditionally push;
5. requires Session B's stale conditional push to fail;
6. verifies the winner from a fresh clone;
7. cleans up the temporary branch under a revision lease.

Provider credentials are supplied through external secrets and are not persisted in governance evidence.

See [MS-012 Acceptance Evidence](../validation/rdg-ms012-acceptance.md).
