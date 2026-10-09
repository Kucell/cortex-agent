# ChatGPT / GitHub-native review: governance evidence bridge

> Status: EXPERIMENTAL Draft PR, NOT RELEASED. This is an opt-in, review-only evidence transport, not a new authoritative GovernanceStore, Task machine, L3 approval, remote Lease, or execution gateway.

## Purpose and topology

ChatGPT Web Chat sessions can work through GitHub APIs without installing the Cortex CLI or sharing a filesystem. Existing Remote & Detached Governance supplies ProjectIdentity, Git-backed GovernanceStore and git-remote WorkspaceIdentity; this proposal fills a narrowly defined gap: recording evidence of branch/PR review for a remote Chat session without forging approval status.

- Product repository carries source code, independent feature branches, tests and Draft PRs.
- Separately verified governance repository carries the actual project governance. For Cortex itself: Kucell/cortex-agent and Kucell/cortex-agent-agent.
- Resolve the product commit tree's .agent gitlink (mode 160000), its pinned SHA and the configured governance binding before attaching evidence. A matching repository name or chat comment is not proof of binding or live Owner.
- **Canonical current GovernanceStore status cannot be inferred** from a historical Git snapshot; a PR/comment/CI green is never a Decision, owning released Waitpoint, exclusive Lease, or fencing proof.

## Chat-only collaboration steps

1. Fetch exact current product main SHA, governance gitlink and relevant scoped Task/owned_files assignments; keep missing/unverified authority explicit.
2. Submit *review-only* code to an isolated branch and open a Draft PR, never main. Each write lane stays within its independent file scope. No PR review authorizes merge, deploy, real Host effects or release.
3. Run the exact focused test suites and existing regressions, not only a generic CI that omits the new tests. Record actual PR URL, head SHA, test command/exit and reviewer identity; otherwise record NOT_RUN/NOT_VERIFIED.
4. Prepare a deterministic review receipt with prepareChatGitHubReview. Submit only through an injected GitHub create-only file operation to the **governance review branch**, under activities/events/chat-github/<digest>.json. Never update/overwrite, retry past a conflict, or write canonical Task/Decision/Waitpoint/Lease objects.
5. Another Chat agent can fetch this receipt from the named review branch, verify the digest and re-fetch its referenced exact PR head for independent review. This receipt is *staged collaboration evidence*, not canonical progress until the legitimate governance Owner verifies and integrates it under existing workflows.
6. Official /start-task, /mission, /parallel, /handoff, resource-bound Decisions/Waitpoints and promotion to the canonical governance store require a legitimate bound authority/Owner/Lease. If there is no safe write authority, remain R0_REVIEW_ONLY and identify the missing gate; do not simulate CLI execution.

## Example (host-agnostic injected GitHub operation)

~~~javascript
const { prepareChatGitHubReview, submitChatGitHubReview } =
  require("./lib/governance/chat-github-review.js");

const receipt = prepareChatGitHubReview({
  project_ref: "cortex-agent",
  product_repository: "Kucell/cortex-agent",
  governance_repository: "Kucell/cortex-agent-agent",
  governance_gitlink_sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", // REPLACE with observed gitlink
  product_head_sha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", // REPLACE with observed commit
  product_branch: "review/v116-c-next-action",
  record_branch: "review/v116-a-chat-github", // must exist in governance repository
  actor_id: "chat-c",
  task_ref: null, // unknown is better than inventing a Task
  action: "patch-submitted",
  changed_paths: ["lib/next-action/advisor.js"],
  patch_digest: null,
  pull_request_url: null,
  test_status: "not-verified",
  observed_at: "2026-10-09T07:00:00.000Z"
});

// On an authorized review branch, a host may supply a create-only GitHub operation:
// await submitChatGitHubReview(receipt, {
//   createFile: ({ repository_full_name, branch, path, content, message }) =>
//     githubConnector.createFile({ repository_full_name, branch, path, content, message })
// });
~~~

The helper builds review data, checks exact identifiers/digest and prohibits canonical writes by constraining the record branch to review/*. It does **not** authenticate repo/gitlink values, verify a live Owner, perform remote CAS/lease/fencing, validate real Decision/Waitpoint, or execute a L3 task. Callers must obtain authoritative binding/permissions separately. An API conflict is propagated with no blind retry or overwrite.

## Capability truth

| Capability | Current implementation |
| --- | --- |
| Chat GPT GitHub connector source commits and Draft PR | Available via connected GitHub API permissions; distinct from this library |
| Deterministic immutable review receipt candidate | Implemented in helper, review branch only |
| Cross-device reading of a review receipt | Possible after the review branch is pushed; reader must use the exact ref |
| Durable *canonical* Task/Mission progress and Owner/Lease | NOT implemented by this helper |
| Authoritative /handoff publish or Decision/Waitpoint release | NOT supported |
| GitHub multi-writer automatic L3 / sink-fenced remote effects | UNSUPPORTED |
| E2E release or formal G0 PASS | NOT VERIFIED until independent on-checkout evidence |

Run node --test tests/governance/chat-github-review.test.js to inspect the review-only boundaries. The accompanying GitHub workflow runs this test and existing provider/Git-store contracts on exact Draft PR heads; a workflow name or green unrelated check does not count as targeted test evidence.

## Forward compatibility

The reviewed adapter is provider-neutral at the receipt/authority boundary and deliberately avoids PostgreSQL, Redis, a separate daemon, a new LLM SDK or changing the legacy manual Dispatch. A future separately approved integration must bind the authoritative current GovernanceStore revision and implement a safe canonical evidence promotion gateway, verifiable optimistic concurrency and ownership, precise scope and independent review. That work cannot be inferred from merging a review-only transport.
