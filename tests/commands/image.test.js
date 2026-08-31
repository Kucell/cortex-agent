"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { imageCommand, _internal } = require("../../lib/commands/image");

function makeTmpProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-image-"));
  fs.mkdirSync(path.join(dir, ".agent"), { recursive: true });
  return dir;
}

// Reset process.exitCode so an earlier test that intentionally triggers exit 2
// does not leak into the file-level runner.
test.beforeEach(() => {
  process.exitCode = 0;
});
test.after(() => {
  process.exitCode = 0;
});

// ─── parseImageArgs ──────────────────────────────────────────────────────────

test("parseImageArgs: minimum invocation", () => {
  const opts = _internal.parseImageArgs(["IMG-001"], "zh");
  assert.equal(opts.taskId, "IMG-001");
  assert.equal(opts.prompt, null);
  assert.equal(opts.model, "gpt-image-2");
  assert.equal(opts.aspect, "1:1");
  assert.equal(opts.count, 1);
});

test("parseImageArgs: --prompt=<text>", () => {
  const opts = _internal.parseImageArgs(["T", "--prompt=A red cat"], "en");
  assert.equal(opts.prompt, "A red cat");
});

test("parseImageArgs: --model seedream-5.0", () => {
  const opts = _internal.parseImageArgs(["T", "--model=seedream-5.0"], "en");
  assert.equal(opts.model, "seedream-5.0");
});

test("parseImageArgs: --aspect=16:9", () => {
  const opts = _internal.parseImageArgs(["T", "--aspect=16:9"], "en");
  assert.equal(opts.aspect, "16:9");
});

test("parseImageArgs: --count=3", () => {
  const opts = _internal.parseImageArgs(["T", "--count", "3"], "en");
  assert.equal(opts.count, 3);
});

test("parseImageArgs: --output-dir resolves to absolute path", () => {
  const opts = _internal.parseImageArgs(["T", "--output-dir", "./out"], "en");
  assert.ok(path.isAbsolute(opts.outputDir));
  assert.match(opts.outputDir, /out$/);
});

// ─── modelProvider ───────────────────────────────────────────────────────────

test("modelProvider: maps model id to BYOK provider id", () => {
  assert.equal(_internal.modelProvider("gpt-image-2"), "openai");
  assert.equal(_internal.modelProvider("seedream-5.0"), "seedream");
  assert.equal(_internal.modelProvider("nano-banana-2.0"), "nano_banana");
  assert.equal(_internal.modelProvider("nope"), null);
});

// ─── buildManifest ───────────────────────────────────────────────────────────

test("buildManifest: schema od-image/v1, includes byok.keyRef", () => {
  const opts = _internal.parseImageArgs(["T", "--prompt=hi"], "en");
  const m = _internal.buildManifest(opts, { present: false, keyRef: null, provider: "openai", configPath: "/x", reason: "missing" });
  assert.equal(m.schema, "od-image/v1");
  assert.equal(m.workflow, "image");
  assert.match(m.workflow_ref, /P-003/);
  assert.equal(m.task_id, "T");
  assert.equal(m.model, "gpt-image-2");
  assert.equal(m.aspect, "1:1");
  assert.equal(m.count, 1);
  assert.equal(m.prompt.text, "hi");
  assert.ok(m.prompt.bytes >= 2);
  assert.equal(m.byok.provider, "openai");
  assert.equal(m.byok.keyRef, null);
  assert.equal(m.byok.configured, false);
  assert.equal(m.outputs.length, 1);
  assert.equal(m.outputs[0].status, "pending");
});

test("buildManifest: keyRef surfaces when BYOK is configured", () => {
  const opts = _internal.parseImageArgs(["T"], "en");
  const m = _internal.buildManifest(opts, {
    present: true,
    keyRef: "byok://openai/OPENAI_API_KEY",
    provider: "openai",
    configPath: "/x",
    reason: null,
  });
  assert.equal(m.byok.configured, true);
  assert.equal(m.byok.keyRef, "byok://openai/OPENAI_API_KEY");
});

// ─── imageCommand integration ────────────────────────────────────────────────

test("imageCommand: default generates prompt.md + manifest.json + vc + README", async () => {
  const dir = makeTmpProject();
  try {
    const code = await imageCommand({ args: ["IMG-001"], cwd: dir, lang: "en" });
    assert.equal(code, 0);
    const outDir = path.join(dir, ".agent", "artifacts", "IMG-001", "images");
    assert.ok(fs.existsSync(path.join(outDir, "prompt.md")), "prompt.md");
    assert.ok(fs.existsSync(path.join(outDir, "manifest.json")), "manifest.json");
    assert.ok(fs.existsSync(path.join(outDir, "README.md")), "README.md");
    assert.ok(fs.existsSync(path.join(outDir, "validation-contract.json")), "vc");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("imageCommand: manifest never contains plaintext key", async () => {
  const dir = makeTmpProject();
  try {
    await imageCommand({ args: ["IMG-KEY"], cwd: dir, lang: "en" });
    const outDir = path.join(dir, ".agent", "artifacts", "IMG-KEY", "images");
    const files = ["manifest.json", "prompt.md", "README.md", "validation-contract.json"];
    for (const f of files) {
      const str = fs.readFileSync(path.join(outDir, f), "utf8");
      assert.equal(str.includes("sk-"), false, f + " must not contain plaintext sk- key");
      assert.equal(str.includes("OPENAI_API_KEY=sk-"), false, f + " must not contain plaintext KEY=value");
    }
    // manifest.byok.keyRef may be null (BYOK not configured) or a stable
    // reference like "byok://openai/OPENAI_API_KEY" — never the actual key.
    const manifest = JSON.parse(fs.readFileSync(path.join(outDir, "manifest.json"), "utf8"));
    if (manifest.byok.keyRef !== null) {
      assert.match(manifest.byok.keyRef, /^byok:\//);
      assert.equal(manifest.byok.keyRef.length, "byok://openai/OPENAI_API_KEY".length);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("imageCommand: --aspect validation rejects invalid value", async () => {
  const dir = makeTmpProject();
  try {
    const code = await imageCommand({
      args: ["IMG-BAD", "--aspect=2:1"],
      cwd: dir,
      lang: "en",
    });
    assert.equal(code, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("imageCommand: --help returns 0", async () => {
  const dir = makeTmpProject();
  try {
    const code = await imageCommand({ args: ["--help"], cwd: dir, lang: "en" });
    assert.equal(code, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("imageCommand: no BYOK configured still succeeds with placeholder manifest", async () => {
  const dir = makeTmpProject();
  try {
    const code = await imageCommand({
      args: ["IMG-NOBYOK", "--prompt=A blue whale"],
      cwd: dir,
      lang: "en",
    });
    assert.equal(code, 0);
    const outDir = path.join(dir, ".agent", "artifacts", "IMG-NOBYOK", "images");
    const manifest = JSON.parse(fs.readFileSync(path.join(outDir, "manifest.json"), "utf8"));
    // BYOK absent — keyRef null but configured=false and probe.reason populated
    assert.equal(manifest.byok.configured, false);
    assert.equal(manifest.byok.keyRef, null);
    assert.equal(manifest.byok.provider, "openai");
    assert.ok(manifest.byok.probe);
    // prompt.md carries the user-supplied text
    const prompt = fs.readFileSync(path.join(outDir, "prompt.md"), "utf8");
    assert.match(prompt, /A blue whale/);
    // README explains how to set up BYOK
    const readme = fs.readFileSync(path.join(outDir, "README.md"), "utf8");
    assert.match(readme, /BYOK/);
    assert.match(readme, /\.config\/cortex-agent\/byok/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("imageCommand: default prompt placeholder is generated when --prompt omitted", async () => {
  const dir = makeTmpProject();
  try {
    const code = await imageCommand({
      args: ["IMG-DEFAULT-PROMPT"],
      cwd: dir,
      lang: "zh",
    });
    assert.equal(code, 0);
    const outDir = path.join(dir, ".agent", "artifacts", "IMG-DEFAULT-PROMPT", "images");
    const prompt = fs.readFileSync(path.join(outDir, "prompt.md"), "utf8");
    assert.match(prompt, /IMG-DEFAULT-PROMPT/);
    assert.match(prompt, /激活用户|placeholder|Subject/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("imageCommand: rejects unknown --model", async () => {
  const dir = makeTmpProject();
  try {
    const code = await imageCommand({
      args: ["IMG-BAD", "--model=dall-e-99"],
      cwd: dir,
      lang: "en",
    });
    assert.equal(code, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("imageCommand: rejects out-of-range --count", async () => {
  const dir = makeTmpProject();
  try {
    const code = await imageCommand({
      args: ["IMG-BAD", "--count=0"],
      cwd: dir,
      lang: "en",
    });
    assert.equal(code, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("imageCommand: validation contract matches deck style schema", async () => {
  const dir = makeTmpProject();
  try {
    await imageCommand({ args: ["IMG-VC"], cwd: dir, lang: "en" });
    const vcPath = path.join(dir, ".agent", "artifacts", "IMG-VC", "images", "validation-contract.json");
    const vc = JSON.parse(fs.readFileSync(vcPath, "utf8"));
    assert.equal(vc.type, "validation_contract");
    assert.equal(vc.workflow, "image");
    assert.match(vc.workflow_ref, /P-003/);
    assert.match(vc.workflow_ref, /4\.3/);
    assert.equal(vc.task_id, "IMG-VC");
    assert.ok(vc.files);
    assert.ok(Array.isArray(vc.notes));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
