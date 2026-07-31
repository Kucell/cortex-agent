"use strict";

// publish-security + verify-strict + upgrade-rejects + doctor-fix boundary
// integration tests for Team Pack.

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execSync } = require("child_process");
const t = require("../../lib/team-pack");

let failures = 0;
function check(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (err) { failures += 1; console.error(`  ✗ ${name}: ${err.message}`); }
}

function tmpDir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `tap-pub-${label}-`));
}

function writeFile(root, rel, content) {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

// ─── publish rejects PEM private key ─────────────────────────────────────────
check("publish rejects PEM private key in source file", () => {
  const root = tmpDir("pem");
  fs.mkdirSync(path.join(root, ".agent-shared"), { recursive: true });
  writeFile(root, "src/secret.pem", "-----BEGIN RSA PRIVATE KEY-----\nfoo\n-----END RSA PRIVATE KEY-----\n");
  const r = t.publishPack(root, [{ source: "src/secret.pem", dest: "rules/secret.pem" }], {
    name: "p", version: "0.1.0",
    requires: { cortex_agent: ">=1.6.0" },
    signers: { mode: "disabled" },
    includes: [], excludes: [],
  });
  assert.strictEqual(r.ok, false);
  assert.ok(r.skipped.length === 1);
  assert.match(r.skipped[0].reason, /secret_or_path_scan/);
});

// ─── publish rejects host entry ──────────────────────────────────────────────
check("publish rejects AGENTS.md", () => {
  const root = tmpDir("host");
  writeFile(root, "AGENTS.md", "# agents");
  const r = t.publishPack(root, [{ source: "AGENTS.md", dest: "AGENTS.md" }], {
    name: "p", version: "0.1.0",
    requires: { cortex_agent: ">=1.6.0" },
    signers: { mode: "disabled" },
    includes: [], excludes: [],
  });
  assert.strictEqual(r.ok, false);
  assert.match(r.skipped[0].reason, /host_entry_excluded/);
});

// ─── publish rejects absolute machine path ───────────────────────────────────
check("publish rejects /Users/<name>/... leak", () => {
  const root = tmpDir("abs");
  writeFile(root, "src/leak.md", "see /Users/alice/work/notes.md for details");
  const r = t.publishPack(root, [{ source: "src/leak.md", dest: "rules/leak.md" }], {
    name: "p", version: "0.1.0",
    requires: { cortex_agent: ">=1.6.0" },
    signers: { mode: "disabled" },
    includes: [], excludes: [],
  });
  assert.strictEqual(r.ok, false);
  assert.match(r.skipped[0].reason, /secret_or_path_scan/);
});

check("publish rejects source path traversal", () => {
  const root = tmpDir("source-traversal");
  const outside = path.join(root, "..", `${path.basename(root)}-outside.md`);
  fs.writeFileSync(outside, "# Outside");
  const r = t.publishPack(root, [{ source: `../${path.basename(outside)}`, dest: "rules/outside.md" }], {
    name: "p", version: "0.1.0",
    requires: { cortex_agent: ">=1.7.0" },
    signers: { mode: "disabled" },
    includes: [], excludes: [],
  });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.skipped[0].reason, "unsafe_source_path");
  fs.unlinkSync(outside);
});

check("publish rejects a symlinked destination ancestor", () => {
  const root = tmpDir("destination-symlink");
  const outside = tmpDir("destination-outside");
  writeFile(root, "src/rules/foo.md", "# Safe");
  fs.mkdirSync(path.join(root, ".agent-shared"), { recursive: true });
  fs.symlinkSync(outside, path.join(root, ".agent-shared/rules"));
  const r = t.publishPack(root, [{ source: "src/rules/foo.md", dest: "rules/foo.md" }], {
    name: "p", version: "0.1.0",
    requires: { cortex_agent: ">=1.7.0" },
    signers: { mode: "disabled" },
    includes: [], excludes: [],
  });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.skipped[0].reason, "destination_symlink_rejected");
  assert.strictEqual(fs.existsSync(path.join(outside, "foo.md")), false);
});

// ─── publish accepts safe content ───────────────────────────────────────────
check("publish accepts safe rule content", () => {
  const root = tmpDir("ok");
  writeFile(root, "src/rules/foo.md", "---\nname: foo\n---\n# Safe rule");
  const r = t.publishPack(root, [{ source: "src/rules/foo.md", dest: "rules/foo.md" }], {
    name: "ok", version: "0.1.0",
    requires: { cortex_agent: ">=1.6.0" },
    signers: { mode: "disabled" },
    includes: ["rules/**/*.md"], excludes: [],
  });
  assert.strictEqual(r.ok, true);
  assert.ok(r.applied.length === 1);
  // Manifest rebuilt
  const m = JSON.parse(fs.readFileSync(path.join(root, ".agent-shared/team-pack.json"), "utf8"));
  assert.strictEqual(m.files.length, 1);
  assert.strictEqual(m.files[0].path, "rules/foo.md");
});

check("publish dry-run validates without writing target or manifest", () => {
  const root = tmpDir("dry-run-zero-write");
  writeFile(root, "src/rules/planned.md", "# Planned\n");
  t.initSkeleton(root, "dry-run-pack");
  const manifestPath = path.join(root, ".agent-shared/team-pack.json");
  const beforeManifest = fs.readFileSync(manifestPath);

  const result = t.publishPack(
    root,
    [{ source: "src/rules/planned.md", dest: "rules/planned.md" }],
    { dryRun: true },
  );

  assert.strictEqual(result.ok, true);
  assert.strictEqual(fs.existsSync(path.join(root, ".agent-shared/rules/planned.md")), false);
  assert.deepStrictEqual(fs.readFileSync(manifestPath), beforeManifest);
});

// ─── verify-strict fails on tampered manifest ───────────────────────────────
check("verify-strict catches tampered manifest", () => {
  const root = tmpDir("tamper");
  writeFile(root, "src/rules/foo.md", "# Safe");
  const r = t.publishPack(root, [{ source: "src/rules/foo.md", dest: "rules/foo.md" }], {
    name: "tamper", version: "0.1.0",
    requires: { cortex_agent: ">=1.6.0" },
    signers: { mode: "disabled" },
    includes: ["rules/**/*.md"], excludes: [],
  });
  assert.strictEqual(r.ok, true);
  // Tamper manifest by changing declared hash to wrong value
  const manifestPath = path.join(root, ".agent-shared/team-pack.json");
  const m = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  m.files[0].sha256 = "0".repeat(64);
  fs.writeFileSync(manifestPath, JSON.stringify(m, null, 2));
  const loaded = t.loadPack(root);
  assert.strictEqual(loaded.ok, false);
  assert.strictEqual(loaded.reason, "manifest_validation_failed");
  assert.strictEqual(loaded.errors.some((error) => error.startsWith("hash mismatch:")), true);
});

// ─── signers: git_committers mode rejects when committer not in allowlist ──
check("signers rejects committer not in allowlist (when fallback=reject)", () => {
  const root = tmpDir("signer");
  // Init a git repo with a known committer email
  execSync("git init -q", { cwd: root });
  execSync("git config user.email test@example.com", { cwd: root });
  execSync("git config user.name Tester", { cwd: root });
  fs.writeFileSync(path.join(root, "README.md"), "# Test");
  execSync("git add -A && git -c commit.gpgsign=false commit -q -m initial", { cwd: root });

  writeFile(root, "src/rules/foo.md", "# Safe");
  const r = t.publishPack(root, [{ source: "src/rules/foo.md", dest: "rules/foo.md" }], {
    name: "s", version: "0.1.0",
    requires: { cortex_agent: ">=1.6.0" },
    signers: { mode: "git_committers", allowed_committers: ["someone-else@example.com"], fallback: "reject" },
    includes: ["rules/**/*.md"], excludes: [],
  });
  assert.strictEqual(r.ok, true);
  const loaded = t.loadPack(root);
  execSync("git add .agent-shared && git -c commit.gpgsign=false commit -q -m pack", { cwd: root });
  execSync("git config user.email someone-else@example.com", { cwd: root });
  fs.writeFileSync(path.join(root, "README.md"), "# Later unrelated change");
  execSync("git add README.md && git -c commit.gpgsign=false commit -q -m unrelated", { cwd: root });
  const verifyReport = t.verifyStrict(loaded.manifest, root);
  const sig = verifyReport.checks.find((c) => c.id === "manifest_signature");
  assert.strictEqual(sig.status, "fail");
  assert.match(sig.reason, /committer_not_allowed:test@example.com/);
});

if (failures > 0) { console.error(`\nFAIL: ${failures}`); process.exit(1); }
console.log(`\nPASS: publish/verify integration`);
