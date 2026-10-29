#!/usr/bin/env node
"use strict";

// ─── Check Runtime Artifact Location ──────────────────────────────────────────
// Mechanical gate for the L1 rule `runtime-artifacts-location.md`:
// in a cortex-agent-managed project, every runtime artifact (logs, probe
// scripts, per-run output, observations, scratch JSON) belongs under the
// project `.agent/` directory — never in /tmp, the home directory, or the
// project root.
//
// The rule is written as prose, so prose alone does not keep a skill from
// shipping a `os.tmpdir()` draft directory to every managed project. This
// gate turns the rule into something a build can fail on.
//
// Scope: the L1 distribution tree (`templates/**`) plus the L3 governance
// tree (`.agent/{skills,scripts,workflows}`). Both ship code and documents
// that decide where artifacts land, so both are scanned.
//
// The judgement the gate cannot make for you is "does this artifact still
// have value after the process exits?". So it does not ban the temp
// directory; it bans *an artifact* landing in it. The rule has one
// documented exception, and the gate respects it:
//
//   * process plumbing — a private context file for a child process, a
//     throwaway compile directory, a single-test fixture;
//   * text that mentions /tmp in order to forbid it.
//
// How it decides — a two-property taint analysis over each file:
//
//   temp     : the path derives from os.tmpdir(), a mkdtemp call, or a
//              literal /tmp (or /var/folders) path;
//   artifact : the path names a log, report, draft, snapshot, record, …
//              rather than a machine-generated fixture name.
//
// A write whose target is both is the violation the rule describes. Taint
// propagates across lines, so the common shape
//
//     const dir = fs.mkdtempSync(path.join(os.tmpdir(), "x-"));
//     const out = path.join(dir, "report.md");
//     fs.writeFileSync(out, data);
//
// is caught even though no single line contains both facts.
//
// Run:
//   node scripts/check-runtime-artifact-location.js [--root <dir>] [--verbose]
//
// Exit 0 = clean, exit 1 = violations found.

const fs = require("node:fs");
const path = require("node:path");

const DEFAULT_ROOT = path.resolve(__dirname, "..");

const CODE_EXTENSIONS = Object.freeze([
  ".js", ".cjs", ".mjs", ".ts", ".sh", ".bash", ".ps1", ".py",
]);
const DOC_EXTENSIONS = Object.freeze([".md"]);

const SKIP_DIRS = Object.freeze([
  "node_modules", ".git", "dist", "coverage",
  // Runtime state directories: these hold artifacts, they do not write them.
  "metrics", "runs", "locks", "registry", "activities",
]);

// A file that is excluded from the scan must say why. An exemption without a
// reason is just a hole in the gate.
const EXEMPT_FILES = Object.freeze({
  "lib/governed/launcher.js":
    "writeContextFile() writes a 0600 context file for a child process and " +
    "deletes it on completion — process plumbing, the rule's documented exception.",
  "lib/governance/git-store.js":
    "The GIT_INDEX_FILE is a throwaway git index for a single commit operation, " +
    "removed in the same call — process plumbing.",
});

// ─── Lexical facts ────────────────────────────────────────────────────────────

// A temp root, however it is spelled.
const TEMP_SOURCES = Object.freeze([
  /os\.tmpdir\(\)/,
  /\bmkdtemp(?:Sync)?\b/,
  /\bTMPDIR\b/,
  /%TEMP%/i,
  /\/(?:tmp|var\/folders)\//,
]);

// An artifact file name: a meaningful name plus an artifact-ish extension.
// A fixture has a machine-generated name (hps-1a2b3c); an artifact has one a
// human chose (report.md, session-signals.json, exp-S-DEMO-1-draft.md).
const ARTIFACT_KEYWORDS = Object.freeze([
  "report", "result", "output", "summary", "log", "trace", "draft",
  "evidence", "artifact", "record", "snapshot", "sample", "export",
  "dump", "metric", "debug", "session", "signal", "progress", "analysis",
  "finding",
]);

const ARTIFACT_EXTENSIONS = Object.freeze([
  "md", "json", "jsonl", "ndjson", "log", "txt", "csv", "yaml", "yml",
]);

// Splits a file name into its stem tokens, so that "catalog.json" does not
// read as an artifact just because "log" appears inside it, while
// "session-signals.json" does.
function stemTokens(fileName) {
  return fileName
    .replace(/\.[A-Za-z0-9]+$/, "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((token) => token.toLowerCase());
}

// True when the text names an artifact file: a token that reads like a
// category of artifact, plus an artifact-ish extension.
function namesArtifactFile(text) {
  const pattern = /([A-Za-z0-9_.-]+)\.(md|jsonl?|ndjson|log|txt|csv|ya?ml)\b/gi;
  let match;
  while ((match = pattern.exec(text)) !== null) {
    if (!ARTIFACT_EXTENSIONS.includes(match[2].toLowerCase())) continue;
    const tokens = stemTokens(match[1]);
    if (tokens.some((token) => ARTIFACT_KEYWORDS.some((k) => token.startsWith(k)))) {
      return true;
    }
  }
  return false;
}

// A directory whose name reads like a category of artifact rather than like a
// process scratch area.
const ARTIFACT_DIRNAME = new RegExp(
  String.raw`["'](?:drafts?|evidence|logs?|reports?|output|artifacts?|traces?|captures?|exports?|snapshots?)["']`,
  "i",
);

// Lines that are the rule itself, or that are part of a temp-path pipe, are
// not violations. The rule text must be able to name /tmp in order to ban it.
const ALLOW_PATTERNS = Object.freeze([
  // Describing the rule (the rule file, and the tests that assert it).
  /runtime-artifacts-location/i,
  /Do not write runtime artifacts/i,
  /不要把运行时产物或脚本写到/i,
  // Process plumbing: the temp path is handed to a child process.
  /spawnSync|execFileSync|execSync|child_process|writeContextFile/i,
  // A git index is plumbing, not an artifact.
  /GIT_INDEX_FILE/,
  // A fixture that is removed again in the same breath.
  /rmSync|rimraf|removeSync|unlinkSync/,
]);

// A test file is where a fixture legitimately lives in a temp directory: the
// rule's exception says "a test fixture directory created and removed inside
// a single test case". The gate therefore does not judge test files by the
// write rule — it only checks that the fixture is actually cleaned up, so a
// test that leaks a directory into /tmp still gets flagged.
const TEST_FILE_PATTERN = /(^|\/)(?:tests?|__tests__|spec)\//;

// A `*.test.js` / `*.spec.js` file is a test file wherever it sits — the
// `tests/` directory is the common case, not the only one.
const TEST_FILE_NAME = /\.(?:test|spec)\.[A-Za-z0-9]+$/;

// A fixture that is removed again — the counterpart of mkdtempSync.
const FIXTURE_CLEANUP = /rmSync|rimraf|removeSync|unlinkSync|rmdirSync/;

// Does the file create a temp fixture at all?
const CREATES_TEMP_FIXTURE = /mkdtemp(?:Sync)?\(|os\.tmpdir\(\)/;

function isAllowlisted(line) {
  return ALLOW_PATTERNS.some((pattern) => pattern.test(line));
}

function containsTempSource(text) {
  return TEMP_SOURCES.some((pattern) => pattern.test(text));
}

function containsArtifactName(text) {
  return namesArtifactFile(text) || ARTIFACT_DIRNAME.test(text);
}

// ─── Taint analysis ───────────────────────────────────────────────────────────

// Extracts the first argument of a call, respecting nesting so that
// `writeFileSync(path.join(a, b), data)` yields `path.join(a, b)`.
function firstArgument(text, openIndex) {
  let depth = 0;
  let quote = null;
  for (let i = openIndex; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      if (ch === "\\") { i += 1; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") { quote = ch; continue; }
    if (ch === "(" || ch === "[" || ch === "{") { depth += 1; continue; }
    if (ch === ")" || ch === "]" || ch === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(openIndex + 1, i);
      continue;
    }
    if (ch === "," && depth === 1) return text.slice(openIndex + 1, i);
  }
  return text.slice(openIndex + 1);
}

const WRITE_CALLS = Object.freeze([
  /\bwriteFileSync\s*\(/g,
  /\bwriteFile\s*\(/g,
  /\bappendFileSync\s*\(/g,
  /\bcreateWriteStream\s*\(/g,
  /\boutputFileSync\s*\(/g,
  /\bwriteJson(?:Sync)?\s*\(/g,
  /\bwriteTextFileSync\s*\(/g,
]);

const ASSIGNMENT = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*([^;]+)/;

function analyseFile(filePath, root) {
  let text;
  try {
    text = fs.readFileSync(filePath, "utf8");
  } catch {
    return [];
  }
  const rel = path.relative(root, filePath);
  if (isExemptFile(rel.split(path.sep).join("/"))) return [];

  // A test file may keep its fixture in a temp directory, as long as the
  // fixture is cleaned up in the same file. The write rule does not apply to
  // it; only a leaked fixture does.
  const normalizedRel = rel.split(path.sep).join("/");
  const isTestFile = TEST_FILE_PATTERN.test(normalizedRel) ||
    TEST_FILE_NAME.test(normalizedRel);
  if (isTestFile) {
    // Only a file that actually creates a temp fixture has to clean it up.
    if (CREATES_TEMP_FIXTURE.test(text) && !FIXTURE_CLEANUP.test(text)) {
      return [{
        rule: "fixture-not-cleaned-up",
        title: "test fixture left behind in a temp directory",
        file: rel,
        line: 1,
        detail: "the file creates a temp fixture but never removes it",
      }];
    }
    return [];
  }

  const findings = [];

  // Taint sets, tracked across lines so a path built in one line and written
  // in another is still caught.
  const tempVars = new Set();
  const artifactVars = new Set();

  const lines = text.split("\n");
  lines.forEach((line, idx) => {
    if (isAllowlisted(line)) return;

    const assignment = line.match(ASSIGNMENT);
    if (assignment) {
      const [, name, expr] = assignment;
      const referencesTemp = containsTempSource(expr) ||
        [...tempVars].some((v) => new RegExp(`\\b${v}\\b`).test(expr));
      const referencesArtifact = containsArtifactName(expr) ||
        [...artifactVars].some((v) => new RegExp(`\\b${v}\\b`).test(expr));
      if (referencesTemp) tempVars.add(name);
      if (referencesArtifact) artifactVars.add(name);
    }

    // A write whose target is a temp path and names an artifact.
    for (const call of WRITE_CALLS) {
      const pattern = new RegExp(call.source, call.flags);
      let match;
      while ((match = pattern.exec(line)) !== null) {
        const openIndex = line.indexOf("(", match.index);
        if (openIndex < 0) continue;
        const arg = firstArgument(line, openIndex);
        const isTemp = containsTempSource(arg) ||
          [...tempVars].some((v) => new RegExp(`\\b${v}\\b`).test(arg));
        const isArtifact = containsArtifactName(arg) ||
          [...artifactVars].some((v) => new RegExp(`\\b${v}\\b`).test(arg));
        if (isTemp && isArtifact) {
          findings.push({
            rule: "artifact-written-to-temp",
            title: "runtime artifact written to a temp directory",
            file: rel,
            line: idx + 1,
            detail: line.trim().slice(0, 120),
          });
        }
      }
    }

    // A directory named like a category of artifact, created under a temp
    // root — the shape a "drafts" or "evidence" directory takes.
    if (containsTempSource(line) && ARTIFACT_DIRNAME.test(line)) {
      findings.push({
        rule: "artifact-dir-under-temp",
        title: "artifact directory created under a temp directory",
        file: rel,
        line: idx + 1,
        detail: line.trim().slice(0, 120),
      });
    }
  });

  lines.forEach((line, idx) => {
    if (isAllowlisted(line)) return;
    // A literal artifact path inside a temp directory — the shape a document
    // uses when it tells an agent where to write.
    const literal = /\/(?:tmp|var\/folders)\//.test(line) && namesArtifactFile(line);
    if (!literal) return;
    findings.push({
      rule: "temp-artifact-path-literal",
      title: "artifact path in a temp directory",
      file: rel,
      line: idx + 1,
      detail: line.trim().slice(0, 120),
    });
  });

  return findings;
}

// ─── Scanning ────────────────────────────────────────────────────────────────

function isExemptFile(relativePath) {
  return Object.prototype.hasOwnProperty.call(EXEMPT_FILES, relativePath);
}

function isScannable(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return CODE_EXTENSIONS.includes(ext) || DOC_EXTENSIONS.includes(ext);
}

function collectFiles(dir, acc) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.includes(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) collectFiles(full, acc);
    else if (entry.isFile() && isScannable(full)) acc.push(full);
  }
  return acc;
}

function scanTree(root, relativeDir, violations) {
  const dir = path.join(root, relativeDir);
  if (!fs.existsSync(dir)) return 0;
  const files = collectFiles(dir, []);
  for (const file of files) violations.push(...analyseFile(file, root));
  return files.length;
}

function main() {
  const args = process.argv.slice(2);
  const verbose = args.includes("--verbose") || args.includes("-v");
  const rootIndex = args.indexOf("--root");
  const root = rootIndex >= 0 && args[rootIndex + 1]
    ? path.resolve(args[rootIndex + 1])
    : DEFAULT_ROOT;

  const violations = [];
  let checked = 0;
  checked += scanTree(root, "templates", violations);
  checked += scanTree(root, path.join(".agent", "skills"), violations);
  checked += scanTree(root, path.join(".agent", "scripts"), violations);
  checked += scanTree(root, path.join(".agent", "workflows"), violations);

  console.log(`\n📍 Runtime Artifact Location Report`);
  console.log(`   Files scanned: ${checked}`);
  console.log(`   Violations:    ${violations.length}`);

  if (violations.length === 0) {
    console.log(`\n✅ No runtime artifact is written to a temp directory`);
    process.exit(0);
  }

  const byRule = new Map();
  for (const v of violations) {
    if (!byRule.has(v.rule)) byRule.set(v.rule, []);
    byRule.get(v.rule).push(v);
  }
  for (const [rule, items] of byRule) {
    console.log(`\n❌ ${rule} — ${items[0].title} (${items.length})`);
    for (const v of items) {
      console.log(`   ${v.file}:${v.line}  ${v.detail}`);
    }
  }

  console.log(`\n⚠️  Runtime artifacts belong under the project .agent/ directory.`);
  console.log(`   See .agent/rules/runtime-artifacts-location.md. Process plumbing`);
  console.log(`   (a private child-process context file, a throwaway compile dir, a`);
  console.log(`   single-test fixture) is the one documented exception.`);
  if (verbose) {
    console.log(`\n   Add an entry with a reason to EXEMPT_FILES in this script.`);
  }

  process.exit(1);
}

main();
