"use strict";

// tests/motion/scaffold.test.js — `motion scaffold` 脚手架 (P-005 MS-005)。
// 验证:产物文件 / .gitignore 隐藏 .hyperframes-cache / 锁定文件只编辑 index.html /
// 模板校验 / npx 缺失优雅报错。纯单元测试(不 spawn 外部进程)。

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const scaffold = require("../../lib/motion/scaffold");
const { _internal } = scaffold;

// 用仓库真实 starter 模板(同时验证 shipped 模板结构)。
const REAL_TEMPLATE_DIR = path.join(__dirname, "..", "..", "templates", "_shared", ".agent", "motion");

function makeTmpProject() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cortex-motion-scaffold-"));
}

test("LOCAL_STARTERS: kobe-lite / saas-hero / stat-counter", () => {
  assert.deepEqual([...scaffold.LOCAL_STARTERS].sort(), ["kobe-lite", "saas-hero", "stat-counter"]);
});

test("GITIGNORE_CONTENT: hides .hyperframes-cache/", () => {
  assert.match(scaffold.GITIGNORE_CONTENT, /\.hyperframes-cache\//);
});

test("isSlug: valid motion ids only", () => {
  assert.equal(scaffold.isSlug("m-001"), true);
  assert.equal(scaffold.isSlug("hero_v2"), false);
  assert.equal(scaffold.isSlug("UPPER"), false);
  assert.equal(scaffold.isSlug(""), false);
});

// ─── scaffoldComposition 产物 ────────────────────────────────────────────────

test("scaffoldComposition: produces index.html + hyperframes.json + meta.json + DESIGN.md + brief.md", () => {
  const dir = makeTmpProject();
  const result = scaffold.scaffoldComposition({ cwd: dir, motionId: "m-001", template: "kobe-lite", templateDir: REAL_TEMPLATE_DIR });
  assert.ok(result.compositionDir.endsWith(path.join(".agent", "motion", "m-001")));
  for (const f of ["index.html", "hyperframes.json", "meta.json", "DESIGN.md", "brief.md"]) {
    assert.ok(fs.existsSync(path.join(result.compositionDir, f)), `${f} scaffolded`);
  }
  // index.html 含 GSAP timeline 契约
  const html = fs.readFileSync(path.join(result.compositionDir, "index.html"), "utf8");
  assert.match(html, /gsap/);
  assert.match(html, /window\.__timelines\["main"\]/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("scaffoldComposition: writes .agent/motion/.gitignore with .hyperframes-cache/", () => {
  const dir = makeTmpProject();
  const result = scaffold.scaffoldComposition({ cwd: dir, motionId: "m-002", template: "saas-hero", templateDir: REAL_TEMPLATE_DIR });
  assert.ok(fs.existsSync(result.gitignore));
  const content = fs.readFileSync(result.gitignore, "utf8");
  assert.match(content, /\.hyperframes-cache\//);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("scaffoldComposition: only index.html editable — others locked in editPolicy", () => {
  const dir = makeTmpProject();
  const result = scaffold.scaffoldComposition({ cwd: dir, motionId: "m-003", template: "stat-counter", templateDir: REAL_TEMPLATE_DIR });
  const contract = JSON.parse(fs.readFileSync(path.join(result.compositionDir, "hyperframes.json"), "utf8"));
  assert.deepEqual(contract.editPolicy.editable, ["index.html"]);
  for (const locked of contract.editPolicy.locked) {
    assert.ok(fs.existsSync(path.join(result.compositionDir, locked)), `${locked} exists and locked`);
  }
  // brief.md / DESIGN.md 是系统生成(锁定),内容可溯源到模板
  const brief = fs.readFileSync(path.join(result.compositionDir, "brief.md"), "utf8");
  assert.match(brief, /stat-counter/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("scaffoldComposition: --style compiles style tokens into .agent/motion/style-tokens/", () => {
  const dir = makeTmpProject();
  const ds = path.join(dir, ".agent", "design-systems", "acme");
  fs.mkdirSync(ds, { recursive: true });
  fs.writeFileSync(
    path.join(ds, "DESIGN.md"),
    "# Acme\n\n## Color roles\n\n| Role | Hex | Usage |\n|---|---|---|\n| Primary | `#ff6a00` | x |\n| Surface | `#0b0b0f` | bg |\n",
    "utf8",
  );
  const result = scaffold.scaffoldComposition({ cwd: dir, motionId: "m-004", template: "kobe-lite", style: "acme", templateDir: REAL_TEMPLATE_DIR });
  assert.ok(result.tokens);
  assert.equal(result.tokens.palette.primary, "#ff6a00");
  const tokensFile = path.join(dir, ".agent", "motion", "style-tokens", "acme.json");
  assert.ok(fs.existsSync(tokensFile));
  fs.rmSync(dir, { recursive: true, force: true });
});

test("scaffoldComposition: invalid motion id → throws", () => {
  const dir = makeTmpProject();
  assert.throws(
    () => scaffold.scaffoldComposition({ cwd: dir, motionId: "Bad ID!", template: "kobe-lite", templateDir: REAL_TEMPLATE_DIR }),
    /invalid --motion-id/,
  );
  fs.rmSync(dir, { recursive: true, force: true });
});

test("scaffoldComposition: unknown template → throws with starter list", () => {
  const dir = makeTmpProject();
  assert.throws(
    () => scaffold.scaffoldComposition({ cwd: dir, motionId: "m-005", template: "nope", templateDir: REAL_TEMPLATE_DIR }),
    /unknown template "nope"/,
  );
  fs.rmSync(dir, { recursive: true, force: true });
});

test("scaffoldComposition: existing composition → throws (no overwrite)", () => {
  const dir = makeTmpProject();
  const comp = path.join(dir, ".agent", "motion", "m-006");
  fs.mkdirSync(comp, { recursive: true });
  assert.throws(
    () => scaffold.scaffoldComposition({ cwd: dir, motionId: "m-006", template: "kobe-lite", templateDir: REAL_TEMPLATE_DIR }),
    /already exists/,
  );
  fs.rmSync(dir, { recursive: true, force: true });
});

test("scaffoldComposition: all 3 starters scaffold cleanly", () => {
  const dir = makeTmpProject();
  for (const t of scaffold.LOCAL_STARTERS) {
    const result = scaffold.scaffoldComposition({ cwd: dir, motionId: `m-${t}`, template: t, templateDir: REAL_TEMPLATE_DIR });
    assert.ok(fs.existsSync(path.join(result.compositionDir, "index.html")));
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

// ─── npx 委托(路径 B)────────────────────────────────────────────────────────

test("runHyperframesScaffold: npx missing → graceful NPX_MISSING error", async () => {
  const dir = makeTmpProject();
  const result = await scaffold.runHyperframesScaffold({
    cwd: dir,
    motionId: "m-007",
    template: "charts",
    env: { PATH: "/nonexistent" },
    wait: true,
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, "NPX_MISSING");
  assert.match(result.message, /npx 不在 PATH/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("runHyperframesScaffold: spawns npx hyperframes scaffold with template arg", async () => {
  const dir = makeTmpProject();
  const { EventEmitter } = require("node:events");
  const spawned = [];
  const fakeSpawn = (cmd, args) => {
    spawned.push({ cmd, args });
    const child = new EventEmitter();
    setImmediate(() => child.emit("exit", 0));
    return child;
  };
  const result = await scaffold.runHyperframesScaffold({
    cwd: dir,
    motionId: "m-007",
    template: "charts",
    env: { PATH: `/tmp:${process.env.PATH}` },
    spawnFn: fakeSpawn,
  });
  assert.equal(result.ok, true);
  assert.equal(path.basename(spawned[0].cmd), "npx");
  assert.deepEqual(spawned[0].args, ["hyperframes", "scaffold", "m-007", "--template", "charts"]);
  fs.rmSync(dir, { recursive: true, force: true });
});
