"use strict";

// ─── tests/catalog/fetch-4kind.test.js ─────────────────────────────────────────
//
// Unit tests for lib/catalog/fetch.js — 4-kind content-addressed fetch.
//
// Coverage:
//   1. helpers (sha256, verifyHash, writeFileAtomic, clearDirectory, joinUrl)
//   2. fileSetFor / KIND_FILE_SETS / isRequiredFile / isOptionalFile
//   3. fetchEntry — design-system delegation (T-OD-001 frozen, must not break)
//   4. fetchEntry — plugin (open-design.json + manifest.json via converter)
//   5. fetchEntry — skill (SKILL.md only)
//   6. fetchEntry — template (SKILL.md + index.html)
//   7. fetchEntry — required file 404 hard error
//   8. fetchEntry — optional file 404 silent skip
//   9. fetchEntry — unknown kind rejection
//  10. fetchEntry — id required
//  11. fetchEntry — expectedHashes fail-closed on mismatch
//  12. fetchEntry — atomic write (tmp + rename, directory cleared first)
//  13. fetchEntry — fetcher injection (zero real network in tests)
//  14. fetchManifest — kind-specific light fetch
//  15. fetchManifest — unknown kind rejection
//  16. integration — end-to-end mock upstream for all 4 kinds

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");

const fetch = require("../../lib/catalog/fetch");

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "fetch-4kind-"));
}

function sha256(s) {
  return crypto.createHash("sha256").update(s, "utf8").digest("hex");
}

// In-memory fetcher: maps URL → { statusCode, body }
function makeMemoryFetcher(routes) {
  return (url, options) =>
    new Promise((resolve, reject) => {
      const handler = routes[url];
      if (!handler) {
        reject(new Error("HTTP 404"));
        return;
      }
      if (typeof handler === "string") {
        resolve(handler);
      } else if (handler && typeof handler.body === "string") {
        resolve(handler.body);
      } else {
        reject(new Error("HTTP 500"));
      }
    });
}

const VALID_OD_PLUGIN = {
  od: {
    kind: "plugin",
    name: "Figma Migration Helper",
    version: "1.2.0",
    description: "Migrate Figma designs to Open Design.",
    mode: "code",
    taskKind: "plugin",
    capabilities: ["design.import"],
    inputs: ["figma_url"],
  },
  license: "Apache-2.0",
};

const VALID_SKILL_MD = "---\nlicense: Apache-2.0\n---\n# Test Skill\n";

const VALID_TEMPLATE_SKILL = "---\nlicense: Apache-2.0\n---\n# Test Template\n";
const VALID_TEMPLATE_INDEX = "<!doctype html><html><body>Hello</body></html>";

const UPSTREAM = "https://raw.githubusercontent.com/nexu-io/open-design/main";

// ─── 1. helpers ────────────────────────────────────────────────────────────────

test("sha256 — stable across runs", () => {
  assert.equal(fetch.sha256("hello"), sha256("hello"));
  assert.equal(fetch.sha256("").length, 64);
});

test("verifyHash — passes when expected matches", () => {
  fetch.verifyHash("foo", "hello", sha256("hello"));
});

test("verifyHash — passes when expected is null (skip)", () => {
  fetch.verifyHash("foo", "hello", null);
  fetch.verifyHash("foo", "hello", undefined);
});

test("verifyHash — throws on mismatch", () => {
  assert.throws(
    () => fetch.verifyHash("foo", "hello", "deadbeef".repeat(8)),
    /Hash mismatch for foo/,
  );
});

test("writeFileAtomic + clearDirectory — round-trip", () => {
  const dir = tmpDir();
  const file = path.join(dir, "a.txt");
  fetch.writeFileAtomic(file, "content");
  assert.ok(fs.existsSync(file));
  assert.equal(fs.readFileSync(file, "utf8"), "content");
  // Tmp file is renamed, not left behind.
  assert.ok(!fs.existsSync(file + ".tmp"));
  // clearDirectory removes everything.
  const sub = path.join(dir, "sub");
  fs.mkdirSync(sub);
  fs.writeFileSync(path.join(sub, "b.txt"), "b");
  fetch.clearDirectory(dir);
  assert.ok(!fs.existsSync(sub));
  assert.ok(!fs.existsSync(file));
});

test("joinUrl — strips leading/trailing slashes", () => {
  assert.equal(fetch.joinUrl("https://x.com", "/y/", "/a"), "https://x.com/y/a");
  assert.equal(fetch.joinUrl("a", "b", null, "", "c"), "a/b/c");
});

// ─── 2. file sets + kind classification ───────────────────────────────────────

test("fileSetFor — design-system: required=manifest.json, optional=DESIGN.md+tokens.css", () => {
  const set = fetch.fileSetFor("design-system");
  assert.deepEqual(set.required, ["manifest.json"]);
  assert.deepEqual(set.optional, ["DESIGN.md", "tokens.css"]);
});

test("fileSetFor — plugin: required=open-design.json, optional=SKILL.md+README.md", () => {
  const set = fetch.fileSetFor("plugin");
  assert.deepEqual(set.required, ["open-design.json"]);
  assert.deepEqual(set.optional.sort(), ["README.md", "SKILL.md"]);
});

test("fileSetFor — skill: required=SKILL.md", () => {
  const set = fetch.fileSetFor("skill");
  assert.deepEqual(set.required, ["SKILL.md"]);
  assert.ok(set.optional.includes("README.md"));
});

test("fileSetFor — template: required=SKILL.md + index.html", () => {
  const set = fetch.fileSetFor("template");
  assert.deepEqual(set.required.sort(), ["SKILL.md", "index.html"]);
});

test("fileSetFor — unknown kind throws", () => {
  assert.throws(() => fetch.fileSetFor("foo-bar"), /unknown kind "foo-bar"/);
});

test("isRequiredFile / isOptionalFile", () => {
  assert.equal(fetch.isRequiredFile("plugin", "open-design.json"), true);
  assert.equal(fetch.isRequiredFile("plugin", "SKILL.md"), false);
  assert.equal(fetch.isOptionalFile("plugin", "SKILL.md"), true);
  assert.equal(fetch.isRequiredFile("skill", "SKILL.md"), true);
  assert.equal(fetch.isOptionalFile("skill", "SKILL.md"), false);
  // Edge: required files are NOT classified as optional.
  assert.equal(fetch.isOptionalFile("plugin", "open-design.json"), false);
});

// ─── 3. fetchEntry — design-system delegation ─────────────────────────────────

test("fetchEntry — design-system delegates to T-OD-001 (manifest + DESIGN.md + tokens.css)", async () => {
  const manifest = JSON.stringify({ id: "linear-app", name: "Linear", license: "Apache-2.0" });
  const design = "# Linear\n";
  const tokens = ":root { --primary: #5e6ad2; }\n";

  const fetcher = makeMemoryFetcher({
    [`${UPSTREAM}/design-systems/linear-app/manifest.json`]: manifest,
    [`${UPSTREAM}/design-systems/linear-app/DESIGN.md`]: design,
    [`${UPSTREAM}/design-systems/linear-app/tokens.css`]: tokens,
  });

  const cwd = tmpDir();
  const result = await fetch.fetchEntry({
    kind: "design-system",
    id: "linear-app",
    upstream: UPSTREAM,
    destDir: path.join(cwd, ".agent", "design-systems", "linear-app"),
    fetcher,
  });

  assert.equal(result.kind, "design-system");
  assert.equal(result.id, "linear-app");
  assert.equal(result.sha256.manifest, sha256(manifest));
  assert.equal(result.sha256.design, sha256(design));
  assert.equal(result.sha256.tokens, sha256(tokens));
  assert.ok(fs.existsSync(path.join(result.path, "manifest.json")));
  assert.ok(fs.existsSync(path.join(result.path, "DESIGN.md")));
  assert.ok(fs.existsSync(path.join(result.path, "tokens.css")));
});

// ─── 4. fetchEntry — plugin (open-design.json + converted manifest.json) ──────

test("fetchEntry — plugin: writes open-design.json + converted manifest.json", async () => {
  const od = JSON.stringify(VALID_OD_PLUGIN);
  const skill = "# Migration Skill\n";

  const fetcher = makeMemoryFetcher({
    [`${UPSTREAM}/plugins/figma-migration/open-design.json`]: od,
    [`${UPSTREAM}/plugins/figma-migration/SKILL.md`]: skill,
  });

  const cwd = tmpDir();
  const result = await fetch.fetchEntry({
    kind: "plugin",
    id: "figma-migration",
    upstream: UPSTREAM,
    destDir: path.join(cwd, ".agent", "plugins", "figma-migration"),
    fetcher,
  });

  assert.equal(result.kind, "plugin");
  assert.equal(result.id, "figma-migration");

  // open-design.json preserved verbatim
  const odOnDisk = JSON.parse(fs.readFileSync(path.join(result.path, "open-design.json"), "utf8"));
  assert.equal(odOnDisk.od.kind, "plugin");

  // manifest.json produced by plugin-converter
  assert.ok(fs.existsSync(path.join(result.path, "manifest.json")));
  const manifest = JSON.parse(fs.readFileSync(path.join(result.path, "manifest.json"), "utf8"));
  assert.equal(manifest.source, "open-design");
  assert.equal(manifest.license, "Apache-2.0");
  assert.equal(manifest.taskKind, "plugin");

  // SKILL.md also written
  assert.ok(fs.existsSync(path.join(result.path, "SKILL.md")));

  // sha256 covers all three files
  assert.ok(result.sha256["open-design.json"]);
  assert.ok(result.sha256["manifest.json"]);
  assert.ok(result.sha256["SKILL.md"]);
});

test("fetchEntry — plugin: invalid open-design.json does NOT crash install", async () => {
  const od = JSON.stringify({ od: { kind: "wrong-kind", name: "x", version: "0.0.0" } });

  const fetcher = makeMemoryFetcher({
    [`${UPSTREAM}/plugins/bad-plugin/open-design.json`]: od,
  });

  const cwd = tmpDir();
  const result = await fetch.fetchEntry({
    kind: "plugin",
    id: "bad-plugin",
    upstream: UPSTREAM,
    destDir: path.join(cwd, ".agent", "plugins", "bad-plugin"),
    fetcher,
  });

  // open-design.json is preserved, manifest.json NOT generated.
  assert.ok(fs.existsSync(path.join(result.path, "open-design.json")));
  assert.ok(!fs.existsSync(path.join(result.path, "manifest.json")));
});

// ─── 5. fetchEntry — skill (SKILL.md only) ────────────────────────────────────

test("fetchEntry — skill: writes SKILL.md (and optional README.md if present)", async () => {
  const skill = VALID_SKILL_MD;
  const readme = "# Plugin README\n";

  const fetcher = makeMemoryFetcher({
    [`${UPSTREAM}/skills/my-skill/SKILL.md`]: skill,
    [`${UPSTREAM}/skills/my-skill/README.md`]: readme,
  });

  const cwd = tmpDir();
  const result = await fetch.fetchEntry({
    kind: "skill",
    id: "my-skill",
    upstream: UPSTREAM,
    destDir: path.join(cwd, ".agent", "skills", "my-skill"),
    fetcher,
  });

  assert.equal(result.kind, "skill");
  assert.ok(fs.existsSync(path.join(result.path, "SKILL.md")));
  assert.ok(fs.existsSync(path.join(result.path, "README.md")));
  assert.equal(result.sha256["SKILL.md"], sha256(skill));
  assert.equal(result.manifest, skill); // raw text for SKILL.md
});

// ─── 6. fetchEntry — template (SKILL.md + index.html) ─────────────────────────

test("fetchEntry — template: writes SKILL.md + index.html (both required)", async () => {
  const skill = VALID_TEMPLATE_SKILL;
  const index = VALID_TEMPLATE_INDEX;

  const fetcher = makeMemoryFetcher({
    [`${UPSTREAM}/design-templates/my-template/SKILL.md`]: skill,
    [`${UPSTREAM}/design-templates/my-template/index.html`]: index,
  });

  const cwd = tmpDir();
  const result = await fetch.fetchEntry({
    kind: "template",
    id: "my-template",
    upstream: UPSTREAM,
    destDir: path.join(cwd, ".agent", "templates", "my-template"),
    fetcher,
  });

  assert.equal(result.kind, "template");
  assert.ok(fs.existsSync(path.join(result.path, "SKILL.md")));
  assert.ok(fs.existsSync(path.join(result.path, "index.html")));
});

// ─── 7. fetchEntry — required file 404 hard error ────────────────────────────

test("fetchEntry — required file 404 throws (no silent install)", async () => {
  const fetcher = makeMemoryFetcher({}); // empty → all 404

  const cwd = tmpDir();
  await assert.rejects(
    () =>
      fetch.fetchEntry({
        kind: "skill",
        id: "missing",
        upstream: UPSTREAM,
        destDir: path.join(cwd, ".agent", "skills", "missing"),
        fetcher,
      }),
    /required file "SKILL.md" missing for skill\/missing/,
  );

  // Dest dir must NOT be created on failure.
  assert.ok(!fs.existsSync(path.join(cwd, ".agent", "skills", "missing")));
});

test("fetchEntry — template: missing index.html fails with explicit file name", async () => {
  const skill = VALID_TEMPLATE_SKILL;
  const fetcher = makeMemoryFetcher({
    [`${UPSTREAM}/design-templates/broken/SKILL.md`]: skill,
    // index.html missing
  });

  const cwd = tmpDir();
  await assert.rejects(
    () =>
      fetch.fetchEntry({
        kind: "template",
        id: "broken",
        upstream: UPSTREAM,
        destDir: path.join(cwd, ".agent", "templates", "broken"),
        fetcher,
      }),
    /required file "index.html" missing for template\/broken/,
  );
});

// ─── 8. fetchEntry — optional file 404 silent skip ───────────────────────────

test("fetchEntry — optional file 404 silently skipped", async () => {
  const od = JSON.stringify(VALID_OD_PLUGIN);
  // Only open-design.json is reachable; SKILL.md + README.md both 404.
  const fetcher = makeMemoryFetcher({
    [`${UPSTREAM}/plugins/no-optional/open-design.json`]: od,
  });

  const cwd = tmpDir();
  const result = await fetch.fetchEntry({
    kind: "plugin",
    id: "no-optional",
    upstream: UPSTREAM,
    destDir: path.join(cwd, ".agent", "plugins", "no-optional"),
    fetcher,
  });

  assert.ok(fs.existsSync(path.join(result.path, "open-design.json")));
  // SKILL.md + README.md NOT written.
  assert.ok(!fs.existsSync(path.join(result.path, "SKILL.md")));
  assert.ok(!fs.existsSync(path.join(result.path, "README.md")));
});

// ─── 9. fetchEntry — unknown kind rejection ──────────────────────────────────

test("fetchEntry — unknown kind throws", async () => {
  await assert.rejects(
    () => fetch.fetchEntry({ kind: "foo-bar", id: "x" }),
    /unknown kind "foo-bar"/,
  );
});

// ─── 10. fetchEntry — id required ────────────────────────────────────────────

test("fetchEntry — id is required", async () => {
  await assert.rejects(
    () => fetch.fetchEntry({ kind: "skill" }),
    /id is required/,
  );
});

// ─── 11. fetchEntry — expectedHashes fail-closed on mismatch ─────────────────

test("fetchEntry — expectedHashes mismatch throws (MITM guard)", async () => {
  const skill = VALID_SKILL_MD;
  const wrongHash = "0".repeat(64);

  const fetcher = makeMemoryFetcher({
    [`${UPSTREAM}/skills/tampered/SKILL.md`]: skill,
  });

  const cwd = tmpDir();
  await assert.rejects(
    () =>
      fetch.fetchEntry({
        kind: "skill",
        id: "tampered",
        upstream: UPSTREAM,
        destDir: path.join(cwd, ".agent", "skills", "tampered"),
        fetcher,
        expectedHashes: { "SKILL.md": wrongHash },
      }),
    /Hash mismatch for SKILL.md/,
  );

  // Dest dir NOT created on hash mismatch.
  assert.ok(!fs.existsSync(path.join(cwd, ".agent", "skills", "tampered")));
});

test("fetchEntry — expectedHashes matches allows install", async () => {
  const skill = VALID_SKILL_MD;
  const correctHash = sha256(skill);

  const fetcher = makeMemoryFetcher({
    [`${UPSTREAM}/skills/verified/SKILL.md`]: skill,
  });

  const cwd = tmpDir();
  const result = await fetch.fetchEntry({
    kind: "skill",
    id: "verified",
    upstream: UPSTREAM,
    destDir: path.join(cwd, ".agent", "skills", "verified"),
    fetcher,
    expectedHashes: { "SKILL.md": correctHash },
  });

  assert.ok(fs.existsSync(path.join(result.path, "SKILL.md")));
});

// ─── 12. fetchEntry — atomic write (tmp + rename, directory cleared first) ───

test("fetchEntry — clears destination directory before writing", async () => {
  const skill = VALID_SKILL_MD;
  const fetcher = makeMemoryFetcher({
    [`${UPSTREAM}/skills/cleared/SKILL.md`]: skill,
  });

  const cwd = tmpDir();
  const destDir = path.join(cwd, ".agent", "skills", "cleared");
  fs.mkdirSync(destDir, { recursive: true });
  // Pre-existing stale file in destDir.
  fs.writeFileSync(path.join(destDir, "stale.txt"), "STALE");

  await fetch.fetchEntry({
    kind: "skill",
    id: "cleared",
    upstream: UPSTREAM,
    destDir,
    fetcher,
  });

  assert.ok(!fs.existsSync(path.join(destDir, "stale.txt")));
  assert.ok(fs.existsSync(path.join(destDir, "SKILL.md")));
  // No leftover .tmp files.
  const remaining = fs.readdirSync(destDir);
  assert.ok(!remaining.some((f) => f.endsWith(".tmp")));
});

// ─── 13. fetchEntry — fetcher injection (zero real network) ──────────────────

test("fetchEntry — uses injected fetcher (no real network)", async () => {
  let called = 0;
  const myFetcher = (url) => {
    called++;
    if (url.endsWith("SKILL.md")) return Promise.resolve(VALID_SKILL_MD);
    return Promise.reject(new Error("HTTP 404"));
  };

  const cwd = tmpDir();
  await fetch.fetchEntry({
    kind: "skill",
    id: "injected",
    upstream: UPSTREAM,
    destDir: path.join(cwd, ".agent", "skills", "injected"),
    fetcher: myFetcher,
  });

  assert.ok(called > 0, "fetcher must be invoked");
});

// ─── 14. fetchManifest — kind-specific light fetch ──────────────────────────

test("fetchManifest — plugin reads open-design.json + synthesizes cortex-agent manifest via converter", async () => {
  const od = JSON.stringify(VALID_OD_PLUGIN);
  const fetcher = makeMemoryFetcher({
    [`${UPSTREAM}/plugins/light/open-design.json`]: od,
  });

  const result = await fetch.fetchManifest({
    kind: "plugin",
    id: "light",
    upstream: UPSTREAM,
    fetcher,
  });

  assert.equal(result.kind, "plugin");
  assert.equal(result.id, "light");
  // open-design.json preserved for audit
  assert.ok(result.openDesignRaw);
  assert.equal(result.openDesignRaw, od);
  // cortex-agent manifest synthesized via converter
  assert.equal(result.manifest.source, "open-design");
  assert.equal(result.manifest.taskKind, "plugin");
  assert.equal(result.manifest.license, "Apache-2.0");
});

test("fetchManifest — plugin with invalid open-design.json returns raw + conversionError", async () => {
  const od = JSON.stringify({ od: { kind: "wrong-kind", name: "x", version: "0.0.0" } });
  const fetcher = makeMemoryFetcher({
    [`${UPSTREAM}/plugins/bad/open-design.json`]: od,
  });

  const result = await fetch.fetchManifest({
    kind: "plugin",
    id: "bad",
    upstream: UPSTREAM,
    fetcher,
  });

  assert.equal(result.kind, "plugin");
  assert.ok(result.conversionError);
  assert.match(result.conversionError, /od.kind "wrong-kind"/);
});

test("fetchManifest — design-system delegates to T-OD-001", async () => {
  const manifest = JSON.stringify({ id: "x", name: "X", license: "Apache-2.0" });
  const fetcher = makeMemoryFetcher({
    [`${UPSTREAM}/design-systems/x/manifest.json`]: manifest,
  });

  const result = await fetch.fetchManifest({
    kind: "design-system",
    id: "x",
    upstream: UPSTREAM,
    fetcher,
  });

  assert.equal(result.kind, "design-system");
  assert.equal(result.id, "x");
  assert.equal(result.sha256, sha256(manifest));
});

// ─── 15. fetchManifest — unknown kind rejection ─────────────────────────────

test("fetchManifest — unknown kind throws", async () => {
  await assert.rejects(
    () => fetch.fetchManifest({ kind: "nope", id: "x" }),
    /unknown kind "nope"/,
  );
});

test("fetchManifest — id is required", async () => {
  await assert.rejects(
    () => fetch.fetchManifest({ kind: "skill" }),
    /id is required/,
  );
});

// ─── 16. integration — end-to-end mock upstream for all 4 kinds ─────────────

test("integration — 4 kinds in sequence share zero state", async () => {
  const dsManifest = JSON.stringify({ id: "ds1", license: "Apache-2.0" });
  const od = JSON.stringify(VALID_OD_PLUGIN);
  const routes = {
    [`${UPSTREAM}/design-systems/ds1/manifest.json`]: dsManifest,
    [`${UPSTREAM}/plugins/p1/open-design.json`]: od,
    [`${UPSTREAM}/skills/s1/SKILL.md`]: VALID_SKILL_MD,
    [`${UPSTREAM}/design-templates/t1/SKILL.md`]: VALID_TEMPLATE_SKILL,
    [`${UPSTREAM}/design-templates/t1/index.html`]: VALID_TEMPLATE_INDEX,
  };
  const fetcher = makeMemoryFetcher(routes);

  const cwd = tmpDir();

  const ds = await fetch.fetchEntry({
    kind: "design-system", id: "ds1",
    upstream: UPSTREAM,
    destDir: path.join(cwd, ".agent", "design-systems", "ds1"),
    fetcher,
  });
  const pl = await fetch.fetchEntry({
    kind: "plugin", id: "p1",
    upstream: UPSTREAM,
    destDir: path.join(cwd, ".agent", "plugins", "p1"),
    fetcher,
  });
  const sk = await fetch.fetchEntry({
    kind: "skill", id: "s1",
    upstream: UPSTREAM,
    destDir: path.join(cwd, ".agent", "skills", "s1"),
    fetcher,
  });
  const tm = await fetch.fetchEntry({
    kind: "template", id: "t1",
    upstream: UPSTREAM,
    destDir: path.join(cwd, ".agent", "templates", "t1"),
    fetcher,
  });

  assert.equal(ds.kind, "design-system");
  assert.equal(pl.kind, "plugin");
  assert.equal(sk.kind, "skill");
  assert.equal(tm.kind, "template");

  // Each install dir is independent.
  assert.ok(fs.existsSync(path.join(cwd, ".agent", "design-systems", "ds1", "manifest.json")));
  assert.ok(fs.existsSync(path.join(cwd, ".agent", "plugins", "p1", "open-design.json")));
  assert.ok(fs.existsSync(path.join(cwd, ".agent", "plugins", "p1", "manifest.json")));
  assert.ok(fs.existsSync(path.join(cwd, ".agent", "skills", "s1", "SKILL.md")));
  assert.ok(fs.existsSync(path.join(cwd, ".agent", "templates", "t1", "SKILL.md")));
  assert.ok(fs.existsSync(path.join(cwd, ".agent", "templates", "t1", "index.html")));

  // KIND_LIST is exported + matches expected 4 kinds.
  assert.deepEqual(
    [...fetch.KIND_LIST].sort(),
    ["design-system", "plugin", "skill", "template"],
  );
});