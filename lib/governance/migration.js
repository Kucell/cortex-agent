"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const { REBIND_TRANSACTION_STATES } = require("../../packages/project-sdk/src/governance.js");
const { readRegistry, classifyStatePath } = require("../state-registry");
const { readDescriptor, writeDescriptor } = require("./lifecycle");
const { createGitGovernanceStore } = require("./git-store");

const MIGRATION_DIR = ".cortex-governance-migrations";

function migrationError(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  return error;
}

function hash(content) {
  return crypto.createHash("sha256").update(content).digest("hex");
}

function stateClassForEntry(entry) {
  if (!entry) return null;
  if (["machine-local", "instance-local"].includes(entry.runtime_scope) || entry.sync_policy === "local") return "ephemeral";
  if (entry.sync_policy === "derived") return "derived";
  if (entry.runtime_scope === "portable" && ["tracked", "evidence", "legacy"].includes(entry.sync_policy)) {
    return "durable";
  }
  if (entry.sync_policy === "ignored") return "ephemeral";
  return null;
}

function classifyMigrationPath(relativePath, registry = readRegistry()) {
  const entry = classifyStatePath(relativePath, registry);
  const stateClass = stateClassForEntry(entry);
  return entry ? {
    path: relativePath.replace(/\\/g, "/"),
    state_class: stateClass,
    registry_id: entry.id,
    sync_policy: entry.sync_policy,
    runtime_scope: entry.runtime_scope,
    rebuildable: entry.rebuildable,
  } : {
    path: relativePath.replace(/\\/g, "/"),
    state_class: null,
    registry_id: null,
    sync_policy: null,
    runtime_scope: null,
    rebuildable: null,
  };
}

function walkFiles(root) {
  const out = [];
  function visit(current, prefix = "") {
    for (const name of fs.readdirSync(current).sort()) {
      if (name === ".git") continue;
      const absolute = path.join(current, name);
      const relative = prefix ? prefix + "/" + name : name;
      const stat = fs.lstatSync(absolute);
      if (stat.isSymbolicLink()) {
        out.push({ absolute, relative, symlink: true });
        continue;
      }
      if (stat.isDirectory()) visit(absolute, relative);
      else if (stat.isFile()) out.push({ absolute, relative, symlink: false });
    }
  }
  visit(root);
  return out;
}

function buildMigrationManifest(sourceRoot, options = {}) {
  const registry = options.registry || readRegistry();
  const included = [];
  const skipped = [];
  const unclassified = [];

  for (const file of walkFiles(sourceRoot)) {
    const classification = classifyMigrationPath(file.relative, registry);
    if (file.symlink) {
      const record = {
        ...classification,
        symlink: true,
        target: fs.readlinkSync(file.absolute),
        sha256: null,
        size: 0,
      };
      if (classification.state_class === "ephemeral") {
        skipped.push(record);
        continue;
      }
      if (classification.state_class == null) {
        unclassified.push(record);
        continue;
      }
      throw migrationError("ERR_GOVERNANCE_MIGRATION_SYMLINK_UNSUPPORTED", "Portable governance state contains an unsupported symlink.", { path: file.relative });
    }
    const record = {
      ...classification,
      symlink: false,
      sha256: hash(fs.readFileSync(file.absolute)),
      size: fs.statSync(file.absolute).size,
    };
    if (classification.state_class === "durable" || classification.state_class === "derived") included.push(record);
    else if (classification.state_class === "ephemeral") skipped.push(record);
    else unclassified.push(record);
  }

  if (unclassified.length && options.allow_unclassified !== true) {
    throw migrationError("ERR_GOVERNANCE_MIGRATION_UNCLASSIFIED", "Governance source contains unclassified state paths.", {
      paths: unclassified.map((item) => item.path),
    });
  }

  return {
    schema_version: 1,
    source_root: fs.realpathSync(sourceRoot),
    generated_at: new Date().toISOString(),
    included,
    skipped,
    unclassified,
  };
}

function copyManifestToFilesystem(manifest, targetRoot) {
  fs.mkdirSync(targetRoot, { recursive: true });
  for (const item of manifest.included) {
    const source = path.join(manifest.source_root, item.path);
    const target = path.join(targetRoot, item.path);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(source, target);
  }
  return verifyFilesystemTarget(manifest, targetRoot);
}

function verifyFilesystemTarget(manifest, targetRoot) {
  const mismatches = [];
  for (const item of manifest.included) {
    const target = path.join(targetRoot, item.path);
    if (!fs.existsSync(target)) {
      mismatches.push({ path: item.path, reason: "missing" });
      continue;
    }
    const actual = hash(fs.readFileSync(target));
    if (actual !== item.sha256) mismatches.push({ path: item.path, reason: "sha256", expected: item.sha256, actual });
  }
  if (mismatches.length) {
    throw migrationError("ERR_GOVERNANCE_MIGRATION_VERIFY_FAILED", "Filesystem migration verification failed.", { mismatches });
  }
  return { ok: true, files: manifest.included.length };
}

function seedManifestToGit(manifest, repo, options = {}) {
  const store = createGitGovernanceStore(repo, { ref: options.ref || "refs/heads/main" });
  let revision = store.getRevision();
  for (const item of manifest.included) {
    const content = fs.readFileSync(path.join(manifest.source_root, item.path), "utf8");
    const result = store.writeText(item.path, content, {
      expected_revision: revision,
      message: "cortex governance migration: " + item.path,
    });
    revision = result.revision;
  }
  for (const item of manifest.included) {
    const read = store.readText(item.path);
    if (hash(read.content) !== item.sha256) {
      throw migrationError("ERR_GOVERNANCE_MIGRATION_VERIFY_FAILED", "Git migration verification failed.", { path: item.path });
    }
  }
  return { ok: true, revision, files: manifest.included.length };
}

function journalPath(projectRoot, migrationId) {
  return path.join(projectRoot, MIGRATION_DIR, migrationId + ".json");
}

function writeJournal(projectRoot, journal) {
  const file = journalPath(projectRoot, journal.migration_id);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + ".tmp-" + process.pid + "-" + Date.now();
  fs.writeFileSync(tmp, JSON.stringify(journal, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
  fs.renameSync(tmp, file);
  return file;
}

function createJournal(projectRoot, target) {
  const descriptor = readDescriptor(projectRoot);
  const migrationId = "MIG-" + Date.now() + "-" + crypto.randomUUID().slice(0, 8);
  const journal = {
    schema_version: 1,
    migration_id: migrationId,
    project_id: descriptor.project_id,
    state: "prepare",
    source_binding: descriptor.governance,
    target_binding: target,
    archive_path: null,
    manifest: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    error: null,
  };
  writeJournal(projectRoot, journal);
  return journal;
}

function transitionJournal(projectRoot, journal, state, patch = {}) {
  if (!REBIND_TRANSACTION_STATES.includes(state)) {
    throw migrationError("ERR_GOVERNANCE_MIGRATION_STATE", "Unknown migration state.", { state });
  }
  const next = { ...journal, ...patch, state, updated_at: new Date().toISOString() };
  writeJournal(projectRoot, next);
  return next;
}

function migrateEmbeddedToDetached(projectRoot, targetRoot, options = {}) {
  const descriptor = readDescriptor(projectRoot);
  if (!descriptor.governance || descriptor.governance.kind !== "filesystem" || descriptor.governance.locator !== ".agent") {
    throw migrationError("ERR_GOVERNANCE_MIGRATION_SOURCE_UNSUPPORTED", "Migration source must be embedded filesystem governance.");
  }

  const sourceRoot = path.join(projectRoot, ".agent");
  if (!fs.existsSync(sourceRoot) || fs.lstatSync(sourceRoot).isSymbolicLink()) {
    throw migrationError("ERR_GOVERNANCE_MIGRATION_SOURCE_INVALID", "Embedded .agent source must be a real directory.");
  }

  const absoluteTarget = path.resolve(targetRoot);
  const relativeTarget = path.relative(projectRoot, absoluteTarget).replace(/\\/g, "/");
  if (!relativeTarget || path.isAbsolute(relativeTarget)) {
    throw migrationError("ERR_GOVERNANCE_MIGRATION_TARGET_SCOPE", "Detached filesystem target must resolve to a distinct path.", { targetRoot });
  }
  if (absoluteTarget === path.resolve(sourceRoot) || absoluteTarget.startsWith(path.resolve(sourceRoot) + path.sep)) {
    throw migrationError("ERR_GOVERNANCE_MIGRATION_TARGET_SCOPE", "Detached filesystem target cannot be the embedded .agent source or its child.", { targetRoot });
  }

  let journal = createJournal(projectRoot, { kind: "filesystem", locator: relativeTarget, ref: null });
  const archive = path.join(projectRoot, ".agent.pre-migration-" + journal.migration_id);

  try {
    const manifest = buildMigrationManifest(sourceRoot, options);
    journal = transitionJournal(projectRoot, journal, "copy", { manifest });
    copyManifestToFilesystem(manifest, absoluteTarget);
    journal = transitionJournal(projectRoot, journal, "verify");

    fs.renameSync(sourceRoot, archive);
    journal = transitionJournal(projectRoot, journal, "freeze-old-authority", { archive_path: archive });

    fs.symlinkSync(absoluteTarget, sourceRoot);
    writeDescriptor(projectRoot, {
      schema_version: descriptor.schema_version,
      project_id: descriptor.project_id,
      repository: descriptor.repository,
      integration_mode: descriptor.integration_mode,
      capabilities: descriptor.capabilities,
      validation: descriptor.validation,
      artifacts: descriptor.artifacts,
      events: descriptor.events,
      boundaries: descriptor.boundaries,
      governance: { kind: "filesystem", locator: relativeTarget, ref: null },
    });
    journal = transitionJournal(projectRoot, journal, "flip-canonical-binding");

    if (fs.realpathSync(sourceRoot) !== fs.realpathSync(absoluteTarget)) {
      throw migrationError("ERR_GOVERNANCE_MIGRATION_VERIFY_FAILED", "Post-cutover symlink does not resolve to target.");
    }
    verifyFilesystemTarget(manifest, absoluteTarget);
    journal = transitionJournal(projectRoot, journal, "verify-new-authority");
    journal = transitionJournal(projectRoot, journal, "archive-old-source");
    journal = transitionJournal(projectRoot, journal, "completed");
    return { ok: true, journal, archive_path: archive, target_root: fs.realpathSync(absoluteTarget) };
  } catch (error) {
    try {
      if (fs.existsSync(sourceRoot) && fs.lstatSync(sourceRoot).isSymbolicLink()) fs.unlinkSync(sourceRoot);
      if (fs.existsSync(archive) && !fs.existsSync(sourceRoot)) fs.renameSync(archive, sourceRoot);
      writeDescriptor(projectRoot, descriptor);
    } catch (_) {}
    writeJournal(projectRoot, {
      ...journal,
      state: "rolled-back",
      updated_at: new Date().toISOString(),
      error: { code: error.code || "ERR_GOVERNANCE_MIGRATION_FAILED", message: error.message },
    });
    throw error;
  }
}

module.exports = {
  MIGRATION_DIR,
  stateClassForEntry,
  classifyMigrationPath,
  walkFiles,
  buildMigrationManifest,
  copyManifestToFilesystem,
  verifyFilesystemTarget,
  seedManifestToGit,
  journalPath,
  writeJournal,
  createJournal,
  transitionJournal,
  migrateEmbeddedToDetached,
};
