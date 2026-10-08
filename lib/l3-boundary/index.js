"use strict";

// ─── L3 distribution boundary guard ───────────────────────────────────────────
// The cortex-agent framework repository holds two very different kinds of `.agent/`
// content (see .agent/rules/agent-scope.md):
//
//   L1  templates/{_shared,zh,en,general}/.agent/  → shipped to every managed project
//   L3  <repo>/.agent/                             → framework self-bootstrap, never shipped
//
// Nothing enforces that boundary at build time. A rule authored in the state repo
// with `scope: L1` in its frontmatter looks perfectly shippable, so it gets mirrored
// into `templates/_shared/` — and the framework's private two-nested-git workflow
// silently lands in every user project. This module is the missing gate.
//
// Ownership: L3 ONLY. Lives in the cortex-agent main repository, is NOT distributed
// via init/upgrade, and is meaningless inside a user project (which has no nested
// .agent git repo). Deliberately NOT a template skill — shipping the guard would
// reproduce the exact leak it exists to catch.
//
// Zero dependency: only Node built-ins.

const fs = require("node:fs");
const path = require("node:path");

// Text extensions worth scanning. Binary assets (png/wasm/woff) are skipped.
const TEXT_EXTENSIONS = Object.freeze([
  ".md", ".js", ".cjs", ".mjs", ".ts", ".sh", ".bash", ".json",
  ".yml", ".yaml", ".txt", ".html", ".css",
]);

const SKIP_DIRS = Object.freeze(["node_modules", ".git", "dist", "coverage"]);

// ─── Rules ────────────────────────────────────────────────────────────────────
// Each rule: { id, title, severity, test(line) -> match detail | null }

const HOME_PATH_RE = /\/(?:Users|home)\/([A-Za-z0-9._-]+)/g;

// A home-path segment that is a placeholder, not a real person's directory.
// `/Users/.../`, `/Users/<user>/`, `/Users/$HOME/` are documentation conventions.
function isPlaceholderSegment(segment) {
  return (
    /^\.+$/.test(segment) || // ...
    /^<.*>$/.test(segment) || // <user>, <project>
    segment === "*" ||
    /^\$/.test(segment) || // $HOME
    /^(USER|USERNAME|user|username|whoami)$/i.test(segment)
  );
}

const RULES = Object.freeze([
  {
    id: "author-local-path",
    title: "author-local absolute path in distributed content",
    severity: "error",
    test(line) {
      HOME_PATH_RE.lastIndex = 0;
      let m;
      while ((m = HOME_PATH_RE.exec(line)) !== null) {
        if (isPlaceholderSegment(m[1])) continue;
        return { detail: m[0], column: m.index + 1 };
      }
      return null;
    },
  },
  {
    id: "framework-private-repo",
    title: "framework-private repository reference in distributed content",
    severity: "error",
    test(line) {
      const m = line.match(/cortex-agent-agent\.git|Inner mirror:/);
      return m ? { detail: m[0], column: m.index + 1 } : null;
    },
  },
  {
    id: "l3-scope-in-template",
    title: "distributed rule declares scope: L3",
    severity: "error",
    test(line) {
      const m = line.match(/^\s*scope:\s*L3\s*$/);
      return m ? { detail: "scope: L3", column: 1 } : null;
    },
  },
]);

// ─── Scanning ─────────────────────────────────────────────────────────────────

function isScannable(filePath) {
  return TEXT_EXTENSIONS.includes(path.extname(filePath).toLowerCase());
}

function collectFiles(dir, acc) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".") && entry.name !== ".agent") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.includes(entry.name)) continue;
      collectFiles(full, acc);
    } else if (entry.isFile() && isScannable(full)) {
      acc.push(full);
    }
  }
  return acc;
}

function scanFile(filePath, root) {
  let text;
  try {
    text = fs.readFileSync(filePath, "utf8");
  } catch {
    return [];
  }
  // A file too large to plausibly be hand-authored content is skipped rather
  // than slowing the gate down; templates are documentation-sized.
  if (text.length > 2 * 1024 * 1024) return [];

  const rel = path.relative(root, filePath);
  const found = [];
  text.split("\n").forEach((line, idx) => {
    for (const rule of RULES) {
      const hit = rule.test(line);
      if (hit) {
        found.push({
          rule: rule.id,
          severity: rule.severity,
          title: rule.title,
          file: rel,
          line: idx + 1,
          detail: hit.detail,
        });
      }
    }
  });
  return found;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Scan the L1 distribution tree for L3 content leakage.
 *
 * @param {string} root  Repository root (the directory containing `templates/`).
 * @returns {{ok: boolean, checked: number, violations: Array<object>}}
 */
function scanDistribution(root) {
  const templatesDir = path.join(root, "templates");
  if (!fs.existsSync(templatesDir)) {
    return { ok: true, checked: 0, violations: [] };
  }
  const files = collectFiles(templatesDir, []);
  const violations = files.flatMap((f) => scanFile(f, root));
  return { ok: violations.length === 0, checked: files.length, violations };
}

module.exports = { scanDistribution, RULES };
