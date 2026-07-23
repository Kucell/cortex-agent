"use strict";

// ─── L1 script upgrade engine ─────────────────────────────────────────────────
// Cortex Agent `upgrade` is additive-only: walkAndAdd only copies files that do
// not yet exist, so bug fixes to already-installed L1 skill scripts (*.js) never
// reach existing user projects. This module provides a hash-ledger mechanism to
// safely update those managed scripts without clobbering user customizations.
//
// Ownership boundary (see .agent/rules/agent-scope.md):
//   The managed whitelist is DISCOVERED from templates/<lang>/.agent/**/*.js.
//   L3 framework-bootstrap scripts (self-check, reality-reconciliation, ...) are
//   NOT in the templates, so they are never managed here. This is by design.
//
// Zero dependency: only Node built-ins (fs, path, crypto) — bin/cli.js stays clean.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const MANIFEST_RELATIVE = path.join(".agent", ".script-manifest.json");
const SCHEMA_VERSION = 1;

// ─── path helpers ─────────────────────────────────────────────────────────────

function manifestPath(cwd) {
  return path.join(cwd, MANIFEST_RELATIVE);
}

function templateAgentDir(templateDir) {
  return path.join(templateDir, ".agent");
}

function projectAgentDir(cwd) {
  return path.join(cwd, ".agent");
}

function sharedAgentDir(templateDir) {
  return path.resolve(templateDir, "..", "_shared", ".agent");
}

// ─── hashing ──────────────────────────────────────────────────────────────────

function hashFile(absPath) {
  const buffer = fs.readFileSync(absPath);
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

// ─── template scanning (whitelist source) ─────────────────────────────────────

// Recursively collect *.js files under templateDir/.agent, returning paths
// relative to .agent/ (posix-style separators for stable manifest keys).
// Excludes *.bak / *.bak.prev and schema files.
// If includeDirs is an array of absolute root dirs, all of them are scanned
// and deduped (first root wins when a relative path appears in multiple dirs).
function discoverTemplateScriptEntries(templateDir, includeDirs = []) {
  const roots = [templateAgentDir(templateDir), ...includeDirs];
  const seen = new Set();
  const results = [];
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;

    const walk = (dir) => {
      let entries;
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const abs = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(abs);
        } else if (entry.isFile() && isManagedScriptName(entry.name)) {
          const rel = toRelative(root, abs);
          if (!seen.has(rel)) {
            seen.add(rel);
            results.push({ rel, root });
          }
        }
      }
    };

    walk(root);
  }
  return results.sort((a, b) => a.rel.localeCompare(b.rel));
}

// Keep the public API backward-compatible: callers that only need the
// whitelist receive relative path strings, while reconciliation can retain
// the source root selected by the language-overlay precedence rule.
function discoverTemplateScripts(templateDir, includeDirs = []) {
  return discoverTemplateScriptEntries(templateDir, includeDirs).map(({ rel }) => rel);
}

function isManagedScriptName(name) {
  if (!name.endsWith(".js")) return false;
  if (name.endsWith(".schema.json")) return false; // defensive; .js check already excludes
  if (name.endsWith(".bak") || name.endsWith(".bak.prev")) return false;
  return true;
}

function toRelative(root, abs) {
  return path.relative(root, abs).split(path.sep).join("/");
}

// ─── manifest read / write ─────────────────────────────────────────────────────

function emptyManifest() {
  return { schema_version: SCHEMA_VERSION, scripts: {} };
}

// Returns null when the manifest is missing OR unreadable/corrupt, so callers
// can treat "no manifest" and "broken manifest" identically (conservative).
function readManifest(cwd) {
  const file = manifestPath(cwd);
  if (!fs.existsSync(file)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!parsed || typeof parsed !== "object" || typeof parsed.scripts !== "object") {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function writeManifest(cwd, manifest) {
  const file = manifestPath(cwd);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

function manifestEntry(sha, templateSha, lang, size) {
  return {
    sha256: sha,
    origin_hash: sha,
    size,
    last_updated: new Date().toISOString(),
    source_template_sha256: templateSha,
    source_template_lang: lang,
  };
}

// ─── init-time registration ─────────────────────────────────────────────────────

// Called right after init copies templates into the project. Registers every
// managed template script that now exists in the project, using the actual
// on-disk hash as both sha256 and origin_hash (safe: we just wrote them).
// Preserves any pre-existing manifest entries.
function ensureManifestForInit(cwd, templateDir, lang) {
  const relPaths = discoverTemplateScriptEntries(templateDir, [sharedAgentDir(templateDir)]);
  const manifest = readManifest(cwd) || emptyManifest();
  const agentDir = projectAgentDir(cwd);

  for (const { rel } of relPaths) {
    const dest = path.join(agentDir, rel);
    if (!fs.existsSync(dest)) continue; // template file not installed in project
    const sha = hashFile(dest);
    manifest.scripts[rel] = manifestEntry(sha, sha, lang, statSize(dest));
  }

  writeManifest(cwd, manifest);
  return manifest;
}

function statSize(absPath) {
  try {
    return fs.statSync(absPath).size;
  } catch {
    return 0;
  }
}

// ─── reconciliation (upgrade / doctor core) ────────────────────────────────────

// Decide, for every managed template script, whether the project copy should be
// updated. Pure planning when apply=false; performs writes (with .bak backup and
// rollback) when apply=true.
//
// options: { cwd, templateDir, lang, apply, force }
// returns: {
//   updates:  [{ path, reason }]           — would be / were updated
//   skipped:  [{ path, reason }]           — left untouched (e.g. user-modified)
//   applied:  [ path ]                     — actually written (apply=true only)
//   failed:   [{ path, error }]            — write failed & rolled back
//   backedUp: [ path ]                     — .bak created (apply=true only)
//   manifestMissing: bool                  — true when no manifest existed (cold start)
// }
function reconcileScripts(options) {
  const { cwd, templateDir, lang, apply = false, force = false } = options;
  // _shared base layer + language-specific overlay.
  const relPaths = discoverTemplateScriptEntries(templateDir, [sharedAgentDir(templateDir)]);
  const existingManifest = readManifest(cwd);
  const manifestMissing = existingManifest === null;
  const manifest = existingManifest || emptyManifest();
  const agentDir = projectAgentDir(cwd);

  const report = {
    updates: [],
    skipped: [],
    applied: [],
    failed: [],
    backedUp: [],
    manifestMissing,
  };

  for (const { rel, root } of relPaths) {
    const srcAbs = path.join(root, rel);
    const destAbs = path.join(agentDir, rel);
    let templateSha;
    try {
      templateSha = hashFile(srcAbs);
    } catch {
      continue; // template file vanished mid-scan; skip
    }

    const decision = classify({
      destAbs,
      templateSha,
      entry: manifest.scripts[rel],
      manifestMissing,
      force,
    });

    if (decision.action === "skip") {
      report.skipped.push({ path: rel, reason: decision.reason });
      // Exact template equality is sufficient proof of framework ownership.
      // Repair stale or missing ledger entries so a manually backported fix
      // does not remain permanently classified as a local customization.
      if (apply && decision.reason === "in_sync") {
        manifest.scripts[rel] = manifestEntry(templateSha, templateSha, lang, statSize(destAbs));
      }
      // Cold-start bookkeeping: register current file so a later upgrade can
      // recognize an unmodified file as updatable. Never overwrites content.
      if (manifestMissing && fs.existsSync(destAbs)) {
        const sha = hashFile(destAbs);
        manifest.scripts[rel] = manifestEntry(sha, sha, lang, statSize(destAbs));
      }
      continue;
    }

    // decision.action === "update"
    report.updates.push({ path: rel, reason: decision.reason });
    if (!apply) continue;

    const result = writeManagedScript(srcAbs, destAbs);
    if (result.ok) {
      report.applied.push(rel);
      if (result.backedUp) report.backedUp.push(rel);
      const sha = hashFile(destAbs);
      manifest.scripts[rel] = manifestEntry(sha, templateSha, lang, statSize(destAbs));
    } else {
      report.failed.push({ path: rel, error: result.error });
    }
  }

  // Persist manifest whenever we applied changes or did cold-start bookkeeping.
  if (apply || manifestMissing) {
    writeManifest(cwd, manifest);
  }

  return report;
}

// Determine update vs skip for a single script. See the decision table in
// the implementation plan (缺口 B, safe replacement rules).
function classify({ destAbs, templateSha, entry, manifestMissing, force }) {
  if (!fs.existsSync(destAbs)) {
    return { action: "update", reason: "missing" };
  }

  const userSha = hashFile(destAbs);

  if (userSha === templateSha) {
    return { action: "skip", reason: "in_sync" };
  }

  if (force) {
    return { action: "update", reason: "forced" };
  }

  // No manifest (or corrupt): cannot prove the file is unmodified → conservative.
  if (manifestMissing || !entry) {
    return { action: "skip", reason: "unmanaged_cold_start" };
  }

  // User file matches what the framework last wrote → user hasn't touched it.
  if (userSha === entry.origin_hash) {
    return { action: "update", reason: "stale_template" };
  }

  return { action: "skip", reason: "user_modified" };
}

// Write srcAbs → destAbs with a .bak backup and rollback-on-failure. Verifies
// the written content hash matches the source before declaring success.
function writeManagedScript(srcAbs, destAbs) {
  const backup = `${destAbs}.bak`;
  let backedUp = false;
  try {
    if (fs.existsSync(destAbs)) {
      if (fs.existsSync(backup)) {
        fs.copyFileSync(backup, `${destAbs}.bak.prev`);
      }
      fs.copyFileSync(destAbs, backup);
      backedUp = true;
    } else {
      fs.mkdirSync(path.dirname(destAbs), { recursive: true });
    }

    fs.copyFileSync(srcAbs, destAbs);

    if (hashFile(destAbs) !== hashFile(srcAbs)) {
      throw new Error("post_write_hash_mismatch");
    }

    return { ok: true, backedUp };
  } catch (error) {
    // Roll back from backup when we have one.
    if (backedUp && fs.existsSync(backup)) {
      try {
        fs.copyFileSync(backup, destAbs);
      } catch {
        /* leave .bak in place for manual recovery */
      }
    }
    return { ok: false, error: error.message, backedUp };
  }
}

module.exports = {
  SCHEMA_VERSION,
  MANIFEST_RELATIVE,
  manifestPath,
  hashFile,
  discoverTemplateScripts,
  discoverTemplateScriptEntries,
  readManifest,
  writeManifest,
  ensureManifestForInit,
  reconcileScripts,
  classify,
};
