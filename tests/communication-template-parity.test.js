"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const ROOT = path.resolve(__dirname, "..");
const CANONICAL = path.join(ROOT, ".agent");
const TEMPLATE_ROOTS = [
  path.join(ROOT, "templates", "en", ".agent"),
  path.join(ROOT, "templates", "zh", ".agent"),
];
const SHARED_ROOT = path.join(ROOT, "templates", "_shared", ".agent");

const COMMUNICATION_FILES = {
  inbox: ["README.md", "inbox-message.schema.json", "index.json", "index.schema.json"],
  decisions: ["README.md", "decision.schema.json", "index.json", "index.schema.json"],
  waitpoints: ["README.md", "index.json", "index.schema.json", "waitpoint.schema.json"],
};

const MACHINE_FILES = [
  "inbox/inbox-message.schema.json",
  "inbox/index.schema.json",
  "decisions/decision.schema.json",
  "decisions/index.schema.json",
  "waitpoints/index.schema.json",
  "waitpoints/waitpoint.schema.json",
  "skills/management-api/scripts/index.js",
  "skills/agent-dashboard/scripts/generate.js",
];

const DOCUMENT_FILES = [
  "inbox/README.md",
  "decisions/README.md",
  "waitpoints/README.md",
  "skills/management-api/SKILL.md",
  "skills/management-api/write-gates.md",
];

function read(root, relativePath) {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

function hash(root, relativePath) {
  return crypto.createHash("sha256").update(read(root, relativePath)).digest("hex");
}

test("communication template directories are complete", () => {
  for (const templateRoot of TEMPLATE_ROOTS) {
    for (const [directory, expectedFiles] of Object.entries(COMMUNICATION_FILES)) {
      const actualFiles = [...new Set([
        ...fs.readdirSync(path.join(templateRoot, directory)),
        ...fs.readdirSync(path.join(SHARED_ROOT, directory)),
      ])].sort();
      assert.deepEqual(actualFiles, [...expectedFiles].sort(), `${templateRoot}/${directory} is incomplete`);
    }
  }
});

test("machine-readable communication files match canonical hashes", () => {
  for (const relativePath of MACHINE_FILES) {
    assert.equal(
      hash(SHARED_ROOT, relativePath),
      hash(CANONICAL, relativePath),
      `${relativePath} drifted in shared template`,
    );
  }
});

test("English communication documents match canonical content", () => {
  const englishRoot = TEMPLATE_ROOTS[0];
  for (const relativePath of DOCUMENT_FILES) {
    assert.equal(read(englishRoot, relativePath), read(CANONICAL, relativePath), `${relativePath} drifted`);
  }
});

test("localized documents retain commands, lifecycle states, gates, and safety boundaries", () => {
  const requiredByFile = {
    "inbox/README.md": [
      "IM-", "unread", "read", "acknowledged", "archived", "artifact_refs", "read-only",
    ],
    "decisions/README.md": [
      "D-", "open", "approved", "rejected", "revision_requested", "canceled", "superseded",
      "gate.action", "gate.resource_ref", "selected_option", "resolved_by", "resolved_at", "read-only",
    ],
    "waitpoints/README.md": [
      "WP-", "pending", "blocked", "released", "canceled", "expired", "decision_id",
      "evidence_refs", "gate.action", "gate.resource_ref", "read-only",
    ],
    "skills/management-api/SKILL.md": [
      "query inbox", "query decisions", "query waitpoints", "decisions request",
      "decisions resolve --gate user", "waitpoints create", "waitpoints release", "--gate owner",
      "waitpoints cancel", "Dashboard", "read-only",
    ],
    "skills/management-api/write-gates.md": [
      "inbox send/transition --gate", "decisions request --gate", "decisions resolve --gate user",
      "waitpoints create --gate", "waitpoints release --gate owner", "gate.action",
      "gate.resource_ref", "evidence_refs", "read-only",
    ],
  };

  for (const templateRoot of TEMPLATE_ROOTS) {
    for (const [relativePath, markers] of Object.entries(requiredByFile)) {
      const content = read(templateRoot, relativePath);
      for (const marker of markers) {
        assert.ok(content.includes(marker), `${relativePath} in ${templateRoot} is missing ${marker}`);
      }
    }
  }
});
