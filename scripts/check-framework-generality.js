#!/usr/bin/env node
"use strict";

// ─── Check Framework Generality ──────────────────────────────────────────────
// Mechanical gate for the L1 rule `framework-generality.md`:
// cortex-agent is a *generic* agent-management framework. The code, rules,
// workflows and skills it ships to every managed project must not be bound
// to one field project.
//
// The failure this gate exists to prevent is concrete. A distributed config
// example that names one project's repo, one project's org and one
// developer's keychain account:
//
//     default:
//       org: SamkoonHMI
//       repo: SamHMI
//     namespace: SamHMI
//
// It ships to every project. A new user copies the example, and the
// framework's default silently points at somebody else's repository. The
// example does not fail loudly — it works, and it works *wrong*, which is
// worse than a crash.
//
// The same failure has a second shape: a *mission* identifier from one
// field project baked into the framework's own commit message, branch name,
// or architecture document title. The identifier means nothing outside that
// project, so it is noise to every reader — and it makes the framework look
// like a component of one product rather than a framework that product
// happens to use.
//
// Scope: the code and documents that ship to managed projects, plus the
// framework's own source tree where the binding is functional rather than
// merely narrative.
//
// What it detects:
//   - a field project's *identity* bound into a distributed file (repo name,
//     org name, keychain namespace, service name, hardcoded private host);
//   - a field project's mission identifier appearing in the framework's own
//     code, templates or architecture documents;
//   - a personal account name bound into a distributed file;
//   - a field project's name in a *document title or file name* — a document
//     may narrate that a change was verified in a real project, but a
//     document *named* after one project reads as if it belongs to it.
//
// What it deliberately does not flag:
//   - the framework's *own* mission / milestone / validation-contract
//     identifiers (M-0xx, MS-0xx, VC-xxx-xxx of cortex-agent itself) — they
//     are the framework's internal traceability, and the governance repo is
//     where they belong;
//   - names in prose that are clearly illustrative ("for example", a
//     placeholder, a fenced example block in a document);
//   - a field project named in the *body* of an architecture document. The
//     body is where the decision trail lives: "verified against <project>"
//     is a fact worth keeping, and rewriting it would falsify the record.
//     The document's *name* is policed separately, because that is the part
//     that makes a framework document look like a component of one product.
//   - a comment that explains *why* a field project appears in the history
//     of a decision.
//
// Run:
//   node scripts/check-framework-generality.js [--root <dir>] [--verbose]
//
// Exit 0 = clean, exit 1 = violations found.

const fs = require("node:fs");
const path = require("node:path");

const DEFAULT_ROOT = path.resolve(__dirname, "..");

const CODE_EXTENSIONS = Object.freeze([
  ".js", ".cjs", ".mjs", ".ts", ".sh", ".bash", ".ps1", ".py",
]);
const DOC_EXTENSIONS = Object.freeze([".md"]);
const CONFIG_EXTENSIONS = Object.freeze([
  ".yml", ".yaml", ".json", ".example", ".sh",
]);

const SKIP_DIRS = Object.freeze([
  "node_modules", ".git", "dist", "coverage",
  "metrics", "runs", "locks", "registry", "activities", "artifacts",
  // Task review scripts are execution records, not distributed assets. A
  // review script legitimately names the mission and the project it reviews,
  // and it never ships: the distributed surface is templates/_shared/.agent/,
  // which carries no reviews/ directory. The sibling location
  // .agent/missions/<M-xxx>/scripts/reviews/ is already outside every scan
  // tree for the same reason.
  "reviews",
]);

// The trees that ship code or rules to managed projects, plus the framework's
// own source, tests and architecture documents.
const SCAN_TREES = Object.freeze([
  "templates",
  "lib",
  "docs",
  "scripts",
  ".agent/rules",
  ".agent/workflows",
  ".agent/skills",
  ".agent/scripts",
]);

// A file that is excluded from the scan must say why. An exemption without a
// reason is just a hole in the gate.
const EXEMPT_FILES = Object.freeze({
  // The gate's own pattern table necessarily spells the identifiers it
  // looks for. Without this exemption the gate would report itself.
  "scripts/check-framework-generality.js": "the gate's own pattern table",

  // Release notes record what shipped, including the field projects that
  // motivated the change. A changelog that has been rewritten to remove
  // history is worse than one that names a project.
  "docs/releases": "historical release notes — they record what shipped",

  // Completed execution plans are the historical record of a decision that
  // happened in a specific project. Rewriting them would falsify the
  // decision trail; they are not part of the distributed surface.
  "docs/exec-plans/completed": "completed execution plans — decision history, not distribution surface",

  // The `design-package` feature is a *product-pipeline* feature that was
  // piloted in one field project: its template id, its default artifact
  // name and its rendered shell branding are that project's product
  // vocabulary, not framework configuration. Generalising it means
  // parameterising the shell — an architecture-level change with its own
  // decision, not a rename. The gate therefore does not police it until
  // that change lands.
  "lib/design-package": "product-pipeline feature pilot — generalising it is an architecture-level change",
  "lib/commands/design-package.js": "product-pipeline feature pilot — see lib/design-package",
  "lib/cli/contract.js": "product-pipeline feature pilot — see lib/design-package",

  // The end-to-end smoke script drives two *named* field projects on purpose:
  // it proves the cross-project bridge works between a source and a target
  // project, and the names are the fixture, not a binding. Renaming them
  // would make the script read as generic while still being the same script.
  "scripts/p006-e2e-smoke.js": "cross-project bridge smoke fixture — the two project names are the fixture",

  // The protected scope string is *persisted*: the permit store rejects any
  // state whose `scope` does not match it exactly, so the literal is part of
  // the on-disk format, not a label. Renaming it invalidates every state
  // already written under the current scope, which needs its own migration
  // decision rather than a rename in a hygiene pass.
  "lib/coordination/protected-scope.js": "persisted runtime scope literal — renaming it is a format migration",
});

// ─── Patterns ─────────────────────────────────────────────────────────────────

// A field project's identity. These are the strings that make a distributed
// file point at one product instead of at "your project".
//
// The list is intentionally small and explicit. A general heuristic (any
// capitalised word that looks like a project) would fire on every product
// name in the framework's own docs and would be turned off within a week.
const FIELD_PROJECT_IDENTITY = Object.freeze([
  { pattern: /\bSamHMI\b/g, label: "field project name (SamHMI)" },
  { pattern: /\bsamhmi\b/g, label: "field project slug (samhmi)" },
  { pattern: /\bSamkoonHMI\b/g, label: "field project org (SamkoonHMI)" },
  { pattern: /\bhmi-platform\b/g, label: "field project name (hmi-platform)" },
  { pattern: /\bhmi-agent-os\b/g, label: "field project name (hmi-agent-os)" },
  { pattern: /\bcsm-view\b/g, label: "field project name (csm-view)" },
  { pattern: /\bsamkoonyun-mobile\b/g, label: "field project name (samkoonyun-mobile)" },
]);

// A private host address. The framework ships to other people's networks; a
// developer's LAN address in a distributed example resolves to nothing, or
// worse, to somebody else's device.
//
// Loopback (127.0.0.0/8) and link-local (169.254.0.0/16) are deliberately
// excluded: `127.0.0.1` is how a local server is addressed on every machine,
// and flagging it would make the gate cry wolf on the framework's own
// dashboard. The addresses that are actually bound to one site are the RFC
// 1918 ranges.
const PRIVATE_HOST = /\b(?:10\.\d{1,3}|192\.168|172\.(?:1[6-9]|2\d|3[01]))\.\d{1,3}\.\d{1,3}\b/g;

// A personal account name bound into a distributed file.
const PERSONAL_ACCOUNT = /\bxueyq\b/g;

// A field project's *mission* identifier. Cortex-agent's own identifiers are
// deliberately not in this list: the framework's traceability is its own.
// SamHMI's M-053 is a field project's identifier and means nothing here.
const FIELD_MISSION = /\bM-053\b/g;

// The words that mark a documented example rather than a binding.
const EXAMPLE_MARKER = /(?:for example|e\.g\.|example:|示例|例如|your project|<your|replace .* with|placeholder)/i;

// A comment explains; it does not bind.
const COMMENT_LINE = /^\s*(?:\/\/|#|\*)/;

// A fenced code block inside a document. A document may show an example that
// names a project — including a real one — because that is how a lookup
// order or a config shape is documented.
const DOC_CODE_FENCE = /^\s*(?:```|~~~)/;

// ─── Helpers ───────────────────────────────────────────────────────────────────

function isExemptFile(relativePath) {
  if (Object.prototype.hasOwnProperty.call(EXEMPT_FILES, relativePath)) return true;
  // A directory exemption covers everything beneath it.
  for (const key of Object.keys(EXEMPT_FILES)) {
    if (relativePath.startsWith(`${key}/`)) return true;
  }
  return false;
}

function isScannable(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (CODE_EXTENSIONS.includes(ext)) return true;
  if (DOC_EXTENSIONS.includes(ext)) return true;
  // `.yml.example` and friends have no useful extname of their own.
  return ext === ".example" || CONFIG_EXTENSIONS.includes(ext);
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

function scanTree(root, tree, findings) {
  const treeRoot = path.join(root, tree);
  if (!fs.existsSync(treeRoot)) return;
  for (const file of collectFiles(treeRoot, [])) {
    const rel = path.relative(root, file);
    if (isExemptFile(rel)) continue;
    const isDoc = DOC_EXTENSIONS.includes(path.extname(file).toLowerCase());
    // A document's *name* is part of its interface: a framework document
    // named after a field project reads as a component of that project. The
    // body is where the decision trail lives and is not policed.
    checkDocumentName(rel, findings);
    let text;
    try {
      text = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    analyze(text, rel, isDoc, findings);
  }
}

// A document named after a field project. The first heading is the title the
// reader sees in a table of contents, so it is policed along with the file
// name.
function checkDocumentName(rel, findings) {
  const base = path.basename(rel);
  const stem = base.replace(/\.[^.]+$/, "");
  for (const { pattern, label } of FIELD_PROJECT_IDENTITY) {
    pattern.lastIndex = 0;
    if (pattern.test(stem)) {
      findings.push({
        rule: "field-project-document-name",
        title: `${label} in a document name`,
        file: rel,
        line: 1,
        detail: stem,
      });
      return;
    }
  }
}

function analyze(text, rel, isDoc, findings) {
  const lines = text.split("\n");
  let inCodeFence = false;
  let seenTitle = false;

  lines.forEach((line, idx) => {
    if (isDoc && DOC_CODE_FENCE.test(line)) {
      inCodeFence = !inCodeFence;
      return;
    }
    // A comment explains; it does not bind a project to the framework.
    if (COMMENT_LINE.test(line)) return;
    // A documented example is a template, not a binding.
    if (isDoc && EXAMPLE_MARKER.test(line)) return;
    // A fenced block in a document shows an example.
    if (isDoc && inCodeFence) return;

    // In a document, only the title (the first ATX heading) is policed. The
    // body narrates *where* a decision was verified, and that record is
    // worth keeping — erasing it would falsify the decision trail.
    if (isDoc) {
      if (!seenTitle) {
        if (/^#{1,6}\s+\S/.test(line)) {
          seenTitle = true;
          checkDocumentTitle(line, rel, findings);
        }
        return;
      }
    }

    for (const { pattern, label } of FIELD_PROJECT_IDENTITY) {
      pattern.lastIndex = 0;
      if (pattern.test(line)) {
        findings.push({
          rule: "field-project-identity",
          title: label,
          file: rel,
          line: idx + 1,
          detail: line.trim().slice(0, 120),
        });
        return;
      }
    }

    FIELD_MISSION.lastIndex = 0;
    if (FIELD_MISSION.test(line)) {
      findings.push({
        rule: "field-mission-identifier",
        title: "field project mission identifier",
        file: rel,
        line: idx + 1,
        detail: line.trim().slice(0, 120),
      });
      return;
    }

    PRIVATE_HOST.lastIndex = 0;
    if (PRIVATE_HOST.test(line)) {
      findings.push({
        rule: "private-host-address",
        title: "private host address bound into a distributed file",
        file: rel,
        line: idx + 1,
        detail: line.trim().slice(0, 120),
      });
      return;
    }

    PERSONAL_ACCOUNT.lastIndex = 0;
    if (PERSONAL_ACCOUNT.test(line)) {
      findings.push({
        rule: "personal-account",
        title: "personal account name bound into a distributed file",
        file: rel,
        line: idx + 1,
        detail: line.trim().slice(0, 120),
      });
    }
  });
}

function checkDocumentTitle(line, rel, findings) {
  for (const { pattern, label } of FIELD_PROJECT_IDENTITY) {
    pattern.lastIndex = 0;
    if (pattern.test(line)) {
      findings.push({
        rule: "field-project-document-title",
        title: `${label} in a document title`,
        file: rel,
        line: 1,
        detail: line.trim().slice(0, 120),
      });
      return;
    }
  }
}

function main() {
  const args = process.argv.slice(2);
  const rootIndex = args.indexOf("--root");
  const root = rootIndex >= 0 ? path.resolve(args[rootIndex + 1]) : DEFAULT_ROOT;
  const verbose = args.includes("--verbose");

  const findings = [];
  for (const tree of SCAN_TREES) scanTree(root, tree, findings);

  if (findings.length === 0) {
    console.log("✓ framework generality: no field-project binding found");
    return 0;
  }

  console.error(`✗ framework generality: ${findings.length} violation(s)\n`);
  for (const f of findings) {
    console.error(`  ${f.file}:${f.line}  [${f.rule}] ${f.title}`);
    if (verbose) console.error(`      ${f.detail}`);
  }
  console.error("\ncortex-agent is a generic framework. A field project's identity");
  console.error("must not be bound into code, config, rules or docs that ship to");
  console.error("managed projects. See .agent/rules/framework-generality.md.");
  return 1;
}

if (require.main === module) {
  process.exit(main());
}

module.exports = { analyze, collectFiles };
