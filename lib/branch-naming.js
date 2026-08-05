"use strict";

// ─── Branch Naming Validator (M-016 MS-001 / F-002) ──────────────────────────
//
// Enforces proposal §4 naming rules:
//   - type prefix whitelist: feat | fix | release | hotfix | chore
//   - body must be kebab-case slug
//   - total length ≤ 60 chars
//   - body must NOT be a bare task id (T-NNN, T-NNN-NNN, ...) — they carry
//     no semantic intent (proposal §4.2).
//
// Pure functions, side-effect-free. Used by:
//   - lib/branch-registry.js (validate before writing entries)
//   - lib/commands/branch.js (CLI create / cleanup validation)
//   - .agent/workflows/approve.md / .agent/workflows/commit.md

const VALID_PREFIXES = Object.freeze(["feat", "fix", "release", "hotfix", "chore"]);
const MAX_LENGTH = 60;
const KEBAB_CASE_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
// Bare task id body — T-NNN or T-NNN-NNN-... digit-only. Forbidden because it
// carries no semantic intent. T-NNN-<slug> is allowed (not bare).
const BARE_TASK_ID_RE = /^T-\d+(?:-\d+)*$/;

function splitBranchName(name) {
  if (typeof name !== "string" || name.length === 0) {
    return { ok: false, error: "branch_name_must_be_string" };
  }
  const slashIndex = name.indexOf("/");
  if (slashIndex <= 0 || slashIndex === name.length - 1) {
    return { ok: false, error: "branch_name_missing_prefix" };
  }
  const prefix = name.slice(0, slashIndex);
  const body = name.slice(slashIndex + 1);
  return { ok: true, prefix, body, fullName: name };
}

function isKebabCase(slug) {
  return typeof slug === "string" && slug.length > 0 && KEBAB_CASE_RE.test(slug);
}

function isValidPrefix(prefix) {
  return VALID_PREFIXES.includes(prefix);
}

function isBareTaskId(body) {
  return typeof body === "string" && BARE_TASK_ID_RE.test(body);
}

function validate(name) {
  const split = splitBranchName(name);
  if (!split.ok) {
    return { ok: false, error: split.error, name };
  }
  const { prefix, body, fullName } = split;
  if (fullName.length > MAX_LENGTH) {
    return { ok: false, error: "branch_name_too_long", max: MAX_LENGTH, length: fullName.length, name };
  }
  if (!isValidPrefix(prefix)) {
    return { ok: false, error: "branch_name_invalid_prefix", allowed: VALID_PREFIXES.slice(), got: prefix, name };
  }
  // Bare-task-id check before kebab-case so we surface the more specific error
  // (T-001 is not kebab-case anyway, but the diagnostic matters for triage).
  if (isBareTaskId(body)) {
    return { ok: false, error: "branch_name_body_is_bare_task_id", body, name };
  }
  if (!isKebabCase(body)) {
    return { ok: false, error: "branch_name_body_not_kebab_case", body, name };
  }
  return { ok: true, prefix, body, fullName, type: prefix };
}

// Derive kebab-case body from a proposal file path:
//   1. take the basename and strip `.md`
//   2. strip the package prefix `cortex-agent-` (case-insensitive)
//   3. lowercase
//   4. strip the trailing `-proposal` segment
//   5. collapse non-alphanumeric runs to `-`
//   6. trim leading/trailing `-`
// Examples:
//   cortex-agent-branch-management-proposal.md  → "branch-management"
//   dispatch-runtime-proposal.md                → "dispatch-runtime"
//   cortex-agent-BranchManagement-proposal.md   → "branchmanagement"
//   foo/bar_baz-qux.md                          → "bar-baz-qux"
function slugFromProposal(proposalPath) {
  if (typeof proposalPath !== "string" || proposalPath.length === 0) return null;
  const fileName = proposalPath.split("/").pop() || "";
  const stem = fileName.replace(/\.md$/i, "");
  let body = stem.replace(/^cortex-agent-/i, "");
  body = body.toLowerCase();
  body = body.replace(/-proposal$/, "");
  body = body.replace(/[^a-z0-9]+/g, "-");
  body = body.replace(/^-+|-+$/g, "");
  return body.length > 0 ? body : null;
}

function slugFromMissionId(missionId) {
  if (typeof missionId !== "string" || missionId.length === 0) return null;
  return missionId.toLowerCase();
}

module.exports = {
  VALID_PREFIXES,
  MAX_LENGTH,
  splitBranchName,
  isKebabCase,
  isValidPrefix,
  isBareTaskId,
  validate,
  slugFromProposal,
  slugFromMissionId,
};
