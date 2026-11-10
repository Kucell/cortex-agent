#!/usr/bin/env node
"use strict";

// ─── check-gitlink-pins ─────────────────────────────────────────────────────
// Keeps the `.agent` submodule pointer and the EXPECTED_GITLINK pins used by
// the release acceptance workflows in lockstep.
//
// Why this exists: `.github/workflows/offline-package-acceptance.yml` and
// `.github/workflows/registry-upgrade-acceptance.yml` compare the `.agent`
// blob inside the packed tarball with the pinned sha
// (scripts/release/offline-package-acceptance.py). Advancing the gitlink
// without advancing the pins makes both jobs fail on a mismatch that has
// nothing to do with the shipped product, and the drift stays silent until
// release time.
//
// Invariant: every EXPECTED_GITLINK pin equals the *staged* `.agent` gitlink.
//
// Usage:
//   node scripts/check-gitlink-pins.js             # fix in place, re-stage
//   node scripts/check-gitlink-pins.js --check     # report only, exit 1 on drift
//   node scripts/check-gitlink-pins.js --root DIR  # target another checkout
//
// Ownership: L3. This is cortex-agent's own development gate; it is not part
// of the distributed L1 templates (see .agent/rules/agent-scope.md).

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const DEFAULT_ROOT = path.resolve(__dirname, "..");
const WORKFLOW_DIR = path.join(".github", "workflows");
const PIN_KEY = "EXPECTED_GITLINK";
const SHA_RE = /\b[0-9a-f]{40}\b/;

let ROOT = DEFAULT_ROOT;
let CHECK_ONLY = false;

function configure(argv) {
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--check") {
      CHECK_ONLY = true;
    } else if (arg === "--root") {
      const next = argv[i + 1];
      if (!next) {
        console.error("❌ --root requires a directory");
        process.exit(2);
      }
      ROOT = path.resolve(next);
      i += 1;
    } else if (arg === "--help" || arg === "-h") {
      console.log("usage: node scripts/check-gitlink-pins.js [--check] [--root DIR]");
      process.exit(0);
    } else {
      console.error(`❌ unknown argument: ${arg}`);
      process.exit(2);
    }
  }
}

function git(args, options = {}) {
  const r = spawnSync("git", args, {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    ...options,
  });
  if (r.error) return { status: 127, stdout: "", stderr: String(r.error.message) };
  return { status: r.status, stdout: r.stdout || "", stderr: r.stderr || "" };
}

// The staged `.agent` pointer. Reading the index (not HEAD, not the working
// tree) is what makes the gate agree with what the commit will actually ship.
function stagedGitlink() {
  const r = git(["ls-files", "--stage", "--", ".agent"]);
  if (r.status !== 0) return null;
  for (const line of r.stdout.split("\n")) {
    if (!line.trim()) continue;
    const m = line.match(/^(\d{6})\s+([0-9a-f]{40})\s+(\d)\t(.+)$/);
    if (!m) continue;
    if (m[4] !== ".agent") continue;
    // 160000 = gitlink (submodule). A regular file or directory named .agent
    // is somebody else's layout; this gate does not apply.
    if (m[1] !== "160000") return null;
    return m[2];
  }
  return null;
}

function pinFiles() {
  const dir = path.join(ROOT, WORKFLOW_DIR);
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const name of fs.readdirSync(dir).sort()) {
    if (!/\.(ya?ml)$/.test(name)) continue;
    const abs = path.join(dir, name);
    let text;
    try {
      text = fs.readFileSync(abs, "utf8");
    } catch {
      continue;
    }
    if (!text.includes(PIN_KEY)) continue;
    out.push({ rel: path.join(WORKFLOW_DIR, name), abs, text });
  }
  return out;
}

// Every EXPECTED_GITLINK line in a file, with the sha it currently pins.
function pinsIn(text) {
  const found = [];
  const lines = text.split("\n");
  lines.forEach((line, idx) => {
    if (!line.includes(PIN_KEY)) return;
    const m = line.match(SHA_RE);
    if (!m) return;
    found.push({ index: idx, sha: m[0], line });
  });
  return found;
}

function indexBlob(rel) {
  const r = git(["show", `:${rel}`]);
  if (r.status !== 0) return null;
  return r.stdout;
}

function isStaged(rel) {
  const r = git(["diff", "--cached", "--name-only", "--", rel]);
  if (r.status !== 0) return false;
  return r.stdout.split("\n").some((l) => l.trim() === rel);
}

function main() {
  configure(process.argv.slice(2));

  const gitlink = stagedGitlink();
  if (!gitlink) {
    // No `.agent` gitlink in the index — nothing to pin against.
    console.log("ℹ️  未检测到 .agent gitlink，跳过 pin 校验。");
    return 0;
  }

  const files = pinFiles();
  if (files.length === 0) {
    console.log("ℹ️  未找到 EXPECTED_GITLINK pin，跳过。");
    return 0;
  }

  const drifted = [];
  for (const file of files) {
    for (const pin of pinsIn(file.text)) {
      if (pin.sha !== gitlink) {
        drifted.push({ file, pin });
      }
    }
  }

  if (drifted.length === 0) {
    console.log(`✅ gitlink pins 与 .agent 指针一致（${gitlink.slice(0, 8)}）。`);
    return 0;
  }

  if (CHECK_ONLY) {
    console.error("❌ EXPECTED_GITLINK 与已暂存的 .agent gitlink 不一致：");
    for (const d of drifted) {
      console.error(`   ${d.file.rel}:${d.pin.index + 1}  pin=${d.pin.sha}  gitlink=${gitlink}`);
    }
    console.error("   请把 pin 推进到当前 .agent 指针后重试。");
    return 1;
  }

  // Auto-fix. Refuse to touch a pin file that has unstaged edits: rewriting it
  // and re-staging would silently sweep unrelated work into the commit.
  const conflicts = [];
  for (const d of drifted) {
    const indexed = indexBlob(d.file.rel);
    if (indexed !== null && indexed !== d.file.text) {
      conflicts.push(d.file.rel);
    }
  }
  if (conflicts.length > 0) {
    console.error("❌ 以下 pin 文件存在未暂存改动，拒绝自动改写（避免把无关改动带入提交）：");
    for (const rel of conflicts) console.error(`   ${rel}`);
    console.error("   请先处理这些改动，或手动把 EXPECTED_GITLINK 对齐后重试。");
    return 1;
  }

  const touched = new Set();
  for (const d of drifted) {
    if (touched.has(d.file.rel)) continue;
    touched.add(d.file.rel);
    const lines = d.file.text.split("\n");
    const seen = new Set();
    for (const pin of pinsIn(d.file.text)) {
      if (seen.has(pin.index)) continue;
      seen.add(pin.index);
      lines[pin.index] = lines[pin.index].replace(pin.sha, gitlink);
    }
    fs.writeFileSync(d.file.abs, lines.join("\n"));
    const add = git(["add", "--", d.file.rel]);
    if (add.status !== 0) {
      console.error(`❌ 无法重新暂存 ${d.file.rel}：${add.stderr.trim()}`);
      return 1;
    }
    console.log(`🔧 ${d.file.rel}：EXPECTED_GITLINK → ${gitlink}`);
  }

  console.log(`✅ pin 已同步到 .agent 指针 ${gitlink} 并重新暂存（${touched.size} 个文件）。`);
  return 0;
}

process.exit(main());
