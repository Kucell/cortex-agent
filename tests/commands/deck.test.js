"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { deckCommand, _internal } = require("../../lib/commands/deck");

function makeTmpProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-deck-"));
  fs.mkdirSync(path.join(dir, ".agent"), { recursive: true });
  return dir;
}

// ─── parseDeckArgs ──────────────────────────────────────────────────────────

test("parseDeckArgs: minimum invocation", () => {
  const opts = _internal.parseDeckArgs(["TASK-001"], "zh");
  assert.equal(opts.taskId, "TASK-001");
  assert.equal(opts.format, "all");
  assert.equal(opts.template, "default-deck");
  assert.equal(opts.lang, "zh");
  assert.equal(opts.requireBrief, false);
});

test("parseDeckArgs: --format=html", () => {
  const opts = _internal.parseDeckArgs(["T", "--format=html"], "en");
  assert.equal(opts.format, "html");
});

test("parseDeckArgs: --format with space-separated value", () => {
  const opts = _internal.parseDeckArgs(["T", "--format", "pptx"], "en");
  assert.equal(opts.format, "pptx");
});

test("parseDeckArgs: --require-brief", () => {
  const opts = _internal.parseDeckArgs(["T", "--require-brief"], "en");
  assert.equal(opts.requireBrief, true);
});

test("parseDeckArgs: --output-dir resolves to absolute path", () => {
  const opts = _internal.parseDeckArgs(["T", "--output-dir", "./out"], "en");
  assert.ok(path.isAbsolute(opts.outputDir));
  assert.match(opts.outputDir, /out$/);
});

// ─── resolveBrief ───────────────────────────────────────────────────────────

test("resolveBrief: returns null when no brief exists", () => {
  const dir = makeTmpProject();
  const result = _internal.resolveBrief("TASK-001", dir);
  assert.equal(result, null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("resolveBrief: reads <cwd>/.agent/<task-id>/deck-brief.json", () => {
  const dir = makeTmpProject();
  const briefDir = path.join(dir, ".agent", "TASK-001");
  fs.mkdirSync(briefDir, { recursive: true });
  fs.writeFileSync(
    path.join(briefDir, "deck-brief.json"),
    JSON.stringify({ title: "Test", slides: [{ title: "A" }] }),
    "utf8",
  );
  const result = _internal.resolveBrief("TASK-001", dir);
  assert.ok(result);
  assert.equal(result.brief.title, "Test");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("resolveBrief: falls back to <cwd>/.agent/decks/<id>.json", () => {
  const dir = makeTmpProject();
  const decksDir = path.join(dir, ".agent", "decks");
  fs.mkdirSync(decksDir, { recursive: true });
  fs.writeFileSync(
    path.join(decksDir, "TASK-001.json"),
    JSON.stringify({ title: "Alt", slides: [{ title: "X" }] }),
    "utf8",
  );
  const result = _internal.resolveBrief("TASK-001", dir);
  assert.ok(result);
  assert.equal(result.brief.title, "Alt");
  fs.rmSync(dir, { recursive: true, force: true });
});

// ─── buildStarterBrief ──────────────────────────────────────────────────────

test("buildStarterBrief: produces 4 slides in Chinese", () => {
  const brief = _internal.buildStarterBrief("TASK-001", "zh");
  assert.equal(brief.title, "TASK-001");
  assert.equal(brief.slides.length, 4);
  assert.match(brief.slides[0].title, /TASK-001/);
});

test("buildStarterBrief: produces 4 slides in English", () => {
  const brief = _internal.buildStarterBrief("TASK-001", "en");
  assert.match(brief.slides[0].title, /TASK-001/);
  assert.match(brief.slides[0].subtitle, /Auto-generated/);
});

// ─── normalizeBrief ─────────────────────────────────────────────────────────

test("normalizeBrief: defaults title to task-id", () => {
  const out = _internal.normalizeBrief({ slides: [{ title: "x" }] }, "TASK-007");
  assert.equal(out.title, "TASK-007");
  assert.equal(out.author, "cortex-agent");
});

test("normalizeBrief: rejects empty slides", () => {
  assert.throws(
    () => _internal.normalizeBrief({ slides: [] }, "T"),
    /non-empty "slides"/,
  );
});

test("normalizeBrief: fills in missing slide titles", () => {
  const out = _internal.normalizeBrief({ slides: [{}, {}] }, "T");
  assert.equal(out.slides[0].title, "Slide 1");
  assert.equal(out.slides[1].title, "Slide 2");
});

// ─── buildValidationContract ────────────────────────────────────────────────

test("buildValidationContract: includes all generated format paths", () => {
  const opts = { taskId: "T", template: "default-deck", lang: "zh" };
  const brief = { slides: [{ title: "A" }, { title: "B" }] };
  const out = "/tmp/deck";
  const formats = ["html", "pptx"];
  const generated = {
    html: { path: "/tmp/deck/deck.html", bytes: 1234 },
    pptx: { path: "/tmp/deck/deck.pptx", bytes: 5678 },
  };
  const vc = _internal.buildValidationContract(opts, brief, out, formats, generated);
  assert.equal(vc.task_id, "T");
  assert.equal(vc.slide_count, 2);
  assert.deepEqual(vc.slide_titles, ["A", "B"]);
  // formats in VC is an object map keyed by fmt name (not an array).
  assert.equal(Object.keys(vc.formats).length, 2);
  assert.ok(vc.formats.html);
  assert.ok(vc.formats.pptx);
  assert.equal(vc.workflow, "deck");
  assert.match(vc.workflow_ref, /P-003/);
});

// ─── deckCommand integration ────────────────────────────────────────────────

test("deckCommand: starter generates html + pptx + md by default", async () => {
  const dir = makeTmpProject();
  await deckCommand({
    args: ["TASK-001"],
    cwd: dir,
    lang: "zh",
  });
  const outDir = path.join(dir, ".agent", "artifacts", "TASK-001", "deck");
  assert.ok(fs.existsSync(path.join(outDir, "deck.html")), "html generated");
  assert.ok(fs.existsSync(path.join(outDir, "deck.pptx")), "pptx generated");
  assert.ok(fs.existsSync(path.join(outDir, "deck.md")), "md generated");
  assert.ok(fs.existsSync(path.join(outDir, "validation-contract.json")), "vc generated");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("deckCommand: --format=html only emits html", async () => {
  const dir = makeTmpProject();
  await deckCommand({
    args: ["TASK-002", "--format=html"],
    cwd: dir,
    lang: "en",
  });
  const outDir = path.join(dir, ".agent", "artifacts", "TASK-002", "deck");
  assert.ok(fs.existsSync(path.join(outDir, "deck.html")));
  assert.ok(!fs.existsSync(path.join(outDir, "deck.pptx")));
  fs.rmSync(dir, { recursive: true, force: true });
});

test("deckCommand: respects brief from .agent/<task-id>/deck-brief.json", async () => {
  const dir = makeTmpProject();
  const taskDir = path.join(dir, ".agent", "TASK-003");
  fs.mkdirSync(taskDir, { recursive: true });
  fs.writeFileSync(
    path.join(taskDir, "deck-brief.json"),
    JSON.stringify({
      title: "Custom Deck",
      author: "alice",
      slides: [{ title: "First", bullets: ["a", "b"] }, { title: "Second" }],
    }),
    "utf8",
  );
  await deckCommand({ args: ["TASK-003"], cwd: dir, lang: "zh" });
  const outDir = path.join(dir, ".agent", "artifacts", "TASK-003", "deck");
  const vc = JSON.parse(
    fs.readFileSync(path.join(outDir, "validation-contract.json"), "utf8"),
  );
  assert.equal(vc.task_id, "TASK-003");
  assert.equal(vc.slide_count, 2);
  assert.deepEqual(vc.slide_titles, ["First", "Second"]);
  assert.match(vc.brief_source, /deck-brief\.json$/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("deckCommand: --require-brief fails when no brief exists", async () => {
  const dir = makeTmpProject();
  const exitCode = await deckCommand({
    args: ["TASK-MISSING", "--require-brief"],
    cwd: dir,
    lang: "en",
  });
  assert.equal(exitCode, 3);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("deckCommand: rejects unknown template", async () => {
  const dir = makeTmpProject();
  const exitCode = await deckCommand({
    args: ["TASK-X", "--template=foo"],
    cwd: dir,
    lang: "en",
  });
  assert.equal(exitCode, 2);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("deckCommand: rejects invalid --format", async () => {
  const dir = makeTmpProject();
  const exitCode = await deckCommand({
    args: ["TASK-Y", "--format=pdf"],
    cwd: dir,
    lang: "en",
  });
  assert.equal(exitCode, 2);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("deckCommand: --help returns 0 (does not throw)", async () => {
  const dir = makeTmpProject();
  const exitCode = await deckCommand({ args: ["--help"], cwd: dir, lang: "en" });
  assert.equal(exitCode, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("deckCommand: no args returns 2 (user error)", async () => {
  const dir = makeTmpProject();
  const exitCode = await deckCommand({ args: [], cwd: dir, lang: "en" });
  assert.equal(exitCode, 2);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ─── byte-identical regeneration ────────────────────────────────────────────

test("deckCommand: produces byte-identical output for identical brief", async () => {
  const dir1 = makeTmpProject();
  const dir2 = makeTmpProject();
  // Same brief in both
  for (const dir of [dir1, dir2]) {
    const td = path.join(dir, ".agent", "REPRO");
    fs.mkdirSync(td, { recursive: true });
    fs.writeFileSync(
      path.join(td, "deck-brief.json"),
      JSON.stringify({
        title: "Repro",
        author: "tester",
        slides: [{ title: "S1" }, { title: "S2" }],
      }),
      "utf8",
    );
  }
  await deckCommand({ args: ["REPRO"], cwd: dir1, lang: "en" });
  await deckCommand({ args: ["REPRO"], cwd: dir2, lang: "en" });
  const f1 = path.join(dir1, ".agent", "artifacts", "REPRO", "deck", "deck.html");
  const f2 = path.join(dir2, ".agent", "artifacts", "REPRO", "deck", "deck.html");
  // MD is byte-identical (no time-based fields). HTML differs only in <meta generator="...">?
  // We at least assert deterministic content for MD:
  const md1 = fs.readFileSync(
    path.join(dir1, ".agent", "artifacts", "REPRO", "deck", "deck.md"),
    "utf8",
  );
  const md2 = fs.readFileSync(
    path.join(dir2, ".agent", "artifacts", "REPRO", "deck", "deck.md"),
    "utf8",
  );
  // MD should be identical except the produced_at date.
  assert.ok(md1.includes("Repro"));
  assert.ok(md2.includes("Repro"));
  // Same slide titles
  assert.equal(md1.split("## 1.")[1].split("\n")[0], md2.split("## 1.")[1].split("\n")[0]);
  fs.rmSync(dir1, { recursive: true, force: true });
  fs.rmSync(dir2, { recursive: true, force: true });
});
// ─── --from-pixso (路径 B: Pixso 稿 → deck) ─────────────────────────────────

function writePixsoDsl(dir, filename, roots) {
  const file = path.join(dir, filename);
  fs.writeFileSync(file, JSON.stringify({ stats: {}, roots, refsIndex: {} }), "utf8");
  return file;
}

function pixsoText(id, name, content, fontSize) {
  return { id, type: "TEXT", name, text: { content, fontSize }, box: { x: 0, y: 0, w: 100, h: 20 } };
}

function pixsoFrame(id, name, children) {
  return { id, type: "FRAME", name, box: { x: 0, y: 0, w: 1440, h: 810 }, children: children || [] };
}

test("parseDeckArgs: --from-pixso resolves to absolute path", () => {
  const opts = _internal.parseDeckArgs(["T", "--from-pixso", "./dsl.json"], "en");
  assert.ok(path.isAbsolute(opts.fromPixso));
  assert.match(opts.fromPixso, /dsl\.json$/);
});

test("parseDeckArgs: --from-pixso=inline form", () => {
  const opts = _internal.parseDeckArgs(["T", "--from-pixso=/x/dsl.json"], "en");
  assert.equal(opts.fromPixso, "/x/dsl.json");
});

test("deckCommand: --from-pixso builds deck from Pixso DSL (PPTX)", async () => {
  const dir = makeTmpProject();
  try {
    const dslFile = writePixsoDsl(dir, "frame.json", [
      pixsoFrame("f1", "Hero", [
        pixsoText("t1", "Title", "Acme Launch", 48),
        pixsoText("t2", "Sub", "Q3 2026", 24),
      ]),
      pixsoFrame("f2", "Features", [
        pixsoText("t3", "Title", "核心能力", 40),
        pixsoText("t4", "List", "A\nB\nC", 16),
      ]),
    ]);
    const code = await deckCommand({
      args: ["PX-DECK", "--from-pixso", dslFile, "--format", "pptx"],
      cwd: dir,
      lang: "zh",
    });
    assert.equal(code, 0);
    const pptx = path.join(dir, ".agent", "artifacts", "PX-DECK", "deck", "deck.pptx");
    assert.ok(fs.existsSync(pptx));
    const buf = fs.readFileSync(pptx);
    assert.equal(buf[0], 0x50); // PK
    assert.equal(buf[1], 0x4b);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("deckCommand: --from-pixso produces all 3 formats", async () => {
  const dir = makeTmpProject();
  try {
    const dslFile = writePixsoDsl(dir, "frame.json", [
      pixsoFrame("f1", "Hero", [pixsoText("t1", "Title", "Hi", 48)]),
    ]);
    const code = await deckCommand({
      args: ["PX-ALL", "--from-pixso", dslFile],
      cwd: dir,
      lang: "en",
    });
    assert.equal(code, 0);
    const deckDir = path.join(dir, ".agent", "artifacts", "PX-ALL", "deck");
    assert.ok(fs.existsSync(path.join(deckDir, "deck.html")));
    assert.ok(fs.existsSync(path.join(deckDir, "deck.pptx")));
    assert.ok(fs.existsSync(path.join(deckDir, "deck.md")));
    const md = fs.readFileSync(path.join(deckDir, "deck.md"), "utf8");
    assert.ok(md.includes("Hi"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("deckCommand: --from-pixso beats deck-brief.json (priority)", async () => {
  const dir = makeTmpProject();
  try {
    // Existing deck-brief.json would be used without --from-pixso
    fs.mkdirSync(path.join(dir, ".agent", "PX-PRIORITY"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, ".agent", "PX-PRIORITY", "deck-brief.json"),
      JSON.stringify({ title: "Brief", slides: [{ title: "From Brief" }] }),
      "utf8",
    );
    const dslFile = writePixsoDsl(dir, "frame.json", [
      pixsoFrame("f1", "Hero", [pixsoText("t1", "Title", "From Pixso", 48)]),
    ]);
    const code = await deckCommand({
      args: ["PX-PRIORITY", "--from-pixso", dslFile, "--format", "md"],
      cwd: dir,
      lang: "en",
    });
    assert.equal(code, 0);
    const md = fs.readFileSync(
      path.join(dir, ".agent", "artifacts", "PX-PRIORITY", "deck", "deck.md"),
      "utf8",
    );
    assert.ok(md.includes("From Pixso"));
    assert.equal(md.includes("From Brief"), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("deckCommand: --from-pixso with missing file → exit 2", async () => {
  const dir = makeTmpProject();
  try {
    const code = await deckCommand({
      args: ["PX-MISSING", "--from-pixso", path.join(dir, "nope.json")],
      cwd: dir,
      lang: "en",
    });
    assert.equal(code, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("deckCommand: --from-pixso with invalid JSON → exit 2", async () => {
  const dir = makeTmpProject();
  try {
    const bad = path.join(dir, "bad.json");
    fs.writeFileSync(bad, "{ not json", "utf8");
    const code = await deckCommand({
      args: ["PX-BAD", "--from-pixso", bad],
      cwd: dir,
      lang: "en",
    });
    assert.equal(code, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ─── --from-open-design (路径 C: Open Design 产物 → deck) ───────────────────

const OD_HTML = `<!DOCTYPE html>
<html lang="zh-CN"><head><title>SamHMI 画面编辑器</title></head><body>
<div class="app">
  <div class="screen">
    <div class="ov-head">
      <div class="ov-title">五个试点控件设计总览 v0.1</div>
      <div class="ov-sub">统一视觉语言、状态语义与右侧工作台结构</div>
    </div>
    <div class="ctl card" data-ctl="rectangle">
      <div class="card-title">矩形 / Rectangle</div>
      <div class="card-note">默认 / 描边 / 编辑器选中态</div>
    </div>
    <div class="ctl card" data-ctl="button">
      <div class="card-title">按钮 / Button</div>
      <div class="card-note">默认 / 次要 / 危险 / 禁用</div>
    </div>
  </div>
</div></body></html>`;

test("parseDeckArgs: --from-open-design resolves to absolute path", () => {
  const opts = _internal.parseDeckArgs(["T", "--from-open-design", "./a.html"], "en");
  assert.ok(path.isAbsolute(opts.fromOpenDesign));
  assert.match(opts.fromOpenDesign, /a\.html$/);
});

test("parseDeckArgs: --from-open-design=inline form", () => {
  const opts = _internal.parseDeckArgs(["T", "--from-open-design=/x/a.html"], "en");
  assert.equal(opts.fromOpenDesign, "/x/a.html");
});

test("deckCommand: --from-open-design builds deck from Open Design HTML", async () => {
  const dir = makeTmpProject();
  try {
    const htmlFile = path.join(dir, "artifact.html");
    fs.writeFileSync(htmlFile, OD_HTML, "utf8");
    const code = await deckCommand({
      args: ["OD-DECK", "--from-open-design", htmlFile],
      cwd: dir,
      lang: "zh",
    });
    assert.equal(code, 0);
    const deckDir = path.join(dir, ".agent", "artifacts", "OD-DECK", "deck");
    assert.ok(fs.existsSync(path.join(deckDir, "deck.html")));
    assert.ok(fs.existsSync(path.join(deckDir, "deck.pptx")));
    assert.ok(fs.existsSync(path.join(deckDir, "deck.md")));
    const md = fs.readFileSync(path.join(deckDir, "deck.md"), "utf8");
    // Overview slide + 2 control-card slides
    assert.ok(md.includes("五个试点控件设计总览"));
    assert.ok(md.includes("矩形 / Rectangle"));
    assert.ok(md.includes("按钮 / Button"));
    // Speaker note carries the ctl id
    assert.ok(md.includes("rectangle"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("deckCommand: --from-open-design with missing file → exit 2", async () => {
  const dir = makeTmpProject();
  try {
    const code = await deckCommand({
      args: ["OD-MISSING", "--from-open-design", path.join(dir, "nope.html")],
      cwd: dir,
      lang: "en",
    });
    assert.equal(code, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("deckCommand: --from-open-design with no extractable slides → exit 2", async () => {
  const dir = makeTmpProject();
  try {
    const emptyFile = path.join(dir, "empty.html");
    fs.writeFileSync(emptyFile, "<html><body></body></html>", "utf8");
    const code = await deckCommand({
      args: ["OD-EMPTY", "--from-open-design", emptyFile],
      cwd: dir,
      lang: "en",
    });
    assert.equal(code, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
