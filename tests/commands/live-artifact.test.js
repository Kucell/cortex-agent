"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { liveArtifactCommand, _internal } = require("../../lib/commands/live-artifact");

function makeTmpProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-live-artifact-"));
  fs.mkdirSync(path.join(dir, ".agent"), { recursive: true });
  return dir;
}

// Reset process.exitCode before every test so a previously-failing command
// (e.g. "invalid --data-source") does not poison subsequent tests' file-level
// pass/fail reporting.
test.beforeEach(() => {
  process.exitCode = 0;
});

// Same reset after the suite — the last test may have left process.exitCode
// at a non-zero value (intentionally). The test runner inherits that value
// and reports the file as failed even though every test passed.
test.after(() => {
  process.exitCode = 0;
});

// ─── parseLiveArtifactArgs ───────────────────────────────────────────────────

test("parseLiveArtifactArgs: minimum invocation", () => {
  const opts = _internal.parseLiveArtifactArgs(["TASK-001"], "zh");
  assert.equal(opts.taskId, "TASK-001");
  assert.equal(opts.dataSource, "static");
  assert.equal(opts.interactive, true);
  assert.equal(opts.template, "default-live");
  assert.equal(opts.lang, "zh");
});

test("parseLiveArtifactArgs: --data-source=csv", () => {
  const opts = _internal.parseLiveArtifactArgs(["T", "--data-source=csv"], "en");
  assert.equal(opts.dataSource, "csv");
});

test("parseLiveArtifactArgs: --data-source with space-separated value", () => {
  const opts = _internal.parseLiveArtifactArgs(["T", "--data-source", "json"], "en");
  assert.equal(opts.dataSource, "json");
});

test("parseLiveArtifactArgs: --interactive=false turns off", () => {
  const opts = _internal.parseLiveArtifactArgs(["T", "--interactive=false"], "en");
  assert.equal(opts.interactive, false);
});

test("parseLiveArtifactArgs: --output-dir resolves to absolute path", () => {
  const opts = _internal.parseLiveArtifactArgs(["T", "--output-dir", "./out"], "en");
  assert.ok(path.isAbsolute(opts.outputDir));
  assert.match(opts.outputDir, /out$/);
});

// ─── buildTweaksManifest ─────────────────────────────────────────────────────

test("buildTweaksManifest: default panels include kpi-window + chart-type", () => {
  const opts = _internal.parseLiveArtifactArgs(["T"], "zh");
  const t = _internal.buildTweaksManifest(opts);
  assert.equal(t.schema, "od-tweaks/v1");
  assert.equal(t.workflow, "live-artifact");
  assert.equal(t.task_id, "T");
  assert.ok(Array.isArray(t.panels));
  assert.equal(t.panels.length, 2);
  const ids = t.panels.map((p) => p.id);
  assert.ok(ids.includes("kpi-window"));
  assert.ok(ids.includes("chart-type"));
  // bind contract — both bind fields present
  for (const p of t.panels) {
    assert.ok(p.bind && typeof p.bind === "object", "panel.bind must be object");
  }
});

// ─── CSV helpers ─────────────────────────────────────────────────────────────

test("parseCsv: handles quoted fields with escaped quotes", () => {
  const rows = _internal.parseCsv('a,b,c\n"x ""y""","z",1\n');
  assert.deepEqual(rows[0], ["a", "b", "c"]);
  assert.deepEqual(rows[1], ['x "y"', "z", "1"]);
});

test("csvToSeries: produces 7d/30d/90d/YTD windows from day column", () => {
  const csv = _internal.defaultSampleCsv();
  const result = _internal.csvToSeries(csv);
  assert.ok(result.series);
  assert.equal(result.series["7d"].length, 7);
  assert.equal(result.series["30d"].length, 30);
  assert.equal(result.series["YTD"].length, 30);
});

// ─── liveArtifactCommand integration ─────────────────────────────────────────

test("liveArtifactCommand: default (static) emits index.html + tweaks.json + vc", async () => {
  const dir = makeTmpProject();
  try {
    const code = await liveArtifactCommand({
      args: ["TASK-001"],
      cwd: dir,
      lang: "en",
    });
    assert.equal(code, 0);
    const outDir = path.join(dir, ".agent", "artifacts", "TASK-001", "live-artifact");
    assert.ok(fs.existsSync(path.join(outDir, "index.html")), "index.html");
    assert.ok(fs.existsSync(path.join(outDir, "tweaks.json")), "tweaks.json");
    assert.ok(fs.existsSync(path.join(outDir, "validation-contract.json")), "vc");
    // No data/source.* when --data-source static
    const dataDir = path.join(outDir, "data");
    assert.ok(!fs.existsSync(path.join(dataDir, "source.json")));
    assert.ok(!fs.existsSync(path.join(dataDir, "source.csv")));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("liveArtifactCommand: --data-source=csv writes sample CSV when missing", async () => {
  const dir = makeTmpProject();
  try {
    const code = await liveArtifactCommand({
      args: ["TASK-CSV"],
      cwd: dir,
      lang: "en",
    }).then(() =>
      liveArtifactCommand({ args: ["TASK-CSV", "--data-source=csv"], cwd: dir, lang: "en" }),
    );
    assert.equal(code, 0);
    const csvPath = path.join(dir, ".agent", "artifacts", "TASK-CSV", "live-artifact", "data", "source.csv");
    assert.ok(fs.existsSync(csvPath), "sample CSV written");
    const csv = fs.readFileSync(csvPath, "utf8");
    assert.match(csv, /^day,active_users,signups/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("liveArtifactCommand: --data-source=json writes sample JSON when missing", async () => {
  const dir = makeTmpProject();
  try {
    const code = await liveArtifactCommand({
      args: ["TASK-JSON", "--data-source=json"],
      cwd: dir,
      lang: "en",
    });
    assert.equal(code, 0);
    const jsonPath = path.join(dir, ".agent", "artifacts", "TASK-JSON", "live-artifact", "data", "source.json");
    assert.ok(fs.existsSync(jsonPath), "sample JSON written");
    const obj = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
    assert.ok(obj.series);
    assert.ok(Array.isArray(obj.series["30d"]));
    assert.equal(obj.series["30d"].length, 30);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("liveArtifactCommand: --data-source=static embeds inline JSON in index.html", async () => {
  const dir = makeTmpProject();
  try {
    const code = await liveArtifactCommand({
      args: ["TASK-STATIC"],
      cwd: dir,
      lang: "zh",
    });
    assert.equal(code, 0);
    const htmlPath = path.join(dir, ".agent", "artifacts", "TASK-STATIC", "live-artifact", "index.html");
    const html = fs.readFileSync(htmlPath, "utf8");
    // srcdoc iframe with sandbox
    assert.match(html, /<iframe[^>]+sandbox=/);
    assert.match(html, /srcdoc=/);
    // Inline JSON data is embedded into the iframe
    assert.ok(html.includes("30d") || html.includes("D1"));
    // tweak protocol is wired
    assert.match(html, /postMessage\(/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("liveArtifactCommand: --interactive=false omits the host tweak control script", async () => {
  const dir = makeTmpProject();
  try {
    const code = await liveArtifactCommand({
      args: ["TASK-NOINT", "--interactive=false"],
      cwd: dir,
      lang: "en",
    });
    assert.equal(code, 0);
    const htmlPath = path.join(dir, ".agent", "artifacts", "TASK-NOINT", "live-artifact", "index.html");
    const html = fs.readFileSync(htmlPath, "utf8");
    // The interactive host-tweaks controls script is wrapped in a block that
    // only runs when opts.interactive is true. Search for the script-block
    // marker (id="host-tweaks" div plus the surrounding IIFE wrapper).
    assert.equal(html.includes('id="host-tweaks"'), false, "no host-tweaks control div");
    // The iframe-internal postMessage handler is still present (re-render is
    // *local*, not driven by host).
    assert.match(html, /postMessage\(/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("liveArtifactCommand: validation contract matches deck style schema", async () => {
  const dir = makeTmpProject();
  try {
    await liveArtifactCommand({ args: ["TASK-VC"], cwd: dir, lang: "en" });
    const vcPath = path.join(dir, ".agent", "artifacts", "TASK-VC", "live-artifact", "validation-contract.json");
    const vc = JSON.parse(fs.readFileSync(vcPath, "utf8"));
    assert.equal(vc.type, "validation_contract");
    assert.equal(vc.workflow, "live-artifact");
    assert.match(vc.workflow_ref, /P-003/);
    assert.match(vc.workflow_ref, /4\.5/);
    assert.equal(vc.task_id, "TASK-VC");
    assert.ok(vc.files);
    assert.ok(Array.isArray(vc.notes));
    assert.ok(vc.panels.includes("kpi-window"));
    assert.ok(vc.panels.includes("chart-type"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("liveArtifactCommand: tweaks.json default panels present", async () => {
  const dir = makeTmpProject();
  try {
    await liveArtifactCommand({ args: ["TASK-TW"], cwd: dir, lang: "en" });
    const tPath = path.join(dir, ".agent", "artifacts", "TASK-TW", "live-artifact", "tweaks.json");
    const t = JSON.parse(fs.readFileSync(tPath, "utf8"));
    assert.equal(t.schema, "od-tweaks/v1");
    const win = t.panels.find((p) => p.id === "kpi-window");
    const chart = t.panels.find((p) => p.id === "chart-type");
    assert.ok(win);
    assert.ok(chart);
    assert.equal(win.default, "30d");
    assert.deepEqual(win.options, ["7d", "30d", "90d", "YTD"]);
    assert.equal(chart.default, "line");
    assert.deepEqual(chart.options, ["line", "bar", "area"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ─── Error paths ────────────────────────────────────────────────────────────

test("liveArtifactCommand: --help returns 0", async () => {
  const dir = makeTmpProject();
  try {
    const code = await liveArtifactCommand({ args: ["--help"], cwd: dir, lang: "en" });
    assert.equal(code, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("liveArtifactCommand: no task-id returns 2", async () => {
  const dir = makeTmpProject();
  try {
    const code = await liveArtifactCommand({ args: [], cwd: dir, lang: "en" });
    assert.equal(code, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("liveArtifactCommand: invalid --data-source returns 2", async () => {
  const dir = makeTmpProject();
  try {
    const code = await liveArtifactCommand({
      args: ["TASK-BAD", "--data-source=xml"],
      cwd: dir,
      lang: "en",
    });
    assert.equal(code, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("liveArtifactCommand: invalid --template returns 2", async () => {
  const dir = makeTmpProject();
  try {
    const code = await liveArtifactCommand({
      args: ["TASK-BAD", "--template=nope"],
      cwd: dir,
      lang: "en",
    });
    assert.equal(code, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
