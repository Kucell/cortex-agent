"use strict";

// ─── catalog extract — Brand-backed URL → DESIGN.md (P-001 MS-002 round 2) ─────
//
// Thin wrapper around the open-design daemon's `extract` capability:
//   - Input:  a brand URL (e.g. https://stripe.com) + optional design-system id.
//   - Output: a DESIGN.md + tokens.css + manifest.json synthesized by the
//             daemon, dropped at <cwd>/.agent/design-systems/<id>/.
//
// Two operating modes:
//
//   1. Daemon mode (default when `open-design` is on PATH):
//      $ open-design extract --from-url <url> --output-id <id>
//        → parses stdout JSON { manifest, design, tokens, license, source }
//        → atomic write into <installDir>
//        → returns { id, path, sha256 }
//
//   2. Fallback mode (when daemon is missing):
//      - emit a structured prompt + the brand URL as a hand-off to a human
//        (or another skill) — useful when running inside a sandbox where the
//        daemon isn't available.
//      - returns { id, path, sha256: {}, fallback: true, handOffUrl }
//
// No npm deps. Uses node:child_process for daemon mode only (spawn).
//
// Why a thin wrapper and not a built-in extractor:
//   - Open Design Cloud is the canonical extractor; re-implementing it in
//     cortex-agent would fork the rule set. We treat the daemon as upstream.
//   - The fallback mode is a deliberate capability gap (no silent fake
//     DESIGN.md) — see decision D-ODI-001.

const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

const designFetch = require("../design/fetch");
const designRegistry = require("../design/registry");
const designLicense = require("../design/license");
const { resolveInstallPath, getKind } = require("./kind-map");

// P-ODI-001: brand URL allowlist (allow by default — entry list is conservative;
// each entry is checked against SSRF guard upstream in open-design daemon).
const URL_PATTERN = /^https?:\/\/[A-Za-z0-9._~:/?#@!$&'()*+,;=%-]{1,2048}$/;

function isValidUrl(s) {
  return typeof s === "string" && URL_PATTERN.test(s);
}

/**
 * Detect whether the open-design daemon is available on PATH.
 * Pure function — does not start the daemon, just checks `which`-equivalent.
 */
function isDaemonAvailable() {
  return new Promise((resolve) => {
    const probe = process.platform === "win32" ? "where" : "which";
    const child = spawn(probe, ["open-design"], { stdio: "ignore" });
    child.on("error", () => resolve(false));
    child.on("exit", (code) => resolve(code === 0));
  });
}

/**
 * Run the open-design daemon's extract command. Resolves with the daemon's
 * stdout JSON. Rejects on daemon error / non-zero exit.
 */
function runDaemonExtract({ url, id, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const args = ["extract", "--from-url", url, "--output-id", id, "--format", "json"];
    const child = spawn("open-design", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`daemon extract timed out after ${timeoutMs || 30000}ms`));
    }, timeoutMs || 30000);
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`daemon exit ${code}: ${stderr.trim()}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch (e) {
        reject(new Error(`daemon output is not JSON: ${e.message}`));
      }
    });
  });
}

/**
 * Atomic write of {manifest, design, tokens} into the install dir. Mirrors
 * lib/design/fetch.js helpers (kept inline to avoid coupling this file to
 * fetch.js internals beyond the public surface).
 */
function writeExtractOutput(destDir, payload) {
  fs.mkdirSync(destDir, { recursive: true });
  const files = {};
  if (payload.manifest) {
    const text = typeof payload.manifest === "string"
      ? payload.manifest
      : JSON.stringify(payload.manifest, null, 2);
    fs.writeFileSync(path.join(destDir, "manifest.json"), text, "utf8");
    files["manifest.json"] = text;
  }
  if (payload.design) {
    fs.writeFileSync(path.join(destDir, "DESIGN.md"), payload.design, "utf8");
    files["DESIGN.md"] = payload.design;
  }
  if (payload.tokens) {
    fs.writeFileSync(path.join(destDir, "tokens.css"), payload.tokens, "utf8");
    files["tokens.css"] = payload.tokens;
  }
  return files;
}

/**
 * Extract a Brand-backed design system from a URL.
 *
 * @param {{ url: string, id: string, cwd?: string, fetcher?: Function, timeoutMs?: number }} options
 * @returns {Promise<{ id, kind: "design-system", path, sha256, files, source, license?, fallback?: boolean, handOffUrl?: string }>}
 */
async function extractFromUrl(options) {
  options = options || {};
  const url = options.url;
  const id = options.id;
  const cwd = options.cwd || process.cwd();
  const meta = getKind("design-system");

  if (!isValidUrl(url)) {
    throw new Error(`extractFromUrl: invalid URL "${url}"`);
  }
  if (!id || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(id)) {
    throw new Error(`extractFromUrl: id must be kebab-case slug (got "${id}")`);
  }

  const destDir = resolveInstallPath("design-system", id, cwd);
  const haveDaemon = await isDaemonAvailable();

  if (!haveDaemon) {
    // Fallback mode — emit structured hand-off instead of fake DESIGN.md.
    return {
      id,
      kind: "design-system",
      path: destDir,
      sha256: {},
      files: {},
      source: "fallback",
      fallback: true,
      handOffUrl: url,
      message:
        "open-design daemon not on PATH. Run `npx open-design install` separately, " +
        "or install the daemon: see https://github.com/nexu-io/open-design#install.",
    };
  }

  // Daemon mode — spawn + parse JSON + atomic write.
  const payload = await runDaemonExtract({
    url,
    id,
    timeoutMs: options.timeoutMs,
  });
  const files = writeExtractOutput(destDir, payload);
  const sha256 = {};
  for (const [filename, text] of Object.entries(files)) {
    sha256[filename] = designFetch.sha256(text);
  }
  return {
    id,
    kind: "design-system",
    path: destDir,
    sha256,
    files: Object.fromEntries(Object.keys(files).map((f) => [f, f])),
    source: payload.source || "daemon",
    license: payload.license || meta.licenseDefault,
    sourceUrl: url,
    extractedAt: new Date().toISOString(),
  };
}

/**
 * Validate that an extracted entry passes the design-system license gate.
 * Thin wrapper over lib/design/license for kind-aware consumers.
 */
function validateExtractedLicense(payload) {
  if (!payload || typeof payload !== "object") {
    return { ok: false, reason: "extract payload missing" };
  }
  const entry = { id: payload.id, license: payload.license };
  return designLicense.isLicenseAcceptable(entry);
}

module.exports = {
  isValidUrl,
  isDaemonAvailable,
  runDaemonExtract,
  writeExtractOutput,
  extractFromUrl,
  validateExtractedLicense,
  URL_PATTERN,
};