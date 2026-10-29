"use strict";

// share-learnings.js — human-gated experience draft (P-003 / M-003B).
// Self-contained, zero external dependencies (ships to user projects).
// Node >=14.
//
// The recommendation from friction-score NEVER creates a draft automatically.
// This CLI writes .agent/runtime-evidence/friction/drafts/exp-<session-id>-draft.md
// ONLY when the user explicitly passes --confirm; otherwise it refuses (exit 2)
// and creates NOTHING. No auto-upvote, no auto-promotion, no commit.
//
// The draft lives under .agent/ rather than /tmp: a draft awaiting human review
// has value after this process exits, and /tmp is reclaimed with the session.
// See .agent/rules/runtime-artifacts-location.md.

const fs = require("node:fs");
const path = require("node:path");

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : undefined;
}
function has(name) {
  return process.argv.indexOf(name) >= 0;
}

function sanitizeSessionId(sessionId) {
  // Keep only [A-Za-z0-9._-] so the id is safe in a filename.
  return String(sessionId).replace(/[^A-Za-z0-9._-]/g, "_");
}

// Resolve the project root the same way the sibling friction scripts do: the
// .agent/ directory marks it, so walk up from cwd until one is found.
function resolveProjectRoot() {
  const explicit = arg("--project");
  if (explicit) return path.resolve(explicit);
  let dir = process.cwd();
  for (let i = 0; i < 10; i += 1) {
    if (fs.existsSync(path.join(dir, ".agent"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

function main() {
  const sessionId = arg("--session");
  const title = arg("--title");
  const bodyPath = arg("--body");
  if (!sessionId || !title) {
    console.error("usage: share-learnings.js --session <S-id> --title <title> [--body <path>] [--confirm]");
    process.exit(2);
  }
  if (!has("--confirm")) {
    console.error("share-learnings requires explicit user confirmation (--confirm); refusing to create any draft.");
    process.exit(2);
  }
  let body = "";
  if (bodyPath) {
    body = fs.readFileSync(bodyPath, "utf8");
  }
  const safe = sanitizeSessionId(sessionId);
  const root = resolveProjectRoot();
  const draftDir = path.join(root, ".agent", "runtime-evidence", "friction", "drafts");
  fs.mkdirSync(draftDir, { recursive: true });
  const draftPath = path.join(draftDir, "exp-" + safe + "-draft.md");
  const now = new Date().toISOString();
  const content = [
    "---",
    "kind: experience-draft",
    "session_id: " + sessionId,
    "title: " + title,
    "drafted_at: " + now,
    "status: draft (human review required)",
    "---",
    "",
    "# " + title,
    "",
    body.trim(),
    "",
  ].join("\n");
  fs.writeFileSync(draftPath, content, "utf8");
  // Present a diff of the created draft (simple unified diff style).
  const lines = content.split("\n");
  const diff = lines.map(function (l) { return "+" + l; }).join("\n");
  process.stdout.write("diff --git a/(new) b/" + path.basename(draftPath) + "\n");
  process.stdout.write("new file mode 100644\n");
  process.stdout.write("--- /dev/null\n+++ b/" + path.basename(draftPath) + "\n");
  process.stdout.write("@@ -0,0 +1," + lines.length + " @@\n");
  process.stdout.write(diff + "\n");
  process.stdout.write("\nDraft written to: " + draftPath + "\n");
}

try {
  main();
} catch (err) {
  process.stderr.write(String(err && err.message ? err.message : err) + "\n");
  process.exit(1);
}
