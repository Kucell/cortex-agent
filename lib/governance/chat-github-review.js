"use strict";

// Chat + GitHub review-only handoff transport.
// NOT a GovernanceStore, Decision/Waitpoint authority, distributed lease or effect gateway.
const crypto = require("node:crypto");
const KIND = "chat-github-review-receipt";
const SCHEMA_VERSION = "1";
const ACTIONS = Object.freeze(["patch-submitted", "test-observed", "review-observed", "handoff-proposed"]);
const EVIDENCE_STATUSES = Object.freeze(["not-run", "observed-pass", "observed-fail", "not-verified"]);
const RECEIPT_PREFIX = "activities/events/chat-github";

class ChatGitHubReviewError extends Error {
  constructor(code, field) {
    super(code + (field ? ": " + field : ""));
    this.name = "ChatGitHubReviewError";
    this.code = code;
    this.field = field || null;
  }
}
function fail(code, field) { throw new ChatGitHubReviewError(code, field); }
function object(v) { return v !== null && typeof v === "object" && !Array.isArray(v); }
function keys(v, expected, field) {
  if (!object(v)) fail("ERR_CHAT_REVIEW_OBJECT_REQUIRED", field);
  for (const k of Object.keys(v)) if (!expected.includes(k)) fail("ERR_CHAT_REVIEW_FIELD_UNKNOWN", field + "." + k);
}
function string(v, field) {
  if (typeof v !== "string" || !v.trim() || v !== v.trim() || /[\u0000-\u001f\u007f]/.test(v)) {
    fail("ERR_CHAT_REVIEW_FIELD_INVALID", field);
  }
  return v;
}
function repo(v, field) {
  string(v, field);
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}\/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(v) || v.includes("..")) {
    fail("ERR_CHAT_REVIEW_REPOSITORY_INVALID", field);
  }
  return v;
}
function sha(v, field) {
  if (typeof v !== "string" || !/^[a-f0-9]{40}$/.test(v)) fail("ERR_CHAT_REVIEW_SHA_INVALID", field);
  return v;
}
function digest(v, field) {
  if (v == null) return null;
  if (typeof v !== "string" || !/^sha256:[a-f0-9]{64}$/.test(v)) fail("ERR_CHAT_REVIEW_DIGEST_INVALID", field);
  return v;
}
function branch(v, field) {
  string(v, field);
  if (v.length > 160 || !/^[A-Za-z0-9][A-Za-z0-9_.\/-]*$/.test(v) ||
    v.includes("..") || v.includes("//") || v.endsWith("/") || v.endsWith(".lock")) {
    fail("ERR_CHAT_REVIEW_BRANCH_INVALID", field);
  }
  return v;
}
function path(v, field) {
  string(v, field);
  if (v.length > 512 || v.startsWith("/") || v.includes("\\") || v.includes("//") ||
    v.split("/").some(p => p === "." || p === ".." || p === "") ||
    !/^[A-Za-z0-9_./*?{}-]+$/.test(v)) fail("ERR_CHAT_REVIEW_PATH_INVALID", field);
  return v;
}
function iso(v) {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(v) ||
    !Number.isFinite(Date.parse(v))) fail("ERR_CHAT_REVIEW_TIME_INVALID", "observed_at");
  const canonical = new Date(v).toISOString();
  if (v !== canonical && v !== canonical.replace(/\.000Z$/, "Z")) fail("ERR_CHAT_REVIEW_TIME_INVALID", "observed_at");
  return v;
}
function prUrl(v, r) {
  if (v == null) return null;
  string(v, "pull_request_url");
  const m = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/([1-9][0-9]*)$/.exec(v);
  if (!m || m[1].toLowerCase() !== r.toLowerCase()) fail("ERR_CHAT_REVIEW_PR_MISMATCH", "pull_request_url");
  return v;
}
function reviewBranch(v) {
  branch(v, "record_branch");
  if (!v.startsWith("review/") || v === "review/") fail("ERR_CHAT_REVIEW_NONCANONICAL_ONLY", "record_branch");
  return v;
}
const INPUT_FIELDS = Object.freeze([
  "project_ref", "product_repository", "governance_repository", "governance_gitlink_sha",
  "product_head_sha", "product_branch", "record_branch", "actor_id", "task_ref",
  "action", "changed_paths", "patch_digest", "pull_request_url", "test_status", "observed_at",
]);

function normalizeInput(input) {
  keys(input, INPUT_FIELDS, "input");
  const product = repo(input.product_repository, "product_repository");
  const governance = repo(input.governance_repository, "governance_repository");
  if (product.toLowerCase() === governance.toLowerCase()) fail("ERR_CHAT_REVIEW_REPOSITORY_COLLISION", "governance_repository");
  const action = string(input.action, "action");
  if (!ACTIONS.includes(action)) fail("ERR_CHAT_REVIEW_ACTION_INVALID", "action");
  if (!Array.isArray(input.changed_paths) || input.changed_paths.length > 100) fail("ERR_CHAT_REVIEW_PATHS_INVALID", "changed_paths");
  const paths = input.changed_paths.map((value, i) => path(value, "changed_paths[" + i + "]"));
  if (new Set(paths).size !== paths.length) fail("ERR_CHAT_REVIEW_PATHS_DUPLICATE", "changed_paths");
  const testStatus = string(input.test_status, "test_status");
  if (!EVIDENCE_STATUSES.includes(testStatus)) fail("ERR_CHAT_REVIEW_TEST_STATUS", "test_status");
  return Object.freeze({
    project_ref: string(input.project_ref, "project_ref"),
    product_repository: product,
    governance_repository: governance,
    governance_gitlink_sha: sha(input.governance_gitlink_sha, "governance_gitlink_sha"),
    product_head_sha: sha(input.product_head_sha, "product_head_sha"),
    product_branch: branch(input.product_branch, "product_branch"),
    record_branch: reviewBranch(input.record_branch),
    actor_id: string(input.actor_id, "actor_id"),
    task_ref: input.task_ref == null ? null : string(input.task_ref, "task_ref"),
    action,
    changed_paths: Object.freeze(paths),
    patch_digest: digest(input.patch_digest, "patch_digest"),
    pull_request_url: prUrl(input.pull_request_url, product),
    test_status: testStatus,
    observed_at: iso(input.observed_at),
  });
}

/** Deterministic, bounded review receipt; never changes an authoritative Task/Decision/Waitpoint. */
function prepareChatGitHubReview(input) {
  const normalized = normalizeInput(input);
  const record = Object.freeze({
    schema_version: SCHEMA_VERSION, kind: KIND, authority: "none",
    execution_authorized: false, effect_permitted: false,
    canonical_governance_mutation: false, ...normalized,
  });
  const content = JSON.stringify(record, null, 2) + "\n";
  const hex = crypto.createHash("sha256").update(content).digest("hex");
  return Object.freeze({
    target_repository: record.governance_repository,
    target_branch: record.record_branch,
    path: RECEIPT_PREFIX + "/" + hex + ".json",
    sha256: hex, content, record,
  });
}

/** Inject a GitHub create-only API; never perform update/force/automatic retry. */
async function submitChatGitHubReview(plan, api) {
  if (!object(plan) || typeof plan.content !== "string" || !object(plan.record)) {
    fail("ERR_CHAT_REVIEW_PLAN_INVALID");
  }
  const rebuilt = prepareChatGitHubReview(Object.fromEntries(
    INPUT_FIELDS.map(k => [k, plan.record[k]])
  ));
  if (plan.content !== rebuilt.content || plan.path !== rebuilt.path || plan.sha256 !== rebuilt.sha256 ||
    plan.target_repository !== rebuilt.target_repository || plan.target_branch !== rebuilt.target_branch) {
    fail("ERR_CHAT_REVIEW_PLAN_TAMPERED");
  }
  if (!api || typeof api.createFile !== "function") fail("ERR_CHAT_REVIEW_CREATE_ONLY_API_REQUIRED");
  const result = await api.createFile({
    repository_full_name: rebuilt.target_repository,
    branch: rebuilt.target_branch,
    path: rebuilt.path,
    content: rebuilt.content,
    message: "docs(review): record chat handoff " + rebuilt.sha256.slice(0, 12),
  });
  if (!result || typeof result.commit_sha !== "string" || !/^[a-f0-9]{40}$/.test(result.commit_sha)) {
    fail("ERR_CHAT_REVIEW_COMMIT_UNVERIFIED");
  }
  return Object.freeze({
    ok: true, authority: "none", committed_sha: result.commit_sha,
    receipt_path: rebuilt.path, receipt_sha256: rebuilt.sha256,
    canonical_governance_updated: false, execution_authorized: false,
  });
}
module.exports = {
  KIND, SCHEMA_VERSION, ACTIONS, EVIDENCE_STATUSES, RECEIPT_PREFIX,
  ChatGitHubReviewError, prepareChatGitHubReview, submitChatGitHubReview,
};
