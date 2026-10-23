"use strict";

// ─── Version carriers — the single source of truth ────────────────────────────
//
// "Which files carry the release version" and "how do you stamp the version
// into them" used to be answered in two places, and neither answer was
// complete:
//
//   - bin/local-publish-validate.cjs rewrote package.json only
//   - scripts/release/verify-approved-release.cjs allow-listed the paths a
//     release-preparation PR may touch
//
// A bump that moves one carrier and leaves the others behind produces a tree
// that the repository's own release consistency gate rejects
// (tests/release/release-version-consistency.test.js): package.json says the
// new version while the lockfile, the Claude plugin manifest, the marketplace
// manifest and the changelog still say the old one.
//
// Both consumers now read this module, so a carrier cannot be added in one
// place and forgotten in the other.

const fs = require("node:fs");
const path = require("node:path");

const { buildAnchor } = require(path.join(__dirname, "..", "anchor", "anchor.js"));

const PACKAGE_NAME = "cortex-agent";
const CHANGELOG_FILE = "CHANGELOG.md";
const ANCHOR_FILE = "docs/cortex-agent/anchor.md";

// Each carrier knows the shape of its own document. `apply` returns true when
// the document actually changed, so callers can report exactly what moved.
//
// A carrier is either a JSON document (`kind: "json"`, the default) or a
// generated text artifact (`kind: "text"`). The cross-tool anchor is the
// latter: its version lives inside prose, so the only correct way to stamp a
// new version is to re-render it from the anchor template.
const CARRIERS = [
  {
    file: "package.json",
    apply(doc, version) {
      if (doc.version === version) return false;
      doc.version = version;
      return true;
    },
  },
  {
    file: "package-lock.json",
    apply(doc, version) {
      let changed = false;
      if (doc.version !== version) {
        doc.version = version;
        changed = true;
      }
      const root = doc.packages && doc.packages[""];
      if (root && root.version !== version) {
        root.version = version;
        changed = true;
      }
      return changed;
    },
  },
  {
    file: ".claude-plugin/plugin.json",
    apply(doc, version) {
      if (doc.version === version) return false;
      doc.version = version;
      return true;
    },
  },
  {
    file: ".claude-plugin/marketplace.json",
    apply(doc, version) {
      let changed = false;
      if (doc.metadata && doc.metadata.version !== version) {
        doc.metadata.version = version;
        changed = true;
      }
      for (const plugin of doc.plugins || []) {
        if (plugin.name === PACKAGE_NAME && plugin.version !== version) {
          plugin.version = version;
          changed = true;
        }
      }
      return changed;
    },
  },
  {
    file: ANCHOR_FILE,
    kind: "text",
    // The anchor states the framework version this tree was generated with.
    // For the framework's own tree that is the tree version, so a release bump
    // has to re-render it — otherwise the checked-in anchor keeps advertising
    // the version that was current when it was last written.
    apply(text, version, root) {
      const { body } = buildAnchor({ projectDir: root, version });
      return text === body ? null : body;
    },
  },
];

function carrierFiles() {
  return CARRIERS.map((carrier) => carrier.file);
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function writeJson(file, doc) {
  fs.writeFileSync(file, JSON.stringify(doc, null, 2) + "\n");
}

// Stamp `version` into every carrier that exists under `root`.
// Missing carriers are reported rather than silently ignored: a project that
// uses pnpm has no package-lock.json, and that is not an error.
function syncVersion(root, version) {
  const changed = [];
  const missing = [];
  for (const carrier of CARRIERS) {
    const file = path.join(root, carrier.file);
    if (!fs.existsSync(file)) {
      missing.push(carrier.file);
      continue;
    }
    if (carrier.kind === "text") {
      const current = fs.readFileSync(file, "utf8");
      const next = carrier.apply(current, version, root);
      if (next !== null && next !== undefined && next !== current) {
        fs.writeFileSync(file, next);
        changed.push(carrier.file);
      }
      continue;
    }
    const doc = readJson(file);
    if (carrier.apply(doc, version)) {
      writeJson(file, doc);
      changed.push(carrier.file);
    }
  }
  return { changed, missing };
}

function changelogPath(root) {
  return path.join(root, CHANGELOG_FILE);
}

function changelogHasVersion(root, version) {
  const file = changelogPath(root);
  if (!fs.existsSync(file)) return false;
  return fs.readFileSync(file, "utf8").includes("## [" + version + "]");
}

// Create the changelog section for `version` when it does not exist yet.
//
// The release consistency gate requires the current version to be documented,
// and a version number cannot be documented before it exists — so the bump
// writes the section itself. The section is marked "Unreleased" and carries a
// placeholder body: a local version bump is not a publication, and the notes
// still have to be written by a human before the version is released.
function ensureChangelogEntry(root, version, body) {
  const file = changelogPath(root);
  if (!fs.existsSync(file)) return { created: false, reason: "changelog_missing" };
  const text = fs.readFileSync(file, "utf8");
  if (text.includes("## [" + version + "]")) return { created: false, reason: "already_present" };

  const lines = text.split("\n");
  // Insert right before the newest released version so the newest section
  // stays on top. `## [Unreleased]` stays above the new section.
  let insertAt = lines.findIndex(
    (line) => /^## \[/.test(line) && !/^## \[Unreleased\]/.test(line),
  );
  if (insertAt === -1) insertAt = lines.length;

  const section = ["## [" + version + "] - Unreleased", "", body, ""];
  lines.splice(insertAt, 0, ...section);
  fs.writeFileSync(file, lines.join("\n"));
  return { created: true, reason: "inserted" };
}

// Read the version every carrier agrees on. Returns null when the tree has no
// carriers at all.
function readVersion(root) {
  const pkg = path.join(root, "package.json");
  if (!fs.existsSync(pkg)) return null;
  return readJson(pkg).version;
}

module.exports = {
  ANCHOR_FILE,
  CARRIERS,
  CHANGELOG_FILE,
  PACKAGE_NAME,
  carrierFiles,
  changelogHasVersion,
  changelogPath,
  ensureChangelogEntry,
  readVersion,
  syncVersion,
};
