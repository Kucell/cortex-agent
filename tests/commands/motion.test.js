"use strict";

// tests/commands/motion.test.js — `cortex-agent motion` CLI round-trip
// (P-005 MS-005)。通过 bin/cli.js 真实 spawn(既有 pattern,见
// tests/init/init-mode-infer.test.js),覆盖参数解析 + 每个子命令 + 错误处理。
// 外部进程(Chrome/FFmpeg/hyperframes)缺失时走优雅报错路径,不 fail。

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const CLI = path.join(__dirname, "..", "..", "bin", "cli.js");

function makeTmpProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-motion-cli-"));
  fs.mkdirSync(path.join(dir, ".agent"), { recursive: true });
  return dir;
}

function runCli(cwd, args) {
  return spawnSync(process.execPath, [CLI, "motion", ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, LANG: "en_US.UTF-8" },
    timeout: 30000,
  });
}

// ─── help / 错误处理 ────────────────────────────────────────────────────────

test("motion --help: prints usage, exit 0", () => {
  const r = runCli(process.cwd(), ["--help"]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /Usage: cortex-agent motion/);
  assert.match(r.stdout, /scaffold/);
  assert.match(r.stdout, /doctor/);
});

test("motion with no subcommand: exit 2 + help", () => {
  const r = runCli(process.cwd(), []);
  assert.equal(r.status, 2);
  assert.match(r.stdout, /Usage: cortex-agent motion/);
});

test("motion unknown-sub: exit 2 + help", () => {
  const r = runCli(process.cwd(), ["frobnicate"]);
  assert.equal(r.status, 2);
  assert.match(r.stdout, /Usage: cortex-agent motion/);
});

test("motion help lists all 10 subcommands", () => {
  const r = runCli(process.cwd(), ["--help"]);
  for (const sub of ["scaffold", "style-tokens", "lint", "check", "snapshot", "preview", "render", "verify", "presets", "doctor"]) {
    assert.match(r.stdout, new RegExp(sub), `subcommand ${sub} listed`);
  }
});

// ─── presets ────────────────────────────────────────────────────────────────

test("motion presets --json: exactly 8 presets", () => {
  const r = runCli(process.cwd(), ["presets", "--json"]);
  assert.equal(r.status, 0, r.stderr);
  const payload = JSON.parse(r.stdout);
  assert.equal(Object.keys(payload.presets).length, 8);
  assert.ok(payload.presets["fcp-4k"]);
  assert.ok(payload.presets["jianying-1080p"]);
  assert.ok(payload.presets["overlay-webm"]);
  assert.ok(payload.presets["overlay-mov"]);
});

test("motion presets --kind fcp: only ProRes mov presets", () => {
  const r = runCli(process.cwd(), ["presets", "--kind", "fcp"]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /fcp-1080p/);
  assert.match(r.stdout, /fcp-4k/);
  assert.doesNotMatch(r.stdout, /overlay-webm/);
});

test("motion presets --kind bogus: exit 2", () => {
  const r = runCli(process.cwd(), ["presets", "--kind", "bogus"]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /invalid --kind/);
});

// ─── doctor ─────────────────────────────────────────────────────────────────

test("motion doctor --json: deps + platform structure (exit 0|1)", () => {
  const r = runCli(process.cwd(), ["doctor", "--json"]);
  assert.ok(r.status === 0 || r.status === 1, `status ${r.status}: ${r.stderr}`);
  const payload = JSON.parse(r.stdout);
  assert.equal(typeof payload.ok, "boolean");
  for (const key of ["node", "chrome", "ffmpeg", "hyperframes", "openDesign"]) {
    assert.ok(payload.deps[key], `deps.${key} present`);
  }
  assert.equal(typeof payload.platform.id, "string");
  assert.ok(Array.isArray(payload.warnings));
});

// ─── scaffold ───────────────────────────────────────────────────────────────

test("motion scaffold: creates composition in tmp project", () => {
  const dir = makeTmpProject();
  const r = runCli(dir, ["scaffold", "--motion-id", "m-cli-1", "--template", "kobe-lite"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /composition scaffolded/);
  assert.ok(fs.existsSync(path.join(dir, ".agent", "motion", "m-cli-1", "index.html")));
  assert.ok(fs.existsSync(path.join(dir, ".agent", "motion", ".gitignore")));
  fs.rmSync(dir, { recursive: true, force: true });
});

test("motion scaffold: all 3 local starters work via CLI", () => {
  const dir = makeTmpProject();
  for (const t of ["kobe-lite", "saas-hero", "stat-counter"]) {
    const r = runCli(dir, ["scaffold", "--motion-id", `m-${t}`, "--template", t]);
    assert.equal(r.status, 0, `${t}: ${r.stderr}`);
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

test("motion scaffold: unknown template → exit 1 with starter list", () => {
  const dir = makeTmpProject();
  const r = runCli(dir, ["scaffold", "--motion-id", "m-cli-2", "--template", "nope"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /unknown template/);
  assert.match(r.stderr, /kobe-lite/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("motion scaffold: missing --motion-id → exit 2", () => {
  const r = runCli(process.cwd(), ["scaffold"]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--motion-id/);
});

// ─── style-tokens ───────────────────────────────────────────────────────────

test("motion style-tokens: compiles from design system, --json round-trip", () => {
  const dir = makeTmpProject();
  const ds = path.join(dir, ".agent", "design-systems", "acme");
  fs.mkdirSync(ds, { recursive: true });
  fs.writeFileSync(
    path.join(ds, "DESIGN.md"),
    [
      "# Acme",
      "",
      "## Color roles",
      "",
      "| Role | Hex | Usage |",
      "| --- | --- | --- |",
      "| Primary | `#ff6a00` | x |",
      "| Surface | `#0b0b0f` | bg |",
      "",
      "## Typography",
      "",
      "- **Heading**: Inter Display, weight 700",
      "- **Body**: Inter, weight 400",
      "",
      "## Motion and interaction",
      "",
      "- **Easing**: `power2.out`",
      "- **Duration**: 200ms / 400ms / 800ms",
      "",
      "## Anti-patterns",
      "",
      "- ❌ no default #333 / #3b82f6 / Roboto",
      "",
    ].join("\n"),
    "utf8",
  );
  const r = runCli(dir, ["style-tokens", "--motion-id", "m-cli-3", "--design-system", "acme", "--json"]);
  assert.equal(r.status, 0, r.stderr);
  const tokens = JSON.parse(r.stdout);
  assert.equal(tokens.version, "od-motion-tokens/v1");
  assert.equal(tokens.palette.primary, "#ff6a00");
  assert.equal(tokens.palette.bg, "#0b0b0f");
  assert.ok(tokens.anti_patterns.some((a) => a.includes("no default #333")));
  assert.ok(fs.existsSync(path.join(dir, ".agent", "motion", "style-tokens", "acme.json")));
  fs.rmSync(dir, { recursive: true, force: true });
});

// ─── render(用户门控)────────────────────────────────────────────────────────

test("motion render without --yes in non-TTY: blocked by approve gate, exit 2", () => {
  const dir = makeTmpProject();
  const comp = path.join(dir, ".agent", "motion", "m-cli-4");
  fs.mkdirSync(comp, { recursive: true });
  fs.writeFileSync(path.join(comp, "index.html"), "<html></html>", "utf8");
  const r = runCli(dir, ["render", "--motion-id", "m-cli-4", "--preset", "fcp-4k"]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /用户门控/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("motion render: unknown preset → exit 2", () => {
  const dir = makeTmpProject();
  const comp = path.join(dir, ".agent", "motion", "m-cli-5");
  fs.mkdirSync(comp, { recursive: true });
  fs.writeFileSync(path.join(comp, "index.html"), "<html></html>", "utf8");
  const r = runCli(dir, ["render", "--motion-id", "m-cli-5", "--preset", "bogus", "--yes"]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /unknown --preset/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("motion render: missing --preset → exit 2", () => {
  const r = runCli(process.cwd(), ["render", "--motion-id", "m-cli-6", "--yes"]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--preset/);
});

// ─── lint / verify / snapshot(外部缺失时优雅报错)──────────────────────────

test("motion lint: missing composition → exit 1 graceful error", () => {
  const dir = makeTmpProject();
  const r = runCli(dir, ["lint", "--motion-id", "m-nope"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /composition not found/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("motion check: missing composition → exit 1 graceful error", () => {
  const dir = makeTmpProject();
  const r = runCli(dir, ["check", "--motion-id", "m-nope"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /composition not found/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("motion verify: no render output → exit 1 graceful error", () => {
  const dir = makeTmpProject();
  const r = runCli(dir, ["verify", "--motion-id", "m-nope"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /no render output/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("motion snapshot: missing composition → exit 1 graceful error", () => {
  const dir = makeTmpProject();
  const r = runCli(dir, ["snapshot", "--motion-id", "m-nope"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /composition not found/);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ─── parseMotionArgs(单元级)────────────────────────────────────────────────

test("parseMotionArgs: strips motion prefix, parses sub + flags", () => {
  const { _internal } = require("../../lib/commands/motion");
  const opts = _internal.parseMotionArgs(["motion", "render", "--motion-id", "m-1", "--preset", "fcp-4k", "--yes"]);
  assert.equal(opts.sub, "render");
  assert.equal(opts.motionId, "m-1");
  assert.equal(opts.preset, "fcp-4k");
  assert.equal(opts.yes, true);
});

test("parseMotionArgs: inline --motion-id= and --kind= values", () => {
  const { _internal } = require("../../lib/commands/motion");
  const opts = _internal.parseMotionArgs(["presets", "--kind=webm", "--json"]);
  assert.equal(opts.sub, "presets");
  assert.equal(opts.kind, "webm");
  assert.equal(opts.json, true);
});

test("parseMotionArgs: invalid --port captured as portError", () => {
  const { _internal } = require("../../lib/commands/motion");
  const opts = _internal.parseMotionArgs(["preview", "--motion-id", "m-1", "--port", "abc"]);
  assert.match(opts.portError, /invalid --port/);
});
