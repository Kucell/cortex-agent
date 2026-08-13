"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  HARD_CAPS,
  ALL_TYPES,
  validateMemory,
  buildFixPlan,
  applyFixPlan,
  parseMemoryIndex,
  parseFrontmatter,
} = require("../../lib/memory-validate");

function makeTopicFile(type, name, frontmatter, body = "") {
  const fmLines = Object.entries(frontmatter)
    .map(([k, v]) => {
      if (Array.isArray(v)) return `${k}: [${v.join(", ")}]`;
      return `${k}: ${v}`;
    })
    .join("\n");
  return `---\n${fmLines}\n---\n\n${body}\n`;
}

function freshProject(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-memval-"));
  const memoryRoot = path.join(root, ".agent", "memory");
  for (const type of ALL_TYPES) {
    fs.mkdirSync(path.join(memoryRoot, type), { recursive: true });
  }
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, memoryRoot };
}

function writeIndex(memoryRoot, sections) {
  const lines = ["# Memory", ""];
  for (const type of ALL_TYPES) {
    const s = sections[type] || { count: 0, items: [] };
    lines.push(`## ${type} (${s.count}/${HARD_CAPS[type]})`);
    for (const item of s.items) {
      lines.push(`- [${item.name}](${item.path}) — ${item.description || ""}`);
    }
    lines.push("");
  }
  fs.writeFileSync(path.join(memoryRoot, "MEMORY.md"), lines.join("\n"));
}

test("V-1 drift: declared count vs actual items mismatch is reported", (t) => {
  const { memoryRoot } = freshProject(t);
  writeIndex(memoryRoot, {
    user: { count: 2, items: [{ name: "reply-zh", path: "user/reply-zh.md" }] },
  });
  const result = validateMemory({ memoryRoot });
  const drift = result.issues.filter((i) => i.kind === "drift");
  assert.equal(drift.length, 1);
  assert.equal(drift[0].type, "user");
  assert.match(drift[0].detail, /user \(2\/10\).*found 1/);
});

test("V-1 drift: matching count does not produce drift issue", (t) => {
  const { memoryRoot } = freshProject(t);
  writeIndex(memoryRoot, {
    user: { count: 1, items: [{ name: "reply-zh", path: "user/reply-zh.md" }] },
  });
  fs.writeFileSync(
    path.join(memoryRoot, "user", "reply-zh.md"),
    makeTopicFile("user", "reply-zh", {
      name: "reply-zh",
      description: "中文回复偏好",
      type: "user",
      created: "2026-08-13",
      tags: ["language", "reply"],
    })
  );
  const result = validateMemory({ memoryRoot });
  assert.equal(result.issues.filter((i) => i.kind === "drift").length, 0);
});

test("V-2 missing: indexed path with no file is reported", (t) => {
  const { memoryRoot } = freshProject(t);
  writeIndex(memoryRoot, {
    project: { count: 1, items: [{ name: "pnpm", path: "project/pnpm-not-npm.md" }] },
  });
  const result = validateMemory({ memoryRoot });
  const missing = result.issues.filter((i) => i.kind === "missing");
  assert.equal(missing.length, 1);
  assert.equal(missing[0].path, "project/pnpm-not-npm.md");
});

test("V-2 missing: .gitkeep placeholder is NOT reported", (t) => {
  const { memoryRoot } = freshProject(t);
  fs.writeFileSync(path.join(memoryRoot, "user", ".gitkeep"), "");
  writeIndex(memoryRoot, {
    user: { count: 1, items: [{ name: "gitkeep", path: "user/.gitkeep" }] },
  });
  const result = validateMemory({ memoryRoot });
  assert.equal(result.issues.filter((i) => i.kind === "missing").length, 0);
});

test("V-2 missing: 0-byte topic file IS reported", (t) => {
  const { memoryRoot } = freshProject(t);
  fs.writeFileSync(path.join(memoryRoot, "user", "reply-zh.md"), "");
  writeIndex(memoryRoot, {
    user: { count: 1, items: [{ name: "reply-zh", path: "user/reply-zh.md" }] },
  });
  const result = validateMemory({ memoryRoot });
  assert.equal(result.issues.filter((i) => i.kind === "missing").length, 1);
});

test("V-3 schema: missing required frontmatter keys is reported", (t) => {
  const { memoryRoot } = freshProject(t);
  fs.writeFileSync(
    path.join(memoryRoot, "project", "pnpm-not-npm.md"),
    makeTopicFile("project", "pnpm-not-npm", { name: "pnpm-not-npm", type: "project" })
  );
  writeIndex(memoryRoot, {
    project: { count: 1, items: [{ name: "pnpm-not-npm", path: "project/pnpm-not-npm.md" }] },
  });
  const result = validateMemory({ memoryRoot });
  const schema = result.issues.filter((i) => i.kind === "schema");
  assert.equal(schema.length, 1);
  assert.match(schema[0].detail, /description, created, tags/);
});

test("V-3 schema: complete frontmatter passes", (t) => {
  const { memoryRoot } = freshProject(t);
  fs.writeFileSync(
    path.join(memoryRoot, "project", "pnpm-not-npm.md"),
    makeTopicFile("project", "pnpm-not-npm", {
      name: "pnpm-not-npm",
      description: "Use pnpm, not npm",
      type: "project",
      created: "2026-08-13",
      tags: ["pnpm", "package-manager"],
    })
  );
  writeIndex(memoryRoot, {
    project: { count: 1, items: [{ name: "pnpm-not-npm", path: "project/pnpm-not-npm.md" }] },
  });
  const result = validateMemory({ memoryRoot });
  assert.equal(result.issues.filter((i) => i.kind === "schema").length, 0);
});

test("V-3 schema: orphan file with no frontmatter is still flagged", (t) => {
  const { memoryRoot } = freshProject(t);
  fs.writeFileSync(path.join(memoryRoot, "user", "bare.md"), "# bare\n");
  writeIndex(memoryRoot, {});
  const result = validateMemory({ memoryRoot });
  const schema = result.issues.filter((i) => i.kind === "schema");
  assert.equal(schema.length, 1);
  assert.match(schema[0].detail, /no YAML frontmatter/);
});

test("V-4 orphan: file on disk but not indexed is reported", (t) => {
  const { memoryRoot } = freshProject(t);
  fs.writeFileSync(
    path.join(memoryRoot, "user", "reply-zh.md"),
    makeTopicFile("user", "reply-zh", {
      name: "reply-zh",
      description: "中文回复偏好",
      type: "user",
      created: "2026-08-13",
      tags: ["language"],
    })
  );
  writeIndex(memoryRoot, {});
  const result = validateMemory({ memoryRoot });
  const orphan = result.issues.filter((i) => i.kind === "orphan");
  assert.equal(orphan.length, 1);
  assert.equal(orphan[0].path, "user/reply-zh.md");
});

test("V-4 orphan: non-md files in topic dirs are ignored", (t) => {
  const { memoryRoot } = freshProject(t);
  fs.writeFileSync(path.join(memoryRoot, "user", "README.txt"), "ignored");
  writeIndex(memoryRoot, {});
  const result = validateMemory({ memoryRoot });
  assert.equal(result.issues.filter((i) => i.kind === "orphan").length, 0);
});

test("V-5 duplicate: same path indexed twice is reported", (t) => {
  const { memoryRoot } = freshProject(t);
  writeIndex(memoryRoot, {
    user: {
      count: 2,
      items: [
        { name: "reply-zh", path: "user/reply-zh.md" },
        { name: "reply-zh-2", path: "user/reply-zh.md" },
      ],
    },
  });
  fs.writeFileSync(
    path.join(memoryRoot, "user", "reply-zh.md"),
    makeTopicFile("user", "reply-zh", {
      name: "reply-zh",
      description: "x",
      type: "user",
      created: "2026-08-13",
      tags: ["x"],
    })
  );
  const result = validateMemory({ memoryRoot });
  const dup = result.issues.filter((i) => i.kind === "duplicate");
  assert.equal(dup.length, 1);
  assert.match(dup[0].detail, /indexed at line \d+ and again at line \d+/);
});

test("V-5 over-cap: items.length > HARD_CAPS is reported", (t) => {
  const { memoryRoot } = freshProject(t);
  const items = [];
  for (let i = 0; i < HARD_CAPS.user + 1; i++) {
    items.push({ name: `topic-${i}`, path: `user/topic-${i}.md` });
    fs.writeFileSync(
      path.join(memoryRoot, "user", `topic-${i}.md`),
      makeTopicFile("user", `topic-${i}`, {
        name: `topic-${i}`,
        description: `Topic ${i}`,
        type: "user",
        created: "2026-08-13",
        tags: [`tag-${i}`],
      })
    );
  }
  writeIndex(memoryRoot, { user: { count: items.length, items } });
  const result = validateMemory({ memoryRoot });
  const over = result.issues.filter((i) => i.kind === "over-cap");
  assert.equal(over.length, 1);
  assert.equal(over[0].type, "user");
  assert.match(over[0].detail, /exceeding the hard cap of 10/);
});

test("fix plan: drift / orphan / duplicate are auto-fixable; missing / schema / over-cap are skipped", (t) => {
  const { memoryRoot } = freshProject(t);
  fs.writeFileSync(
    path.join(memoryRoot, "user", "reply-zh.md"),
    makeTopicFile("user", "reply-zh", {
      name: "reply-zh",
      description: "中文回复偏好",
      type: "user",
      created: "2026-08-13",
      tags: ["language"],
    })
  );
  fs.writeFileSync(path.join(memoryRoot, "project", "broken.md"), "# no frontmatter\n");
  writeIndex(memoryRoot, {
    user: { count: 0, items: [] },
    project: {
      count: 1,
      items: [
        { name: "broken", path: "project/broken.md" },
        { name: "broken-2", path: "project/broken.md" },
      ],
    },
  });
  const result = validateMemory({ memoryRoot });
  const plan = buildFixPlan(result.parsed, result.issues, memoryRoot);
  assert.equal(plan.ok, true);
  const kinds = new Set(plan.edits.map((e) => e.kind));
  assert.ok(kinds.has("drift"));
  assert.ok(kinds.has("orphan"));
  assert.ok(kinds.has("duplicate"));
  for (const skip of plan.skipReasons) {
    assert.match(skip.reason, /cannot auto-(create|fill)|out of scope/);
  }
});

test("applyFixPlan: refuses without confirm=true (proposal safety bound)", (t) => {
  const { memoryRoot } = freshProject(t);
  writeIndex(memoryRoot, {});
  const result = validateMemory({ memoryRoot });
  const plan = buildFixPlan(result.parsed, result.issues, memoryRoot);
  assert.throws(
    () => applyFixPlan(result.parsed, plan),
    /refusing to mutate MEMORY\.md without confirm=true/
  );
});

test("applyFixPlan: with confirm=true, drift + orphan + duplicate edits actually rewrite MEMORY.md", (t) => {
  const { memoryRoot } = freshProject(t);
  fs.writeFileSync(
    path.join(memoryRoot, "user", "reply-zh.md"),
    makeTopicFile("user", "reply-zh", {
      name: "reply-zh",
      description: "中文回复偏好",
      type: "user",
      created: "2026-08-13",
      tags: ["language"],
    })
  );
  writeIndex(memoryRoot, { user: { count: 0, items: [] } });
  const before = validateMemory({ memoryRoot });
  const plan = buildFixPlan(before.parsed, before.issues, memoryRoot);
  applyFixPlan(before.parsed, plan, { confirm: true });
  const after = validateMemory({ memoryRoot });
  assert.equal(after.issues.filter((i) => i.kind === "drift").length, 0);
  assert.equal(after.issues.filter((i) => i.kind === "orphan").length, 0);
});

test("end-to-end: reproduces the current-repo drift pattern (user orphan + project drift)", (t) => {
  const { memoryRoot } = freshProject(t);
  fs.writeFileSync(
    path.join(memoryRoot, "user", "reply-zh.md"),
    makeTopicFile("user", "reply-zh", {
      name: "reply-zh",
      description: "中文回复偏好",
      type: "user",
      created: "2026-08-13",
      tags: ["language", "reply"],
    })
  );
  fs.writeFileSync(
    path.join(memoryRoot, "project", "pnpm-not-npm.md"),
    makeTopicFile("project", "pnpm-not-npm", {
      name: "pnpm-not-npm",
      description: "Use pnpm, not npm",
      type: "project",
      created: "2026-08-13",
      tags: ["pnpm", "package-manager"],
    })
  );
  writeIndex(memoryRoot, {
    user: { count: 0, items: [] },
    feedback: {
      count: 2,
      items: [
        { name: "rc-1", path: "feedback/rc-1.md" },
        { name: "rc-2", path: "feedback/rc-2.md" },
      ],
    },
    project: {
      count: 2,
      items: [
        { name: "rc-1", path: "project/rc-1.md" },
        { name: "rc-2", path: "project/rc-2.md" },
        { name: "pnpm-not-npm", path: "project/pnpm-not-npm.md" },
        { name: "postcommit", path: "project/postcommit-hook-incompat.md" },
      ],
    },
  });
  const result = validateMemory({ memoryRoot });
  assert.equal(result.issues.filter((i) => i.kind === "drift").length, 1);
  assert.equal(result.issues.filter((i) => i.kind === "orphan").length, 1);
  // 5 indexed files do not exist on disk: feedback/rc-1.md, feedback/rc-2.md,
  // project/rc-1.md, project/rc-2.md, project/postcommit-hook-incompat.md.
  // Only project/pnpm-not-npm.md was actually created.
  assert.equal(result.issues.filter((i) => i.kind === "missing").length, 5);
});

test("parseFrontmatter: handles bare, quoted, and inline-array values", () => {
  const text = `---
name: reply-zh
description: "中文回复偏好"
type: user
created: 2026-08-13
tags: [language, reply]
---
body
`;
  const fm = parseFrontmatter(text);
  assert.equal(fm.name, "reply-zh");
  assert.equal(fm.description, "中文回复偏好");
  assert.equal(fm.type, "user");
  assert.equal(fm.created, "2026-08-13");
  assert.deepEqual(fm.tags, ["language", "reply"]);
});

test("parseMemoryIndex: returns ok=false when MEMORY.md missing", (t) => {
  const { memoryRoot } = freshProject(t);
  const parsed = parseMemoryIndex(memoryRoot);
  assert.equal(parsed.ok, false);
  assert.match(parsed.reason, /MEMORY\.md missing/);
});
