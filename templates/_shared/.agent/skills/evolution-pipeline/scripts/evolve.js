#!/usr/bin/env node
/**
 * evolve — Phase 2.2 Self-evolution async pipeline.
 *
 * Inspired by OpenViking's `session.commit()` async memory extraction:
 * after `runtime-continuity` writes an archive, this worker reads the
 * archive, classifies its content into the four memory scopes, and writes
 * topic files into `.agent/memory/{user,feedback,project,reference}/`
 * (plus optionally `experiences/` for commit-anchored lessons).
 *
 * v1 uses a deterministic keyword-based classifier; downstream `extractor`
 * can be swapped for an LLM call without changing the queue contract.
 *
 * Usage:
 *   node evolve.js --enqueue --archive <archive-id>      # add to queue
 *   node evolve.js --worker --once                       # process one task
 *   node evolve.js --worker --loop --interval 30        # poll loop
 *   node evolve.js --status                             # queue summary
 *   node evolve.js --list [--status pending]             # list tasks
 *   node evolve.js --replay EVO-2026-07-24-001          # retry failed
 *   node evolve.js --dead-letter                        # show dead tasks
 *   node evolve.js --enqueue-from-latest                # enqueue from latest archive
 *   node evolve.js --enqueue-from-latest --max 5        # batch up to 5
 *
 * Output: JSON to stdout.
 *
 * Task files live at `.agent/tasks/evolution/{task_id}.json`.
 * Dead-letter moves to `.agent/tasks/evolution/_dead/`.
 */

"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const ROOT = process.cwd();
const TASKS_DIR = path.join(ROOT, ".agent", "tasks", "evolution");
const DEAD_DIR = path.join(TASKS_DIR, "_dead");
const MEMORY_DIR = path.join(ROOT, ".agent", "memory");
const ARCHIVES_DIR = path.join(ROOT, ".agent", "runtime-continuity", "archives");
const LATEST_ARCHIVE = path.join(ARCHIVES_DIR, "latest.json");


const PROPOSAL_KIND = "archive_learning_proposal";
const PROPOSALS_DIR = path.join(TASKS_DIR, "_proposals");
const PROPOSAL_ID = /^EVO-P-[0-9a-f]{64}$/;
const MAX_ARCHIVE_BYTES = 1024 * 1024;

function proposalError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}
function digest(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}
function proposalBytes(value) {
  return JSON.stringify(value, null, 2) + "\n";
}
function proposalScope(project) {
  if (typeof project !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(project)
      || project.includes("..")) throw proposalError("ERR_PROPOSAL_PROJECT");
  return {
    project,
    workspace_id: "workspace-sha256:" + digest(fs.realpathSync(ROOT)),
  };
}
// Fixed project-local paths only; reject observed symlinked components.
// These checks are not fencing against an adversarial filesystem writer.
function checkedParents(file, create = false) {
  const relative = path.relative(ROOT, path.dirname(file));
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw proposalError("ERR_PROPOSAL_PATH");
  let cursor = ROOT;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, segment);
    if (!fs.existsSync(cursor)) {
      if (!create) return false;
      try { fs.mkdirSync(cursor); } catch (error) { if (error.code !== "EEXIST") throw error; }
    }
    const stat = fs.lstatSync(cursor);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw proposalError("ERR_PROPOSAL_PATH");
  }
  return true;
}
function readProposalBytes(file) {
  if (!checkedParents(file)) throw proposalError("ERR_PROPOSAL_NOT_FOUND");
  if (!Number.isInteger(fs.constants.O_NOFOLLOW) || !Number.isInteger(fs.constants.O_NONBLOCK)
      || fs.constants.O_NOFOLLOW === 0 || fs.constants.O_NONBLOCK === 0) {
    throw proposalError("ERR_PROPOSAL_SAFE_OPEN_UNSUPPORTED");
  }
  function regular(stat) {
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > BigInt(MAX_ARCHIVE_BYTES)) {
      throw proposalError("ERR_PROPOSAL_FILE");
    }
    if (stat.nlink !== 1n) throw proposalError("ERR_PROPOSAL_FILE_LINKS");
  }
  const before = fs.lstatSync(file, { bigint: true });
  regular(before);
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const opened = fs.fstatSync(fd, { bigint: true });
    regular(opened);
    if (opened.dev !== before.dev || opened.ino !== before.ino
        || opened.size !== before.size || opened.mtimeNs !== before.mtimeNs
        || opened.ctimeNs !== before.ctimeNs) throw proposalError("ERR_PROPOSAL_FILE_CHANGED");
    const buffer = Buffer.alloc(Number(opened.size) + 1);
    let size = 0;
    while (size < buffer.length) {
      const count = fs.readSync(fd, buffer, size, buffer.length - size, null);
      if (count === 0) break;
      size += count;
    }
    const after = fs.fstatSync(fd, { bigint: true });
    const named = fs.lstatSync(file, { bigint: true });
    regular(after); regular(named);
    if (size > MAX_ARCHIVE_BYTES || BigInt(size) !== opened.size
        || after.dev !== opened.dev || after.ino !== opened.ino
        || named.dev !== opened.dev || named.ino !== opened.ino
        || after.size !== opened.size || named.size !== opened.size
        || after.mtimeNs !== opened.mtimeNs || after.ctimeNs !== opened.ctimeNs
        || named.mtimeNs !== opened.mtimeNs || named.ctimeNs !== opened.ctimeNs) {
      throw proposalError("ERR_PROPOSAL_FILE_CHANGED");
    }
    return buffer.subarray(0, size);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}
function readProposalFile(file) {
  return readProposalBytes(file).toString("utf8");
}
function sameProposalFile(file, value) {
  if (readProposalFile(file) !== proposalBytes(value)) throw proposalError("ERR_PROPOSAL_RECORD_CONFLICT");
}
// Publish a complete immutable file, or verify the existing identical record.
// An exit before link leaves an ignored .tmp. An exit between link/unlink can
// leave a multi-link record: readers block and preserve it for explicit repair.
// No overwrite, sequence allocation, queue rewrite or index.
function verifyPublishedProposal(file, value) {
  // A concurrent publisher immediately removes its temporary hard link.
  // Never read multi-link bytes; wait only a bounded 100 ms for that transition.
  for (let attempt = 0; ; attempt++) {
    try { sameProposalFile(file, value); return; }
    catch (error) {
      if (error.code !== "ERR_PROPOSAL_FILE_LINKS" || attempt >= 20) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
    }
  }
}
function publishProposalFile(file, value) {
  if (fs.existsSync(file)) {
    verifyPublishedProposal(file, value);
    return false;
  }
  checkedParents(file, true);
  const temporary = path.join(path.dirname(file), ".proposal-" + crypto.randomBytes(12).toString("hex") + ".tmp");
  let fd;
  let ownedTemporary = false;
  try {
    fd = fs.openSync(temporary, "wx", 0o600);
    ownedTemporary = true;
    fs.writeFileSync(fd, proposalBytes(value), "utf8");
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    try { fs.linkSync(temporary, file); }
    catch (error) {
      if (error.code !== "EEXIST") throw error;
      verifyPublishedProposal(file, value);
      return false;
    }
    fs.unlinkSync(temporary);
    ownedTemporary = false;
    verifyPublishedProposal(file, value);
    return true;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    if (ownedTemporary) {
      try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== "ENOENT") throw error; }
    }
  }
}
function proposalArchive(archivePath, expectedProject) {
  const file = path.resolve(archivePath);
  if (path.dirname(file) !== ARCHIVES_DIR || path.basename(file) === "latest.json") {
    throw proposalError("ERR_PROPOSAL_ARCHIVE_PATH");
  }
  const bytes = readProposalBytes(file);
  const raw = bytes.toString("utf8");
  if (!Buffer.from(raw, "utf8").equals(bytes)) throw proposalError("ERR_PROPOSAL_ARCHIVE_ENCODING");
  const archive = JSON.parse(raw);
  if (!archive || typeof archive !== "object" || Array.isArray(archive)
      || typeof archive.archive_id !== "string" || !/^RC-[A-Za-z0-9_-]+$/.test(archive.archive_id)
      || path.basename(file) !== archive.archive_id + ".json") {
    throw proposalError("ERR_PROPOSAL_ARCHIVE_ID");
  }
  const scope = proposalScope(expectedProject);
  if (archive.project !== scope.project) throw proposalError("ERR_PROPOSAL_PROJECT_MISMATCH");
  if (typeof archive.created_at !== "string" || !Number.isFinite(Date.parse(archive.created_at))
      || new Date(archive.created_at).toISOString() !== archive.created_at) {
    throw proposalError("ERR_PROPOSAL_ARCHIVE_TIME");
  }
  const state = archive.state;
  if (!state || typeof state !== "object" || Array.isArray(state)) throw proposalError("ERR_PROPOSAL_ARCHIVE_STATE");
  const counts = {};
  for (const [field, label] of [["done", "reported_done"], ["next", "planned_next"], ["blockers", "reported_blockers"]]) {
    const values = state[field] === undefined ? [] : state[field];
    if (!Array.isArray(values) || values.some((v) => typeof v !== "string" || !v.trim())) {
      throw proposalError("ERR_PROPOSAL_ARCHIVE_STATE");
    }
    counts[label] = values.length;
  }
  if (state.in_progress != null && typeof state.in_progress !== "string") throw proposalError("ERR_PROPOSAL_ARCHIVE_STATE");
  counts.reported_in_progress = typeof state.in_progress === "string" && state.in_progress.trim() ? 1 : 0;
  const sha256 = digest(bytes);
  const taskId = "EVO-P-" + digest(JSON.stringify([scope, archive.archive_id, sha256]));
  return {
    schema_version: "1", kind: PROPOSAL_KIND, task_id: taskId,
    project_scope: scope,
    source_archive: {
      archive_id: archive.archive_id,
      archive_path: path.relative(ROOT, file).split(path.sep).join("/"),
      sha256, created_at: archive.created_at,
    },
    created_at: archive.created_at, updated_at: archive.created_at, status: "pending",
    observation_counts: counts, execution_authorized: false, allowed_effects: [],
  };
}
function proposalFor(task) {
  return {
    schema_version: "1", kind: "archive_learning_proposal_result", proposal_id: task.task_id,
    project_scope: task.project_scope, source_archive: task.source_archive,
    status: "proposal_only", verification_status: "not_run",
    observation_counts: task.observation_counts,
    proposed_checks: [
      "Review the referenced archive inside this project before selecting evidence.",
      "Verify reported outcomes independently before proposing any change.",
    ],
    limitations: [
      "Archive contents are unverified observations; this document contains no extracted private text.",
      "No memory, index, Task, Host run, promotion, or execution permission is created.",
    ],
    execution_authorized: false, allowed_effects: [],
  };
}
function loadProposalTask(taskId) {
  if (typeof taskId !== "string" || !PROPOSAL_ID.test(taskId)) throw proposalError("ERR_PROPOSAL_TASK_ID");
  const file = path.join(TASKS_DIR, taskId + ".json");
  const stored = JSON.parse(readProposalFile(file));
  if (stored.kind !== PROPOSAL_KIND || stored.task_id !== taskId || !stored.source_archive
      || !stored.project_scope) throw proposalError("ERR_PROPOSAL_TASK_SHAPE");
  if (typeof stored.source_archive.archive_path !== "string") throw proposalError("ERR_PROPOSAL_ARCHIVE_PATH");
  const task = proposalArchive(path.resolve(ROOT, stored.source_archive.archive_path), stored.project_scope.project);
  if (task.task_id !== taskId) throw proposalError("ERR_PROPOSAL_SOURCE_CHANGED");
  sameProposalFile(file, task);
  return task;
}
function enqueueProposalFromArchive(archivePath, opts) {
  const task = proposalArchive(archivePath, opts.expectedProject);
  const file = path.join(TASKS_DIR, task.task_id + ".json");
  if (opts.dryRun) {
    if (fs.existsSync(file)) sameProposalFile(file, task);
    return {
      dry_run: true, task_id: null, would_enqueue: !fs.existsSync(file),
      project_scope: task.project_scope, source_archive: task.source_archive,
      execution_authorized: false, allowed_effects: [],
    };
  }
  const created = publishProposalFile(file, task);
  return { ...task, deduplicated: !created };
}
function processProposalTask(taskId, opts = {}) {
  const task = loadProposalTask(taskId);
  const proposal = proposalFor(task);
  const file = path.join(PROPOSALS_DIR, taskId + ".json");
  if (opts.dryRun) {
    if (fs.existsSync(file)) sameProposalFile(file, proposal);
    return { ...task, status: "proposal_only", dry_run: true, proposal_ref: null, would_write_proposal: !fs.existsSync(file) };
  }
  const created = publishProposalFile(file, proposal);
  return {
    ...task, status: "proposal_only", deduplicated: !created,
    proposal_ref: path.relative(ROOT, file).split(path.sep).join("/"),
  };
}
function observedProposalTask(taskId) {
  try {
    const current = loadProposalTask(taskId);
    const file = path.join(PROPOSALS_DIR, taskId + ".json");
    if (!fs.existsSync(file)) return current;
    sameProposalFile(file, proposalFor(current));
    return { ...current, status: "proposal_only", proposal_ref: path.relative(ROOT, file).split(path.sep).join("/") };
  } catch (error) {
    return { schema_version: "1", kind: PROPOSAL_KIND, task_id: taskId,
      created_at: "", status: "blocked", execution_authorized: false, allowed_effects: [],
      proposal_error: error.code || "ERR_PROPOSAL_READ" };
  }
}

function parseArgs() {
  const args = {};
  for (let i = 2; i < process.argv.length; i++) {
    const a = process.argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = process.argv[i + 1];
      if (next && !next.startsWith("--")) { args[key] = next; i++; }
      else args[key] = true;
    }
  }
  return args;
}

function ensureDir(p) { fs.mkdirSync(p, { recursive: true }); }

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

function writeJson(p, obj) {
  ensureDir(path.dirname(p));
  fs.writeFileSync(p, JSON.stringify(obj, null, 2) + "\n");
}

function archIdFromFile(p) {
  return path.basename(p, ".json");
}

function nextTaskId() {
  const now = new Date();
  const ymd = now.toISOString().slice(0, 10);
  const existing = fs.existsSync(TASKS_DIR)
    ? fs.readdirSync(TASKS_DIR).filter((f) => f.endsWith(".json") && f.startsWith(`EVO-${ymd}-`))
    : [];
  let seq = 1;
  while (existing.includes(`EVO-${ymd}-${String(seq).padStart(3, "0")}.json`)) seq++;
  return `EVO-${ymd}-${String(seq).padStart(3, "0")}`;
}

/**
 * Classify an archive into routes. v1 = deterministic keyword match.
 * Returns { routes: { user: [], feedback: [], project: [], experiences: [] }, dropped: [] }
 * Each route entry is a topic file draft ready to write.
 */
function classifyArchive(archive) {
  const out = { user: [], feedback: [], project: [], experiences: [], dropped: [] };
  const state = archive.state || {};
  const head = archive.project || "cortex-agent";
  const archiveId = archive.archive_id || archIdFromFile(archive.path || "");
  const at = (archive.created_at || new Date().toISOString()).slice(0, 10);

  // 1) Blockers → feedback (high-priority observation)
  if (Array.isArray(state.blockers) && state.blockers.length) {
    for (const note of state.blockers) {
      if (typeof note !== "string" || !note.trim()) continue;
      out.feedback.push({
        name: slugify(`blocker-${archiveId}-${at}`),
        body: blockerToFeedbackBody(note, archiveId, at),
      });
    }
  }

  // 2) Done items → project facts (reusable)
  if (Array.isArray(state.done) && state.done.length) {
    for (const note of state.done) {
      if (typeof note !== "string" || !note.trim()) continue;
      // Experiences heuristic: contains "lesson", "trap", "regression", "caused" → experiences
      if (/(\blearn|lesson|trap|regression|caused|root cause|防复发)/i.test(note)) {
        out.experiences.push({
          name: slugify(`lesson-${archiveId}-${at}`),
          body: lessonToExperienceBody(note, archiveId, at),
        });
      } else {
        out.project.push({
          name: slugify(`project-${archiveId}-${at}`),
          body: projectFactBody(note, archiveId, at),
        });
      }
    }
  }

  // 3) In-progress notes → feedback (active observation)
  if (typeof state.in_progress === "string" && state.in_progress.trim()) {
    out.feedback.push({
      name: slugify(`progress-${archiveId}-${at}`),
      body: feedbackBody(state.in_progress, "in_progress", archiveId, at),
    });
  }

  // 4) Next items → project (planned but not committed)
  if (Array.isArray(state.next) && state.next.length) {
    for (const note of state.next) {
      if (typeof note !== "string" || !note.trim()) continue;
      out.project.push({
        name: slugify(`next-${archiveId}-${at}`),
        body: projectFactBody(note, archiveId, at),
      });
    }
  }

  return out;
}

function slugify(s) {
  return s.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "x";
}

function frontmatter(name, type, tags) {
  return [
    "---",
    `name: ${name}`,
    `description: ${type} extracted from ${currentSourceArchiveId || "archive"} on ${new Date().toISOString().slice(0, 10)}`,
    `type: ${type}`,
    `created: ${new Date().toISOString().slice(0, 10)}`,
    `tags: ${tags.join(", ")}`,
    "---",
    "",
  ].join("\n");
}

let currentSourceArchiveId = ""; // set by worker; used by frontmatter()

function blockerToFeedbackBody(note, archiveId, at) {
  return [
    `**Observation**: ${note}`,
    `**Why**: 现存阻塞点，下次启动优先检查是否仍然成立。`,
    `**How to apply**: 对应任务恢复时先验证阻塞根因是否消失，再继续。`,
    ``,
    `<!-- source: ${archiveId} at ${at} -->`,
  ].join("\n");
}

function feedbackBody(note, kind, archiveId, at) {
  return [
    `**Observation (${kind})**: ${note}`,
    `**Why**: 主动跟踪以免下次丢失。`,
    `**How to apply**: 触发场景出现时主动 recall。`,
    ``,
    `<!-- source: ${archiveId} at ${at} -->`,
  ].join("\n");
}

function projectFactBody(note, archiveId, at) {
  return [
    `**Fact**: ${note}`,
    `**Why**: 从 session 归档中提取的项目级事实。`,
    `**How to apply**: 在相关 plan / ship 阶段引用，避免重复调研。`,
    ``,
    `<!-- source: ${archiveId} at ${at} -->`,
  ].join("\n");
}

function lessonToExperienceBody(note, archiveId, at) {
  return [
    `**Lesson**: ${note}`,
    `**Why**: commit-anchored lesson，触发防复发检查。`,
    `**How to apply**: 修改相关文件前调用 \`experience-recall --tags\` 查询。`,
    ``,
    `<!-- source: ${archiveId} at ${at} -->`,
  ].join("\n");
}


function updateMemoryIndex(topicFile, scope, name) {
  const indexPath = path.join(MEMORY_DIR, "MEMORY.md");
  const trigger = scope === "feedback" ? "auto-evolution" : scope;
  const line = `- [${name}](${scope}/${name}.md) — ${trigger}`;
  if (!fs.existsSync(indexPath)) {
    // Initialize from a minimal skeleton
    const skeleton = [
      "# .agent/memory/ INDEX",
      "",
      "## user (0/10)",
      "",
      "## feedback (0/30)",
      "",
      "## project (0/20)",
      "",
      "## reference (0/50)",
      "",
    ].join("\n");
    fs.writeFileSync(indexPath, skeleton);
  }
  const text = fs.readFileSync(indexPath, "utf8");
  if (text.includes(`${scope}/${name}.md`)) return; // already indexed
  const headerRe = new RegExp(`^## ${scope} \([^\n]+\)$`, "m");
  const insert = line + "\n";
  if (headerRe.test(text)) {
    const updated = text.replace(headerRe, `$&\n${insert}`);
    fs.writeFileSync(indexPath, updated);
  } else {
    fs.appendFileSync(indexPath, `\n## ${scope} (auto)\n\n${insert}`);
  }
}

function writeMemoryItem(scope, item, archiveId) {
  const scopeDir = path.join(MEMORY_DIR, scope);
  ensureDir(scopeDir);
  const filePath = path.join(scopeDir, `${item.name}.md`);
  currentSourceArchiveId = archiveId;
  const fm = frontmatter(item.name, scope, [scope, "auto-evolution", archiveId.slice(0, 20)]);
  const content = `${fm}${item.body}`;
  fs.writeFileSync(filePath, content);
  return path.relative(ROOT, filePath);
}

/**
 * Worker: process one task end-to-end.
 * Returns the updated task.
 */
function processTask(taskId, opts = {}) {
  if (typeof taskId === "string" && taskId.startsWith("EVO-P-")) return processProposalTask(taskId, opts);
  const file = path.join(TASKS_DIR, `${taskId}.json`);
  if (!fs.existsSync(file)) throw new Error(`task not found: ${taskId}`);
  const task = readJson(file);
  if (task.kind === PROPOSAL_KIND) return processProposalTask(taskId, opts);
  task.status = "running";
  if (opts.dryRun) task.dry_run = true;
  task.started_at = new Date().toISOString();
  task.updated_at = task.started_at;
  task.errors = task.errors || [];
  task.extracted = task.extracted || { user: [], feedback: [], project: [], experiences: [] };
  task.classification = task.classification || { user: 0, feedback: 0, project: 0, experiences: 0, dropped: 0 };

  try {
    const archivePath = path.join(ROOT, task.source_archive.archive_path);
    if (!fs.existsSync(archivePath)) throw new Error(`source archive missing: ${archivePath}`);
    const archive = readJson(archivePath);
    const routes = classifyArchive(archive);
    const archiveId = task.source_archive.archive_id;

    for (const [scope, items] of Object.entries(routes)) {
      if (scope === "dropped") continue;
      for (const item of items) {
        if (opts.dryRun) {
          task.extracted[scope].push("(dry-run)");
        } else {
          const written = writeMemoryItem(scope, item, archiveId);
          updateMemoryIndex(written, scope, item.name);
          task.extracted[scope].push(written);
        }
        task.classification[scope] = (task.classification[scope] || 0) + 1;
      }
    }
    task.classification.dropped = (routes.dropped || []).length;
   task.status = "completed";
   task.completed_at = new Date().toISOString();
   task.updated_at = task.completed_at;
   if (!opts.dryRun) writeJson(file, task);
 } catch (err) {
    task.errors.push({ at: new Date().toISOString(), stage: "process", message: err.message });
    task.retry_count = (task.retry_count || 0) + 1;
    task.updated_at = new Date().toISOString();
    if (task.retry_count >= (task.max_retries || 3)) {
      task.status = "dead";
      if (!opts.dryRun) {
        // write to dead dir, then delete original (rename would not save updated status)
        ensureDir(DEAD_DIR);
        writeJson(path.join(DEAD_DIR, `${taskId}.json`), task);
        fs.unlinkSync(file);
      }
   } else {
     task.status = "failed";
     if (!opts.dryRun) writeJson(file, task);
   }
 }
 return task;
}

/** Read-only preview: do not allocate a queue ID or write to disk. */
function previewEnqueueFromArchive(archivePath) {
  if (!fs.existsSync(archivePath)) throw new Error(`archive not found: ${archivePath}`);
  const archive = readJson(archivePath);
  if (!archive || typeof archive !== "object" || Array.isArray(archive)) {
    throw new Error(`archive must be a JSON object: ${archivePath}`);
  }
  return {
    dry_run: true,
    would_enqueue: true,
    task_id: null,
    source_archive: {
      archive_id: archive.archive_id || archIdFromFile(archivePath),
      archive_path: path.relative(ROOT, archivePath),
      created_at: archive.created_at || null,
    },
  };
}

function enqueueFromArchive(archivePath, opts = {}) {
  if (opts.proposalOnly === true) return enqueueProposalFromArchive(archivePath, opts);
  if (opts.dryRun) return previewEnqueueFromArchive(archivePath);
  if (!fs.existsSync(archivePath)) throw new Error(`archive not found: ${archivePath}`);
  const archive = readJson(archivePath);
  const taskId = nextTaskId();
  const task = {
    task_id: taskId,
    source_archive: {
      archive_id: archive.archive_id || archIdFromFile(archivePath),
      archive_path: path.relative(ROOT, archivePath),
      created_at: archive.created_at || new Date().toISOString(),
    },
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    status: "pending",
    retry_count: 0,
    max_retries: opts.maxRetries || 3,
    extracted: { user: [], feedback: [], project: [], experiences: [] },
    classification: { user: 0, feedback: 0, project: 0, experiences: 0, dropped: 0 },
    errors: [],
  };
  writeJson(path.join(TASKS_DIR, `${taskId}.json`), task);
  return task;
}

function listTasks(filter = {}) {
  if (filter.proposalOnly === true && !checkedParents(path.join(TASKS_DIR, "reserved.json"))) return [];
  if (!fs.existsSync(TASKS_DIR)) return [];
  const files = fs.readdirSync(TASKS_DIR).filter((f) => f.endsWith(".json"));
  const out = [];
  for (const f of files) {
    if (filter.proposalOnly === true && !f.startsWith("EVO-P-")) continue;
    const t = f.startsWith("EVO-P-")
      ? observedProposalTask(f.slice(0, -5)) : readJson(path.join(TASKS_DIR, f));
    if (filter.status && t.status !== filter.status) continue;
    out.push(t);
  }
  return out.sort((a, b) => a.created_at.localeCompare(b.created_at));
}

function deadLetterTasks() {
  if (!fs.existsSync(DEAD_DIR)) return [];
  return fs.readdirSync(DEAD_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => readJson(path.join(DEAD_DIR, f)));
}

function replayDead(taskId) {
  const deadFile = path.join(DEAD_DIR, `${taskId}.json`);
  if (!fs.existsSync(deadFile)) throw new Error(`dead task not found: ${taskId}`);
  const task = readJson(deadFile);
  task.status = "pending";
  task.retry_count = 0;
  task.errors = [];
  fs.unlinkSync(deadFile);
  writeJson(path.join(TASKS_DIR, `${taskId}.json`), task);
  return task;
}

function main() {
  const args = parseArgs();

  try {
    if (args["dry-run"] && (args.replay || (args.worker && args.loop))) {
      throw new Error("--dry-run does not support replay or a polling worker loop");
    }

    if (args["proposal-only"] !== undefined && args["proposal-only"] !== true) {
      throw proposalError("ERR_PROPOSAL_MODE_FLAG");
    }
    if (args["proposal-only"] && (args["enqueue-from-latest"] || args["dead-letter"] || args.loop)) {
      throw proposalError("ERR_PROPOSAL_UNSUPPORTED_MODE");
    }
    if (args["proposal-only"] && [args.enqueue, args.worker, args.replay, args.list, args.status && !args.list].filter(Boolean).length !== 1) {
      throw proposalError("ERR_PROPOSAL_ACTION_REQUIRED");
    }
    if (args["proposal-only"] && args.worker && !args.once) {
      throw proposalError("ERR_PROPOSAL_WORKER_REQUIRES_ONCE");
    }
    if (args["proposal-only"] && args.replay) {
      const task = processProposalTask(args.replay);
      console.log(JSON.stringify({ ok: true, replayed: task }, null, 2));
      return;
    }

    if (args.enqueue || args["enqueue-from-latest"]) {
      let entries = [];
      if (args.archive) {
        const archivePath = path.isAbsolute(args.archive) ? args.archive : path.join(ARCHIVES_DIR, args.archive + ".json");
        entries.push(archivePath);
      } else if (args["enqueue-from-latest"]) {
        if (!fs.existsSync(LATEST_ARCHIVE)) throw new Error("latest archive not found");
        const latest = readJson(LATEST_ARCHIVE);
        const archId = latest.archive_id;
        // Find all archives newer than latest processed (in v1, just the latest)
        const max = parseInt(args.max || "1", 10);
        const files = fs.readdirSync(ARCHIVES_DIR).filter((f) => f.endsWith(".json") && !f.startsWith("latest")).sort();
        const idx = files.findIndex((f) => f === archId + ".json");
        const slice = idx >= 0 ? files.slice(idx, idx + max) : files.slice(-max);
        entries = slice.map((f) => path.join(ARCHIVES_DIR, f));
      } else {
        throw new Error("specify --archive or --enqueue-from-latest");
      }
      const dryRun = !!args["dry-run"];
      const created = entries.map((e) => enqueueFromArchive(e, {
        dryRun, proposalOnly: args["proposal-only"] === true, expectedProject: args.project,
      }));
      if (dryRun) {
        console.log(JSON.stringify({ ok: true, dry_run: true, enqueued: 0, previews: created }, null, 2));
      } else {
        console.log(JSON.stringify({ ok: true, enqueued: created.filter((t) => !t.deduplicated).length,
          deduplicated: created.filter((t) => t.deduplicated).length, tasks: created.map((t) => t.task_id) }, null, 2));
      }
      return;
    }

    if (args.worker) {
      const proposalOnly = args["proposal-only"] === true;
      const pending = listTasks({ status: "pending", proposalOnly })
        .concat(listTasks({ status: "failed", proposalOnly }));
      if (args.once) {
        if (!pending.length) {
          console.log(JSON.stringify({ ok: true, processed: 0, message: "no pending tasks" }, null, 2));
          return;
        }
        const task = pending[0];
        const dryRun = !!args["dry-run"];
        const result = processTask(task.task_id, { dryRun });
        if (dryRun) {
          console.log(JSON.stringify({ ok: true, dry_run: true, processed: 0, would_process: 1, task: result }, null, 2));
        } else {
          console.log(JSON.stringify({ ok: true, processed: 1, task: result }, null, 2));
        }
        return;
      }
      if (args.loop) {
        const interval = parseInt(args.interval || "30", 10) * 1000;
        console.log(`polling every ${interval / 1000}s (Ctrl-C to stop)`);
        let stop = false;
        process.on("SIGINT", () => { stop = true; });
        const tick = () => {
          if (stop) { process.exit(0); }
          const p = listTasks({ status: "pending" });
          if (p.length) {
            try { processTask(p[0].task_id); } catch (err) { console.error(err.message); }
          }
          setTimeout(tick, interval);
        };
        tick();
        return;
      }
    }

    if (args.replay) {
      const taskId = args.replay;
      if (typeof taskId === "string" && taskId.startsWith("EVO-P-")) throw proposalError("ERR_PROPOSAL_REPLAY_REQUIRES_MODE");
      let task;
     if (fs.existsSync(path.join(TASKS_DIR, `${taskId}.json`))) {
       task = readJson(path.join(TASKS_DIR, `${taskId}.json`));
       if (task.kind === PROPOSAL_KIND) throw proposalError("ERR_PROPOSAL_REPLAY_REQUIRES_MODE");
       task.status = "pending";
       task.retry_count = 0;
       task.errors = [];
       writeJson(path.join(TASKS_DIR, `${taskId}.json`), task);
     } else if (fs.existsSync(path.join(DEAD_DIR, `${taskId}.json`))) {
        task = replayDead(taskId);
      } else {
        throw new Error(`task not found: ${taskId}`);
      }
      console.log(JSON.stringify({ ok: true, replayed: task }, null, 2));
      return;
    }

    if (args["dead-letter"]) {
      const dead = deadLetterTasks();
      console.log(JSON.stringify({ ok: true, dead_count: dead.length, tasks: dead }, null, 2));
      return;
    }

    if (args.list) {
      const filt = args.status || null;
      const tasks = listTasks({ ...(filt ? { status: filt } : {}), proposalOnly: args["proposal-only"] === true });
      console.log(JSON.stringify({ ok: true, count: tasks.length, tasks: tasks.map((t) => ({ task_id: t.task_id, status: t.status, archive: t.source_archive ? t.source_archive.archive_id : null, retry_count: t.retry_count, classification: t.classification, proposal_error: t.proposal_error || null })) }, null, 2));
      return;
    }

    if (args.status) {
      const tasks = listTasks({ proposalOnly: args["proposal-only"] === true });
      const by = tasks.reduce((acc, t) => { acc[t.status] = (acc[t.status] || 0) + 1; return acc; }, {});
      const dead = args["proposal-only"] ? 0 : deadLetterTasks().length;
      console.log(JSON.stringify({
        ok: true,
        total: tasks.length,
        by_status: by,
        dead_letter: dead,
        tasks_dir: path.relative(ROOT, TASKS_DIR),
      }, null, 2));
      return;
    }

    // Default: usage
    console.log(JSON.stringify({
      ok: false,
      error: "specify a flag",
      usage: {
        "--enqueue --archive <id>": "queue a task from a specific archive",
        "--enqueue-from-latest [--max N]": "queue from latest archive",
        "--worker --once": "process one pending task",
        "--worker --loop --interval <s>": "poll loop",
        "--list [--status <status>]": "list tasks",
        "--status": "queue summary",
        "--replay <task_id>": "retry failed or dead task",
        "--dead-letter": "show dead tasks",
      },
    }, null, 2));
  } catch (err) {
    console.log(JSON.stringify({ ok: false, error: err.message, stack: err.stack }, null, 2));
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  classifyArchive,
  processTask,
  processProposalTask,
  previewEnqueueFromArchive,
  enqueueFromArchive,
  listTasks,
  deadLetterTasks,
};
