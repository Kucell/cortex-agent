"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { prepareChatGitHubReview, submitChatGitHubReview } = require("../../lib/governance/chat-github-review.js");

const GITLINK = "a".repeat(40);
const HEAD = "b".repeat(40);
const COMMIT = "c".repeat(40);
function fixture() {
  return {
    project_ref: "cortex-agent",
    product_repository: "Kucell/cortex-agent",
    governance_repository: "Kucell/cortex-agent-agent",
    governance_gitlink_sha: GITLINK,
    product_head_sha: HEAD,
    product_branch: "review/v116-c-next-action",
    record_branch: "review/v116-a-chat-github",
    actor_id: "chat-c",
    task_ref: null,
    action: "patch-submitted",
    changed_paths: ["lib/next-action/advisor.js", "tests/next-action/advisor.test.js"],
    patch_digest: "sha256:" + "d".repeat(64),
    pull_request_url: "https://github.com/Kucell/cortex-agent/pull/52",
    ci_run_url: "https://github.com/Kucell/cortex-agent/actions/runs/37903768742",
    test_status: "not-verified",
    observed_at: "2026-10-09T07:00:00.000Z",
  };
}
function error(code, cb) { assert.throws(cb, e => e.code === code); }

test("deterministic digest, append-only scoped namespace, permanent no-authority flags", () => {
  const a = prepareChatGitHubReview(fixture());
  const b = prepareChatGitHubReview(fixture());
  assert.equal(a.sha256, b.sha256);
  assert.equal(a.path, b.path);
  assert.match(a.path, /^activities\/events\/chat-github\/[a-f0-9]{64}\.json$/);
  assert.equal(a.target_branch, "review/v116-a-chat-github");
  assert.equal(a.target_repository, "Kucell/cortex-agent-agent");
  assert.equal(a.record.authority, "none");
  assert.equal(a.record.execution_authorized, false);
  assert.equal(a.record.effect_permitted, false);
  assert.equal(a.record.canonical_governance_mutation, false);
  assert.equal(a.record.task_ref, null);
  assert.equal(a.record.ci_run_url, "https://github.com/Kucell/cortex-agent/actions/runs/37903768742");
});

test("reject unknown authority/approval injection and modified plan before any API effect", async () => {
  error("ERR_CHAT_REVIEW_FIELD_UNKNOWN", () => prepareChatGitHubReview({ ...fixture(), execution_authorized: true }));
  const plan = prepareChatGitHubReview(fixture());
  let invoked = 0;
  const api = { createFile: async () => { invoked++; return { commit_sha: COMMIT }; } };
  for (const altered of [
    { ...plan, target_branch: "main" },
    { ...plan, path: "decisions/D-X.json" },
    { ...plan, content: plan.content.replace('"none"', '"approved"') },
    { ...plan, sha256: "0".repeat(64) },
  ]) {
    await assert.rejects(submitChatGitHubReview(altered, api), { code: "ERR_CHAT_REVIEW_PLAN_TAMPERED" });
  }
  assert.equal(invoked, 0);
});

test("review-only branch restriction, repo collision, and bad source identifiers", () => {
  for (const name of ["main", "feat/write", "review/../main", "review/a.lock", "review/a//b"]) {
    error(name === "main" || name === "feat/write" ? "ERR_CHAT_REVIEW_NONCANONICAL_ONLY" : "ERR_CHAT_REVIEW_BRANCH_INVALID",
      () => prepareChatGitHubReview({ ...fixture(), record_branch: name }));
  }
  error("ERR_CHAT_REVIEW_REPOSITORY_COLLISION", () => prepareChatGitHubReview({ ...fixture(), governance_repository: "Kucell/cortex-agent" }));
  error("ERR_CHAT_REVIEW_SHA_INVALID", () => prepareChatGitHubReview({ ...fixture(), governance_gitlink_sha: "a".repeat(64) }));
  error("ERR_CHAT_REVIEW_SHA_INVALID", () => prepareChatGitHubReview({ ...fixture(), product_head_sha: "ABC" }));
  error("ERR_CHAT_REVIEW_PR_MISMATCH", () => prepareChatGitHubReview({ ...fixture(), pull_request_url: "https://github.com/other/repo/pull/2" }));
  error("ERR_CHAT_REVIEW_CI_MISMATCH", () => prepareChatGitHubReview({ ...fixture(), ci_run_url: "https://github.com/other/repo/actions/runs/3" }));
});

test("reject unknown action/status, invalid date, and file path escapes", () => {
  error("ERR_CHAT_REVIEW_ACTION_INVALID", () => prepareChatGitHubReview({ ...fixture(), action: "release-approved" }));
  error("ERR_CHAT_REVIEW_TEST_STATUS", () => prepareChatGitHubReview({ ...fixture(), test_status: "ci-green-authorized" }));
  error("ERR_CHAT_REVIEW_TIME_INVALID", () => prepareChatGitHubReview({ ...fixture(), observed_at: "2026-02-30T09:00:00Z" }));
  for (const p of ["../secret", "/tmp/secret", "a/../../b", "a\\b", "a//b", "./a", "a/./b"]) {
    error("ERR_CHAT_REVIEW_PATH_INVALID", () => prepareChatGitHubReview({ ...fixture(), changed_paths: [p] }));
  }
  error("ERR_CHAT_REVIEW_PATHS_DUPLICATE", () => prepareChatGitHubReview({ ...fixture(), changed_paths: ["a.js", "a.js"] }));
});

test("create-only API writes review namespace, not canonical governance; refuses missing API receipt", async () => {
  const plan = prepareChatGitHubReview(fixture());
  const calls = [];
  const api = { createFile: async arg => { calls.push(arg); return { commit_sha: COMMIT }; } };
  const out = await submitChatGitHubReview(plan, api);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].repository_full_name, "Kucell/cortex-agent-agent");
  assert.equal(calls[0].branch, "review/v116-a-chat-github");
  assert.equal(calls[0].path, plan.path);
  assert.equal(calls[0].content, plan.content);
  assert.equal(out.committed_sha, COMMIT);
  assert.equal(out.canonical_governance_updated, false);
  assert.equal(out.execution_authorized, false);
  await assert.rejects(submitChatGitHubReview(plan, { createFile: async () => ({}) }), { code: "ERR_CHAT_REVIEW_COMMIT_UNVERIFIED" });
  await assert.rejects(submitChatGitHubReview(plan, { updateFile: async () => ({}) }), { code: "ERR_CHAT_REVIEW_CREATE_ONLY_API_REQUIRED" });
});

test("failed remote create is propagated and not silently retried or overwritten", async () => {
  const plan = prepareChatGitHubReview(fixture());
  let attempts = 0;
  await assert.rejects(submitChatGitHubReview(plan, { createFile: async () => {
    attempts++;
    const e = new Error("conflict"); e.status = 409; throw e;
  } }), /conflict/);
  assert.equal(attempts, 1);
});

test("unverified tests remain unverified and input arrays cannot mutate record", () => {
  const input = fixture();
  const plan = prepareChatGitHubReview(input);
  input.changed_paths.push("decisions/FAKE.json");
  assert.equal(plan.record.changed_paths.length, 2);
  assert.equal(plan.record.test_status, "not-verified");
});
