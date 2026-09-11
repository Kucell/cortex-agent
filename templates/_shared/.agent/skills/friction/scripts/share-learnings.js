"use strict";

// share-learnings.js — human-gated experience draft (P-003 / M-003B).
// Self-contained, zero external dependencies (ships to user projects).
// Node >=14.
//
// The recommendation from friction-score NEVER creates a draft automatically.
// This CLI writes /tmp/exp-<session-id>-draft.md ONLY when the user explicitly
// passes --confirm; otherwise it refuses (exit 2) and creates NOTHING.
// No auto-upvote, no auto-promotion, no commit.

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : undefined;
}
function has(name) {
  return process.argv.indexOf(name) >= 0;
}

function sanitizeSessionId(sessionId) {
  // Keep only [A-Za-z0-9._-] so the id is safe in a /tmp filename.
  return String(sessionId).replace(/[^A-Za-z0-9._-]/g, "_");
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
  const draftPath = path.join(os.tmpdir(), "exp-" + safe + "-draft.md");
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
}

try {
  main();
} catch (err) {
  process.stderr.write(String(err && err.message ? err.message : err) + "\n");
  process.exit(1);
}
