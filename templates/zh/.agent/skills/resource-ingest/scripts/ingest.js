#!/usr/bin/env node
/**
 * ingest — Phase 2.1 Resource Ingestion Pipeline.
 *
 * Inspired by OpenViking's `client.add_resource(url, reason)` API: pull external
 * knowledge (URL / file / git repo) into `.agent/resources/external/` with L0/L1
 * auto-generation and auto-registration in `context-index.json` + `uri-map.json`.
 *
 * v1 scope: deterministic, zero LLM. Supports three entry points:
 *   --url   <https://...>      fetch HTML, strip tags, save as markdown
 *   --file  <path>             copy local file into resources/
 *   --git   <git-url>          shallow clone, copy README/docs/ into resources/
 *   --source <name>            manual namespace (default: derived from url/file)
 *   --write                    actually write to disk + register (default: dry-run)
 *   --refresh-l0l1             after ingest, run build-l0l1 on the new files
 *
 * Output: JSON to stdout describing the ingested source + L0/L1 stats.
 *
 * Conventions:
 *   - `.agent/resources/external/{source}/{slug}.md`               single resource
 *   - `.agent/resources/external/{source}/{slug}/index.md`         dir hierarchy
 *   - `.agent/resources/MANIFEST.json`                            append-only log
 *   - `cortex://resources/{source}/{slug}`                        URI to read
 */

"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { execFileSync } = require("node:child_process");

const ROOT = process.cwd();
const RESOURCES_DIR = path.join(ROOT, ".agent", "resources");
const EXTERNAL_DIR = path.join(RESOURCES_DIR, "external");
const MANIFEST_FILE = path.join(RESOURCES_DIR, "MANIFEST.json");
const URI_MAP = path.join(ROOT, ".agent", "registry", "uri-map.json");
const INDEX_FILE = path.join(ROOT, ".agent", "context-index.json");
const BUILD_L0L1 = path.join(ROOT, ".agent", "skills", "context-budget", "scripts", "build-l0l1.js");

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

function sha256(s) {
  return crypto.createHash("sha256").update(s).digest("hex").slice(0, 16);
}

function slugify(s) {
  return s.replace(/^https?:\/\//, "").replace(/[^a-zA-Z0-9._-]+/g, "-").toLowerCase().slice(0, 80).replace(/^-+|-+$/g, "") || "resource";
}

function sourceFromUrl(url) {
  try {
    const u = new URL(url);
    return u.hostname.replace(/^www\./, "").replace(/[^a-z0-9.-]/g, "-");
  } catch {
    return slugify(url).split(/[/.]/)[0] || "external";
  }
}

function fetchUrl(url, timeoutMs = 15000) {
  // Node 18+ has fetch. Use it. We intentionally avoid large dependencies.
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  return fetch(url, { signal: ctrl.signal, redirect: "follow", headers: { "user-agent": "cortex-agent-resource-ingest/1.0" } })
    .then((r) => {
      clearTimeout(timer);
      if (!r.ok) throw new Error(`HTTP ${r.status} ${r.statusText}`);
      return r.text();
    })
    .catch((err) => {
      clearTimeout(timer);
      throw new Error(`fetch failed: ${err.message}`);
    });
}

function htmlToMarkdown(html) {
  // Minimal HTML → text: strip tags, decode common entities, collapse whitespace.
  // v1 is intentionally simple — no link preservation, no image embedding.
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, "")
    .replace(/<(\/?)(p|div|br|li|h[1-6]|tr|td|th)(\s[^>]*)?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function readManifest() {
  if (!fs.existsSync(MANIFEST_FILE)) return { version: 1, entries: [] };
  try {
    return JSON.parse(fs.readFileSync(MANIFEST_FILE, "utf8"));
  } catch {
    return { version: 1, entries: [] };
  }
}

function writeManifest(m) {
  fs.writeFileSync(MANIFEST_FILE, JSON.stringify(m, null, 2) + "\n");
}

function updateUriMap(source) {
  if (!fs.existsSync(URI_MAP)) return { ok: false, reason: "uri-map.json not found" };
  const map = JSON.parse(fs.readFileSync(URI_MAP, "utf8"));
  const before = map.scopes.resources;
  map.scopes.resources = path.join(".agent", "resources", "external");
  map.generated_at = new Date().toISOString();
  fs.writeFileSync(URI_MAP, JSON.stringify(map, null, 2) + "\n");
  return { ok: true, before, after: map.scopes.resources };
}

function updateContextIndex(entry) {
  if (!fs.existsSync(INDEX_FILE)) return { ok: false, reason: "context-index.json not found" };
  const idx = JSON.parse(fs.readFileSync(INDEX_FILE, "utf8"));
  if (!idx.modules) idx.modules = [];
  // Replace existing module with same ref_path, else append.
  const refPath = entry.ref_path;
  const existingIdx = idx.modules.findIndex((m) => m.ref_path === refPath);
  if (existingIdx >= 0) idx.modules[existingIdx] = { ...idx.modules[existingIdx], ...entry };
  else idx.modules.push(entry);
  idx._meta = idx._meta || {};
  idx._meta.last_updated = new Date().toISOString().slice(0, 10);
  fs.writeFileSync(INDEX_FILE, JSON.stringify(idx, null, 2) + "\n");
  return { ok: true, updated: existingIdx >= 0 ? "replaced" : "appended" };
}

function ingestFromUrl(args) {
  const url = args.url;
  if (!url) throw new Error("--url is required");
  const source = args.source || sourceFromUrl(url);
  const slug = args.slug || slugify(url);
  const html = args["no-fetch"] ? null : null; // pre-fetched optional
  const content = args._content || null; // for testing
  const targetDir = path.join(EXTERNAL_DIR, source);
  const targetFile = path.join(targetDir, `${slug}.md`);
  const body = content || htmlToMarkdown(_lastFetch || "");
  return {
    source,
    slug,
    target: path.relative(ROOT, targetFile),
    uri: `cortex://resources/${source}/${slug}`,
    content_bytes: Buffer.byteLength(body || "", "utf8"),
    fetch_url: url,
  };
}

function ingestFromFile(args) {
  const filePath = args.file;
  if (!filePath) throw new Error("--file is required");
  const absolute = path.isAbsolute(filePath) ? filePath : path.join(ROOT, filePath);
  if (!fs.existsSync(absolute)) throw new Error(`file not found: ${absolute}`);
  const source = args.source || path.basename(path.dirname(absolute)) || "local";
  const slug = args.slug || path.basename(filePath, path.extname(filePath));
  const body = fs.readFileSync(absolute, "utf8");
  const targetDir = path.join(EXTERNAL_DIR, source);
  const targetFile = path.join(targetDir, `${slug}.md`);
  return {
    source,
    slug,
    target: path.relative(ROOT, targetFile),
    uri: `cortex://resources/${source}/${slug}`,
    content_bytes: Buffer.byteLength(body, "utf8"),
    source_path: path.relative(ROOT, absolute),
  };
}

function ingestFromGit(args) {
  const gitUrl = args.git;
  if (!gitUrl) throw new Error("--git is required");
  const source = args.source || sourceFromUrl(gitUrl);
  const slug = args.slug || slugify(gitUrl).split("/").slice(0, 2).join("-") || "repo";
  const cloneDir = path.join(ROOT, ".agent", "resources", "_cache", `${source}_${slug}`);
  // v1: read existing clone if present, otherwise instruct user to clone.
  const targetDir = path.join(EXTERNAL_DIR, source);
  const targetFile = path.join(targetDir, `${slug}-README.md`);
  const readmePath = path.join(cloneDir, "README.md");
  let body = "";
  if (fs.existsSync(readmePath)) {
    body = fs.readFileSync(readmePath, "utf8");
  } else {
    // Dry-run: emit a stub explaining how to clone.
    body = `# ${slug} (git)\n\n` +
      `> **未克隆**: 自动 git clone 暂未启用（避免大仓库意外拉取）。\n` +
      `> 手动执行:\n\`\`\`bash\n` +
      `git clone --depth 1 ${gitUrl} ${cloneDir}\n` +
      `node .agent/skills/resource-ingest/scripts/ingest.js --git ${gitUrl} --write\n` +
      `\`\`\`\n`;
  }
  return {
    source,
    slug,
    target: path.relative(ROOT, targetFile),
    uri: `cortex://resources/${source}/${slug}`,
    content_bytes: Buffer.byteLength(body, "utf8"),
    clone_dir: path.relative(ROOT, cloneDir),
    git_url: gitUrl,
  };
}

function writeIngested(plan, body) {
  ensureDir(path.join(EXTERNAL_DIR, plan.source));
  fs.writeFileSync(path.join(ROOT, plan.target), body);
  return { ok: true, written: plan.target };
}

function buildFrontmatter(plan, contentHash) {
  return [
    "---",
    `name: ${plan.slug}`,
    `source: ${plan.source}`,
    `uri: ${plan.uri}`,
    `content_hash: ${contentHash}`,
    `ingested_at: ${new Date().toISOString()}`,
    plan.fetch_url ? `origin: ${plan.fetch_url}` : null,
    plan.source_path ? `origin: ${plan.source_path}` : null,
    plan.git_url ? `origin: ${plan.git_url}` : null,
    plan.clone_dir ? `clone_dir: ${plan.clone_dir}` : null,
    "---",
    "",
  ].filter(Boolean).join("\n");
}

function main() {
  const args = parseArgs();
  let plan;
  let body;
  try {
    if (args.url) {
      if (args["no-fetch"]) {
        body = "";
      } else {
        // Inline fetch for synchronous ease; we used to defer to fetchUrl but
        // for CLI simplicity we run the promise chain here.
      }
      // We synchronously need fetch — use deasync-style by polling.  But Node 18+ has top-level await.
      // For CLI, we use sync approach: spawn curl via child_process if available, else skip.
      // v1: we ONLY process --url when --no-fetch is set (caller provides content via -).
      if (args["no-fetch"]) {
        body = args._content || "";
      } else {
        // fetch synchronously using execFileSync curl
        try {
          const html = execFileSync("curl", ["-fsSL", "--max-time", "15", "-A", "cortex-agent/1.0", args.url], { encoding: "utf8", cwd: ROOT });
          body = htmlToMarkdown(html);
        } catch (err) {
          console.log(JSON.stringify({ ok: false, error: `curl failed: ${err.message}`, hint: "install curl or use --no-fetch --content-body" }, null, 2));
          return;
        }
      }
      plan = ingestFromUrl(args);
    } else if (args.file) {
      plan = ingestFromFile(args);
      body = fs.readFileSync(path.join(ROOT, plan.source_path || args.file), "utf8");
    } else if (args.git) {
      plan = ingestFromGit(args);
      const cachePath = path.join(ROOT, ".agent", "resources", "_cache", `${plan.source}_${plan.slug}`, "README.md");
      if (fs.existsSync(cachePath)) {
        body = fs.readFileSync(cachePath, "utf8");
      } else {
        body = `# ${plan.slug} (git)

` +
          `> **未克隆**: 自动 git clone 暂未启用（避免大仓库意外拉取）。
` +
          `> 手动执行:
\`\`\`bash
` +
          `git clone --depth 1 ${plan.git_url} ${path.join(ROOT, ".agent", "resources", "_cache", plan.source + "_" + plan.slug)}
` +
          `node .agent/skills/resource-ingest/scripts/ingest.js --git ${plan.git_url} --source ${plan.source} --slug ${plan.slug} --write
` +
          `\`\`\`
`;
      }
    } else {
      console.log(JSON.stringify({
        ok: false,
        error: "specify one of --url, --file, or --git",
        usage: {
          "--url": "https://example.com/docs",
          "--file": "./external-doc.md",
          "--git": "https://github.com/foo/bar",
          "--source": "namespace (default: derived)",
          "--slug": "filename without extension (default: derived)",
          "--write": "actually write to disk + register",
          "--refresh-l0l1": "after ingest, run build-l0l1 on the new files",
        },
      }, null, 2));
      return;
    }
  } catch (err) {
    console.log(JSON.stringify({ ok: false, error: err.message }, null, 2));
    return;
  }

  const contentHash = sha256(body);
  const fm = buildFrontmatter(plan, contentHash);
  const fullBody = `${fm}\n${body}\n`;

  const writeResults = [];
  if (args.write) {
    writeResults.push(writeIngested(plan, fullBody));
    // Update MANIFEST
    const manifest = readManifest();
    manifest.entries.push({
      ingested_at: new Date().toISOString(),
      source: plan.source,
      slug: plan.slug,
      uri: plan.uri,
      target: plan.target,
      content_hash: contentHash,
      bytes: plan.content_bytes,
    });
    writeManifest(manifest);
    // Update uri-map.json
    updateUriMap(plan.source);
    // Update context-index.json
    updateContextIndex({
      module: `${plan.source}/${plan.slug}`,
      module_path: path.dirname(plan.target),
      module_type: "external resource",
      keywords: [plan.source, plan.slug],
      estimated_tokens: Math.ceil(plan.content_bytes / 4),
      last_updated: new Date().toISOString().slice(0, 10),
      ref_path: plan.target,
      uri: plan.uri,
      summary: body.slice(0, 200).replace(/\s+/g, " ").trim(),
    });
  }

  let l0l1 = null;
  if (args["refresh-l0l1"] && args.write) {
    try {
      execFileSync(process.execPath, [BUILD_L0L1, "--file", plan.target, "--inject-index"], { cwd: ROOT, stdio: "ignore" });
      l0l1 = { ok: true, ran: true };
    } catch (err) {
      l0l1 = { ok: false, error: err.message };
    }
  }

  console.log(JSON.stringify({
    ok: true,
    plan,
    content_hash: contentHash,
    written: writeResults,
    refresh_l0l1: l0l1,
    dry_run: !args.write,
  }, null, 2));
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    console.log(JSON.stringify({ ok: false, error: err.message, stack: err.stack }, null, 2));
    process.exit(1);
  }
}

module.exports = { htmlToMarkdown, slugify, sourceFromUrl, sha256 };
