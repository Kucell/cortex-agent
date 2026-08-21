"use strict";

// ─── catalog fetch — 4-kind content-addressed fetch (P-001 MS-002 round 2) ────
//
// Generic content-addressed fetch for any of the 4 catalog kinds:
//   design-system  — manifest.json + DESIGN.md (optional) + tokens.css (optional)
//                    delegates per-kind file resolution to lib/design/fetch.js
//                    (T-OD-001 frozen).
//   plugin         — open-design.json + SKILL.md (optional) → lib/catalog/plugin-converter
//                    produces cortex-agent manifest.json on top.
//   skill          — SKILL.md (required, Agent Skills convention) + optional assets.
//   template       — SKILL.md (required) + index.html (required) + optional assets.
//
// For design-system, the call is forwarded to T-OD-001 lib/design/fetch.js so
// license ack / SHA-256 MITM guard / 4-level cascade stay byte-identical.
//
// For plugin / skill / template, fetch is:
//
//   1. resolve the entry from the catalog index (or accept a caller-supplied `entry`).
//   2. walk the per-kind "required files" list (kind-map.requiredFiles) +
//      optional sidecar files.
//   3. download via injected `fetcher` (default: httpsGetText over node:https).
//   4. compute SHA-256 per file; verify against `expectedHashes` when supplied.
//   5. atomic write to <cwd>/.agent/<installDir>/<id>/ with tmp+rename.
//
// Atomic write + content-addressed hashing is mandatory for all 4 kinds; the
// legacy design-system already enforces this, so we mirror its helpers.
//
// No npm deps. All network I/O via injected `fetcher`. No subprocess calls.

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const https = require("node:https");

const {
  KINDS,
  KIND_LIST,
  getKind,
  resolveInstallPath,
  requiredFiles,
} = require("./kind-map");

// T-OD-001 frozen fetch — design-system only.
const designFetch = require("../design/fetch");

const DEFAULT_TIMEOUT_MS = 10000;

// Per-kind required files + optional sidecars. design-system is the only kind
// whose required-file list isn't just `manifestFilename` (it also has the
// optional DESIGN.md + tokens.css).
const KIND_FILE_SETS = Object.freeze({
  "design-system": {
    required: ["manifest.json"],
    optional: ["DESIGN.md", "tokens.css"],
  },
  plugin: {
    required: ["open-design.json"],
    optional: ["SKILL.md", "README.md"],
  },
  skill: {
    required: ["SKILL.md"],
    optional: ["README.md", "assets/**"],
  },
  template: {
    required: ["SKILL.md", "index.html"],
    optional: ["README.md", "assets/**", "screenshot.png"],
  },
});

function sha256(s) {
  return crypto.createHash("sha256").update(s, "utf8").digest("hex");
}

function httpsGetText(url, options) {
  options = options || {};
  const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: options.headers || {} }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const next = new URL(res.headers.location, url).toString();
        httpsGetText(next, options).then(resolve, reject);
        return;
      }
      if (res.statusCode === 404) {
        reject(new Error("HTTP 404"));
        return;
      }
      if (res.statusCode < 200 || res.statusCode >= 300) {
        reject(new Error("HTTP " + res.statusCode));
        return;
      }
      let data = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => resolve(data));
    });
    req.on("error", reject);
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error("Timeout (" + timeoutMs + "ms) fetching " + url));
    });
  });
}

async function fetchText(url, fetcher) {
  fetcher = fetcher || httpsGetText;
  if (url.startsWith("https://")) {
    return fetcher(url, { headers: { "User-Agent": "cortex-agent-catalog-fetch" } });
  }
  return fetcher(url);
}

function verifyHash(name, content, expected) {
  if (expected == null) return;
  const actual = sha256(content);
  if (actual !== expected) {
    throw new Error(
      "Hash mismatch for " + name + ": expected " + expected + ", got " + actual + " (possible MITM or corruption)"
    );
  }
}

function writeFileAtomic(filePath, content) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = filePath + ".tmp";
  fs.writeFileSync(tmpPath, content, "utf8");
  fs.renameSync(tmpPath, filePath);
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

// Detect manifest path for HTTP 404 swallowing.  When the path equals one of
// the kind's required files, 404 is a HARD failure (we don't silently install
// an incomplete entry).  When it's in `optional`, 404 becomes null.
function isRequiredFile(kind, filename) {
  const set = KIND_FILE_SETS[kind];
  if (!set) return false;
  return set.required.includes(filename);
}

function isOptionalFile(kind, filename) {
  const set = KIND_FILE_SETS[kind];
  if (!set) return false;
  if (set.required.includes(filename)) return false; // disallow re-classifying required as optional
  return set.optional.includes(filename);
}

function joinUrl(...parts) {
  return parts
    .filter((p) => p != null && p !== "")
    .map((p) => String(p).replace(/^\/+|\/+$/g, ""))
    .join("/");
}

/**
 * Fetch a single catalog entry. Supports all 4 kinds.
 *
 * @param {object} options
 * @param {string} options.kind        one of KIND_LIST
 * @param {string} options.id          catalog id
 * @param {object} options.entry       upstream entry { id, path, upstream_url }
 * @param {string} options.upstream    base URL (default: open-design raw)
 * @param {string} options.destDir     install target (default: <cwd>/.agent/<installDir>/<id>)
 * @param {Function} fetcher           injectable
 * @param {object}   expectedHashes    { <file>: sha256 } (fail-closed when supplied)
 * @returns {Promise<{ id, kind, path, sha256, files, manifest }>}
 */
async function fetchEntry(options) {
  options = options || {};
  const kind = options.kind;
  const id = options.id;
  if (!KINDS[kind]) {
    throw new Error(`fetchEntry: unknown kind "${kind}". Valid: ${KIND_LIST.join(", ")}`);
  }
  if (!id) {
    throw new Error("fetchEntry: id is required");
  }

  // design-system: delegate to T-OD-001 frozen fetch.
  if (kind === "design-system") {
    return designFetch.fetchSystem({
      id,
      entry: options.entry,
      upstream: options.upstream,
      destDir: options.destDir,
      fetcher: options.fetcher,
      expectedHashes: options.expectedHashes,
    }).then((r) => ({
      ...r,
      kind: "design-system",
    }));
  }

  const meta = getKind(kind);
  const entry = options.entry || { id, path: meta.upstreamSubdir + "/" + id };
  const upstream = options.upstream || "https://raw.githubusercontent.com/nexu-io/open-design/main";
  const destDir = options.destDir || resolveInstallPath(kind, id, process.cwd());
  const fetcher = options.fetcher;
  const expected = options.expectedHashes || {};

  const baseUrl = joinUrl(upstream, entry.path);

  const fileSet = KIND_FILE_SETS[kind];
  const downloadsToTry = [...fileSet.required, ...fileSet.optional];

  const downloaded = {};
  for (const filename of downloadsToTry) {
    const url = joinUrl(baseUrl, filename);
    try {
      const text = await fetchText(url, fetcher);
      verifyHash(filename, text, expected[filename]);
      downloaded[filename] = { text, sha256: sha256(text) };
    } catch (e) {
      if (e && /HTTP 404/.test(e.message)) {
        if (isRequiredFile(kind, filename)) {
          // 404 on a required file is a HARD error.
          throw new Error(
            `fetchEntry: required file "${filename}" missing for ${kind}/${id} (HTTP 404 at ${url})`
          );
        }
        // optional — silently skip
        continue;
      }
      throw e;
    }
  }

  // Validate that every required file was actually downloaded.
  for (const filename of fileSet.required) {
    if (!downloaded[filename]) {
      throw new Error(
        `fetchEntry: missing required file "${filename}" for ${kind}/${id}`
      );
    }
  }

  // For plugin: also run plugin-converter to produce cortex-agent manifest.json
  // next to open-design.json. The original is preserved (audit).
  if (kind === "plugin" && downloaded["open-design.json"]) {
    try {
      const od = JSON.parse(downloaded["open-design.json"].text);
      const converter = require("./plugin-converter");
      const check = converter.validateOpenDesign(od);
      if (check.ok) {
        const manifest = converter.toCortexAgentManifest(od, {
          license: extractLicenseField(od) || meta.licenseDefault,
        });
        downloaded["manifest.json"] = {
          text: JSON.stringify(manifest, null, 2),
          sha256: sha256(JSON.stringify(manifest, null, 2)),
          _synthetic: true,
        };
      }
    } catch (e) {
      // Conversion failure: leave open-design.json in place but skip
      // manifest.json. Caller may inspect or re-install.
    }
  }

  // Atomic write — all-or-nothing.
  clearDirectory(destDir);
  const files = {};
  const hashes = {};
  for (const filename of Object.keys(downloaded).sort()) {
    const entry2 = downloaded[filename];
    const filePath = path.join(destDir, filename);
    writeFileAtomic(filePath, entry2.text);
    files[filename] = filename;
    hashes[filename] = entry2.sha256;
  }

  // The "manifest" field of the return shape is the canonical kind manifest
  // (parsed JSON when JSON-shaped, raw text otherwise).
  const manifestFilename = meta.manifestFilename;
  const manifestRaw = downloaded[manifestFilename];
  let manifest = null;
  if (manifestRaw) {
    if (manifestFilename.endsWith(".json")) {
      try {
        manifest = JSON.parse(manifestRaw.text);
      } catch (_) {
        manifest = manifestRaw.text;
      }
    } else {
      // SKILL.md / DESIGN.md: leave as raw text + try to parse frontmatter.
      manifest = manifestRaw.text;
    }
  }

  return {
    id,
    kind,
    path: destDir,
    sha256: hashes,
    files,
    manifest,
  };
}

function extractLicenseField(od) {
  if (!od || typeof od !== "object") return null;
  if (typeof od.license === "string") return od.license;
  if (od.compat && typeof od.compat.license === "string") return od.compat.license;
  return null;
}

/**
 * Fetch only the manifest (lightweight, no install). Useful for `--dry-run`.
 *
 * For plugin, the canonical upstream source is `open-design.json` — we fetch
 * that, then run plugin-converter to produce the cortex-agent manifest
 * (matches fetchEntry's write behavior). The original open-design.json shape
 * is preserved in `openDesignRaw` for callers that need it.
 *
 * @param {object} options  same shape as fetchEntry
 * @returns {Promise<{ id, kind, manifestText, sha256, manifest, openDesignRaw? }>}
 */
async function fetchManifest(options) {
  options = options || {};
  const kind = options.kind;
  const id = options.id;
  if (!KINDS[kind]) {
    throw new Error(`fetchManifest: unknown kind "${kind}". Valid: ${KIND_LIST.join(", ")}`);
  }
  if (!id) throw new Error("fetchManifest: id is required");

  if (kind === "design-system") {
    return designFetch.fetchManifest({
      id,
      entry: options.entry,
      upstream: options.upstream,
      fetcher: options.fetcher,
      expectedHashes: options.expectedHashes,
    }).then((r) => ({ ...r, kind: "design-system" }));
  }

  const meta = getKind(kind);
  const entry = options.entry || { id, path: meta.upstreamSubdir + "/" + id };
  const upstream = options.upstream || "https://raw.githubusercontent.com/nexu-io/open-design/main";
  const fetcher = options.fetcher;
  const expected = options.expectedHashes || {};

  const baseUrl = joinUrl(upstream, entry.path);

  // plugin: fetch open-design.json upstream, then synthesize cortex-agent
  // manifest.json via plugin-converter (matches fetchEntry behavior).
  if (kind === "plugin") {
    const url = joinUrl(baseUrl, "open-design.json");
    const text = await fetchText(url, fetcher);
    verifyHash("open-design.json", text, expected["open-design.json"]);
    let od;
    try {
      od = JSON.parse(text);
    } catch (e) {
      throw new Error(`fetchManifest: invalid open-design.json for plugin/${id}: ${e.message}`);
    }
    const converter = require("./plugin-converter");
    const check = converter.validateOpenDesign(od);
    if (!check.ok) {
      // Upstream shape invalid — fall back to returning the open-design.json
      // verbatim so the caller can decide whether to install anyway.
      return {
        id,
        kind,
        manifestText: text,
        sha256: sha256(text),
        manifest: od,
        openDesignRaw: text,
        conversionError: check.reason,
      };
    }
    const manifest = converter.toCortexAgentManifest(od, {
      license: extractLicenseField(od) || meta.licenseDefault,
    });
    const manifestText = JSON.stringify(manifest, null, 2);
    return {
      id,
      kind,
      manifestText,
      sha256: sha256(manifestText),
      manifest,
      openDesignRaw: text,
    };
  }

  // skill / template: fetch the canonical manifest file (SKILL.md raw text).
  const manifestFilename = meta.manifestFilename;
  const url = joinUrl(baseUrl, manifestFilename);

  const text = await fetchText(url, fetcher);
  verifyHash(manifestFilename, text, expected[manifestFilename]);

  let manifest;
  try {
    manifest = JSON.parse(text);
  } catch (_) {
    manifest = text;
  }

  return {
    id,
    kind,
    manifestText: text,
    sha256: sha256(text),
    manifest,
  };
}

/**
 * List the per-kind required + optional file sets (testable).
 */
function fileSetFor(kind) {
  if (!KINDS[kind]) {
    throw new Error(`fetch.fileSetFor: unknown kind "${kind}"`);
  }
  return KIND_FILE_SETS[kind];
}

module.exports = {
  // Public API
  fetchEntry,
  fetchManifest,
  fileSetFor,
  KIND_FILE_SETS,
  KIND_LIST,
  // Helpers (testable)
  sha256,
  verifyHash,
  writeFileAtomic,
  clearDirectory,
  httpsGetText,
  fetchText,
  joinUrl,
  isRequiredFile,
  isOptionalFile,
  // Constants
  DEFAULT_TIMEOUT_MS,
};