"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const spec = require("../../lib/design-package/spec");
const tokens = require("../../lib/design-package/tokens");
const render = require("../../lib/design-package/render");
const artifact = require("../../lib/design-package/artifact");
const zip = require("../../lib/design-package/zip");

// ─── Fixture: minimal compact Pixso DSL (SamHMI shape) ────────────────────────

function makeDsl() {
  return {
    stats: { source: { variableMap: 0, variableSetMap: 0, localStyleMap: 0 }, outputBytes: 1000 },
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
                id: "76:218",
                type: "TEXT",
                name: "摘要文本",
                box: { w: 130, h: 38, x: 64, y: 12 },
                text: { fontFamily: "Noto Sans SC", fontSize: 13, fontStyle: "Regular" },
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
      },
    ],
    refsIndex: {},
  };
}

// ─── spec ─────────────────────────────────────────────────────────────────────

test("spec: parseArgs handles CLI and direct forms", () => {
  const cli = spec.parseArgs(["design-package", "T1", "--from-pixso", "/x/a.json", "--zip"], "zh");
  assert.equal(cli.taskId, "T1");
  assert.equal(cli.fromPixso, "/x/a.json");
  assert.equal(cli.zip, true);
  assert.equal(cli.template, "samhmi-editor");
  assert.equal(cli.entry, "samhmi-editor.html");

  const direct = spec.parseArgs(["T2", "--from-pixso=/y/b.json", "--lang", "en", "--json"], "en");
  assert.equal(direct.taskId, "T2");
  assert.equal(direct.fromPixso, "/y/b.json");
  assert.equal(direct.lang, "en");
  assert.equal(direct.json, true);
});

test("spec: parseArgs defaults", () => {
  const o = spec.parseArgs(["T"], "zh");
  assert.equal(o.fromPixso, null);
  assert.equal(o.preview, false);
  assert.equal(o.outputDir, null);
});

test("spec: parseArgs resolves relative paths against provided cwd, not process.cwd()", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-dp-cwd-"));
  try {
    const o = spec.parseArgs(
      ["T", "--from-pixso", "dsl.json", "--output-dir", "out/pkg"],
      "zh",
      dir,
    );
    assert.equal(o.fromPixso, path.join(dir, "dsl.json"));
    assert.equal(o.outputDir, path.join(dir, "out", "pkg"));
    // Absolute paths pass through unchanged.
    const abs = spec.parseArgs(
      ["T", "--from-pixso=/abs/a.json", "--output-dir=/abs/out"],
      "zh",
      dir,
    );
    assert.equal(abs.fromPixso, "/abs/a.json");
    assert.equal(abs.outputDir, "/abs/out");
    // Equals (=) forms resolve relative to the same provided cwd too.
    const eq = spec.parseArgs(
      ["T", "--from-pixso=eq.json", "--output-dir=eq/out"],
      "zh",
      dir,
    );
    assert.equal(eq.fromPixso, path.join(dir, "eq.json"));
    assert.equal(eq.outputDir, path.join(dir, "eq", "out"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("spec: validateEntry rejects traversal and non-html", () => {
  assert.equal(spec.validateEntry("ok.html"), "ok.html");
  assert.throws(() => spec.validateEntry("../escape.html"), /plain filename/);
  assert.throws(() => spec.validateEntry("a/b.html"), /plain filename/);
  assert.throws(() => spec.validateEntry("no-ext"), /\.html/);
});

test("spec: validateLang / validateTemplate", () => {
  assert.equal(spec.validateLang("zh"), "zh");
  assert.equal(spec.validateLang("en"), "en");
  assert.throws(() => spec.validateLang("fr"), /zh\|en/);
  assert.equal(spec.validateTemplate("samhmi-editor"), "samhmi-editor");
  assert.throws(() => spec.validateTemplate("nope"), /unknown --template/);
});

test("spec: resolveOutputDir rejects traversal out of project", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-dp-spec-"));
  try {
    const inside = spec.resolveOutputDir(null, "T", cwd);
    assert.ok(inside.startsWith(cwd + path.sep + ".agent"));
    assert.throws(() => spec.resolveOutputDir(path.join(cwd, "..", "escape"), "T", cwd), /escapes project root/);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("spec: validateDsl + readDslFile", () => {
  const dsl = makeDsl();
  assert.equal(spec.validateDsl(dsl), dsl);
  assert.throws(() => spec.validateDsl({ roots: [] }), /non-empty "roots"/);
  assert.throws(() => spec.validateDsl(null), /non-empty "roots"/);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-dp-file-"));
  try {
    const file = path.join(dir, "dsl.json");
    fs.writeFileSync(file, JSON.stringify(dsl), "utf8");
    const loaded = spec.readDslFile(file);
    assert.equal(loaded.roots[0].id, "73:464");
    const bad = path.join(dir, "bad.json");
    fs.writeFileSync(bad, "{ nope", "utf8");
    assert.throws(() => spec.readDslFile(bad), /not valid JSON/);
    assert.throws(() => spec.readDslFile(path.join(dir, "missing.json")), /cannot read/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ─── tokens ───────────────────────────────────────────────────────────────────

test("tokens: rgbaToHex", () => {
  assert.equal(tokens.rgbaToHex("rgba(202,211,223,1)"), "#CAD3DF");
  assert.equal(tokens.rgbaToHex("rgb(255,255,255)"), "#FFFFFF");
  assert.equal(tokens.rgbaToHex("not-a-color"), null);
});

test("tokens: extractTokens collects colors + fonts", () => {
  const t = tokens.extractTokens(makeDsl());
  assert.ok(t.colors.includes("#CAD3DF")); // 202,211,223
  assert.ok(t.colors.includes("#FFFFFF"));
  assert.ok(t.colors.includes("#233041")); // 35,48,65
  assert.ok(t.fontFamilies.includes("Noto Sans SC"));
  assert.ok(t.fontSizes.includes(13));
});

test("tokens: rootCanvas / rootChildren / textLabels", () => {
  const dsl = makeDsl();
  const canvas = tokens.rootCanvas(dsl);
  assert.equal(canvas.w, 1920);
  assert.equal(canvas.h, 1080);
  const children = tokens.rootChildren(dsl);
  assert.equal(children.length, 1);
  assert.equal(children[0].name, "属性面板");
  const labels = tokens.textLabels(dsl);
  assert.ok(labels.some((l) => l.text.includes("名称 Text_1")));
});

test("tokens: buildBrandTokens includes semantic aliases", () => {
  const b = tokens.buildBrandTokens(makeDsl(), { lang: "zh" });
  assert.equal(b.semantic.accent, "#2F6DEB");
  assert.equal(b.semantic.ok, "#22A06B");
  assert.equal(b.canvas.w, 1920);
});

test("tokens: buildBrandSpec is deterministic and complete", () => {
  const dsl = makeDsl();
  const brief = { taskId: "SAMHMI", dsl };
  const t = tokens.buildBrandTokens(dsl, { lang: "zh" });
  const md = tokens.buildBrandSpec(brief, t, { lang: "zh", template: "samhmi-editor" });
  assert.ok(md.includes("SAMHMI"));
  assert.ok(md.includes("1920 × 1080"));
  assert.ok(md.includes("#CAD3DF"));
  assert.ok(md.includes("Noto Sans SC"));
  assert.ok(md.includes("#2F6DEB"));
  const md2 = tokens.buildBrandSpec(brief, t, { lang: "zh", template: "samhmi-editor" });
  assert.equal(md, md2);
});

// ─── render ───────────────────────────────────────────────────────────────────

test("render: buildHtml produces runnable SamHMI shell", () => {
  const dsl = makeDsl();
  const brief = { taskId: "SAMHMI", title: "标准模板控件详情", dsl };
  const html = render.buildHtml(brief, { lang: "zh" });
  assert.ok(html.includes("<!DOCTYPE html>"));
  assert.ok(html.includes("1920px"));
  assert.ok(html.includes("width:205px"));
  assert.ok(html.includes("width:468px"));
  assert.ok(html.includes("height:36px"));
  assert.ok(html.includes("height:52px"));
  assert.ok(html.includes("height:22px"));
  assert.ok(html.includes("Noto Sans SC"));
  assert.ok(html.includes("属性参数"));
  assert.ok(html.includes("#CAD3DF"));
  // Verified Pixso shell refs (91:3196 页面外壳)
  for (const ref of ["91:3196", "91:2834", "91:2835", "91:2836", "91:3065", "91:3064", "78:741"]) {
    assert.ok(html.includes(`data-od-ref="${ref}"`), `shell ref ${ref} present`);
  }
  // deterministic
  assert.equal(html, render.buildHtml(brief, { lang: "zh" }));
});

test("render: escapeHtml", () => {
  assert.equal(render.escapeHtml('<a b="c">'), "&lt;a b=&quot;c&quot;&gt;");
});

// ─── artifact ─────────────────────────────────────────────────────────────────

test("artifact: buildArtifact Open Design v1 shape", () => {
  const a = artifact.buildArtifact({
    taskId: "SAMHMI",
    title: "SamHMI 画面编辑器",
    entry: "samhmi-editor.html",
    renderer: "html",
    exports: ["html", "zip"],
    source: "pixso-dsl",
    designSystem: "default",
    template: "samhmi-editor",
    skills: [],
    license: null,
    pixsoDslDigest: "abc123",
    dslDigest: "abc123",
    sourceGuid: "73:464",
    outputDir: "/x/y",
  });
  assert.equal(a.version, 1);
  assert.equal(a.kind, "html");
  assert.equal(a.entry, "samhmi-editor.html");
  assert.equal(a.status, "complete");
  assert.deepEqual(a.exports, ["html", "zip"]);
  assert.equal(a.metadata.source, "pixso-dsl");
  assert.equal(a.metadata.template, "samhmi-editor");
  // Provenance contract: canonical pixsoDslDigest + retained dslDigest + sourceGuid.
  assert.equal(a.metadata.pixsoDslDigest, "abc123");
  assert.equal(a.metadata.dslDigest, "abc123");
  assert.equal(a.metadata.sourceGuid, "73:464");
  assert.ok(a.createdAt && a.updatedAt);
});

test("artifact: buildValidationContract includes guard assertion", () => {
  const vc = artifact.buildValidationContract({
    taskId: "SAMHMI",
    outputDir: "/x",
    entry: "samhmi-editor.html",
    formats: ["html", "zip"],
    template: "samhmi-editor",
    lang: "zh",
    source: "pixso-dsl",
    preview: true,
    previewRendered: false,
  });
  assert.equal(vc.workflow, "design-package");
  assert.ok(vc.assertions.some((a) => a.id === "output.traversal-guard"));
  assert.ok(vc.assertions.some((a) => a.id === "output.zip"));
  const preview = vc.assertions.find((a) => a.id === "output.preview");
  assert.equal(preview.status, "skipped");
});

// ─── zip ──────────────────────────────────────────────────────────────────────

test("zip: crc32 known vector", () => {
  // CRC-32 of "123456789" is 0xCBF43926.
  assert.equal(zip.crc32(Buffer.from("123456789", "ascii")), 0xcbf43926);
});

test("zip: buildZip produces valid STORE zip (PK signature + round-trip)", () => {
  const buf = zip.buildZip([
    { filename: "a.txt", data: "hello" },
    { filename: "b/b.txt", data: Buffer.from("world", "utf8") },
  ]);
  assert.equal(buf[0], 0x50); // P
  assert.equal(buf[1], 0x4b); // K
  assert.equal(buf[2], 0x03);
  assert.equal(buf[3], 0x04);
  // End-of-central-directory signature present
  assert.ok(buf.includes(Buffer.from([0x50, 0x4b, 0x05, 0x06])));
  // Deterministic
  const buf2 = zip.buildZip([
    { filename: "a.txt", data: "hello" },
    { filename: "b/b.txt", data: Buffer.from("world", "utf8") },
  ]);
  assert.deepEqual(buf, buf2);
});

test("zip: buildZipFromObject", () => {
  const buf = zip.buildZipFromObject({ "index.html": "<html></html>", "spec.md": "# hi" });
  assert.ok(buf.includes(Buffer.from("index.html")));
  assert.ok(buf.includes(Buffer.from("spec.md")));
});
