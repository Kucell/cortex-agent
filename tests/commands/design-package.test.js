"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { designPackageCommand, _internal } = require("../../lib/commands/design-package");

// Test-harness isolation: `designPackageCommand`'s fail() sets
// process.exitCode on exit-2 error paths. node:test treats a non-zero
// process exit as a file-level failure even when every test passes, so we
// snapshot the initial value once and restore it around every test.
const INITIAL_EXIT_CODE = process.exitCode;

test.beforeEach(() => {
  process.exitCode = INITIAL_EXIT_CODE;
});

test.afterEach(() => {
  process.exitCode = INITIAL_EXIT_CODE;
});

function makeTmpProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-dp-cli-"));
  fs.mkdirSync(path.join(dir, ".agent"), { recursive: true });
  return dir;
}

function makeDsl() {
  return {
    roots: [
      {
        id: "73:464",
        type: "COMPONENT_SET",
        name: "标准模板控件详情",
        box: { w: 1920, h: 1080 },
        fills: [{ type: "solid", value: "rgba(202,211,223,1)" }],
        children: [
          {
            id: "73:507",
            type: "COMPONENT_SET",
            name: "属性面板",
            box: { w: 468, h: 1080, x: 1452, y: 36 },
            fills: [{ type: "solid", value: "rgba(255,255,255,1)" }],
            children: [
              {
                id: "76:218_1_1",
                type: "SPAN",
                name: "SPAN",
                text: { content: "名称 Text_1 · 图层 1", fontFamily: "Noto Sans SC", fontSize: 13 },
                fills: [{ type: "solid", value: "rgba(35,48,65,1)" }],
              },
            ],
          },
        ],
      },
    ],
  };
}

function writeDsl(dir, name, dsl) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, JSON.stringify(dsl), "utf8");
  return file;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

// ─── E2E ──────────────────────────────────────────────────────────────────────

test("design-package: default build produces all artifacts", async () => {
  const dir = makeTmpProject();
  try {
    const dslFile = writeDsl(dir, "dsl.json", makeDsl());
    const code = await designPackageCommand({
      args: ["SAMHMI", "--from-pixso", dslFile],
      cwd: dir,
      lang: "zh",
    });
    assert.equal(code, 0);

    const pkg = path.join(dir, ".agent", "artifacts", "SAMHMI", "package");
    const htmlPath = path.join(pkg, "samhmi-editor.html");
    assert.ok(fs.existsSync(htmlPath));
    const html = fs.readFileSync(htmlPath, "utf8");
    assert.ok(html.includes("1920px"));
    assert.ok(html.includes("width:205px"));
    assert.ok(html.includes("width:468px"));
    assert.ok(html.includes("Noto Sans SC"));

    const specPath = path.join(pkg, "brand-spec.md");
    assert.ok(fs.existsSync(specPath));
    const md = fs.readFileSync(specPath, "utf8");
    assert.ok(md.includes("SAMHMI"));
    assert.ok(md.includes("1920 × 1080"));

    const artPath = path.join(pkg, "samhmi-editor.html.artifact.json");
    assert.ok(fs.existsSync(artPath));
    const art = readJson(artPath);
    assert.equal(art.version, 1);
    assert.equal(art.kind, "html");
    assert.equal(art.entry, "samhmi-editor.html");
    assert.equal(art.metadata.source, "pixso-dsl");
    // Provenance contract: pixsoDslDigest canonical + sourceGuid from DSL root.
    assert.match(art.metadata.pixsoDslDigest, /^[0-9a-f]{16}$/);
    assert.equal(art.metadata.dslDigest, art.metadata.pixsoDslDigest);
    assert.equal(art.metadata.sourceGuid, "73:464");

    const vcPath = path.join(pkg, "validation-contract.json");
    assert.ok(fs.existsSync(vcPath));
    const vc = readJson(vcPath);
    assert.equal(vc.workflow, "design-package");
    assert.ok(vc.assertions.some((a) => a.id === "output.traversal-guard"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("design-package: --zip produces STORE zip", async () => {
  const dir = makeTmpProject();
  try {
    const dslFile = writeDsl(dir, "dsl.json", makeDsl());
    const code = await designPackageCommand({
      args: ["SAMHMI", "--from-pixso", dslFile, "--zip"],
      cwd: dir,
      lang: "zh",
    });
    assert.equal(code, 0);
    const pkg = path.join(dir, ".agent", "artifacts", "SAMHMI", "package");
    const zipPath = path.join(pkg, "samhmi-editor.zip");
    assert.ok(fs.existsSync(zipPath));
    const buf = fs.readFileSync(zipPath);
    assert.equal(buf[0], 0x50);
    assert.equal(buf[1], 0x4b);
    assert.equal(buf[2], 0x03);
    assert.equal(buf[3], 0x04);
    const art = readJson(path.join(pkg, "samhmi-editor.html.artifact.json"));
    assert.ok(art.exports.includes("zip"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("design-package: --preview gracefully degrades", async () => {
  const dir = makeTmpProject();
  try {
    const dslFile = writeDsl(dir, "dsl.json", makeDsl());
    const code = await designPackageCommand({
      args: ["SAMHMI", "--from-pixso", dslFile, "--preview", "--json"],
      cwd: dir,
      lang: "zh",
    });
    assert.equal(code, 0);
    const vc = readJson(path.join(dir, ".agent", "artifacts", "SAMHMI", "package", "validation-contract.json"));
    const preview = vc.assertions.find((a) => a.id === "output.preview");
    assert.equal(preview.status, "skipped");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("design-package: --preview --json stdout is clean JSON (no warning prefix)", async () => {
  const dir = makeTmpProject();
  const originalLog = console.log;
  const captured = [];
  console.log = (...args) => captured.push(args.join(" "));
  try {
    const dslFile = writeDsl(dir, "dsl.json", makeDsl());
    const code = await designPackageCommand({
      args: ["SAMHMI", "--from-pixso", dslFile, "--preview", "--json"],
      cwd: dir,
      lang: "zh",
    });
    assert.equal(code, 0);
    const stdout = captured.join("\n");
    // Every captured line must be part of one JSON document (no ⚠ warning).
    assert.equal(captured.length, 1, "exactly one stdout line in JSON mode");
    assert.ok(!stdout.includes("⚠"), "no plain-text warning in JSON mode");
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.preview, "skipped");
  } finally {
    console.log = originalLog;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("design-package: relative --from-pixso resolves against command cwd", async () => {
  const dir = makeTmpProject();
  try {
    writeDsl(dir, "dsl.json", makeDsl());
    // Relative path, no leading ./ — must resolve against ctx.cwd, not process.cwd().
    const code = await designPackageCommand({
      args: ["SAMHMI", "--from-pixso", "dsl.json"],
      cwd: dir,
      lang: "zh",
    });
    assert.equal(code, 0);
    const pkg = path.join(dir, ".agent", "artifacts", "SAMHMI", "package");
    assert.ok(fs.existsSync(path.join(pkg, "samhmi-editor.html")));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("design-package: --entry override", async () => {
  const dir = makeTmpProject();
  try {
    const dslFile = writeDsl(dir, "dsl.json", makeDsl());
    const code = await designPackageCommand({
      args: ["SAMHMI", "--from-pixso", dslFile, "--entry", "hmi.html"],
      cwd: dir,
      lang: "zh",
    });
    assert.equal(code, 0);
    const pkg = path.join(dir, ".agent", "artifacts", "SAMHMI", "package");
    assert.ok(fs.existsSync(path.join(pkg, "hmi.html")));
    assert.ok(fs.existsSync(path.join(pkg, "hmi.html.artifact.json")));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("design-package: missing --from-pixso → exit 2", async () => {
  const dir = makeTmpProject();
  try {
    const code = await designPackageCommand({ args: ["SAMHMI"], cwd: dir, lang: "zh" });
    assert.equal(code, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("design-package: missing task id → exit 2", async () => {
  const dir = makeTmpProject();
  try {
    const code = await designPackageCommand({ args: [], cwd: dir, lang: "zh" });
    assert.equal(code, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("design-package: invalid DSL → exit 2", async () => {
  const dir = makeTmpProject();
  try {
    const bad = path.join(dir, "bad.json");
    fs.writeFileSync(bad, "{ nope", "utf8");
    const code = await designPackageCommand({
      args: ["SAMHMI", "--from-pixso", bad],
      cwd: dir,
      lang: "zh",
    });
    assert.equal(code, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("design-package: output traversal rejected → exit 2", async () => {
  const dir = makeTmpProject();
  try {
    const dslFile = writeDsl(dir, "dsl.json", makeDsl());
    const code = await designPackageCommand({
      args: ["SAMHMI", "--from-pixso", dslFile, "--output-dir", path.join(dir, "..", "escape")],
      cwd: dir,
      lang: "zh",
    });
    assert.equal(code, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("design-package: --system unknown → exit 2 (read-only advisory)", async () => {
  const dir = makeTmpProject();
  try {
    const dslFile = writeDsl(dir, "dsl.json", makeDsl());
    const code = await designPackageCommand({
      args: ["SAMHMI", "--from-pixso", dslFile, "--system", "nope"],
      cwd: dir,
      lang: "zh",
    });
    assert.equal(code, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("design-package: --template default works", async () => {
  const dir = makeTmpProject();
  try {
    const dslFile = writeDsl(dir, "dsl.json", makeDsl());
    const code = await designPackageCommand({
      args: ["SAMHMI", "--from-pixso", dslFile, "--template", "default"],
      cwd: dir,
      lang: "en",
    });
    assert.equal(code, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("design-package: dslDigest is deterministic", () => {
  const dsl = makeDsl();
  const d1 = _internal.dslDigest(dsl);
  const d2 = _internal.dslDigest(JSON.parse(JSON.stringify(dsl)));
  assert.equal(d1, d2);
  assert.match(d1, /^[0-9a-f]{16}$/);
});

test("design-package: verifySystem returns ok for installed", () => {
  const dir = makeTmpProject();
  try {
    fs.mkdirSync(path.join(dir, ".agent", "design-systems", "default"), { recursive: true });
    fs.writeFileSync(path.join(dir, ".agent", "design-systems", "default", "DESIGN.md"), "# default\n", "utf8");
    const check = _internal.verifySystem("default", dir);
    assert.equal(check.ok, true);
    const missing = _internal.verifySystem("zzz", dir);
    assert.equal(missing.ok, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
