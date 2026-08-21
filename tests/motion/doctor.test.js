"use strict";

// tests/motion/doctor.test.js — 依赖检测 (P-005 MS-005)。
// node / chrome / ffmpeg / hyperframes / open-design / 平台。注入 fake which/run,
// 不依赖真实外部环境。

const test = require("node:test");
const assert = require("node:assert/strict");

const doctor = require("../../lib/motion/doctor");

// ─── node ───────────────────────────────────────────────────────────────────

test("detectNode: current runtime passes >= 18", () => {
  const r = doctor.detectNode();
  assert.equal(r.ok, true);
  assert.ok(Number(r.version.split(".")[0]) >= 18);
});

test("detectNode: required field present", () => {
  const r = doctor.detectNode();
  assert.equal(r.required, ">= 18");
});

// ─── chrome ─────────────────────────────────────────────────────────────────

test("detectChrome: finds chrome on PATH via injected env", () => {
  const env = { PATH: "/usr/local/bin:/opt/chrome" };
  const which = (cmd, e) => (cmd === "google-chrome" ? "/opt/chrome/google-chrome" : null);
  const r = doctor.detectChrome(env, which);
  assert.equal(r.ok, true);
  assert.equal(r.path, "/opt/chrome/google-chrome");
});

test("detectChrome: missing → ok:false with hint", () => {
  const r = doctor.detectChrome({ PATH: "/nonexistent" }, null, []);
  assert.equal(r.ok, false);
  assert.match(r.hint, /install Google Chrome/);
});

// ─── platform ───────────────────────────────────────────────────────────────

test("platformInfo: darwin-arm64 supported", () => {
  const p = doctor.platformInfo();
  if (p.id === "darwin-arm64" || p.id === "darwin-x64" || p.id === "linux-x64") {
    assert.equal(p.supported, true);
  }
});

test("platformInfo: unsupported platform warns", () => {
  const p = doctor.platformInfo();
  assert.ok(Array.isArray(p.warnings));
  if (!p.supported) {
    assert.ok(p.warnings.some((w) => w.includes("不支持本地渲染")));
  }
});

// ─── firstLine ──────────────────────────────────────────────────────────────

test("firstLine: trims to first line", () => {
  assert.equal(doctor.firstLine("ffmpeg version 6.0\nCopyright..."), "ffmpeg version 6.0");
  assert.equal(doctor.firstLine(""), null);
});

// ─── runDoctor(全依赖注入)──────────────────────────────────────────────────

function allOkWhich(cmd, env) {
  const map = { ffmpeg: "/usr/bin/ffmpeg", npx: "/usr/bin/npx", "open-design": "/usr/local/bin/open-design" };
  return map[cmd] || null;
}

function allOkRun(cmd, args, opts) {
  const versions = {
    ffmpeg: "ffmpeg version 6.1.1",
    "npx --no-install hyperframes": "1.2.3",
  };
  const key = cmd === "npx" ? "npx --no-install hyperframes" : cmd;
  return Promise.resolve({ ok: true, stdout: versions[key] || "" });
}

test("runDoctor: all deps ok → ok:true with platform", async () => {
  const r = await doctor.runDoctor({
    which: allOkWhich,
    run: allOkRun,
    chromeDetect: () => ({ ok: true, path: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" }),
    env: { PATH: "/usr/bin:/usr/local/bin" },
  });
  assert.equal(r.ok, true);
  assert.equal(r.deps.node.ok, true);
  assert.equal(r.deps.chrome.ok, true);
  assert.equal(r.deps.ffmpeg.ok, true);
  assert.equal(r.deps.hyperframes.ok, true);
  assert.equal(r.deps.openDesign.ok, true);
  assert.equal(typeof r.platform.id, "string");
  assert.ok(Array.isArray(r.warnings));
});

test("runDoctor: ffmpeg missing → ok:false + install hint", async () => {
  const r = await doctor.runDoctor({
    which: (cmd) => (cmd === "ffmpeg" ? null : allOkWhich(cmd)),
    run: allOkRun,
    chromeDetect: () => ({ ok: true, path: "/x" }),
    env: { PATH: "/usr/bin" },
  });
  assert.equal(r.ok, false);
  assert.equal(r.deps.ffmpeg.ok, false);
  assert.match(r.deps.ffmpeg.hint, /brew install ffmpeg/);
});

test("runDoctor: hyperframes + daemon both missing → renderer warning", async () => {
  const r = await doctor.runDoctor({
    which: (cmd) => (cmd === "ffmpeg" ? "/usr/bin/ffmpeg" : null),
    run: allOkRun,
    chromeDetect: () => ({ ok: true, path: "/x" }),
    env: { PATH: "/usr/bin" },
  });
  assert.equal(r.ok, false);
  assert.ok(r.warnings.some((w) => w.includes("既没有 hyperframes 也没有 open-design daemon")));
});

test("runDoctor: CLAUDE_CODE=true → sandbox warning", async () => {
  const r = await doctor.runDoctor({
    which: allOkWhich,
    run: allOkRun,
    chromeDetect: () => ({ ok: true, path: "/x" }),
    env: { PATH: "/usr/bin", CLAUDE_CODE: "true" },
  });
  assert.ok(r.warnings.some((w) => w.includes("sandbox-exec 会挂起 Chrome")));
});

test("runDoctor: hyperframes version captured from run stdout", async () => {
  const r = await doctor.runDoctor({
    which: allOkWhich,
    run: allOkRun,
    chromeDetect: () => ({ ok: true, path: "/x" }),
    env: { PATH: "/usr/bin" },
  });
  assert.match(r.deps.hyperframes.version, /1\.2\.3/);
});
