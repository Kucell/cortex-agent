"use strict";

// ─── patches — version-file I/O + patch engine (used by `init`) ──────────────
//
// Originally lived in lib/commands.js. Kept as a self-contained module so
// `init` can `require('./patches')` without dragging in the rest of the
// 3000-line command surface.

const fs = require("node:fs");
const path = require("node:path");

const PATCH_DIR_NAME = "patches";
const APPLIED_FILE = ".applied-patches";

// ─── version-file I/O ────────────────────────────────────────────────────────

function writeVersionFile(cwd, options = {}) {
  const { version } = require("../../package.json");
  const file = path.join(cwd, ".agent", ".cortex-version");
  // Only upgrade opts into a checked result. Code/general init retain their
  // historical single-argument best-effort behavior and undefined return.
  if (options.mode === "upgrade") {
    let fd, error, cleanupError, phase = "mkdir", attempted = false;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      phase = "open";
      // Even open('w') may truncate before an error is reported. Once tried,
      // no exception proves that the previous stamp is still intact.
      attempted = true;
      fd = fs.openSync(file, "w");
      phase = "write";
      const bytes = Buffer.from(`${version}\n`, "utf8");
      let offset = 0;
      while (offset < bytes.length) {
        const count = fs.writeSync(fd, bytes, offset, bytes.length - offset, offset);
        if (!Number.isInteger(count) || count <= 0 || count > bytes.length - offset) {
          throw Object.assign(new Error("Incomplete version stamp write"), { code: "EIO" });
        }
        offset += count;
      }
      phase = "close";
    } catch (cause) { error = cause; }
    if (fd !== undefined) {
      const closing = fd;
      fd = undefined; // One close attempt, including a release-then-throw.
      try { fs.closeSync(closing); }
      catch (cause) {
        if (error) cleanupError = cause;
        else error = cause;
      }
    }
    // This is local write/close evidence, not atomic upgrade, fsync, durable
    // activation or migration proof. Never undo earlier upgrade/template IO.
    if (error) return {
      ok: false, outcome: attempted ? "unknown" : "not-attempted", phase,
      code: error.code || "ERR_VERSION_STAMP_WRITE",
      ...(cleanupError ? { cleanupError: { code: cleanupError.code || "ERR_VERSION_STAMP_CLOSE" } } : {}),
    };
    return { ok: true, outcome: "written", version };
  }
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${version}\n`, "utf8");
  } catch (_) {
    // best-effort: missing perms or readonly FS shouldn't fail the whole init
  }
}

function readVersionFile(cwd) {
  const file = path.join(cwd, ".agent", ".cortex-version");
  try {
    return fs.readFileSync(file, "utf8").trim();
  } catch (_) {
    return null;
  }
}

// ─── patch engine ─────────────────────────────────────────────────────────────
// Patch files live in templates/.agent/patches/*.patch.md
// Frontmatter fields:
//   id           – unique patch identifier (stored in .agent/.applied-patches)
//   target       – path relative to .agent/ (use ../ to reach project root)
//   anchor       – string that must NOT already exist in target (idempotency check)
//   insert_after – (optional) insert body after the line containing this string;
//                  if omitted or not found, body is appended to end of file
function applyPatches(ctx) {
  const { cwd, templateDir, lang } = ctx;
  const isZh = lang === "zh";
  const patchDir = path.join(templateDir, ".agent", PATCH_DIR_NAME);
  if (!fs.existsSync(patchDir)) return;

  const appliedFile = path.join(cwd, ".agent", APPLIED_FILE);
  const applied = fs.existsSync(appliedFile)
    ? new Set(fs.readFileSync(appliedFile, "utf8").split("\n").filter(Boolean))
    : new Set();

  const patchFiles = fs.readdirSync(patchDir)
    .filter((f) => f.endsWith(".patch.md"))
    .sort();

  const patched = [];
  const skipped = [];

  for (const fname of patchFiles) {
    const raw = fs.readFileSync(path.join(patchDir, fname), "utf8");
    // Parse frontmatter between first and second ---
    const fmMatch = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
    if (!fmMatch) continue;
    const fm = {};
    fmMatch[1].split("\n").forEach((line) => {
      const [k, ...v] = line.split(":");
      if (k && v.length) fm[k.trim()] = v.join(":").trim().replace(/^"|"$/g, "");
    });
    const { id, target, anchor, insert_after } = fm;
    if (!id || !target || !anchor) continue;
    if (applied.has(id)) { skipped.push(id); continue; }

    const destFile = path.join(cwd, ".agent", target);
    if (!fs.existsSync(destFile)) { skipped.push(id); continue; }

    const existing = fs.readFileSync(destFile, "utf8");
    if (existing.includes(anchor)) {
      applied.add(id);
      skipped.push(id);
      continue;
    }

    const body = fmMatch[2].trimEnd();
    let updated;
    if (insert_after && existing.includes(insert_after)) {
      const markerIndex = existing.indexOf(insert_after);
      const markerLineEnd = existing.indexOf("\n", markerIndex + insert_after.length);
      const idx = markerLineEnd === -1 ? existing.length : markerLineEnd;
      updated = existing.slice(0, idx) + "\n" + body + existing.slice(idx);
    } else {
      updated = existing.trimEnd() + "\n" + body + "\n";
    }
    fs.writeFileSync(destFile, updated, "utf8");
    applied.add(id);
    patched.push(`${id} → ${target}`);
  }

  fs.writeFileSync(appliedFile, [...applied].join("\n") + "\n", "utf8");

  if (patched.length > 0) {
    console.log(isZh
      ? `\n🩹 已应用规则补丁 (${patched.length})：`
      : `\n🩹 Applied patches (${patched.length}):`);
    patched.forEach((p) => console.log(`   + ${p}`));
  }
}

module.exports = {
  applyPatches,
  writeVersionFile,
  readVersionFile,
  APPLIED_FILE,
  PATCH_DIR_NAME,
};
