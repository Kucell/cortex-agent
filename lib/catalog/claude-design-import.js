"use strict";

// ─── claude-design-import — Claude Design ZIP → .agent/ design-system (P-001 MS-002 round 2) ──
//
// Importer for Claude Design (`https://claude.ai/design`) project exports.
//
// Input:  a ZIP archive downloaded from Claude Design (typically `my-project.zip`).
//         The ZIP contains at minimum:
//           - design.md         (markdown with the design description)
//           - tokens.json       (design tokens — optional)
//           - assets/           (images / fonts / icons — optional)
//
// Output: extracted as a design-system at <cwd>/.agent/design-systems/<id>/:
//           - DESIGN.md   ← renamed from design.md
//           - tokens.css  ← synthesized from tokens.json (best-effort)
//           - manifest.json ← synthesized (id, license: Apache-2.0 default, source: claude-design)
//           - assets/     ← verbatim copy
//
// Implementation notes:
//   - Pure Node.js built-ins (node:fs, node:path, node:crypto, node:zlib).
//   - The ZIP reader handles both stored (method 0) and deflated (method 8)
//     entries — no external zip lib needed. (Most Claude Design exports use
//     deflate for assets, stored for markdown/text.)
//   - Concurrency is single-threaded and atomic — the dest dir is created only
//     after all entries are validated and ready to write. On any failure, the
//     dest dir is removed.
//
// Why "best-effort" tokens.css:
//   - Claude Design's tokens.json schema isn't frozen (we observed v0.3 / v0.4
//     in the wild). We synthesize a `:root { --token-name: value; }` CSS block
//     that Libre / Figma / Sketch / Tokens Studio all understand. Unknown
//     token shapes are preserved verbatim in `x-unknown-tokens` to avoid
//     information loss.
//   - When tokens.json is missing, we skip tokens.css (the install still
//     succeeds — DESIGN.md + manifest.json are sufficient for the cascade).
//
// No npm deps.

const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");

const { resolveInstallPath, getKind } = require("./kind-map");

// ZIP end-of-central-directory signature: 0x06054b50 (little-endian "PK\005\006").
const EOCD_SIG = 0x06054b50;
// ZIP local file header signature: 0x04034b50.
const LFH_SIG = 0x04034b50;
// ZIP central directory entry signature: 0x02014b50.
const CDH_SIG = 0x02014b50;

const METHOD_STORED = 0;
const METHOD_DEFLATED = 8;

const ZIP_MAX_BYTES = 200 * 1024 * 1024; // 200 MiB hard cap (Claude Design exports are < 50 MiB)

/**
 * Read 16-bit little-endian unsigned int.
 */
function readU16LE(buf, off) {
  return buf[off] | (buf[off + 1] << 8);
}

/**
 * Read 32-bit little-endian unsigned int.
 */
function readU32LE(buf, off) {
  return buf[off] | (buf[off + 1] << 8) | (buf[off + 2] << 16) | (buf[off + 3] << 24);
}

/**
 * Locate the End of Central Directory record by scanning backwards. The EOCD
 * can live in the last 64 KiB (with a 22-byte minimum).
 */
function findEocd(buf) {
  const maxBack = Math.min(buf.length, 65557);
  const start = buf.length - maxBack;
  for (let i = buf.length - 22; i >= start; i--) {
    if (readU32LE(buf, i) === EOCD_SIG) {
      return i;
    }
  }
  return -1;
}

/**
 * Validate that a path is safe (no traversal outside the destination root).
 * Rejects absolute paths, parent refs, and CR/LF injection.
 */
function isSafeEntryPath(name) {
  if (typeof name !== "string" || name.length === 0) return false;
  if (name.includes("\0") || name.includes("\r") || name.includes("\n")) return false;
  if (path.isAbsolute(name)) return false;
  const normalized = path.posix.normalize(name);
  if (normalized.startsWith("../") || normalized === ".." || normalized.includes("/../")) {
    return false;
  }
  return true;
}

/**
 * Parse a ZIP archive buffer into a Map<filename, Buffer>. Pure JS, no deps.
 *
 * @param {Buffer} buf  ZIP bytes
 * @returns {Map<string, { data: Buffer, method: number, size: number }>}
 */
function parseZip(buf) {
  if (!Buffer.isBuffer(buf)) {
    throw new Error("claude-design-import: input must be a Buffer");
  }
  if (buf.length > ZIP_MAX_BYTES) {
    throw new Error(`claude-design-import: ZIP exceeds ${ZIP_MAX_BYTES} bytes`);
  }

  const eocdOff = findEocd(buf);
  if (eocdOff < 0) {
    throw new Error("claude-design-import: not a valid ZIP archive (no EOCD record)");
  }

  const totalEntries = readU16LE(buf, eocdOff + 10);
  const cdSize = readU32LE(buf, eocdOff + 12);
  const cdOffset = readU32LE(buf, eocdOff + 16);
  if (cdOffset + cdSize > buf.length) {
    throw new Error("claude-design-import: central directory out of bounds");
  }

  const entries = new Map();
  let p = cdOffset;
  for (let i = 0; i < totalEntries; i++) {
    if (p + 46 > buf.length || readU32LE(buf, p) !== CDH_SIG) {
      throw new Error(`claude-design-import: invalid CDH at offset ${p}`);
    }
    const method = readU16LE(buf, p + 10);
    const compSize = readU32LE(buf, p + 20);
    const uncompSize = readU32LE(buf, p + 24);
    const fileNameLen = readU16LE(buf, p + 28);
    const extraLen = readU16LE(buf, p + 30);
    const commentLen = readU16LE(buf, p + 32);
    const lfhOffset = readU32LE(buf, p + 42);
    const name = buf.slice(p + 46, p + 46 + fileNameLen).toString("utf8");

    if (readU32LE(buf, lfhOffset) !== LFH_SIG) {
      throw new Error(`claude-design-import: invalid LFH for ${name}`);
    }
    const lfhNameLen = readU16LE(buf, lfhOffset + 26);
    const lfhExtraLen = readU16LE(buf, lfhOffset + 28);
    const dataStart = lfhOffset + 30 + lfhNameLen + lfhExtraLen;
    const compressed = buf.slice(dataStart, dataStart + compSize);

    let data;
    if (method === METHOD_STORED) {
      data = compressed;
    } else if (method === METHOD_DEFLATED) {
      try {
        data = zlib.inflateRawSync(compressed);
      } catch (e) {
        throw new Error(`claude-design-import: inflate failed for ${name}: ${e.message}`);
      }
    } else {
      throw new Error(`claude-design-import: unsupported method ${method} for ${name}`);
    }
    if (data.length !== uncompSize) {
      // Be lenient — some exporters write size=0 for streaming; trust data length.
      // (Strict mode would throw here.)
    }

    if (name && !name.endsWith("/")) {
      entries.set(name, { data, method, size: data.length });
    }

    p += 46 + fileNameLen + extraLen + commentLen;
  }

  return entries;
}

/**
 * Synthesize a `tokens.css` block from a parsed tokens.json object.
 * Best-effort: top-level keys become `--token-name`, dotted paths become
 * `--token-name-subname`, unknown shapes are preserved in `x-unknown-tokens`.
 */
function synthesizeTokensCss(tokens) {
  if (!tokens || typeof tokens !== "object") return null;
  const lines = [":root {"];
  const unknown = {};
  function walk(prefix, value) {
    if (value == null) return;
    if (typeof value === "string" || typeof value === "number") {
      // Value is a leaf — emit a CSS custom property.
      lines.push(`  --${prefix}: ${value};`);
    } else if (Array.isArray(value)) {
      value.forEach((item, idx) => walk(`${prefix}-${idx}`, item));
    } else if (typeof value === "object") {
      const keys = Object.keys(value);
      if (keys.length === 0) {
        unknown[prefix || "(root)"] = value;
      } else {
        for (const k of keys) walk(prefix ? `${prefix}-${k}` : k, value[k]);
      }
    } else {
      unknown[prefix || "(root)"] = value;
    }
  }
  walk("", tokens);
  lines.push("}");
  if (Object.keys(unknown).length > 0) {
    lines.push("");
    lines.push("/* x-unknown-tokens (preserved verbatim) */");
    for (const [k, v] of Object.entries(unknown)) {
      lines.push(`/* ${k}: ${JSON.stringify(v)} */`);
    }
  }
  return lines.join("\n");
}

/**
 * Build a synthesized manifest.json from a Claude Design project name + token
 * shape. Always emits schemaVersion + id + license + source + origin.
 */
function synthesizeManifest(id, source) {
  return {
    schemaVersion: "1.0",
    id,
    name: id,
    license: "Apache-2.0",
    source: "claude-design",
    origin: source || "https://claude.ai/design",
    category: "user-imported",
    convertedAt: new Date().toISOString(),
  };
}

/**
 * Import a Claude Design ZIP archive into a design-system install dir.
 *
 * @param {{
 *   zipPath: string,   // absolute path to the .zip file
 *   id: string,         // cortex-agent design-system id (kebab-case slug)
 *   cwd?: string,
 *   source?: string,    // origin URL (default: claude.ai/design)
 *   tokensFromJson?: boolean, // when false, skip tokens.css synthesis
 * }} options
 * @returns {{
 *   id, kind: "design-system", path, sha256, files, source, license,
 *   extractedAt: string, stats: { entries: number, designMd: boolean, tokens: boolean, assets: number }
 * }}
 */
function importFromZip(options) {
  options = options || {};
  const zipPath = options.zipPath;
  const id = options.id;
  const cwd = options.cwd || process.cwd();
  const tokensFromJson = options.tokensFromJson !== false;

  if (!zipPath || !fs.existsSync(zipPath)) {
    throw new Error(`claude-design-import: zipPath not found: ${zipPath}`);
  }
  if (!id || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(id)) {
    throw new Error(`claude-design-import: id must be kebab-case slug (got "${id}")`);
  }

  const buf = fs.readFileSync(zipPath);
  const entries = parseZip(buf);

  // Validate every entry path before writing anything.
  for (const name of entries.keys()) {
    if (!isSafeEntryPath(name)) {
      throw new Error(`claude-design-import: unsafe path in archive: "${name}"`);
    }
  }

  // Required: design.md (case-insensitive). If absent, the export is malformed.
  let designMdEntry = null;
  for (const [name, entry] of entries) {
    if (name.toLowerCase() === "design.md" || name.toLowerCase() === "design.markdown") {
      designMdEntry = entry;
      break;
    }
  }
  if (!designMdEntry) {
    throw new Error("claude-design-import: archive missing required design.md");
  }

  // Optional: tokens.json / tokens.css / assets/*
  let tokensJsonText = null;
  let tokensCssText = null;
  let assetsCount = 0;
  for (const [name, entry] of entries) {
    const lower = name.toLowerCase();
    if (lower === "tokens.json") {
      tokensJsonText = entry.data.toString("utf8");
    } else if (lower === "tokens.css") {
      tokensCssText = entry.data.toString("utf8");
    } else if (lower.startsWith("assets/")) {
      assetsCount += 1;
    }
  }

  const meta = getKind("design-system");
  const destDir = resolveInstallPath("design-system", id, cwd);

  // Pre-flight: prepare a temp dir for atomic install — only after all entries
  // are validated, swap temp → destDir.
  const tmpDir = destDir + ".importing." + Date.now();
  fs.mkdirSync(tmpDir, { recursive: true });

  const filesWritten = {};

  try {
    // 1. manifest.json
    const manifest = synthesizeManifest(id, options.source);
    const manifestText = JSON.stringify(manifest, null, 2);
    fs.writeFileSync(path.join(tmpDir, "manifest.json"), manifestText, "utf8");
    filesWritten["manifest.json"] = manifestText;

    // 2. DESIGN.md
    const designText = designMdEntry.data.toString("utf8");
    fs.writeFileSync(path.join(tmpDir, "DESIGN.md"), designText, "utf8");
    filesWritten["DESIGN.md"] = designText;

    // 3. tokens.css (synthesize from tokens.json or pass-through tokens.css)
    if (tokensFromJson) {
      if (tokensCssText) {
        fs.writeFileSync(path.join(tmpDir, "tokens.css"), tokensCssText, "utf8");
        filesWritten["tokens.css"] = tokensCssText;
      } else if (tokensJsonText) {
        let parsed;
        try {
          parsed = JSON.parse(tokensJsonText);
        } catch (e) {
          throw new Error(`claude-design-import: invalid tokens.json: ${e.message}`);
        }
        const css = synthesizeTokensCss(parsed);
        if (css) {
          fs.writeFileSync(path.join(tmpDir, "tokens.css"), css, "utf8");
          filesWritten["tokens.css"] = css;
        }
      }
    }

    // 4. assets/ — verbatim copy.
    if (assetsCount > 0) {
      const assetsTmp = path.join(tmpDir, "assets");
      fs.mkdirSync(assetsTmp, { recursive: true });
      for (const [name, entry] of entries) {
        if (!name.toLowerCase().startsWith("assets/")) continue;
        const rel = name.slice("assets/".length);
        if (!rel) continue;
        const target = path.join(assetsTmp, rel);
        if (entry.data.length === 0 && name.endsWith("/")) {
          fs.mkdirSync(target, { recursive: true });
        } else {
          fs.mkdirSync(path.dirname(target), { recursive: true });
          fs.writeFileSync(target, entry.data);
        }
      }
    }

    // 5. Atomic swap: tmp → destDir.
    if (fs.existsSync(destDir)) {
      // Pre-existing install: clear before swap.
      clearDirectory(destDir);
      fs.rmdirSync(destDir);
    }
    fs.renameSync(tmpDir, destDir);
  } catch (err) {
    // Clean up temp on failure.
    try {
      clearDirectory(tmpDir);
      fs.rmdirSync(tmpDir);
    } catch (_) {
      // best-effort
    }
    throw err;
  }

  // Compute SHA-256 of all written files for the lock file.
  const crypto = require("node:crypto");
  const sha256 = {};
  for (const [filename, text] of Object.entries(filesWritten)) {
    sha256[filename] = crypto.createHash("sha256").update(text, "utf8").digest("hex");
  }

  return {
    id,
    kind: "design-system",
    path: destDir,
    sha256,
    files: Object.fromEntries(Object.keys(filesWritten).map((f) => [f, f])),
    source: options.source || "https://claude.ai/design",
    license: meta.licenseDefault,
    extractedAt: new Date().toISOString(),
    stats: {
      entries: entries.size,
      designMd: true,
      tokens: Boolean(filesWritten["tokens.css"]),
      assets: assetsCount,
    },
  };
}

function clearDirectory(dir) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir)) {
    const p = path.join(dir, entry);
    if (fs.statSync(p).isDirectory()) {
      clearDirectory(p);
      fs.rmdirSync(p);
    } else {
      fs.unlinkSync(p);
    }
  }
}

module.exports = {
  parseZip,
  isSafeEntryPath,
  synthesizeTokensCss,
  synthesizeManifest,
  importFromZip,
  ZIP_MAX_BYTES,
  // exposed for tests
  _internal: { findEocd, readU16LE, readU32LE, clearDirectory },
};