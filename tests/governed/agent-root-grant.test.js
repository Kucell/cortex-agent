"use strict";

// ─── agent-root-grant.test.js ─────────────────────────────────────────────────
//
// T-AGR-001: Worktree-shared .agent path-level authorization tests.
//
// Coverage:
//   managed project detection
//   pattern validation
//   canonical containment
//   read/write allow
//   read/write deny
//   Bash deny
//   manual add-dir deny (via launcher integration)
//   parent→child delegation subset
//   private-only non-leak
//   Claude argument insertion before -- separator

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  isManagedProject,
  isValidGrantPattern,
  getCanonicalAgentRoot,
  buildAgentRootGrant,
  checkAuthorization,
  validateDelegation,
  buildClaudeAddDirs,
  canonicalizeToExistingParent,
  checkPreToolUse,
  AGENT_ROOT_GRANT_SCHEMA_VERSION,
} = require("../../lib/governed/agent-root-grant.js");

// ─── Fixtures ────────────────────────────────────────────────────────────────

function makeWorktree() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-agr-test-"));
  fs.mkdirSync(path.join(root, ".agent", "rules"), { recursive: true });
  fs.mkdirSync(path.join(root, ".agent", "workflows"), { recursive: true });
  fs.mkdirSync(path.join(root, ".agent", "skills"), { recursive: true });
  fs.writeFileSync(path.join(root, ".agent", "rules", "test.md"), "# test\n");
  return root;
}

function closeWorktree(root) {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) {}
}

// ─── managed project detection ────────────────────────────────────────────────

test("isManagedProject: true for worktree with .agent/rules and .agent/workflows", () => {
  const root = makeWorktree();
  try {
    assert.equal(isManagedProject(root), true);
  } finally { closeWorktree(root); }
});

test("isManagedProject: false when .agent does not exist", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-agr-test-"));
  try {
    assert.equal(isManagedProject(root), false);
  } finally { closeWorktree(root); }
});

test("isManagedProject: false when .agent is a file", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-agr-test-"));
  try {
    fs.writeFileSync(path.join(root, ".agent"), "not a dir");
    assert.equal(isManagedProject(root), false);
  } finally { closeWorktree(root); }
});

test("isManagedProject: false when .agent lacks rules/", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-agr-test-"));
  try {
    fs.mkdirSync(path.join(root, ".agent", "workflows"), { recursive: true });
    assert.equal(isManagedProject(root), false);
  } finally { closeWorktree(root); }
});

test("isManagedProject: false when .agent lacks workflows/", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-agr-test-"));
  try {
    fs.mkdirSync(path.join(root, ".agent", "rules"), { recursive: true });
    assert.equal(isManagedProject(root), false);
  } finally { closeWorktree(root); }
});

test("isManagedProject: false for empty/null/undefined path", () => {
  assert.equal(isManagedProject(""), false);
  assert.equal(isManagedProject(null), false);
  assert.equal(isManagedProject(undefined), false);
});

test("isManagedProject: follows symlink to managed directory", () => {
  const linked = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-agr-real-"));
  // The symlink target itself IS the .agent directory (no inner .agent).
  fs.mkdirSync(path.join(linked, "rules"), { recursive: true });
  fs.mkdirSync(path.join(linked, "workflows"), { recursive: true });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-agr-test-"));
  fs.symlinkSync(linked, path.join(root, ".agent"));
  try {
    assert.equal(isManagedProject(root), true);
  } finally {
    closeWorktree(root);
    closeWorktree(linked);
  }
});

// ─── pattern validation ──────────────────────────────────────────────────────

test("isValidGrantPattern: exact paths are valid", () => {
  assert.equal(isValidGrantPattern("rules/core-principles.md"), true);
  assert.equal(isValidGrantPattern("skills"), true);
  assert.equal(isValidGrantPattern("workflows/launch-governed-agent.md"), true);
  assert.equal(isValidGrantPattern("hooks/claude-governed-hooks.json"), true);
});

test("isValidGrantPattern: directory-prefix glob (dir/**) is valid", () => {
  assert.equal(isValidGrantPattern("rules/**"), true);
  assert.equal(isValidGrantPattern("workflows/**"), true);
  assert.equal(isValidGrantPattern("skills/**"), true);
});

test("isValidGrantPattern: absolute paths are rejected", () => {
  // On macOS/Linux: paths starting with / are absolute.
  assert.equal(isValidGrantPattern("/absolute/path"), false);
});

test("isValidGrantPattern: paths with .. are rejected", () => {
  assert.equal(isValidGrantPattern("../escape"), false);
  assert.equal(isValidGrantPattern("rules/../etc/passwd"), false);
  assert.equal(isValidGrantPattern("foo/.."), false);
});

test("isValidGrantPattern: NUL character is rejected", () => {
  assert.equal(isValidGrantPattern("rules\0evil"), false);
});

test("isValidGrantPattern: arbitrary glob patterns are rejected", () => {
  assert.equal(isValidGrantPattern("*.md"), false);
  assert.equal(isValidGrantPattern("rules/a?c"), false);
  assert.equal(isValidGrantPattern("**/foo"), false);
  assert.equal(isValidGrantPattern("rules/*.json"), false);
});

test("isValidGrantPattern: empty / non-string inputs are rejected", () => {
  assert.equal(isValidGrantPattern(""), false);
  assert.equal(isValidGrantPattern(null), false);
  assert.equal(isValidGrantPattern(undefined), false);
  assert.equal(isValidGrantPattern(42), false);
});

// ─── canonical containment ───────────────────────────────────────────────────

test("buildAgentRootGrant: returns null for non-managed project", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-agr-test-"));
  try {
    assert.equal(buildAgentRootGrant(root), null);
  } finally { closeWorktree(root); }
});

test("buildAgentRootGrant: returns null when rules/ workflows/ missing", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-agr-test-"));
  try {
    fs.mkdirSync(path.join(root, ".agent"), { recursive: true });
    assert.equal(buildAgentRootGrant(root), null);
  } finally { closeWorktree(root); }
});

test("buildAgentRootGrant: returns grant with exact patterns", () => {
  const root = makeWorktree();
  try {
    const grant = buildAgentRootGrant(root, {
      grants: [{ read: ["rules/core-principles.md"], write: ["hooks/claude-governed-hooks.json"] }],
    });
    assert.notEqual(grant, null);
    assert.equal(grant.schemaVersion, AGENT_ROOT_GRANT_SCHEMA_VERSION);
    assert.equal(grant.canonicalAgentRoot.endsWith(".agent"), true);
    assert.deepEqual(grant.operations.read, ["rules/core-principles.md"]);
    assert.deepEqual(grant.operations.write, ["hooks/claude-governed-hooks.json"]);
  } finally { closeWorktree(root); }
});

test("buildAgentRootGrant: expands delegate.read/write from nested delegate object", () => {
  const root = makeWorktree();
  try {
    const grant = buildAgentRootGrant(root, {
      grants: [{
        read: ["skills/**"],
        delegate: { read: ["workflows/**"], write: ["rules/**"] },
      }],
    });
    assert.notEqual(grant, null);
    assert.deepEqual(grant.operations.read, ["skills/**"]);
    assert.deepEqual(grant.operations["delegate.read"], ["workflows/**"]);
    assert.deepEqual(grant.operations["delegate.write"], ["rules/**"]);
  } finally { closeWorktree(root); }
});

test("buildAgentRootGrant: merges multiple grant objects", () => {
  const root = makeWorktree();
  try {
    const grant = buildAgentRootGrant(root, {
      grants: [
        { read: ["rules/core-principles.md"] },
        { read: ["rules/ai-behavior.md"] },
        { write: ["hooks/claude-governed-hooks.json"] },
      ],
    });
    assert.notEqual(grant, null);
    const reads = [...(grant.operations.read || [])].sort();
    assert.deepEqual(reads, ["rules/ai-behavior.md", "rules/core-principles.md"]);
    assert.deepEqual(grant.operations.write, ["hooks/claude-governed-hooks.json"]);
  } finally { closeWorktree(root); }
});

test("buildAgentRootGrant: ignores invalid patterns silently", () => {
  const root = makeWorktree();
  try {
    const grant = buildAgentRootGrant(root, {
      grants: [{
        read: ["rules/core-principles.md", "../etc/passwd", "**/evil"],
        write: ["/absolute/path"],
      }],
    });
    assert.notEqual(grant, null);
    assert.deepEqual(grant.operations.read, ["rules/core-principles.md"]);
    assert.deepEqual(grant.operations.write, []);
  } finally { closeWorktree(root); }
});

test("buildAgentRootGrant: grant is frozen (immutable)", () => {
  const root = makeWorktree();
  try {
    const grant = buildAgentRootGrant(root, { grants: [{ read: ["rules/**"] }] });
    assert.notEqual(grant, null);
    assert.throws(() => { grant.schemaVersion = "2.0"; }, /read only/);
  } finally { closeWorktree(root); }
});

// ─── read/write allow/deny ──────────────────────────────────────────────────

test("checkAuthorization: allows exact path when granted read", () => {
  const root = makeWorktree();
  const targetFile = path.join(root, ".agent", "rules", "core-principles.md");
  fs.writeFileSync(targetFile, "# test");
  try {
    const grant = buildAgentRootGrant(root, { grants: [{ read: ["rules/core-principles.md"] }] });
    const real = fs.realpathSync(targetFile);
    const result = checkAuthorization(grant, "read", real);
    assert.equal(result.allowed, true);
  } finally { closeWorktree(root); }
});

test("checkAuthorization: denies exact path when read not granted", () => {
  const root = makeWorktree();
  const targetFile = path.join(root, ".agent", "rules", "core-principles.md");
  fs.writeFileSync(targetFile, "# test");
  try {
    const grant = buildAgentRootGrant(root, { grants: [{ write: ["hooks/**"] }] });
    const real = fs.realpathSync(targetFile);
    const result = checkAuthorization(grant, "read", real);
    assert.equal(result.allowed, false);
  } finally { closeWorktree(root); }
});

test("checkAuthorization: allows sub-path via directory-prefix glob", () => {
  const root = makeWorktree();
  const targetFile = path.join(root, ".agent", "rules", "ai-behavior.md");
  fs.writeFileSync(targetFile, "# test");
  try {
    const grant = buildAgentRootGrant(root, { grants: [{ read: ["rules/**"] }] });
    const real = fs.realpathSync(targetFile);
    const result = checkAuthorization(grant, "read", real);
    assert.equal(result.allowed, true);
  } finally { closeWorktree(root); }
});

test("checkAuthorization: denies path outside canonical .agent", () => {
  const root = makeWorktree();
  const external = path.join(root, "README.md");
  fs.writeFileSync(external, "# test");
  try {
    const grant = buildAgentRootGrant(root, { grants: [{ read: ["rules/**"] }] });
    const real = fs.realpathSync(external);
    const result = checkAuthorization(grant, "read", real);
    assert.equal(result.allowed, false);
    assert.match(result.reason, /outside/);
  } finally { closeWorktree(root); }
});

test("checkAuthorization: write denied when only read granted", () => {
  const root = makeWorktree();
  fs.mkdirSync(path.join(root, ".agent", "hooks"), { recursive: true });
  const targetFile = path.join(root, ".agent", "hooks", "test.json");
  fs.writeFileSync(targetFile, "{}");
  try {
    const grant = buildAgentRootGrant(root, { grants: [{ read: ["hooks/**"] }] });
    const real = fs.realpathSync(targetFile);
    const result = checkAuthorization(grant, "write", real);
    assert.equal(result.allowed, false);
  } finally { closeWorktree(root); }
});

test("checkAuthorization: write allowed when granted", () => {
  const root = makeWorktree();
  fs.mkdirSync(path.join(root, ".agent", "hooks"), { recursive: true });
  const targetFile = path.join(root, ".agent", "hooks", "test.json");
  fs.writeFileSync(targetFile, "{}");
  try {
    const grant = buildAgentRootGrant(root, { grants: [{ write: ["hooks/**"] }] });
    const real = fs.realpathSync(targetFile);
    const result = checkAuthorization(grant, "write", real);
    assert.equal(result.allowed, true);
  } finally { closeWorktree(root); }
});

test("checkAuthorization: returns false for null grant", () => {
  const result = checkAuthorization(null, "read", "/some/path");
  assert.equal(result.allowed, false);
});

test("checkAuthorization: returns false for empty patterns", () => {
  const root = makeWorktree();
  try {
    const grant = buildAgentRootGrant(root, { grants: [{ read: [] }] });
    const real = fs.realpathSync(path.join(root, ".agent", "rules"));
    const result = checkAuthorization(grant, "read", real);
    assert.equal(result.allowed, false);
  } finally { closeWorktree(root); }
});

test("checkAuthorization: write-granted Bash on .agent allowed", () => {
  const root = makeWorktree();
  const targetDir = path.join(root, ".agent", "rules");
  try {
    const grant = buildAgentRootGrant(root, { grants: [{ write: ["rules/**"] }] });
    const real = fs.realpathSync(targetDir);
    const result = checkAuthorization(grant, "write", real);
    assert.equal(result.allowed, true);
  } finally { closeWorktree(root); }
});

test("checkAuthorization: no write grant - Bash denied", () => {
  const root = makeWorktree();
  const targetDir = path.join(root, ".agent", "rules");
  try {
    const grant = buildAgentRootGrant(root, { grants: [{ read: ["rules/**"] }] });
    const real = fs.realpathSync(targetDir);
    const result = checkAuthorization(grant, "write", real);
    assert.equal(result.allowed, false);
  } finally { closeWorktree(root); }
});

// ─── delegation (parent → child) ────────────────────────────────────────────

test("validateDelegation: child exact subset of parent delegate patterns - ok", () => {
  const root = makeWorktree();
  try {
    const parent = buildAgentRootGrant(root, {
      grants: [{ delegate: { read: ["workflows/**"], write: ["rules/**"] } }],
    });
    const child = buildAgentRootGrant(root, {
      grants: [{
        read: ["workflows/launch-governed-agent.md"],
        write: ["rules/core-principles.md"],
      }],
    });
    assert.equal(validateDelegation(parent, child), true);
  } finally { closeWorktree(root); }
});

test("validateDelegation: child read not in parent delegate.read - throws", () => {
  const root = makeWorktree();
  try {
    const parent = buildAgentRootGrant(root, { grants: [{ delegate: { read: ["rules/**"] } }] });
    const child = buildAgentRootGrant(root, { grants: [{ read: ["skills/**"] }] });
    assert.throws(() => validateDelegation(parent, child), /ERR_DELEGATION_VIOLATION/);
  } finally { closeWorktree(root); }
});

test("validateDelegation: parent has no grant - throws ERR_NO_PARENT_GRANT", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-agr-test-"));
  try {
    const child = buildAgentRootGrant(root, { grants: [{ read: ["rules/**"] }] });
    assert.throws(() => validateDelegation(null, child), /ERR_NO_PARENT_GRANT/);
  } finally { closeWorktree(root); }
});

test("validateDelegation: child has no grant - throws ERR_NO_CHILD_GRANT", () => {
  const root = makeWorktree();
  try {
    const parent = buildAgentRootGrant(root, { grants: [{ delegate: { read: ["rules/**"] } }] });
    assert.throws(() => validateDelegation(parent, null), /ERR_NO_CHILD_GRANT/);
  } finally { closeWorktree(root); }
});

test("validateDelegation: mismatched canonical .agent - throws", () => {
  const root1 = makeWorktree();
  const root2 = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-agr-root2-"));
  fs.mkdirSync(path.join(root2, ".agent", "rules"), { recursive: true });
  fs.mkdirSync(path.join(root2, ".agent", "workflows"), { recursive: true });
  try {
    const parent = buildAgentRootGrant(root1, { grants: [{ delegate: { read: ["rules/**"] } }] });
    const child = buildAgentRootGrant(root2, { grants: [{ read: ["rules/**"] }] });
    assert.throws(() => validateDelegation(parent, child), /ERR_CANONICAL_MISMATCH/);
  } finally {
    closeWorktree(root1);
    closeWorktree(root2);
  }
});

test("validateDelegation: child write subset of parent delegate.write - ok", () => {
  const root = makeWorktree();
  try {
    const parent = buildAgentRootGrant(root, {
      grants: [{ delegate: { write: ["hooks/**", "skills/**"] } }],
    });
    const child = buildAgentRootGrant(root, {
      grants: [{ write: ["hooks/claude-governed-hooks.json"] }],
    });
    assert.equal(validateDelegation(parent, child), true);
  } finally { closeWorktree(root); }
});

// ─── private-only non-leak ──────────────────────────────────────────────────

test("buildAgentRootGrant: operations contain only relative paths", () => {
  const root = makeWorktree();
  try {
    const grant = buildAgentRootGrant(root, {
      grants: [{ read: ["rules/core-principles.md"], write: ["hooks/**"] }],
    });
    assert.notEqual(grant, null);
    // canonicalAgentRoot is the absolute identity key but never in public events.
    assert.equal(typeof grant.canonicalAgentRoot, "string");
    assert.equal(grant.canonicalAgentRoot.length > 0, true);
    const allPatterns = [
      ...(grant.operations.read || []),
      ...(grant.operations.write || []),
    ];
    assert.equal(allPatterns.some((p) => p.startsWith("/")), false);
  } finally { closeWorktree(root); }
});

test("checkAuthorization: result contains no absolute paths in reason", () => {
  const root = makeWorktree();
  const targetFile = path.join(root, ".agent", "rules", "core-principles.md");
  fs.writeFileSync(targetFile, "# test");
  try {
    const grant = buildAgentRootGrant(root, { grants: [{ read: ["hooks/**"] }] });
    const real = fs.realpathSync(targetFile);
    const result = checkAuthorization(grant, "read", real);
    assert.equal(typeof result.allowed, "boolean");
    if (!result.allowed && result.reason) {
      assert.equal(result.reason.includes(root), false);
    }
  } finally { closeWorktree(root); }
});

// ─── Claude argument insertion ───────────────────────────────────────────────

test("buildClaudeAddDirs: returns --add-dir=canonicalAgentRoot", () => {
  const root = makeWorktree();
  try {
    const grant = buildAgentRootGrant(root, { grants: [{ read: ["rules/**"] }] });
    const addDirs = buildClaudeAddDirs(grant);
    assert.equal(Array.isArray(addDirs), true);
    assert.equal(addDirs.length, 1);
    assert.equal(addDirs[0].startsWith("--add-dir="), true);
    assert.equal(addDirs[0].endsWith(".agent"), true);
  } finally { closeWorktree(root); }
});

test("buildClaudeAddDirs: returns empty array when no grant", () => {
  assert.deepEqual(buildClaudeAddDirs(null), []);
  assert.deepEqual(buildClaudeAddDirs(undefined), []);
  assert.deepEqual(buildClaudeAddDirs({}), []);
});

test("buildClaudeAddDirs: value is canonical .agent absolute path", () => {
  const root = makeWorktree();
  try {
    const grant = buildAgentRootGrant(root, { grants: [{ read: ["rules/**"] }] });
    const addDirs = buildClaudeAddDirs(grant);
    const arg = addDirs[0];
    assert.equal(arg.startsWith("--add-dir="), true);
    // Arg is safe for pre-separator insertion (no "--" inside the value).
    assert.equal(arg.includes(" --"), false);
    assert.equal(arg.includes(root.replace(/\\/g, "/")), true);
  } finally { closeWorktree(root); }
});

// ─── PreToolUse gate ───────────────────────────────────────────────────────

test("checkPreToolUse: non-governed (no grant) - deferred", () => {
  const root = makeWorktree();
  try {
    const result = checkPreToolUse("Write", "/some/file.js", null, root);
    assert.equal(result.allowed, true);
    assert.equal(result.deferred, true);
  } finally { closeWorktree(root); }
});

test("checkPreToolUse: business code path - deferred", () => {
  const root = makeWorktree();
  try {
    const grant = buildAgentRootGrant(root, { grants: [{ read: ["rules/**"] }] });
    const result = checkPreToolUse("Write", "/project/src/index.js", grant, root);
    assert.equal(result.allowed, true);
    assert.equal(result.deferred, true);
  } finally { closeWorktree(root); }
});

test("checkPreToolUse: Write on .agent without write grant - denied", () => {
  const root = makeWorktree();
  fs.mkdirSync(path.join(root, ".agent", "hooks"), { recursive: true });
  const targetFile = path.join(root, ".agent", "hooks", "test.json");
  fs.writeFileSync(targetFile, "{}");
  try {
    const grant = buildAgentRootGrant(root, { grants: [{ read: ["hooks/**"] }] });
    const result = checkPreToolUse("Write", targetFile, grant, root);
    assert.equal(result.allowed, false);
    assert.equal(result.deferred, false);
  } finally { closeWorktree(root); }
});

test("checkPreToolUse: Read on .agent without read grant - denied", () => {
  const root = makeWorktree();
  const targetFile = path.join(root, ".agent", "rules", "core-principles.md");
  fs.writeFileSync(targetFile, "# test");
  try {
    const grant = buildAgentRootGrant(root, { grants: [{ write: ["rules/**"] }] });
    const result = checkPreToolUse("Read", targetFile, grant, root);
    assert.equal(result.allowed, false);
  } finally { closeWorktree(root); }
});

test("checkPreToolUse: Bash on .agent with write grant - allowed", () => {
  const root = makeWorktree();
  try {
    const grant = buildAgentRootGrant(root, { grants: [{ write: ["rules/**"] }] });
    const result = checkPreToolUse("Bash", path.join(root, ".agent", "rules"), grant, root);
    assert.equal(result.allowed, true);
  } finally { closeWorktree(root); }
});

test("checkPreToolUse: Bash on .agent without write grant - denied", () => {
  const root = makeWorktree();
  try {
    const grant = buildAgentRootGrant(root, { grants: [{ read: ["rules/**"] }] });
    const result = checkPreToolUse("Bash", path.join(root, ".agent", "rules"), grant, root);
    assert.equal(result.allowed, false);
    assert.match(result.reason, /Cortex CLI\/API/);
  } finally { closeWorktree(root); }
});

test("checkPreToolUse: non-existent file in granted dir - allowed (dir prefix covers parent)", () => {
  const root = makeWorktree();
  const rulesDir = path.join(root, ".agent", "rules");
  try {
    const grant = buildAgentRootGrant(root, { grants: [{ read: ["rules/**"] }] });
    const result = checkPreToolUse("Read", path.join(rulesDir, "does-not-exist.md"), grant, root);
    // Non-existent file canonicalizes to the rules/ directory, which is covered by rules/**.
    assert.equal(result.allowed, true);
  } finally { closeWorktree(root); }
});

test("checkPreToolUse: symlink pointing outside .agent - denied", () => {
  const root = makeWorktree();
  const externalDir = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-agr-ext-"));
  const externalFile = path.join(externalDir, "evil.txt");
  fs.writeFileSync(externalFile, "secret");
  try {
    const linkPath = path.join(root, ".agent", "rules", "escape.link");
    fs.symlinkSync(externalFile, linkPath);
    const grant = buildAgentRootGrant(root, { grants: [{ read: ["rules/**"] }] });
    // Symlink resolves to external file outside .agent/ - denied.
    const result = checkPreToolUse("Read", linkPath, grant, root);
    assert.equal(result.allowed, false);
  } finally {
    closeWorktree(root);
    closeWorktree(externalDir);
  }
});

// ─── integration tests ──────────────────────────────────────────────────────

test("integration: add-dirs never include external paths", () => {
  const root = makeWorktree();
  const externalDir = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-agr-ext-"));
  try {
    const grant = buildAgentRootGrant(root, { grants: [] });
    const addDirs = buildClaudeAddDirs(grant);
    assert.equal(addDirs.every((d) => d.includes(".agent")), true);
    assert.equal(addDirs.some((d) => d.includes("cortex-agr-ext")), false);
  } finally {
    closeWorktree(root);
    closeWorktree(externalDir);
  }
});

test("integration: grant schema version is stable", () => {
  const root = makeWorktree();
  try {
    const grant = buildAgentRootGrant(root, { grants: [{ read: ["rules/**"] }] });
    assert.equal(grant.schemaVersion, "1.0");
    assert.equal(AGENT_ROOT_GRANT_SCHEMA_VERSION, "1.0");
  } finally { closeWorktree(root); }
});

test("integration: operations only contain known keys", () => {
  const root = makeWorktree();
  try {
    const grant = buildAgentRootGrant(root, {
      grants: [{
        read: ["rules/**"],
        delegate: { read: ["workflows/**"], write: ["skills/**"] },
      }],
    });
    const allowed = ["read", "write", "delegate.read", "delegate.write"];
    for (const key of Object.keys(grant.operations)) {
      assert.equal(allowed.includes(key), true, `unexpected operation key: ${key}`);
    }
  } finally { closeWorktree(root); }
});
