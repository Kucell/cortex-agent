"use strict";

// ─── Team Pack core ──────────────────────────────────────────────────────────
// Manifest schema, signers verification, allowlist checks, file expansion,
// hash computation, and three-way merge planner for `.agent-shared/` packs.
//
// Pure module (no fs.write outside of atomic-rename helpers in commands.js).
// Zero external deps; mirrors the style of lib/script-manifest.js.
//
// Owner boundary: Team Pack is L2; it does NOT use lib/script-manifest.js's
// managed-script ledger (which is L1-only).

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { execSync } = require("child_process");

const secretScan = require("./secret-scan");

const SCHEMA_VERSION = 1;
const PACK_ROOT = ".agent-shared";
const PACK_MANIFEST = "team-pack.json";
const RECEIPT_DIR = ".agent/team-sync";
const RECEIPT_FILE = ".team-receipt.json";
const BASELINE_DIR = ".agent/team-sync/baselines";
const CONFLICT_DIR = ".agent/team-sync/conflicts";

// Top-level allowlist under .agent-shared/. Anything else must be rejected.
const PACK_TOP_ALLOWLIST = new Set([
  "team-pack.json",
  "README.md",
  "rules",
  "workflows",
  "skills",
  "references",
  "schemas",
]);

// Explicit host entry files that Team Pack must NEVER carry (P-001 §3.1).
const HOST_ENTRY_EXCLUDES = [
  "**/.claude/settings.json",
  "**/.claude/settings.local.json",
  "**/AGENTS.md",
  "**/CLAUDE.md",
  "**/GEMINI.md",
];

// Default excludes applied to all globs regardless of manifest.
const DEFAULT_EXCLUDES = [
  "**/.DS_Store",
  "**/*.local.*",
  "**/*secret*",
  "**/*token*",
  ...HOST_ENTRY_EXCLUDES,
];

const FORBIDDEN_TOP_DIRS = new Set([
  "hooks",
  "config",
  "runs",
  "sessions",
  "metrics",
  "locks",
  "runtime-continuity",
  "updates",
  "artifacts",
  "screenshots",
]);

function manifestPath(projectRoot) {
  return path.join(projectRoot, PACK_ROOT, PACK_MANIFEST);
}

function receiptDir(projectRoot) {
  return path.join(projectRoot, RECEIPT_DIR);
}

function receiptFile(projectRoot) {
  return path.join(projectRoot, RECEIPT_DIR, RECEIPT_FILE);
}

function hashBuffer(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function hashFile(absPath) {
  const buffer = fs.readFileSync(absPath);
  return hashBuffer(buffer);
}

function sha256OfString(content) {
  return hashBuffer(Buffer.from(content, "utf8"));
}

function manifestFingerprint(files) {
  const sorted = [...files].sort((a, b) => a.path.localeCompare(b.path));
  const lines = sorted.map((f) => `${f.path}\t${f.sha256}\t${f.mode}`);
  return sha256OfString(lines.join("\n"));
}

// ─── Path containment ────────────────────────────────────────────────────────

function isPathSafe(relPath) {
  if (typeof relPath !== "string" || relPath.length === 0) return false;
  if (path.isAbsolute(relPath)) return false;
  // Normalize and ensure it does not escape via ..
  const normalized = path.posix.normalize(relPath.replace(/\\/g, "/"));
  if (normalized === ".." || normalized.startsWith("../")) return false;
  if (normalized.includes("\0")) return false;
  return true;
}

function isForbiddenTopDir(relPath) {
  const first = relPath.split("/")[0];
  return FORBIDDEN_TOP_DIRS.has(first);
}

function matchExclude(relPath, patterns) {
  if (!Array.isArray(patterns)) return false;
  for (const pattern of patterns) {
    if (matchGlob(pattern, relPath)) return true;
  }
  return false;
}

// Minimal glob matcher: support **, *, and exact segment matching.
// `**` matches zero or more path segments (with or without separators).
function matchGlob(pattern, relPath) {
  if (pattern === "**") return true;
  let regexBody = "";
  const segs = pattern.split("/");
  for (let i = 0; i < segs.length; i += 1) {
    const seg = segs[i];
    if (seg === "**") {
      // Trailing ** → matches any remainder. Otherwise consume one or more
      // segments and the following separator.
      if (i === segs.length - 1) regexBody += ".*";
      else regexBody += "(?:.+/)?";
      continue;
    }
    const escaped = seg.replace(/[.+^$|()\[\]{}]/g, "\\$&").replace(/\*/g, "[^/]*");
    regexBody += escaped;
    if (i < segs.length - 1) regexBody += "\\/";
  }
  const re = new RegExp(`^${regexBody}$`);
  return re.test(relPath);
}

function isHostEntryPath(relPath) {
  return HOST_ENTRY_EXCLUDES.some((p) => matchGlob(p, relPath));
}

// ─── Manifest ────────────────────────────────────────────────────────────────

function readManifest(projectRoot) {
  const file = manifestPath(projectRoot);
  if (!fs.existsSync(file)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!parsed || typeof parsed !== "object") return null;
    if (typeof parsed.schema_version !== "number") return null;
    if (typeof parsed.name !== "string" || parsed.name.length === 0) return null;
    if (typeof parsed.version !== "string" || parsed.version.length === 0) return null;
    if (!Array.isArray(parsed.files)) return null;
    for (const entry of parsed.files) {
      if (!entry || typeof entry.path !== "string") return null;
      if (typeof entry.sha256 !== "string" || entry.sha256.length !== 64) return null;
      if (entry.mode !== "add" && entry.mode !== "merge") return null;
      if (!isPathSafe(entry.path)) return null;
      if (isForbiddenTopDir(entry.path)) return null;
      if (isHostEntryPath(entry.path)) return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

// Validate that includes / excludes lists and the actual files[] are consistent.
function validateManifestShape(manifest, availableFiles) {
  const errors = [];
  if (manifest.schema_version !== SCHEMA_VERSION) {
    errors.push(`unsupported schema_version=${manifest.schema_version}`);
  }
  if (!manifest.requires || typeof manifest.requires.cortex_agent !== "string") {
    errors.push("manifest.requires.cortex_agent missing");
  }
  if (manifest.signers && typeof manifest.signers !== "object") {
    errors.push("manifest.signers must be an object when present");
  }
  if (manifest.signers && manifest.signers.mode === "git_committers") {
    if (!Array.isArray(manifest.signers.allowed_committers)) {
      errors.push("signers.allowed_committers must be an array");
    }
  }
  // All declared files must exist relative to pack root with matching hash.
  for (const declared of manifest.files) {
    const abs = path.join(projectRoot(availableFiles), PACK_ROOT, declared.path);
    if (!fs.existsSync(abs)) {
      errors.push(`declared file missing: ${declared.path}`);
      continue;
    }
    const actual = hashFile(abs);
    if (actual !== declared.sha256) {
      errors.push(`hash mismatch: ${declared.path}`);
    }
  }
  return errors;
}

function projectRoot(availableFiles) {
  // `availableFiles` is the unpacked manifest's project root; callers pass
  // through readManifest() so we avoid an extra filesystem read here.
  return availableFiles;
}

// ─── Three-way merge ─────────────────────────────────────────────────────────

// Compute merge decision for a single file.
// Returns { action, reason, kept } where:
//   action: "unchanged" | "apply" | "conflict" | "add" | "deprecated"
//   reason: human-readable explanation
//   kept:   the hash we should write into .agent/ (null means no write)
function mergeDecision({ baseSha, localSha, incomingSha, status }) {
  if (status === "missing_local") return { action: "add", reason: "incoming only", kept: incomingSha };
  if (baseSha === null) {
    // First install: local==base==incoming==null OR local==incoming. Cold start
    // never infers base from existing .agent/ contents.
    if (localSha === incomingSha) return { action: "unchanged", reason: "no delta", kept: null };
    if (localSha === null) return { action: "add", reason: "first install", kept: incomingSha };
    return { action: "conflict", reason: "cold_start_local_divergence", kept: localSha };
  }
  if (localSha === baseSha && incomingSha === baseSha) return { action: "unchanged", reason: "no delta", kept: null };
  if (localSha === baseSha && incomingSha !== baseSha) return { action: "apply", reason: "incoming changed", kept: incomingSha };
  if (localSha !== baseSha && incomingSha === baseSha) return { action: "unchanged", reason: "local changed only", kept: null };
  if (localSha !== baseSha && incomingSha !== baseSha) {
    if (localSha === incomingSha) return { action: "apply", reason: "identical local+incoming", kept: incomingSha };
    return { action: "conflict", reason: "local and incoming both changed", kept: localSha };
  }
  return { action: "unchanged", reason: "default no-op", kept: null };
}

// Walk manifest.files and produce a plan against the current project state.
function buildMergePlan(manifest, receipt, projectRootAbs, { dryRun = false } = {}) {
  const plan = { mode: dryRun ? "dry-run" : "apply", items: [] };
  const baseline = receipt && receipt.files ? Object.fromEntries(receipt.files.map((f) => [f.path, f.baseline_sha256])) : {};
  const installed = receipt && receipt.files ? Object.fromEntries(receipt.files.map((f) => [f.path, f.installed_sha256])) : {};

  for (const entry of manifest.files) {
    const target = path.join(projectRootAbs, ".agent", entry.path);
    const hasLocal = fs.existsSync(target);
    const localSha = hasLocal ? hashFile(target) : null;
    const incomingSha = entry.sha256;
    const baseSha = baseline[entry.path] || null;
    const installedSha = installed[entry.path] || null;

    const decision = mergeDecision({
      baseSha,
      localSha,
      incomingSha,
      status: hasLocal ? "ok" : "missing_local",
    });

    plan.items.push({
      path: entry.path,
      mode: entry.mode,
      base: baseSha,
      local: localSha,
      incoming: incomingSha,
      installed: installedSha,
      decision: decision.action,
      reason: decision.reason,
      kept_sha: decision.kept,
    });
  }
  return plan;
}

// ─── Receipt ─────────────────────────────────────────────────────────────────

function emptyReceipt(pack) {
  return {
    schema_version: SCHEMA_VERSION,
    pack: {
      name: pack.name,
      version: pack.version,
      manifest_sha256: pack.manifest_sha256 || null,
    },
    installed_at: new Date().toISOString(),
    manifest_schema_drift: null,
    files: [],
  };
}

function readReceipt(projectRootAbs) {
  const file = receiptFile(projectRootAbs);
  if (!fs.existsSync(file)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!parsed || typeof parsed !== "object") return null;
    if (typeof parsed.schema_version !== "number") return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeReceiptAtomic(projectRootAbs, receipt) {
  const dir = receiptDir(projectRootAbs);
  fs.mkdirSync(dir, { recursive: true });
  const finalPath = receiptFile(projectRootAbs);
  const tmpPath = `${finalPath}.tmp-${process.pid}`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
  fs.renameSync(tmpPath, finalPath);
}

function buildReceiptFromPlan(manifest, manifestSha256, plan) {
  const applied = plan.items.filter((it) => it.decision === "apply" || it.decision === "add");
  return {
    schema_version: SCHEMA_VERSION,
    pack: {
      name: manifest.name,
      version: manifest.version,
      manifest_sha256: manifestSha256,
    },
    installed_at: new Date().toISOString(),
    manifest_schema_drift: null,
    files: applied.map((it) => ({
      path: it.path,
      baseline_sha256: it.incoming,
      installed_sha256: it.incoming,
      status: "installed",
    })),
  };
}

// ─── Top-level operations used by CLI ─────────────────────────────────────────

function loadPack(projectRootAbs) {
  const manifest = readManifest(projectRootAbs);
  if (!manifest) return { ok: false, reason: "manifest_invalid_or_missing" };
  const manifestSha256 = sha256OfString(JSON.stringify({
    schema_version: manifest.schema_version,
    name: manifest.name,
    version: manifest.version,
    requires: manifest.requires,
    includes: manifest.includes || [],
    excludes: manifest.excludes || [],
    files: [...manifest.files].sort((a, b) => a.path.localeCompare(b.path)),
  }));
  return { ok: true, manifest, manifestSha256 };
}

function initSkeleton(projectRootAbs, name) {
  const packDir = path.join(projectRootAbs, PACK_ROOT);
  fs.mkdirSync(packDir, { recursive: true });
  const manifest = {
    schema_version: SCHEMA_VERSION,
    name: name || path.basename(projectRootAbs) + "-team-pack",
    version: "0.1.0",
    requires: { cortex_agent: ">=1.6.0" },
    signers: { mode: "git_committers", allowed_committers: [], fallback: "reject" },
    includes: ["rules/**/*.md", "workflows/**/*.md", "skills/**", "references/**/*.md", "schemas/**/*.json"],
    excludes: DEFAULT_EXCLUDES,
    files: [],
  };
  fs.mkdirSync(path.join(packDir, "rules"), { recursive: true });
  fs.mkdirSync(path.join(packDir, "workflows"), { recursive: true });
  fs.mkdirSync(path.join(packDir, "skills"), { recursive: true });
  fs.mkdirSync(path.join(packDir, "references"), { recursive: true });
  fs.mkdirSync(path.join(packDir, "schemas"), { recursive: true });
  const file = manifestPath(projectRootAbs);
  fs.writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return { ok: true, manifest_path: file };
}

// ─── MS-003: signers, verify, publish ────────────────────────────────────────

function readGitLastCommitter(projectRootAbs) {
  try {
    const out = execSync("git log -1 --format=%ae", {
      cwd: projectRootAbs,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return out || null;
  } catch {
    return null;
  }
}

function checkSigners(manifest, projectRootAbs) {
  if (!manifest.signers || manifest.signers.mode === "disabled") {
    return { ok: true, mode: manifest.signers ? manifest.signers.mode : "absent" };
  }
  if (manifest.signers.mode !== "git_committers") {
    return { ok: false, reason: `unsupported signers.mode=${manifest.signers.mode}` };
  }
  const lastCommitter = readGitLastCommitter(projectRootAbs);
  if (!lastCommitter) {
    if (manifest.signers.fallback === "reject") {
      return { ok: false, reason: "no_git_history_for_signers" };
    }
    return { ok: true, mode: manifest.signers.mode, lastCommitter: null, fallback: manifest.signers.fallback || "warn" };
  }
  const allowed = Array.isArray(manifest.signers.allowed_committers) ? manifest.signers.allowed_committers : [];
  const allowedLc = allowed.map((e) => String(e).toLowerCase());
  if (allowedLc.includes(lastCommitter.toLowerCase())) {
    return { ok: true, mode: manifest.signers.mode, lastCommitter };
  }
  if (manifest.signers.fallback === "reject") {
    return { ok: false, reason: `committer_not_allowed:${lastCommitter}` };
  }
  return { ok: true, mode: manifest.signers.mode, lastCommitter, fallback: manifest.signers.fallback || "warn" };
}

// Verify-only checks. Always read-only. Returns { ok, checks: [{id,status,reason}], strict }.
function verifyChecks(manifest, projectRootAbs, { strict = false } = {}) {
  const out = { schema_version: 1, ok: true, strict, checks: [] };

  // 1. manifest_schema
  if (!manifest || typeof manifest.schema_version !== "number") {
    out.checks.push({ id: "manifest_schema", status: "fail", reason: "missing or invalid schema_version" });
    out.ok = false;
    return out;
  }
  out.checks.push({ id: "manifest_schema", status: manifest.schema_version === SCHEMA_VERSION ? "pass" : "fail", reason: `schema_version=${manifest.schema_version}` });
  if (manifest.schema_version !== SCHEMA_VERSION) out.ok = false;

  // 2. file_hash — recompute and compare to declared entries
  for (const declared of manifest.files) {
    const abs = path.join(projectRootAbs, PACK_ROOT, declared.path);
    if (!fs.existsSync(abs)) {
      out.checks.push({ id: "file_hash", status: "fail", reason: `missing:${declared.path}`, path: declared.path });
      out.ok = false;
      continue;
    }
    const actual = hashFile(abs);
    if (actual !== declared.sha256) {
      out.checks.push({ id: "file_hash", status: "fail", reason: `hash_mismatch:${declared.path}`, path: declared.path });
      out.ok = false;
    }
  }
  if (strict && !out.checks.some((c) => c.id === "file_hash" && c.status === "fail")) {
    out.checks.push({ id: "file_hash", status: "pass", reason: `${manifest.files.length} file(s) match` });
  }

  // 3. path_containment — every declared path safe + not forbidden top + not host entry
  for (const declared of manifest.files) {
    if (!isPathSafe(declared.path) || isForbiddenTopDir(declared.path) || isHostEntryPath(declared.path)) {
      out.checks.push({ id: "path_containment", status: "fail", reason: `unsafe:${declared.path}`, path: declared.path });
      out.ok = false;
    }
  }

  // 4. symlink_policy — symlinks under .agent-shared must not exist
  function walkForSymlinks(dir) {
    if (!fs.existsSync(dir)) return [];
    const bad = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) bad.push(abs);
      else if (entry.isDirectory()) bad.push(...walkForSymlinks(abs));
    }
    return bad;
  }
  const badLinks = walkForSymlinks(path.join(projectRootAbs, PACK_ROOT));
  if (badLinks.length) {
    out.checks.push({ id: "symlink_policy", status: "fail", reason: `symlink_detected:${badLinks.length}` });
    out.ok = false;
  } else {
    out.checks.push({ id: "symlink_policy", status: "pass", reason: "no symlinks" });
  }

  // 5. secret_scan + absolute_path_scan over each declared file's content
  for (const declared of manifest.files) {
    const abs = path.join(projectRootAbs, PACK_ROOT, declared.path);
    if (!fs.existsSync(abs)) continue;
    const content = fs.readFileSync(abs, "utf8");
    const findings = secretScan.scanContent(content, { filePath: declared.path });
    if (findings.length) {
      out.checks.push({ id: "secret_scan", status: "fail", reason: `${findings.length} finding(s) in ${declared.path}`, findings: findings.map((f) => ({ rule_id: f.rule_id, line: f.line })) });
      out.ok = false;
    }
    const absFindings = findings.filter((f) => f.rule_id === "absolute_machine_path");
    if (absFindings.length) {
      out.checks.push({ id: "absolute_path_scan", status: "fail", reason: `machine_path_in:${declared.path}` });
      out.ok = false;
    }
  }

  // 6. manifest_signature (signers)
  const sig = checkSigners(manifest, projectRootAbs);
  if (!sig.ok) {
    out.checks.push({ id: "manifest_signature", status: "fail", reason: sig.reason });
    out.ok = false;
  } else {
    out.checks.push({ id: "manifest_signature", status: "pass", reason: `mode=${sig.mode}` });
  }

  // 7. receipt_baseline_present — if a receipt exists it must reference a known manifest
  const receipt = readReceipt(projectRootAbs);
  if (receipt) {
    out.checks.push({ id: "receipt_baseline_present", status: "pass", reason: `${receipt.files.length} baseline(s)` });
  } else {
    out.checks.push({ id: "receipt_baseline_present", status: strict ? "fail" : "warn", reason: "no receipt yet" });
    if (strict) out.ok = false;
  }

  return out;
}

// Strict wrapper: same checks but converts warnings to failures.
function verifyStrict(manifest, projectRootAbs) {
  return verifyChecks(manifest, projectRootAbs, { strict: true });
}

// ─── Publish ─────────────────────────────────────────────────────────────────

// Copy a single source path under project root into .agent-shared/<rel>.
// Validates allowlist / safety / secret / path / host-entry. Returns
// { ok, reason?, dest? }.
function copyOneForPublish(projectRootAbs, sourceRel, destRel) {
  const srcAbs = path.join(projectRootAbs, sourceRel);
  if (!fs.existsSync(srcAbs)) return { ok: false, reason: "source_missing" };
  if (!isPathSafe(destRel)) return { ok: false, reason: "unsafe_dest_path" };
  if (isHostEntryPath(destRel)) return { ok: false, reason: "host_entry_excluded" };
  if (isForbiddenTopDir(destRel)) return { ok: false, reason: "forbidden_top_dir" };
  const top = destRel.split("/")[0];
  if (!PACK_TOP_ALLOWLIST.has(top) && top !== PACK_MANIFEST) return { ok: false, reason: "not_in_allowlist" };

  const content = fs.readFileSync(srcAbs, "utf8");
  const findings = secretScan.scanContent(content, { filePath: sourceRel });
  if (findings.length) return { ok: false, reason: `secret_or_path_scan:${findings.length}_finding(s)`, findings };

  const destAbs = path.join(projectRootAbs, PACK_ROOT, destRel);
  fs.mkdirSync(path.dirname(destAbs), { recursive: true });
  // Atomic copy: write to temp file then rename
  const tmp = `${destAbs}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, content, "utf8");
  fs.renameSync(tmp, destAbs);
  return { ok: true, dest: destAbs, sha256: hashBuffer(Buffer.from(content, "utf8")) };
}

// Rebuild team-pack.json after copying files. Returns { ok, manifest? }.
function rebuildManifest(projectRootAbs, name, version, requires, signers, includes, excludes, fileEntries) {
  const manifest = {
    schema_version: SCHEMA_VERSION,
    name,
    version,
    requires,
    signers,
    includes,
    excludes,
    files: fileEntries.sort((a, b) => a.path.localeCompare(b.path)),
  };
  const file = manifestPath(projectRootAbs);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  fs.renameSync(tmp, file);
  return { ok: true, manifest };
}

// publishPack copies a list of (sourceRel, destRel) tuples into .agent-shared/,
// then rebuilds the manifest. Returns { ok, applied[], skipped[], manifest_sha256 }.
function publishPack(projectRootAbs, items, { name, version, requires, signers, includes, excludes, dryRun = false } = {}) {
  const applied = [];
  const skipped = [];
  for (const item of items) {
    if (dryRun) {
      // still validate without writing
      const v = copyOneForPublish(projectRootAbs, item.source, item.dest);
      if (v.ok) applied.push({ source: item.source, dest: item.dest, sha256: "dry-run" });
      else skipped.push({ source: item.source, dest: item.dest, reason: v.reason });
      continue;
    }
    const r = copyOneForPublish(projectRootAbs, item.source, item.dest);
    if (r.ok) applied.push({ source: item.source, dest: r.dest, sha256: r.sha256 });
    else skipped.push({ source: item.source, dest: item.dest, reason: r.reason });
  }
  if (skipped.length || dryRun) {
    return { ok: skipped.length === 0, applied, skipped };
  }
  const fileEntries = applied.map((a) => ({ path: path.relative(path.join(projectRootAbs, PACK_ROOT), a.dest).split(path.sep).join("/"), sha256: a.sha256, mode: "add" }));
  // Carry-forward existing files that were not part of this publish
  const existing = readManifest(projectRootAbs);
  const merged = [...(existing ? existing.files : []).filter((f) => !fileEntries.find((x) => x.path === f.path)), ...fileEntries];
  const rb = rebuildManifest(projectRootAbs, name, version, requires, signers, includes, excludes, merged);
  return { ok: true, applied, skipped, manifest: rb.manifest, manifest_sha256: sha256OfString(JSON.stringify({ schema_version: rb.manifest.schema_version, name: rb.manifest.name, version: rb.manifest.version, requires: rb.manifest.requires, includes: rb.manifest.includes || [], excludes: rb.manifest.excludes || [], files: [...rb.manifest.files].sort((a, b) => a.path.localeCompare(b.path)) })) };
}

module.exports = {
  SCHEMA_VERSION,
  PACK_ROOT,
  PACK_MANIFEST,
  RECEIPT_DIR,
  RECEIPT_FILE,
  BASELINE_DIR,
  CONFLICT_DIR,
  PACK_TOP_ALLOWLIST,
  DEFAULT_EXCLUDES,
  HOST_ENTRY_EXCLUDES,
  FORBIDDEN_TOP_DIRS,
  manifestPath,
  receiptDir,
  receiptFile,
  hashBuffer,
  hashFile,
  sha256OfString,
  manifestFingerprint,
  isPathSafe,
  isForbiddenTopDir,
  isHostEntryPath,
  matchExclude,
  matchGlob,
  readManifest,
  validateManifestShape,
  mergeDecision,
  buildMergePlan,
  emptyReceipt,
  readReceipt,
  writeReceiptAtomic,
  buildReceiptFromPlan,
  loadPack,
  initSkeleton,
  projectRoot,
  secretScan,
  // MS-003 additions
  verifyChecks,
  verifyStrict,
  publishPack,
  readGitLastCommitter,
};