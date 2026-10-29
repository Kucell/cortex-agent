#!/usr/bin/env node
"use strict";

// ─── Check Portable Paths ─────────────────────────────────────────────────────
// Mechanical gate for the L1 rule `portable-path-design.md`:
// cortex-agent is a *generic* framework. Every path it writes, reads or
// executes has to work on a machine that is not the one the code was written
// on — a different home directory, a different package manager layout, a
// different platform.
//
// The failure this gate exists to prevent is concrete. A verification script
// shipped with the absolute path of the package directory it was developed
// against:
//
//     const pkgDir = "/Users/someone/.volta/tools/image/packages/cortex-agent";
//
// It runs on the author's machine and nowhere else. On any other checkout it
// resolves to a package that is not installed, or to a *different version*
// that happens to sit at that path — which is worse than a crash, because the
// script then verifies the wrong code while appearing to work.
//
// Scope: the code that ships to every managed project (the L1 template tree)
// plus the framework's own governance tree, and the runtime-evidence tree
// where reusable verification scripts live. Documentation is scanned too, but
// only for paths presented as *the path to use* — a document may name
// `/Users/<you>/myproject` as an example of what a lookup order looks like.
//
// What it detects:
//   - an absolute user home directory literal (/Users/<name>, /home/<name>)
//     inside a code file;
//   - the same inside a document, when it is used as a path to read or write
//     rather than shown as a placeholder example;
//   - a package-manager-specific install root pinned to a literal path
//     (e.g. a `.volta` / `.nvm` / `AppData` directory spelled out).
//
// What it deliberately does not flag:
//   - `/Users/...` with an ellipsis or a placeholder — that is a template, not
//     a path to one machine;
//   - the same path inside a comment that explains a lookup order;
//   - `os.homedir()`, `process.env.HOME`, `__dirname`, `require.resolve` and
//     friends — those are the portable spellings this gate steers toward;
//   - Windows-style paths, which are checked separately and conservatively.
//
// Run:
//   node scripts/check-portable-paths.js [--root <dir>] [--verbose]
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
  // Runtime state directories: these hold artifacts, they do not decide
  // where artifacts go. The reusable scripts inside runtime-evidence are
  // scanned on purpose — that is exactly where a hardcoded path hides.
  "metrics", "runs", "locks", "registry", "activities",
]);

// The trees that ship code or rules to managed projects, plus the tree where
// reusable verification scripts live.
const SCAN_TREES = Object.freeze([
  "templates",
  ".agent/skills",
  ".agent/scripts",
  ".agent/workflows",
  ".agent/rules",
  ".agent/runtime-evidence",
]);

// The runtime-evidence tree holds two different kinds of material: reusable
// verification scripts that a project may run again, and the *records* of
// runs that already happened — captured logs, extracted project snapshots,
// generated fixtures. A record is a snapshot of one machine on one day; it
// is evidence, not something that will be executed on another machine, and
// its absolute paths are the very thing it is supposed to document.
//
// So the tree is not skipped wholesale. Reusable scripts are still checked —
// that is exactly where a hardcoded path hides. The record-shaped
// subtrees are excluded, and the exclusion is narrow enough that a script
// dropped into one of them would be missed, so the names below are checked
// against the tree's actual contents by the gate's own test.
const RECORD_SUBDIRS = Object.freeze([
  "context-trajectories",
  "trajectory",
  "friction",
  "dashboard-supervisor",
]);

// A file that is excluded from the scan must say why. An exemption without a
// reason is just a hole in the gate.
const EXEMPT_FILES = Object.freeze({});

// ─── Patterns ─────────────────────────────────────────────────────────────────

// An absolute home directory with a *real* user name. The user segment must
// look like a name, not a placeholder: `/Users/<you>` and `/Users/...` are
// documentation, `/Users/xueyq` is a machine.
const HOME_PATH = /\/(?:Users|home)\/([A-Za-z0-9._-]+)/g;

// A placeholder or example segment: not a machine-specific path.
//
// The list holds only segments that cannot be a real account name. Words
// like "user", "test", "name" and "tmp" were removed: they are ordinary
// account names on a real machine (`/Users/test/work` is a real path on a
// machine whose account is called "test"), and treating them as
// placeholders let exactly the paths this gate exists to catch through.
const PLACEHOLDER_SEGMENTS = new Set([
  "...", "..", ".", "<", ">", "your", "you", "username",
  "example", "sample", "me", "anyone",
  "project", "proj", "repo", "myproject",
  "placeholder", "path", "dir", "folder",
]);

// A package-manager install root spelled out. These are machine-specific by
// construction: the version manager's layout is a local convention.
const MANAGER_ROOT = /\.(?:volta|nvm|fnm|asdf|pyenv|rbenv|rvm)\//g;

// Windows install roots. Conservative: only the shape that pins a package
// manager or a program-files tree.
const WINDOWS_ROOT = /[A-Za-z]:\\(?:Users|Program Files|ProgramData)\\[A-Za-z0-9._ -]+/g;

// The portable spellings. When a line uses one of these, the path it builds
// is relative to the running machine, so a home directory appearing on the
// same line is part of an expansion rather than a pinned location.
const PORTABLE_SPELLING = /os\.homedir\(\)|process\.env\.HOME|process\.env\.USERPROFILE|__dirname|require\.resolve|import\.meta\.dir|path\.resolve\(__dirname/;

// A path literal: a quoted string that starts at a filesystem root.
//
// Only string literals are inspected. A home directory mentioned in prose is
// documentation; a home directory inside a string is a path the program will
// open. The leading character must be a quote and the path must begin at the
// root — that is what separates a relative path like
// "fixtures/home/alice/data.json" from an absolute one.
const ABSOLUTE_PATH_LITERAL = /(["'`])\/(?:Users|home)\/([^"'`\/\s]*)/g;

// The same shape without the quotes: a command in a document, or an
// argument passed to a program, names the path directly.
const BARE_ABSOLUTE_PATH = /(?:^|[\s|])((?:\/|\\)(?:Users|home)\/[^"'`\s|]*)/g;

// A comment explains; it does not bind a path. A comment that names a
// machine-specific location is documenting a lookup order, and the rule
// document itself relies on being able to say such a thing. What a comment
// does *not* do is excuse a path that appears in the code beside it — the
// exemption is for the comment line, not for the statement.
const COMMENT_LINE = /^\s*(?:\/\/|#|\*|<!--)/;

// A path literal in the Windows shape. Both separator spellings are
// accepted, because a JavaScript source file may spell a Windows path with
// either one.
const WINDOWS_PATH_LITERAL = /(["'`])[A-Za-z]:(?:\\\\|\\|\/)(?:Users|Program Files|ProgramData)(?:\\\\|\\|\/)([^"'`\r\n]*)/g;

// The marker a document or a comment uses to say "this is a deliberate
// counter-example". It has to be explicit: the gate cannot guess that a
// path inside a fenced block is an example, because the same fenced block
// may hold the command the reader is told to run.
const COUNTER_EXAMPLE_MARKER = /(?:counter-?example|反例|bad example|do not copy|不要照抄|don't copy)/i;

// A document may show a path as an example of what to write or not to
// write. The words that mark it are explicit, so the exemption is narrow:
// the line has to say it is an example. This applies to documents only —
// in code, the presence of a word like "example" next to a path does not
// make the path portable.
const DOC_EXAMPLE_MARKER = /(?:for example|e\.g\.|example:|示例|例如)/i;

// A placeholder written with angle brackets, e.g. "/Users/<you>/myproject".
// The brackets are the signal; the segment itself is checked against
// PLACEHOLDER_SEGMENTS.
const ANGLE_PLACEHOLDER = /<[^>]+>/;

// ─── Helpers ───────────────────────────────────────────────────────────────────

function isPlaceholder(segment) {
  return PLACEHOLDER_SEGMENTS.has(segment.toLowerCase());
}

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

// True when the path is inside one of the record-shaped subtrees of the
// runtime-evidence tree. Those hold the evidence of runs that already
// happened, not reusable scripts.
function isRecordPath(relativePath) {
  const segments = relativePath.split("/");
  const evidenceIndex = segments.indexOf("runtime-evidence");
  if (evidenceIndex === -1) return false;
  const rest = segments.slice(evidenceIndex + 1);
  return rest.length > 0 && RECORD_SUBDIRS.includes(rest[0]);
}

// A nested repository is a snapshot of some other tree, not part of this
// one. A review run keeps one so its findings can be checked against the
// exact source they were taken from, and the paths it contains are the ones
// that existed in that tree at the time.
function isNestedRepository(root, filePath) {
  const segments = path.relative(root, filePath).split(path.sep);
  for (let i = 0; i < segments.length - 1; i += 1) {
    const candidate = path.join(root, ...segments.slice(0, i + 1));
    if (fs.existsSync(path.join(candidate, ".git"))) return true;
  }
  return false;
}

// ─── Analysis ─────────────────────────────────────────────────────────────────

function findHomePathViolations(text, rel, isDoc) {
  const findings = [];
  const lines = text.split("\n");
  const seen = new Set();

  // ── Data flow: variables that hold a portable root ──────────────────────
  //
  // 
  //   const homeDir = os.homedir();
  //   const pkg = path.join(homeDir, ".volta/tools/image/packages/pkg");
  //
  // The second line mentions a version-manager directory, but the path it
  // builds is derived from the running machine. Deciding this per line made
  // the gate's verdict depend on whether os.homedir() happened to sit on the
  // same line, which is not a property of the path. So the variables that
  // hold a portable root are tracked across the file, and a path built from
  // one of them is portable wherever it is written.
  const portableVars = new Set();
  const PORTABLE_ASSIGNMENT = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:os\.homedir\(\)|__dirname|process\.env\.(?:HOME|USERPROFILE)|require\.resolve\([^)]*\)|path\.resolve\(__dirname[^)]*\)|import\.meta\.dir)/g;
  let assignMatch;
  while ((assignMatch = PORTABLE_ASSIGNMENT.exec(text)) !== null) {
    portableVars.add(assignMatch[1]);
  }

  // A path built by joining a portable root with further segments is
  // portable: the result is derived at runtime on whichever machine runs it.
  const portableVarPattern = portableVars.size > 0
    ? new RegExp("\\b(?:path\\.join|path\\.resolve)\\s*\\(\\s*(?:" + [...portableVars].join("|") + ")\\b")
    : null;

  // A rule document shows the counter-example in a table whose *column
  // header* says "counter-example". The header is on one line and the
  // paths are on the next, so the marker has to carry across the rows of
  // that table rather than matching a single line.
  let inCounterExampleTable = false;

  // A document introduces an example with a marker line and then shows it —
  // often inside a fenced block that starts a couple of lines later. The
  // marker covers that block, and stops at the end of it.
  let documentExamplePending = false;
  let inFencedBlock = false;

  const report = (rule, title, line, detail, idx) => {
    const key = `${rule}:${idx}`;
    if (seen.has(key)) return;
    seen.add(key);
    findings.push({ rule, title, file: rel, line: idx + 1, detail });
  };

  lines.forEach((line, idx) => {
    const isFence = /^\s*(?:```|~~~)/.test(line);
    if (isFence) {
      inFencedBlock = !inFencedBlock;
      if (!inFencedBlock) documentExamplePending = false;
    }
    // A marker line arms the example exemption for the block it introduces.
    if (isDoc && !isFence && DOC_EXAMPLE_MARKER.test(line)) {
      documentExamplePending = true;
    }
    // A pure comment line documents; it does not bind a path. The statement
    // beside it is still checked — the exemption is per line, not per
    // statement.
    if (COMMENT_LINE.test(line)) return;

    // Track a table whose header marks a column as the counter-example. The
    // rows below it are examples of what not to do, so the paths in them are
    // deliberate.
    if (/^\s*\|/.test(line)) {
      if (COUNTER_EXAMPLE_MARKER.test(line)) inCounterExampleTable = true;
    } else if (line.trim() !== "") {
      inCounterExampleTable = false;
    }
    // A portable spelling means a path is derived at runtime. The check is
    // about the *expression* the literal appears in, not the whole line: a
    // line may build one path from os.homedir() and pin another one to a
    // literal in the same statement.
    //
    // The portable spelling excuses a literal only when that literal is a
    // *relative* segment appended to the portable root. An absolute literal
    // is never excused by it: path.resolve(__dirname, "/abs/path") returns
    // "/abs/path", because an absolute segment replaces the accumulated
    // path instead of extending it.
    const usesPortableSpelling = PORTABLE_SPELLING.test(line);
    const buildsFromPortableVar = portableVarPattern ? portableVarPattern.test(line) : false;
    // A deliberate counter-example is exempt, but only when it is marked as
    // one. The marker has to be on the line or in the comment above it.
    const previousLine = idx > 0 ? lines[idx - 1] : "";
    const isCounterExample = COUNTER_EXAMPLE_MARKER.test(line)
      || COUNTER_EXAMPLE_MARKER.test(previousLine)
      || inCounterExampleTable;
    // An explicit "for example" in a document marks the path as an
    // illustration. The marker usually sits on the line *above* the path —
    // "For example, run:" then the command — so it carries to the next
    // block. In code the same words do not excuse anything.
    const isDocumentExample = isDoc && (DOC_EXAMPLE_MARKER.test(line)
      || DOC_EXAMPLE_MARKER.test(previousLine)
      || documentExamplePending);

    // ── Absolute home paths ──────────────────────────────────────────────
    //
    // The path has to be a string literal that starts at the root. A
    // relative path that happens to contain "home/alice" is not pinned to a
    // machine, and a home directory mentioned in prose is documentation.
    ABSOLUTE_PATH_LITERAL.lastIndex = 0;
    let match;
    while ((match = ABSOLUTE_PATH_LITERAL.exec(line)) !== null) {
      const user = match[2];
      if (!user) continue;
      // The placeholder may sit in the user segment or further down the
      // path. Either way it is a template, not a machine.
      if (ANGLE_PLACEHOLDER.test(line)) continue;
      if (isPlaceholder(user)) continue;
      // The path is assembled at runtime from the home directory: portable.
      if (buildsFromPortableVar) continue;
      if (isCounterExample) continue;
      if (isDocumentExample) continue;
      report(
        "machine-specific-home-path",
        "path pinned to one machine's home directory",
        line,
        line.trim().slice(0, 120),
        idx,
      );
      break;
    }

    // A path named directly — the argument of a command in a document, or a
    // bare literal in code — is pinned just as much as one inside quotes.
    if (!isDoc || !isDocumentExample) {
      BARE_ABSOLUTE_PATH.lastIndex = 0;
      while ((match = BARE_ABSOLUTE_PATH.exec(line)) !== null) {
        const bare = match[1];
        if (ANGLE_PLACEHOLDER.test(bare)) break;
        const segments = bare.split("/").filter(Boolean);
        if (segments.length < 2) break;
        const user = segments[1];
        if (isPlaceholder(user)) break;
        if (buildsFromPortableVar) break;
        if (isCounterExample) break;
        report(
          "machine-specific-home-path",
          "path pinned to one machine's home directory",
          line,
          line.trim().slice(0, 120),
          idx,
        );
        break;
      }
    }

    // ── Version-manager install roots ────────────────────────────────────
    //
    // The directory name alone is not the problem: a path assembled from
    // os.homedir() is portable even though it ends in ".volta". What is a
    // problem is a *literal* that pins the whole location.
    MANAGER_ROOT.lastIndex = 0;
    while ((match = MANAGER_ROOT.exec(line)) !== null) {
      // A manager directory reached through a portable root is derived at
      // runtime and therefore portable; only a literal one is pinned.
      if (buildsFromPortableVar) break;
      if (isCounterExample) break;
      // A placeholder anywhere in the path makes it a template.
      if (ANGLE_PLACEHOLDER.test(line)) break;
      // Only flag it when the path starts at a root — a relative path that
      // merely mentions ".volta" is not machine-bound.
      const absoluteStart = /(?:^|["'`])(?:\\)?\/(?:Users|home)\//.test(line);
      if (!absoluteStart) break;
      report(
        "machine-specific-manager-root",
        "version-manager install root spelled out literally",
        line,
        line.trim().slice(0, 120),
        idx,
      );
      break;
    }

    // ── Windows install roots ────────────────────────────────────────────
    //
    // Both separator spellings are recognised, because a JavaScript source
    // file may write a Windows path with either one.
    WINDOWS_PATH_LITERAL.lastIndex = 0;
    while ((match = WINDOWS_PATH_LITERAL.exec(line)) !== null) {
      if (buildsFromPortableVar) break;
      if (isCounterExample) break;
      report(
        "machine-specific-windows-path",
        "path pinned to one machine's Windows directory",
        line,
        line.trim().slice(0, 120),
        idx,
      );
      break;
    }
  });

  return findings;
}

function analyseFile(filePath, root) {
  let text;
  try {
    text = fs.readFileSync(filePath, "utf8");
  } catch {
    return [];
  }
  const rel = path.relative(root, filePath);
  const normalized = rel.split(path.sep).join("/");
  if (isExemptFile(normalized)) return [];
  // A record of a past run documents the paths that run used. Checking it
  // would report the evidence itself as a violation.
  if (isRecordPath(normalized)) return [];
  // A nested repository is a snapshot of another tree.
  if (isNestedRepository(root, filePath)) return [];

  const isDoc = DOC_EXTENSIONS.includes(path.extname(filePath).toLowerCase());
  return findHomePathViolations(text, rel, isDoc);
}

// ─── Scanning ─────────────────────────────────────────────────────────────────

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
  for (const tree of SCAN_TREES) {
    checked += scanTree(root, tree, violations);
  }

  console.log(`\n📍 Portable Path Report`);
  console.log(`   Files scanned: ${checked}`);
  console.log(`   Violations:    ${violations.length}`);

  if (violations.length === 0) {
    console.log(`\n✅ No path is pinned to one machine`);
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

  console.log(`\n⚠️  cortex-agent ships to every managed project. A path that names one`);
  console.log(`   machine works there and nowhere else.`);
  console.log(`   Derive paths at runtime instead: os.homedir(), __dirname,`);
  console.log(`   require.resolve(), or an environment variable.`);
  console.log(`   See .agent/rules/portable-path-design.md.`);
  if (verbose) {
    console.log(`\n   Add an entry with a reason to EXEMPT_FILES in this script.`);
  }

  process.exit(1);
}

main();
