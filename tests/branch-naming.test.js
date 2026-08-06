"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  VALID_PREFIXES,
  MAX_LENGTH,
  splitBranchName,
  isKebabCase,
  isValidPrefix,
  isBareTaskId,
  validate,
  slugFromProposal,
  slugFromMissionId,
} = require("../lib/branch-naming");

// ─── Constants ───────────────────────────────────────────────────────────────

test("branch-naming: VALID_PREFIXES contains feat/fix/release/hotfix/chore", () => {
  assert.deepEqual(VALID_PREFIXES, ["feat", "fix", "release", "hotfix", "chore"]);
});

test("branch-naming: MAX_LENGTH is 60", () => {
  assert.equal(MAX_LENGTH, 60);
});

// ─── splitBranchName ─────────────────────────────────────────────────────────

test("branch-naming: splitBranchName parses valid name", () => {
  const r = splitBranchName("feat/branch-management");
  assert.equal(r.ok, true);
  assert.equal(r.prefix, "feat");
  assert.equal(r.body, "branch-management");
  assert.equal(r.fullName, "feat/branch-management");
});

test("branch-naming: splitBranchName rejects empty string", () => {
  assert.equal(splitBranchName("").ok, false);
  assert.equal(splitBranchName("").error, "branch_name_must_be_string");
});

test("branch-naming: splitBranchName rejects non-string", () => {
  assert.equal(splitBranchName(null).ok, false);
  assert.equal(splitBranchName(42).ok, false);
  assert.equal(splitBranchName(undefined).ok, false);
});

test("branch-naming: splitBranchName rejects name without slash", () => {
  const r = splitBranchName("feat-only");
  assert.equal(r.ok, false);
  assert.equal(r.error, "branch_name_missing_prefix");
});

test("branch-naming: splitBranchName rejects name with empty body", () => {
  const r = splitBranchName("feat/");
  assert.equal(r.ok, false);
});

test("branch-naming: splitBranchName rejects name with empty prefix", () => {
  const r = splitBranchName("/something");
  assert.equal(r.ok, false);
});

// ─── isKebabCase ─────────────────────────────────────────────────────────────

test("branch-naming: isKebabCase accepts simple slugs", () => {
  assert.equal(isKebabCase("branch-management"), true);
  assert.equal(isKebabCase("a"), true);
  assert.equal(isKebabCase("a-1-b"), true);
  assert.equal(isKebabCase("v1"), true);
  assert.equal(isKebabCase("fix-2-thing"), true);
});

test("branch-naming: isKebabCase rejects non-kebab strings", () => {
  assert.equal(isKebabCase("BranchManagement"), false);
  assert.equal(isKebabCase("branch_management"), false);
  assert.equal(isKebabCase("branch management"), false);
  assert.equal(isKebabCase("branch.management"), false);
  assert.equal(isKebabCase("-leading"), false);
  assert.equal(isKebabCase("trailing-"), false);
  assert.equal(isKebabCase("--double--dash"), false);
  assert.equal(isKebabCase(""), false);
  assert.equal(isKebabCase(null), false);
  assert.equal(isKebabCase(undefined), false);
  assert.equal(isKebabCase(42), false);
});

// ─── isValidPrefix ───────────────────────────────────────────────────────────

test("branch-naming: isValidPrefix accepts whitelisted prefixes", () => {
  for (const p of VALID_PREFIXES) assert.equal(isValidPrefix(p), true);
});

test("branch-naming: isValidPrefix rejects unknown prefixes", () => {
  assert.equal(isValidPrefix("feature"), false); // common mistake
  assert.equal(isValidPrefix("bug"), false);
  assert.equal(isValidPrefix("main"), false);
  assert.equal(isValidPrefix(""), false);
});

// ─── isBareTaskId ────────────────────────────────────────────────────────────

test("branch-naming: isBareTaskId accepts digit-only T-NNN bodies", () => {
  assert.equal(isBareTaskId("T-001"), true);
  assert.equal(isBareTaskId("T-016"), true);
  assert.equal(isBareTaskId("T-12-34"), true);
  assert.equal(isBareTaskId("T-016-01"), true);
});

test("branch-naming: isBareTaskId rejects suffixed task ids", () => {
  assert.equal(isBareTaskId("T-001-add-coordination"), false);
});

test("branch-naming: isBareTaskId rejects lowercase / non-string", () => {
  assert.equal(isBareTaskId("t-001"), false);
  assert.equal(isBareTaskId(""), false);
  assert.equal(isBareTaskId(null), false);
  assert.equal(isBareTaskId(42), false);
});

// ─── validate (composite) ────────────────────────────────────────────────────

test("branch-naming: validate happy path", () => {
  const r = validate("feat/branch-management");
  assert.equal(r.ok, true);
  assert.equal(r.type, "feat");
  assert.equal(r.body, "branch-management");
});

test("branch-naming: validate rejects name > 60 chars", () => {
  // `feat/` is 5 chars, body is 60 chars -> total 65
  const body = "a".repeat(60);
  const r = validate(`feat/${body}`);
  assert.equal(r.ok, false);
  assert.equal(r.error, "branch_name_too_long");
  assert.equal(r.length, 65);
});

test("branch-naming: validate accepts name exactly 60 chars", () => {
  // `feat/` (5) + body (54) = 60
  const r = validate(`feat/${"a".repeat(54)}`);
  assert.equal(r.ok, true);
});

test("branch-naming: validate rejects name exactly 61 chars", () => {
  const r = validate(`feat/${"a".repeat(56)}`);
  assert.equal(r.ok, false);
  assert.equal(r.error, "branch_name_too_long");
  assert.equal(r.length, 61);
});

test("branch-naming: validate rejects non-kebab body", () => {
  assert.equal(validate("feat/BranchManagement").ok, false);
  assert.equal(validate("feat/branch_management").ok, false);
  assert.equal(validate("feat/branch management").ok, false);
});

test("branch-naming: validate rejects invalid prefix", () => {
  assert.equal(validate("feature/branch-management").ok, false);
  assert.equal(validate("bugfix/branch-management").ok, false);
});

test("branch-naming: validate rejects bare task id as body", () => {
  const r = validate("feat/T-001");
  assert.equal(r.ok, false);
  assert.equal(r.error, "branch_name_body_is_bare_task_id");
});

test("branch-naming: validate accepts all 5 prefixes", () => {
  for (const p of VALID_PREFIXES) {
    const r = validate(`${p}/some-feature`);
    assert.equal(r.ok, true);
    assert.equal(r.type, p);
  }
});

test("branch-naming: validate rejects T-NNN-slug (uppercase T breaks kebab-case)", () => {
  // Strict kebab-case wins — task-id-with-suffix is not on the allowlist.
  // Worktree branches (§10.2) can use task ids because worktree naming has a
  // separate escape hatch.
  const r = validate("feat/T-001-add-coordination");
  assert.equal(r.ok, false);
});

// ─── slugFromProposal ────────────────────────────────────────────────────────

test("branch-naming: slugFromProposal strips cortex-agent- prefix", () => {
  assert.equal(
    slugFromProposal(".agent/plans/proposals/cortex-agent-branch-management-proposal.md"),
    "branch-management",
  );
});

test("branch-naming: slugFromProposal keeps simple names", () => {
  assert.equal(
    slugFromProposal(".agent/plans/proposals/dispatch-runtime-proposal.md"),
    "dispatch-runtime",
  );
});

test("branch-naming: slugFromProposal normalizes underscores", () => {
  assert.equal(slugFromProposal("foo/bar_baz-qux.md"), "bar-baz-qux");
});

test("branch-naming: slugFromProposal lowercases mixed case", () => {
  assert.equal(
    slugFromProposal(".agent/plans/proposals/cortex-agent-BranchManagement-proposal.md"),
    "branchmanagement",
  );
});

test("branch-naming: slugFromProposal handles null/empty", () => {
  assert.equal(slugFromProposal(null), null);
  assert.equal(slugFromProposal(""), null);
  assert.equal(slugFromProposal(undefined), null);
});

// ─── slugFromMissionId ───────────────────────────────────────────────────────

test("branch-naming: slugFromMissionId lowercases", () => {
  assert.equal(slugFromMissionId("M-016"), "m-016");
  assert.equal(slugFromMissionId("M-002-self-bootstrap"), "m-002-self-bootstrap");
});

test("branch-naming: slugFromMissionId handles null/empty", () => {
  assert.equal(slugFromMissionId(null), null);
  assert.equal(slugFromMissionId(""), null);
  assert.equal(slugFromMissionId(undefined), null);
});
