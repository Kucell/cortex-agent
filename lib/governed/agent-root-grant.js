"use strict";

// ─── Agent Root Grant (T-AGR-001) ─────────────────────────────────────────────
//
// Worktree-shared .agent path-level authorization and sub-agent permission
// delegation for Cortex-managed projects.
//
// Grant contract:
//   1. Governed launch adds a private agentRootGrant JSON to CORTEX_LAUNCH_CONTEXT.
//      Fields: read / write / delegate.read / delegate.write — all paths are
//      relative to the canonical .agent root.
//   2. Default: no grant. The launcher automatically projects
//      --add-dir=<canonical .agent>. Caller-supplied --add-dir for external dirs
//      is always rejected.
//   3. Grant is private CORTEX_LAUNCH_CONTEXT only — never enters public Task
//      events, results, or receipts.
//   4. Managed parent → child: child's read/write must be subsets of parent's
//      grant.delegate.read / grant.delegate.write. Parent without delegation
//      fails closed.
//   5. Claude PreToolUse (Write/Edit/MultiEdit/Read/Bash) gate:
//        - Business code paths: defer to Claude default
//        - Shared .agent paths without grant: deny
//        - Path must canonicalize to an existing parent (anti-symlink /
//          non-existent file escape)
//        - Bash directly touching shared .agent: deny by default; runtime
//          updates must go through the Cortex public CLI/API with lease/fencing
//   6. Only Node built-in modules; public events must never leak absolute paths.

const fs = require("node:fs");
const path = require("node:path");

// ─── Schema version ───────────────────────────────────────────────────────────

const AGENT_ROOT_GRANT_SCHEMA_VERSION = "1.0";

// ─── Validation constants ────────────────────────────────────────────────────

// Forbidden patterns: absolute paths, "..", NUL, arbitrary glob.
const GLOB_RE = /[*?\[]/;
const DOTDOT_RE = /\.\./;
const NUL_RE = /\0/;
const DIR_SUFFIX = "/**";

// Valid grant operation names
const VALID_OPERATIONS = Object.freeze(["read", "write", "delegate.read", "delegate.write"]);

// ─── Managed project detection ────────────────────────────────────────────────
//
// A worktree is a Cortex-managed project when its .agent directory exists,
// is a directory, and contains the canonical Cortex marker files (rules/ and
// workflows/). Without both, the worktree is NOT managed and no grant is issued.

function isManagedProject(worktreePath) {
  if (typeof worktreePath !== "string" || worktreePath.length === 0) return false;
  try {
    const agentRoot = path.join(worktreePath, ".agent");
    const lstat = fs.lstatSync(agentRoot);
    let realAgentRoot;
    if (lstat.isDirectory()) {
      realAgentRoot = agentRoot;
    } else if (lstat.isSymbolicLink()) {
      realAgentRoot = fs.realpathSync(agentRoot);
      if (!fs.statSync(realAgentRoot).isDirectory()) return false;
    } else {
      return false;
    }
    const rulesDir = path.join(realAgentRoot, "rules");
    const workflowsDir = path.join(realAgentRoot, "workflows");
    return fs.statSync(rulesDir).isDirectory() && fs.statSync(workflowsDir).isDirectory();
  } catch (_) {
    return false;
  }
}

// ─── Pattern validation ───────────────────────────────────────────────────────
//
// Allowed patterns:
//   - Exact path: "rules/core-principles.md"
//   - Directory prefix (dir/**): "rules/**"
// Rejected:
//   - Absolute paths
//   - Paths containing ".."
//   - Paths containing NUL
//   - Any other glob pattern (e.g. "*.md", "rules/a?c", "**/foo")

function isValidGrantPattern(pattern) {
  if (typeof pattern !== "string" || pattern.length === 0) return false;
  if (path.isAbsolute(pattern)) return false;
  if (DOTDOT_RE.test(pattern)) return false;
  if (NUL_RE.test(pattern)) return false;

  // Allow exact paths (no glob chars) and directory-prefix globs (ending with /**).
  // e.g. "rules/core-principles.md" (exact) or "rules/**" (directory glob).
  // Reject: glob chars elsewhere (e.g. "*.md", "**/foo", "rules/a?c").
  const isExact = !GLOB_RE.test(pattern);
  const isDirGlob = pattern.endsWith(DIR_SUFFIX) && !GLOB_RE.test(pattern.slice(0, -DIR_SUFFIX.length));
  return isExact || isDirGlob;
}

// ─── Canonical containment ───────────────────────────────────────────────────
//
// Resolve `resolvedPath` to its real path (following symlinks). Return null if
// the path does not exist. Used to check whether a target is inside the
// canonical .agent directory.

function resolveRealPath(p) {
  try {
    return fs.realpathSync(p);
  } catch (_) {
    return null;
  }
}

// Returns the canonical .agent directory or null if it does not exist / is not a directory.
function getCanonicalAgentRoot(worktreePath) {
  if (typeof worktreePath !== "string" || worktreePath.length === 0) return null;
  try {
    const agentRoot = path.join(worktreePath, ".agent");
    const real = fs.realpathSync(agentRoot);
    if (!fs.statSync(real).isDirectory()) return null;
    return real;
  } catch (_) {
    return null;
  }
}

// ─── Agent Root Grant ─────────────────────────────────────────────────────────
//
// Creates an agent-root grant object. The grant maps operations (read, write,
// delegate.read, delegate.write) to arrays of validated relative-path patterns.

class AgentRootGrantError extends Error {
  constructor(code, details) {
    super(`[agent-root-grant:${code}] ${JSON.stringify(details || {})}`);
    this.name = "AgentRootGrantError";
    this.code = code;
    this.details = details || {};
  }
}

function assertNonEmptyString(value, field) {
  if (typeof value !== "string" || value.length === 0) {
    throw new AgentRootGrantError("ERR_FIELD_INVALID", { field, received: typeof value });
  }
  return value;
}

function assertArrayOfStrings(value, field) {
  if (!Array.isArray(value)) {
    throw new AgentRootGrantError("ERR_FIELD_INVALID", { field, received: typeof value });
  }
  for (let i = 0; i < value.length; i++) {
    if (typeof value[i] !== "string") {
      throw new AgentRootGrantError("ERR_FIELD_INVALID", { field, index: i, received: typeof value[i] });
    }
  }
  return value;
}

// Validate a grant operations object. Each key must be one of VALID_OPERATIONS
// and each value must be an array of valid patterns.
function validateGrantOperations(ops) {
  if (!ops || typeof ops !== "object" || Array.isArray(ops)) {
    throw new AgentRootGrantError("ERR_INVALID_GRANT", { reason: "grant must be a non-null object" });
  }
  // Empty ops (no grants) is valid — grants are optional.
  const entries = Object.entries(ops);
  if (entries.length === 0) return Object.freeze({});
  const validated = {};
  for (const [key, value] of entries) {
    if (!VALID_OPERATIONS.includes(key)) {
      throw new AgentRootGrantError("ERR_INVALID_OPERATION", { operation: key, valid: VALID_OPERATIONS });
    }
    const patterns = assertArrayOfStrings(value, key);
    const validPatterns = [];
    for (const p of patterns) {
      if (!isValidGrantPattern(p)) {
        throw new AgentRootGrantError("ERR_INVALID_PATTERN", { pattern: p });
      }
      validPatterns.push(p);
    }
    validated[key] = Object.freeze(validPatterns);
  }
  return Object.freeze(validated);
}

// ─── Create Agent Root Grant ──────────────────────────────────────────────────

// buildGrant: public factory.
//
// Inputs:
//   worktreePath   — the physical worktree root (absolute or project-relative)
//   options.grants — Array of grant objects: { read?: string[], write?: string[], delegate?: { read?: string[], write?: string[] } }
//
// Returns a frozen agentRootGrant object or null if the worktree is not managed.

function buildAgentRootGrant(worktreePath, options = {}) {
  if (!isManagedProject(worktreePath)) return null;

  const canonicalAgentRoot = getCanonicalAgentRoot(worktreePath);
  if (!canonicalAgentRoot) return null;

  const grantsInput = Array.isArray(options.grants) ? options.grants : [];

  // Merge all grant objects into one validated operations map.
  // Later grants override earlier ones for the same operation.
  const ops = {};
  for (const grant of grantsInput) {
    if (!grant || typeof grant !== "object" || Array.isArray(grant)) continue;
    if (grant.read) {
      ops.read = [...(ops.read || []), ...grant.read];
    }
    if (grant.write) {
      ops.write = [...(ops.write || []), ...grant.write];
    }
    if (grant.delegate && typeof grant.delegate === "object") {
      if (grant.delegate.read) {
        ops["delegate.read"] = [...(ops["delegate.read"] || []), ...grant.delegate.read];
      }
      if (grant.delegate.write) {
        ops["delegate.write"] = [...(ops["delegate.write"] || []), ...grant.delegate.write];
      }
    }
  }

  let validatedOps;
  try {
    validatedOps = validateGrantOperations(ops);
  } catch (err) {
    // If validation fails, start from an empty ops map and merge only the valid parts.
    const partialOps = {};
    for (const grant of grantsInput) {
      if (!grant || typeof grant !== "object" || Array.isArray(grant)) continue;
      for (const op of ["read", "write"]) {
        if (!grant[op] || !Array.isArray(grant[op])) continue;
        partialOps[op] = [...(partialOps[op] || []), ...grant[op].filter(isValidGrantPattern)];
      }
      if (grant.delegate && typeof grant.delegate === "object") {
        for (const op of ["read", "write"]) {
          if (!grant.delegate[op] || !Array.isArray(grant.delegate[op])) continue;
          const delegateOp = `delegate.${op}`;
          partialOps[delegateOp] = [...(partialOps[delegateOp] || []), ...grant.delegate[op].filter(isValidGrantPattern)];
        }
      }
    }
    validatedOps = Object.freeze(partialOps);
  }

  return Object.freeze({
    schemaVersion: AGENT_ROOT_GRANT_SCHEMA_VERSION,
    canonicalAgentRoot,
    operations: validatedOps,
  });
}

// ─── Check authorization ──────────────────────────────────────────────────────
//
// Checks whether a given operation is permitted for a resolved (real-path)
// target relative to a canonicalAgentRoot.
//
// Returns: { allowed: boolean, reason?: string }

function checkAuthorization(grant, operation, resolvedRealPath) {
  if (!grant || typeof grant !== "object") {
    return { allowed: false, reason: "no grant" };
  }
  // Support both flat grant (canonicalAgentRoot + direct op keys) and nested
  // grant (canonicalAgentRoot + operations.{op}).
  const ops = grant.operations;
  const patterns = (ops && typeof ops === "object")
    ? ops[operation]
    : grant[operation];
  if (!Array.isArray(patterns) || patterns.length === 0) {
    return { allowed: false, reason: `no ${operation} patterns` };
  }

  const canonicalRoot = grant.canonicalAgentRoot;
  // Use realpath comparison: ensure canonicalRoot is a prefix of the real path.
  const normalizedResolved = resolvedRealPath.replace(/\\/g, "/");
  const normalizedRoot = canonicalRoot.replace(/\\/g, "/");
  if (!normalizedResolved.startsWith(normalizedRoot + "/") && normalizedResolved !== normalizedRoot) {
    return { allowed: false, reason: "target outside canonical .agent" };
  }

  // Strip the canonical root to get the relative path.
  let relative = normalizedResolved.slice(normalizedRoot.length + 1);

  // Check each pattern.
  for (const pattern of patterns) {
    if (pattern.endsWith(DIR_SUFFIX)) {
      // Directory-prefix glob: match if relative path starts with the prefix.
      const prefix = pattern.slice(0, -DIR_SUFFIX.length);
      if (relative === prefix || relative.startsWith(prefix + "/")) {
        return { allowed: true };
      }
    } else {
      // Exact match.
      if (relative === pattern) {
        return { allowed: true };
      }
    }
  }

  return { allowed: false, reason: "no matching pattern" };
}

// ─── Validate delegation (parent → child) ─────────────────────────────────────
//
// Child's read/write grants must be subsets of parent's grant.delegate.read/write.
// Parent without delegation capability fails closed.

function validateDelegation(parentGrant, childGrant) {
  if (!parentGrant) {
    throw new AgentRootGrantError("ERR_NO_PARENT_GRANT", { reason: "parent has no agentRootGrant" });
  }
  if (!childGrant) {
    throw new AgentRootGrantError("ERR_NO_CHILD_GRANT", { reason: "child has no agentRootGrant" });
  }
  // Canonical .agent must be the same.
  if (parentGrant.canonicalAgentRoot !== childGrant.canonicalAgentRoot) {
    throw new AgentRootGrantError("ERR_CANONICAL_MISMATCH", {
      parent: parentGrant.canonicalAgentRoot,
      child: childGrant.canonicalAgentRoot,
    });
  }

  // Support both flat (direct op keys) and nested (operations.{op}) grant layouts.
  const getOps = (g) => g.operations && typeof g.operations === "object" ? g.operations : g;

  const parentOps = getOps(parentGrant);
  const childOps = getOps(childGrant);

  for (const op of ["read", "write"]) {
    const childPatterns = childOps[op] || [];
    const parentDelegateOp = `delegate.${op}`;
    const parentPatterns = parentOps[parentDelegateOp] || [];
    for (const cp of childPatterns) {
      // Child pattern must be covered by at least one parent delegate pattern.
      // See patternsCover() below for the coverage rules. Strict literal
      // membership is too narrow: e.g. child="rules/foo.md" should be
      // covered by parent="rules/**", but "**" should NOT be covered by
      // parent="rules/**" (which would widen scope).
      const covered = parentPatterns.some((pp) => patternsCover(pp, cp));
      if (!covered) {
        throw new AgentRootGrantError("ERR_DELEGATION_VIOLATION", {
          childOperation: op,
          childPattern: cp,
          parentDelegate: parentDelegateOp,
          allowedPatterns: parentPatterns,
        });
      }
    }
  }

  return true;
}

// Coverage predicate: does `parentPattern` (a parent delegate pattern)
// authorize `childPattern` (a child pattern)?
//   - Exact equality covers both directions.
//   - Parent is a directory glob (dir/**): child is the same glob, the bare
//     directory, or any path inside the directory.
//   - Child cannot widen scope: e.g. child "**" is NOT covered by
//     parent "rules/**".
function patternsCover(parentPattern, childPattern) {
  if (parentPattern === childPattern) return true;
  if (parentPattern.endsWith("/**")) {
    const prefix = parentPattern.slice(0, -3);
    if (childPattern === prefix) return true;
    if (childPattern.startsWith(prefix + "/")) return true;
  }
  return false;
}
// ─── Host-aware --add-dir policy ─────────────────────────────────────────────
//
// Governed launch injects --add-dir=<canonical .agent> for CLIs that support
// it (Claude Code / Codex). Some hosts reject unknown flags before task
// execution — Pi rejects --add-dir (see
// .agent/memory/feedback/pi-governed-launch-host-args.md). Such hosts still
// receive the private launch context and agentRootGrant via
// CORTEX_LAUNCH_CONTEXT; only the argv injection is skipped.
//
// Deliberately a small denylist keyed on the launch context's host signal
// (context.targetAgentId): hosts not listed keep today's exact behavior, so
// adding a new host can never silently lose its managed-.agent access.

const HOSTS_WITHOUT_ADD_DIR_FLAG = Object.freeze(new Set(["pi"]));

function supportsAddDirFlag(targetAgentId) {
  return typeof targetAgentId === "string" && !HOSTS_WITHOUT_ADD_DIR_FLAG.has(targetAgentId);
}

// ─── PreToolUse: Build Claude arguments from grant ─────────────────────────────
//
// Returns an array of --add-dir strings to be inserted BEFORE the "--" prompt
// separator in the Claude invocation. Only the canonical .agent is added;
// no caller-supplied external directories are permitted.

function buildClaudeAddDirs(agentRootGrant) {
  if (!agentRootGrant || !agentRootGrant.canonicalAgentRoot) return [];
  return Object.freeze([`--add-dir=${agentRootGrant.canonicalAgentRoot}`]);
}

// ─── Canonicalize a path to its nearest existing ancestor ───────────────────
//
// Walks up the directory tree to find the nearest existing ancestor directory,
// then returns its real (symlink-resolved) path.
//
// Anti-symlink-escape property:
//   - If the path or any intermediate component is a symlink pointing outside
//     .agent/, the realpath of its nearest existing ancestor will be outside
//     .agent/, and the containment check will correctly deny.
//   - We use lstatSync to detect symlinks without following them.
//
// Returns null if no ancestor exists (extremely unlikely on a real filesystem).

function canonicalizeToExistingParent(filePath) {
  if (typeof filePath !== "string" || filePath.length === 0) return null;
  let current = path.resolve(filePath);
  for (let i = 0; i < 64; i++) {
    try {
      // lstatSync does NOT follow symlinks — this is key for the anti-escape check.
      const lstat = fs.lstatSync(current);
      if (lstat.isSymbolicLink()) {
        // It's a symlink. Get the real (resolved) target.
        const realTarget = fs.realpathSync(current);
        // Return the real target path so the caller can check containment.
        // If the symlink points outside .agent/, the real target will be outside.
        return realTarget;
      }
      if (lstat.isDirectory()) {
        // It's an existing directory (not a symlink). Return its real path.
        return fs.realpathSync(current);
      }
      // It's an existing file. Walk up to its parent.
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    } catch (_) {
      // Does not exist (stat failed). Walk up to parent.
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }
  // Fallback.
  try {
    return fs.realpathSync(current);
  } catch (_) {
    return null;
  }
}

// ─── PreToolUse check ────────────────────────────────────────────────────────
// Scan a Bash command string for any path token that resolves inside the
// canonical .agent root. Returns the canonical real path of the first match,
// or null if no resolvable .agent path is found. Conservative: only inspects
// tokens that look like absolute paths (start with `/`) or contain a path
// separator with a non-trivial component. Falls back to `null` (defer) when
// no candidate resolves to an existing ancestor of the canonical .agent.
function scanBashCommandForAgentPath(command, agentRootGrant, worktreePath) {
  if (typeof command !== "string" || command.length === 0) return null;
  if (!agentRootGrant || !agentRootGrant.canonicalAgentRoot) return null;

  const canonicalAgentRoot = agentRootGrant.canonicalAgentRoot;
  const normalizedRoot = canonicalAgentRoot.replace(/\\/g, "/");

  // Tokenize on whitespace and common shell metacharacters. Keep raw tokens
  // so we can also strip leading/trailing quotes.
  const rawTokens = command.split(/[\s'"`|;&(){}<>$]+/);
  for (const raw of rawTokens) {
    if (!raw || raw.length === 0) continue;
    // Strip leading redirection marker (e.g. `<file`, `>file`).
    let token = raw;
    while (token.length > 0 && (token[0] === "<" || token[0] === ">")) {
      token = token.slice(1);
    }
    if (!token) continue;
    // Candidate must contain a path separator or be a likely absolute path.
    const looksAbsolute = token.startsWith("/") || token.startsWith("~");
    const looksRelative = token.startsWith("./") || token.startsWith("../");
    if (!looksAbsolute && !looksRelative && !token.includes("/")) continue;
    // Skip flag-like tokens (e.g. `--file`, `-x`).
    if (token.startsWith("-")) continue;

    let abs;
    try {
      if (token.startsWith("~")) {
        // Conservative: refuse tilde expansion here to avoid leaking home paths.
        continue;
      }
      if (path.isAbsolute(token)) {
        abs = token;
      } else if (worktreePath) {
        abs = path.join(worktreePath, token);
      } else {
        continue;
      }
    } catch (_) {
      continue;
    }

    const canonical = canonicalizeToExistingParent(abs);
    if (!canonical) continue;
    const normalized = canonical.replace(/\\/g, "/");
    if (normalized === normalizedRoot || normalized.startsWith(normalizedRoot + "/")) {
      return canonical;
    }
  }
  return null;
}

//
// Main PreToolUse enforcement function. Call this from the PreToolUse hook.
//
// Inputs:
//   toolName        — the Claude tool name (Write, Edit, MultiEdit, Read, Bash)
//   filePath        — the file path argument (may be relative or absolute)
//   bashCommand     — Bash tool_input.command string (only inspected for Bash)
//   agentRootGrant  — the grant from CORTEX_LAUNCH_CONTEXT (null if not governed)
//   worktreePath    — the physical worktree root (for canonical .agent resolution)
//
// Returns: { allowed: boolean, reason?: string, deferred?: boolean }
//   deferred = true  → not a shared .agent path, let Claude decide
//   allowed  = false → deny

function checkPreToolUse(toolName, filePath, bashCommand, agentRootGrant, worktreePath) {
  // Tolerate legacy 4-arg call sites: (toolName, filePath, agentRootGrant, worktreePath).
  // When called with 4 args, treat the 3rd arg as the grant (not as bashCommand).
  if (arguments.length === 4) {
    agentRootGrant = bashCommand;
    bashCommand = undefined;
  }
  // 1. Non-governed tools or missing grant: defer.
  if (!agentRootGrant) {
    return { allowed: true, deferred: true };
  }

  // 2. Determine whether this is a shared .agent path.
  let targetReal;
  if (filePath && typeof filePath === "string" && filePath.length > 0) {
    const abs = path.isAbsolute(filePath) ? filePath : (worktreePath ? path.join(worktreePath, filePath) : filePath);
    const existingParent = canonicalizeToExistingParent(abs);
    if (!existingParent) {
      // Path is completely outside any accessible filesystem.
      return { allowed: false, reason: "path resolves to no existing ancestor" };
    }
    targetReal = existingParent;
  } else {
    // No file path (e.g. Bash without path args) — defer.
    return { allowed: true, deferred: true };
  }

  const canonicalAgentRoot = agentRootGrant.canonicalAgentRoot;
  const normalizedTarget = targetReal.replace(/\\/g, "/");
  const normalizedRoot = canonicalAgentRoot.replace(/\\/g, "/");
  // Anti-symlink-escape: detect when the unresolved path was inside .agent
  // but canonicalization moved it outside — a classic symlink escape
  // (e.g. .agent/rules/escape.link -> /etc/passwd).
  // Use path.relative so macOS /var -> /private/var prefixes do not break the
  // containment check (both sides resolve to the same components once we
  // treat them as strings).
  const originalAbs = path.isAbsolute(filePath)
    ? filePath
    : (worktreePath ? path.join(worktreePath, filePath) : filePath);
  const normalizedOriginal = originalAbs.replace(/\\/g, "/");
  const targetInsideAgent =
    normalizedTarget === normalizedRoot
    || normalizedTarget.startsWith(normalizedRoot + "/");
  let originalIsSymlink = false;
  try { originalIsSymlink = fs.lstatSync(originalAbs).isSymbolicLink(); } catch (_) {}
  if (originalIsSymlink) {
    // Use realpath of the parent directory so macOS /var vs /private/var
    // prefix differences do not break containment checks.
    let parentInsideAgent = false;
    try {
      const parentDir = path.dirname(originalAbs);
      const realParent = fs.realpathSync(parentDir);
      const normalizedParent = realParent.replace(/\\/g, "/");
      parentInsideAgent =
        normalizedParent === normalizedRoot
        || normalizedParent.startsWith(normalizedRoot + "/");
    } catch (_) {}
    if (parentInsideAgent && !targetInsideAgent) {
      return { allowed: false, reason: "symlink escape denied: target resolves outside .agent" };
    }
  }
  const isSharedAgentPath =
    normalizedTarget.startsWith(normalizedRoot + "/") || normalizedTarget === normalizedRoot;

  // 3. Not a shared .agent path: defer to Claude default.
  if (!isSharedAgentPath) {
    return { allowed: true, deferred: true };
  }

  // 4. Shared .agent path — require grant.

  // 4a. Bash touching .agent: deny by default (runtime updates go through CLI/API).
  if (toolName === "Bash") {
    // 4a-i. Resolve a target path from the command string when no filePath is
    // available. This catches forms like `cat /path/.agent/rules/x.md`,
    // `rm /path/.agent/cache.json`, etc. Conservative: only inspect tokens that
    // look like absolute file paths; defer everything else to Claude default.
    let bashTarget = filePath;
    if (!bashTarget && typeof bashCommand === "string" && bashCommand.length > 0) {
      bashTarget = scanBashCommandForAgentPath(bashCommand, agentRootGrant, worktreePath);
    }
    // Canonicalize bashTarget so containment checks below use the realpath
    // (also avoids macOS /var vs /private/var prefix mismatches).
    const canonicalBashTarget = bashTarget ? canonicalizeToExistingParent(bashTarget) : null;
    if (bashTarget && !canonicalBashTarget) {
      return { allowed: true, deferred: true };
    }
    bashTarget = canonicalBashTarget || bashTarget;
    if (!bashTarget) {
      return { allowed: true, deferred: true };
    }
    targetReal = bashTarget;
    const writeCheck = checkAuthorization(agentRootGrant, "write", targetReal);
    if (!writeCheck.allowed) {
      return { allowed: false, reason: "Bash write to shared .agent denied: runtime updates must use Cortex CLI/API" };
    }
    // Write grant satisfied: Bash touching .agent is allowed. Read access is
    // implicitly granted when write is granted (Bash commands cannot reliably
    // declare read vs write intent at the hook layer).
    return { allowed: true };
  }

  // 4b. Write / Edit / MultiEdit: require write grant.
  if (toolName === "Write" || toolName === "Edit" || toolName === "MultiEdit") {
    const result = checkAuthorization(agentRootGrant, "write", targetReal);
    return {
      allowed: result.allowed,
      deferred: result.allowed ? false : false,
      reason: result.allowed ? undefined : result.reason,
    };
  }

  // 4c. Read: require read grant.
  if (toolName === "Read") {
    const result = checkAuthorization(agentRootGrant, "read", targetReal);
    return {
      allowed: result.allowed,
      deferred: false,
      reason: result.allowed ? undefined : result.reason,
    };
  }

  // 4d. Any other tool: defer.
  return { allowed: true, deferred: true };
}

// ─── Exports ─────────────────────────────────────────────────────────────────

module.exports = {
  AGENT_ROOT_GRANT_SCHEMA_VERSION,
  isManagedProject,
  isValidGrantPattern,
  getCanonicalAgentRoot,
  resolveRealPath,
  buildAgentRootGrant,
  checkAuthorization,
  validateDelegation,
  buildClaudeAddDirs,
  supportsAddDirFlag,
  HOSTS_WITHOUT_ADD_DIR_FLAG,
  canonicalizeToExistingParent,
  checkPreToolUse,
  scanBashCommandForAgentPath,
  AgentRootGrantError,
};
