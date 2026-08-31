"use strict";

// ─── live-artifact — /live-artifact workflow CLI surface (P-003 §4.5) ─────────
//
// `cortex-agent live-artifact <task-id> [--data-source static|json|csv]
//                                  [--interactive true|false]
//                                  [--template <id>]
//                                  [--lang <zh|en>]`
//
// Generates an interactive dashboard artifact at:
//   .agent/artifacts/<task-id>/live-artifact/
//   ├── index.html                main dashboard, hosts iframe srcdoc sandbox
//   ├── tweaks.json               od-tweaks/v1 manifest (panels array)
//   ├── data/source.json|csv      data source (static embeds inline JSON)
//   └── validation-contract.json  matching P-003 acceptance contract schema
//
// The dashboard wraps a single iframe with srcdoc sandbox so untrusted tweak
// bindings cannot reach the host. Within the iframe, postMessage (or local
// event dispatch when interactive=false) drives *local* DOM re-renders —
// no full-page reload, so charts animate and KPIs keep state.
//
// Exit codes (frozen, per proposal):
//   0  success
//   1  generic error
//   2  user error (invalid args)
//
// Boundaries:
//   In scope: argv parsing, manifest construction, HTML scaffold with inline
//             JS for tweaks re-render, validation contract.
//   Out of scope: subprocess spawning, network sockets, credential access,
//                 actual chart rendering libraries (the iframe uses tiny
//                 inline canvas-style HTML bars; no D3/Chart.js etc.).

const fs = require("node:fs");
const path = require("node:path");

const VALID_DATA_SOURCES = new Set(["static", "json", "csv"]);
const VALID_TEMPLATES = new Set(["default-live"]);

function printLiveArtifactHelp(isZh) {
  const text = isZh
    ? "\n用法:cortex-agent live-artifact <task-id> [options]\n\n" +
      "生成可交互 dashboard 活体 artifact (P-003 §4.5)。零依赖,产出 HTML + tweaks manifest + 数据源。\n\n" +
      "选项:\n" +
      "  --data-source <static|json|csv>  数据源(默认 static:内嵌 JSON)\n" +
      "  --interactive <true|false>       是否启用交互(默认 true)\n" +
      "  --template <id>                  模板 id(默认 default-live;本版本仅支持该模板)\n" +
      "  --lang <zh|en>                   语言(默认 zh)\n" +
      "  --output-dir <path>              自定义输出目录(默认 .agent/artifacts/<task-id>/live-artifact/)\n" +
      "  --help                           显示本帮助\n\n" +
      "默认 tweaks:\n" +
      "  - kpi-window  select (7d / 30d / 90d / YTD, default 30d)\n" +
      "  - chart-type  select (line / bar / area, default line)\n" +
      "Tweaks 局部重渲染通过 postMessage 驱动, 不触发整页 reload。"
    : "\nUsage: cortex-agent live-artifact <task-id> [options]\n\n" +
      "Generate an interactive dashboard artifact (P-003 §4.5). Zero-dep;\n" +
      "outputs HTML + tweaks manifest + data source.\n\n" +
      "Options:\n" +
      "  --data-source <static|json|csv>  Data source (default: static, inline JSON)\n" +
      "  --interactive <true|false>       Enable interactions (default: true)\n" +
      "  --template <id>                  Template id (default: default-live; only one supported)\n" +
      "  --lang <zh|en>                   Language (default: zh)\n" +
      "  --output-dir <path>              Override output directory\n" +
      "  --help                           Show this help\n\n" +
      "Default tweaks:\n" +
      "  - kpi-window  select (7d / 30d / 90d / YTD, default 30d)\n" +
      "  - chart-type  select (line / bar / area, default line)\n" +
      "Tweaks trigger *local* re-render via postMessage — no full-page reload.";
  console.log(text);
}

function parseLiveArtifactArgs(args, lang) {
  // When invoked from bin/cli.js: args = ["live-artifact", <task-id>, --flags...]
  // When invoked directly from a test: args = [<task-id>, --flags...]
  // Detect by peeking: if args[0] === "live-artifact", drop it.
  let argv = args;
  if (argv[0] === "live-artifact") argv = argv.slice(1);

  const taskId = argv[0];
  const opts = {
    taskId,
    dataSource: "static",
    interactive: true,
    template: "default-live",
    lang: lang || "zh",
    outputDir: null,
    showHelp: taskId === "--help" || taskId === "-h",
  };

  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") opts.showHelp = true;
    else if (a === "--data-source" && argv[i + 1]) {
      opts.dataSource = argv[++i];
    } else if (a.startsWith("--data-source=")) {
      opts.dataSource = a.slice("--data-source=".length);
    } else if (a === "--interactive" && argv[i + 1]) {
      opts.interactive = argv[++i] !== "false";
    } else if (a.startsWith("--interactive=")) {
      opts.interactive = a.slice("--interactive=".length) !== "false";
    } else if (a === "--template" && argv[i + 1]) {
      opts.template = argv[++i];
    } else if (a.startsWith("--template=")) {
      opts.template = a.slice("--template=".length);
    } else if (a === "--lang" && argv[i + 1]) {
      opts.lang = argv[++i];
    } else if (a.startsWith("--lang=")) {
      opts.lang = a.slice("--lang=".length);
    } else if (a === "--output-dir" && argv[i + 1]) {
      opts.outputDir = path.resolve(argv[++i]);
    } else if (a.startsWith("--output-dir=")) {
      opts.outputDir = path.resolve(a.slice("--output-dir=".length));
    }
  }

  return opts;
}

function defaultSampleData(isZh) {
  // 7d / 30d / 90d / YTD KPI series — enough for the default kpi-window select.
  return {
    metric: isZh ? "激活用户" : "active_users",
    series: {
      "7d": [
        { d: "D1", v: 120 }, { d: "D2", v: 145 }, { d: "D3", v: 132 },
        { d: "D4", v: 168 }, { d: "D5", v: 180 }, { d: "D6", v: 175 },
        { d: "D7", v: 210 },
      ],
      "30d": Array.from({ length: 30 }, (_, i) => ({ d: "D" + (i + 1), v: 100 + Math.round(Math.sin(i / 3) * 30 + i * 1.4) })),
      "90d": Array.from({ length: 90 }, (_, i) => ({ d: "D" + (i + 1), v: 80 + Math.round(Math.cos(i / 5) * 40 + i * 0.9) })),
      "YTD": Array.from({ length: 12 }, (_, i) => ({ d: "M" + (i + 1), v: 1200 + i * 80 })),
    },
  };
}

function defaultSampleCsv() {
  // Compact CSV for the 30-day default window. Header + 30 rows.
  const rows = ["day,active_users,signups"];
  for (let i = 1; i <= 30; i++) {
    const au = 100 + Math.round(Math.sin(i / 3) * 30 + i * 1.4);
    const sg = 5 + Math.round(Math.cos(i / 4) * 2 + i * 0.1);
    rows.push("D" + i + "," + au + "," + sg);
  }
  return rows.join("\n") + "\n";
}

// Minimal CSV parser — handles quoted values & escaped quotes, trims whitespace.
// Used when --data-source csv and data/source.csv exists.
function parseCsv(text) {
  const rows = [];
  let i = 0;
  let field = "";
  let row = [];
  let inQuotes = false;
  while (i < text.length) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === "\"") {
        if (text[i + 1] === "\"") { field += "\""; i += 2; continue; }
        inQuotes = false; i++; continue;
      }
      field += ch; i++; continue;
    }
    if (ch === "\"") { inQuotes = true; i++; continue; }
    if (ch === ",") { row.push(field); field = ""; i++; continue; }
    if (ch === "\n" || ch === "\r") {
      if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
      field = ""; row = [];
      if (ch === "\r" && text[i + 1] === "\n") i += 2; else i++;
      continue;
    }
    field += ch; i++;
  }
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
  return rows;
}

function csvToSeries(csvText) {
  const rows = parseCsv(csvText).filter((r) => r.length > 1 || (r.length === 1 && r[0] !== ""));
  if (rows.length < 2) {
    return { series: {}, _warning: "csv has no data rows" };
  }
  const header = rows[0].map((h) => h.trim());
  const dayIdx = header.indexOf("day");
  const auIdx = header.findIndex((h) => /active|user/i.test(h));
  const sgIdx = header.findIndex((h) => /signup|new/i.test(h));
  if (dayIdx === -1) return { series: {}, _warning: "csv missing 'day' column" };
  const points = rows.slice(1).map((r) => ({
    d: r[dayIdx] || "",
    v: auIdx >= 0 ? Number(r[auIdx]) || 0 : 0,
    signups: sgIdx >= 0 ? Number(r[sgIdx]) || 0 : 0,
  }));
  const series = {};
  series["7d"] = points.slice(-7);
  series["30d"] = points.slice(-30);
  series["90d"] = points.slice(-90);
  series["YTD"] = points;
  return { series };
}

function buildTweaksManifest(opts) {
  return {
    schema: "od-tweaks/v1",
    workflow: "live-artifact",
    task_id: opts.taskId,
    template: opts.template,
    lang: opts.lang,
    interactive: opts.interactive,
    data_source: opts.dataSource,
    panels: [
      {
        id: "kpi-window",
        type: "select",
        label: opts.lang === "en" ? "Window" : "时间窗口",
        default: "30d",
        options: ["7d", "30d", "90d", "YTD"],
        bind: { dataSource: "filter:window", render: "rerender:series" },
      },
      {
        id: "chart-type",
        type: "select",
        label: opts.lang === "en" ? "Chart" : "图表类型",
        default: "line",
        options: ["line", "bar", "area"],
        bind: { render: "rerender:chart" },
      },
    ],
    produced_at: new Date().toISOString(),
  };
}

function buildIndexHtml(opts, data, tweaks) {
  const isZh = opts.lang !== "en";
  const title = isZh ? "实时仪表板 · " + opts.taskId : "Live Dashboard · " + opts.taskId;
  // Inline JSON string for the static data source — keeps the artifact
  // single-file friendly and lets the iframe srcdoc read everything inline.
  // Replace "</" so the embedded JSON cannot break out of an inline <script>.
  const inlineData = JSON.stringify(data).replace(/<\//g, "<\\/");
  const inlineTweaks = JSON.stringify(tweaks).replace(/<\//g, "<\\/");

  // Build the iframe body via array-join — the dashboard receives tweak
  // events via postMessage from the host (when interactive) or direct
  // DOM input handlers (when not). Either way re-render is *local* — no
  // page reload, no fetch.
  const iframeBody = [
    "<!DOCTYPE html>",
    "<html lang=\"" + (isZh ? "zh-CN" : "en") + "\">",
    "<head>",
    "<meta charset=\"utf-8\">",
    "<title>" + title + "</title>",
    "<style>",
    "  :root { --bg: #0f1115; --fg: #e6e6e6; --muted: #8a8f9a; --accent: #5b9bd5; --panel: #181c23; }",
    "  body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, \"Segoe UI\", \"PingFang SC\", sans-serif; background: var(--bg); color: var(--fg); }",
    "  header { padding: 16px 24px; border-bottom: 1px solid #232831; }",
    "  header h1 { margin: 0 0 8px; font-size: 18px; }",
    "  .tweaks { display: flex; gap: 16px; flex-wrap: wrap; align-items: center; }",
    "  .tweaks label { display: inline-flex; gap: 6px; align-items: center; color: var(--muted); font-size: 13px; }",
    "  .tweaks select { background: var(--panel); color: var(--fg); border: 1px solid #2b3140; border-radius: 4px; padding: 4px 8px; }",
    "  main { padding: 20px 24px; }",
    "  .kpi-row { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 16px; margin-bottom: 24px; }",
    "  .kpi { background: var(--panel); border-radius: 8px; padding: 16px; }",
    "  .kpi .label { color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: 0.05em; }",
    "  .kpi .value { font-size: 26px; font-weight: 600; margin-top: 6px; }",
    "  .chart { background: var(--panel); border-radius: 8px; padding: 16px; min-height: 220px; }",
    "  .chart h3 { margin: 0 0 12px; font-size: 14px; color: var(--muted); }",
    "  svg { display: block; width: 100%; height: 180px; }",
    "  path.line { fill: none; stroke: var(--accent); stroke-width: 2; }",
    "  path.area { fill: rgba(91,155,213,0.18); stroke: var(--accent); stroke-width: 2; }",
    "  rect.bar { fill: var(--accent); }",
    "  .empty { color: var(--muted); padding: 32px; text-align: center; }",
    "  footer { padding: 12px 24px; color: var(--muted); font-size: 11px; border-top: 1px solid #232831; }",
    "</style>",
    "</head>",
    "<body>",
    "  <header>",
    "    <h1>" + title + "</h1>",
    "    <div class=\"tweaks\" id=\"tweaks\"></div>",
    "  </header>",
    "  <main>",
    "    <div class=\"kpi-row\" id=\"kpi-row\"></div>",
    "    <div class=\"chart\">",
    "      <h3 id=\"chart-title\"></h3>",
    "      <div id=\"chart-host\"></div>",
    "    </div>",
    "  </main>",
    "  <footer>" + (isZh ? "数据来源:" : "Data source:") + " " + opts.dataSource + " · " + (isZh ? "模板:" : "Template:") + " " + opts.template + "</footer>",
    "  <script>",
    "  (function () {",
    "    var DATA = " + inlineData + ";",
    "    var TWEAKS = " + inlineTweaks + ";",
    "    var state = {};",
    "    TWEAKS.panels.forEach(function (p) { state[p.id] = p.default; });",
    "",
    "    function $(id) { return document.getElementById(id); }",
    "",
    "    function renderTweaks() {",
    "      var host = $(\"tweaks\");",
    "      host.innerHTML = \"\";",
    "      TWEAKS.panels.forEach(function (p) {",
    "        var wrap = document.createElement(\"label\");",
    "        wrap.textContent = p.label + \": \";",
    "        var sel = document.createElement(\"select\");",
    "        p.options.forEach(function (opt) {",
    "          var o = document.createElement(\"option\");",
    "          o.value = opt; o.textContent = opt;",
    "          if (opt === p.default) o.selected = true;",
    "          sel.appendChild(o);",
    "        });",
    "        sel.addEventListener(\"change\", function () {",
    "          applyTweak(p.id, sel.value);",
    "        });",
    "        wrap.appendChild(sel);",
    "        host.appendChild(wrap);",
    "      });",
    "    }",
    "",
    "    function getSeries() {",
    "      var win = state[\"kpi-window\"] || \"30d\";",
    "      var s = (DATA && DATA.series && DATA.series[win]) || [];",
    "      return s;",
    "    }",
    "",
    "    function renderKpis() {",
    "      var series = getSeries();",
    "      var row = $(\"kpi-row\");",
    "      row.innerHTML = \"\";",
    "      if (!series.length) {",
    "        row.innerHTML = \"<div class=\"empty\">\" + (TWEAKS.lang === \"en\" ? \"No data\" : \"暂无数据\") + \"</div>\";",
    "        return;",
    "      }",
    "      var last = series[series.length - 1].v;",
    "      var prev = series.length > 1 ? series[series.length - 2].v : last;",
    "      var total = series.reduce(function (a, b) { return a + b.v; }, 0);",
    "      var kpis = [",
    "        { label: TWEAKS.lang === \"en\" ? \"Latest\" : \"最新\", value: last },",
    "        { label: TWEAKS.lang === \"en\" ? \"Δ vs prev\" : \"环比变化\", value: (last - prev) },",
    "        { label: TWEAKS.lang === \"en\" ? \"Total\" : \"累计\", value: total },",
    "      ];",
    "      kpis.forEach(function (k) {",
    "        var div = document.createElement(\"div\");",
    "        div.className = \"kpi\";",
    "        div.innerHTML = \"<div class=\"label\"></div><div class=\"value\"></div>\";",
    "        div.querySelector(\".label\").textContent = k.label;",
    "        div.querySelector(\".value\").textContent = String(k.value);",
    "        row.appendChild(div);",
    "      });",
    "    }",
    "",
    "    function renderChart() {",
    "      var host = $(\"chart-host\");",
    "      host.innerHTML = \"\";",
    "      var series = getSeries();",
    "      if (!series.length) {",
    "        host.innerHTML = \"<div class=\"empty\">\" + (TWEAKS.lang === \"en\" ? \"No data\" : \"暂无数据\") + \"</div>\";",
    "        $(\"chart-title\").textContent = \"\";",
    "        return;",
    "      }",
    "      var chartType = state[\"chart-type\"] || \"line\";",
    "      $(\"chart-title\").textContent = (DATA && DATA.metric ? DATA.metric : \"value\") + \" · \" + state[\"kpi-window\"];",
    "      var W = 800, H = 180, P = 24;",
    "      var max = Math.max.apply(null, series.map(function (p) { return p.v; }));",
    "      var min = Math.min.apply(null, series.map(function (p) { return p.v; }));",
    "      if (max === min) max = min + 1;",
    "      var stepX = (W - P * 2) / Math.max(series.length - 1, 1);",
    "      var svgNs = \"http://www.w3.org/2000/svg\";",
    "      var svg = document.createElementNS(svgNs, \"svg\");",
    "      svg.setAttribute(\"viewBox\", \"0 0 \" + W + \" \" + H);",
    "      svg.setAttribute(\"preserveAspectRatio\", \"none\");",
    "      if (chartType === \"bar\") {",
    "        var barW = Math.max(2, stepX * 0.7);",
    "        series.forEach(function (p, i) {",
    "          var x = P + i * stepX - barW / 2;",
    "          var y = H - P - ((p.v - min) / (max - min)) * (H - P * 2);",
    "          var r = document.createElementNS(svgNs, \"rect\");",
    "          r.setAttribute(\"class\", \"bar\");",
    "          r.setAttribute(\"x\", String(x));",
    "          r.setAttribute(\"y\", String(y));",
    "          r.setAttribute(\"width\", String(barW));",
    "          r.setAttribute(\"height\", String(H - P - y));",
    "          svg.appendChild(r);",
    "        });",
    "      } else {",
    "        var pts = series.map(function (p, i) {",
    "          var x = P + i * stepX;",
    "          var y = H - P - ((p.v - min) / (max - min)) * (H - P * 2);",
    "          return [x, y];",
    "        });",
    "        if (chartType === \"area\") {",
    "          var area = document.createElementNS(svgNs, \"path\");",
    "          area.setAttribute(\"class\", \"area\");",
    "          var d = \"M \" + pts[0][0] + \" \" + (H - P);",
    "          pts.forEach(function (pt) { d += \" L \" + pt[0] + \" \" + pt[1]; });",
    "          d += \" L \" + pts[pts.length - 1][0] + \" \" + (H - P) + \" Z\";",
    "          area.setAttribute(\"d\", d);",
    "          svg.appendChild(area);",
    "        }",
    "        var line = document.createElementNS(svgNs, \"path\");",
    "        line.setAttribute(\"class\", \"line\");",
    "        var dl = \"M \" + pts[0][0] + \" \" + pts[0][1];",
    "        for (var i = 1; i < pts.length; i++) dl += \" L \" + pts[i][0] + \" \" + pts[i][1];",
    "        line.setAttribute(\"d\", dl);",
    "        svg.appendChild(line);",
    "      }",
    "      host.appendChild(svg);",
    "    }",
    "",
    "    function rerender() { renderKpis(); renderChart(); }",
    "",
    "    function applyTweak(id, value) {",
    "      state[id] = value;",
    "      rerender();",
    "      try {",
    "        if (window.parent && window.parent !== window) {",
    "          window.parent.postMessage({ type: \"tweak\", id: id, value: value }, \"*\");",
    "        }",
    "      } catch (e) { /* srcdoc sandbox may block parent access — non-fatal */ }",
    "    }",
    "",
    "    renderTweaks();",
    "    rerender();",
    "",
    "    window.addEventListener(\"message\", function (ev) {",
    "      var data = ev && ev.data;",
    "      if (!data || typeof data !== \"object\") return;",
    "      if (data.type === \"tweak\" && typeof data.id === \"string\") {",
    "        applyTweak(data.id, data.value);",
    "      }",
    "    });",
    "  })();",
    "  </script>",
    "</body>",
    "</html>",
  ].join("\n");

  // Host page wraps the iframe (srcdoc with sandbox). Outer tweak controls
  // (when interactive) postMessage into the iframe.
  let interactiveControls = "";
  if (opts.interactive) {
    interactiveControls = [
      "    <div class=\"host-tweaks\" id=\"host-tweaks\"></div>",
      "    <script>",
      "    (function () {",
      "      var TWEAKS = " + inlineTweaks + ";",
      "      function $(id) { return document.getElementById(id); }",
      "      var iframe = $(\"dash\");",
      "      var host = $(\"host-tweaks\");",
      "      TWEAKS.panels.forEach(function (p) {",
      "        var wrap = document.createElement(\"label\");",
      "        wrap.textContent = p.label + \": \";",
      "        var sel = document.createElement(\"select\");",
      "        p.options.forEach(function (opt) {",
      "          var o = document.createElement(\"option\");",
      "          o.value = opt; o.textContent = opt;",
      "          if (opt === p.default) o.selected = true;",
      "          sel.appendChild(o);",
      "        });",
      "        sel.addEventListener(\"change\", function () {",
      "          iframe.contentWindow.postMessage({ type: \"tweak\", id: p.id, value: sel.value }, \"*\");",
      "        });",
      "        wrap.appendChild(sel);",
      "        host.appendChild(wrap);",
      "      });",
      "    })();",
      "    </script>",
    ].join("\n");
  }

  // Encode the iframe body for the srcdoc attribute: escape backslashes
  // (must be first) and double-quotes so the HTML attribute remains valid.
  const srcdocEscaped = iframeBody
    .replace(/\\/g, "\\\\")
    .replace(/"/g, "&quot;");

  const hostHtml = [
    "<!DOCTYPE html>",
    "<html lang=\"" + (isZh ? "zh-CN" : "en") + "\">",
    "<head>",
    "<meta charset=\"utf-8\">",
    "<title>" + title + "</title>",
    "<style>",
    "  body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, \"Segoe UI\", \"PingFang SC\", sans-serif; background: #0a0c10; color: #e6e6e6; }",
    "  header { padding: 12px 24px; border-bottom: 1px solid #232831; display: flex; align-items: center; gap: 24px; }",
    "  header h1 { margin: 0; font-size: 16px; }",
    "  header .host-tweaks { display: flex; gap: 16px; flex-wrap: wrap; }",
    "  header label { display: inline-flex; gap: 6px; align-items: center; color: #8a8f9a; font-size: 13px; }",
    "  header select { background: #181c23; color: #e6e6e6; border: 1px solid #2b3140; border-radius: 4px; padding: 4px 8px; }",
    "  iframe { border: 0; width: 100%; height: calc(100vh - 60px); display: block; }",
    "</style>",
    "</head>",
    "<body>",
    "  <header>",
    "    <h1>" + title + "</h1>",
    interactiveControls,
    "  </header>",
    "  <iframe id=\"dash\" sandbox=\"allow-scripts\" srcdoc=\"" + srcdocEscaped + "\"></iframe>",
    "</body>",
    "</html>",
  ].join("\n");
  return hostHtml;
}

function buildValidationContract(opts, outputDir, generated) {
  return {
    type: "validation_contract",
    workflow: "live-artifact",
    workflow_ref: "P-003 design-workflow-chain / §4.5",
    task_id: opts.taskId,
    template: opts.template,
    lang: opts.lang,
    data_source: opts.dataSource,
    interactive: opts.interactive,
    output_dir: outputDir,
    files: generated,
    panels: ["kpi-window", "chart-type"],
    notes: [
      "Tweaks manifest is od-tweaks/v1; bind.dataSource and bind.render drive local re-render.",
      "Dashboard runs in iframe srcdoc sandbox — host page cannot be reached by tweak code.",
      "Zero npm deps; chart rendering uses inline SVG (no D3 / Chart.js).",
    ],
    produced_at: new Date().toISOString(),
  };
}

async function liveArtifactCommand(ctx) {
  const { args, cwd, lang } = ctx;
  const opts = parseLiveArtifactArgs(args || [], lang);

  if (opts.showHelp || !opts.taskId) {
    printLiveArtifactHelp(lang === "zh");
    return opts.taskId ? 0 : 2;
  }
  if (!VALID_TEMPLATES.has(opts.template)) {
    console.error("[cortex-agent] ✗ unknown template: " + opts.template);
    console.error("  Valid: " + [...VALID_TEMPLATES].join(", "));
    process.exitCode = 2;
    return 2;
  }
  if (!VALID_DATA_SOURCES.has(opts.dataSource)) {
    console.error("[cortex-agent] ✗ invalid --data-source: " + opts.dataSource);
    console.error("  Valid: " + [...VALID_DATA_SOURCES].join(", "));
    process.exitCode = 2;
    return 2;
  }

  const outputDir = opts.outputDir || path.join(cwd, ".agent", "artifacts", opts.taskId, "live-artifact");
  const dataDir = path.join(outputDir, "data");
  fs.mkdirSync(dataDir, { recursive: true });

  // 1) Resolve / generate data source.
  let data;
  const isZh = opts.lang !== "en";
  if (opts.dataSource === "static") {
    data = defaultSampleData(isZh);
  } else if (opts.dataSource === "json") {
    const jsonPath = path.join(dataDir, "source.json");
    if (fs.existsSync(jsonPath)) {
      try {
        data = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
      } catch (err) {
        console.error("[cortex-agent] ✗ data/source.json is malformed: " + err.message);
        process.exitCode = 2;
        return 2;
      }
    } else {
      data = defaultSampleData(isZh);
      fs.writeFileSync(jsonPath, JSON.stringify(data, null, 2), "utf8");
      console.log("[cortex-agent] ⚠ data/source.json missing; wrote sample series (" + path.relative(cwd, jsonPath) + ")");
    }
  } else if (opts.dataSource === "csv") {
    const csvPath = path.join(dataDir, "source.csv");
    if (fs.existsSync(csvPath)) {
      try {
        data = csvToSeries(fs.readFileSync(csvPath, "utf8"));
      } catch (err) {
        console.error("[cortex-agent] ✗ data/source.csv parse failed: " + err.message);
        process.exitCode = 2;
        return 2;
      }
    } else {
      const csv = defaultSampleCsv();
      fs.writeFileSync(csvPath, csv, "utf8");
      data = csvToSeries(csv);
      console.log("[cortex-agent] ⚠ data/source.csv missing; wrote sample series (" + path.relative(cwd, csvPath) + ")");
    }
  }

  // 2) Tweaks manifest.
  const tweaks = buildTweaksManifest(opts);

  // 3) index.html (srcdoc iframe scaffold).
  const html = buildIndexHtml(opts, data, tweaks);
  const indexPath = path.join(outputDir, "index.html");
  fs.writeFileSync(indexPath, html, "utf8");

  // 4) tweaks.json next to index.html for tooling / external consumers.
  const tweaksPath = path.join(outputDir, "tweaks.json");
  fs.writeFileSync(tweaksPath, JSON.stringify(tweaks, null, 2), "utf8");

  // 5) validation-contract.json.
  const generated = {
    "index.html": { path: indexPath, bytes: Buffer.byteLength(html, "utf8") },
    "tweaks.json": { path: tweaksPath, bytes: Buffer.byteLength(JSON.stringify(tweaks), "utf8") },
  };
  if (opts.dataSource === "json") {
    const jp = path.join(dataDir, "source.json");
    if (fs.existsSync(jp)) generated["data/source.json"] = { path: jp, bytes: fs.statSync(jp).size };
  } else if (opts.dataSource === "csv") {
    const cp = path.join(dataDir, "source.csv");
    if (fs.existsSync(cp)) generated["data/source.csv"] = { path: cp, bytes: fs.statSync(cp).size };
  }
  const vc = buildValidationContract(opts, outputDir, generated);
  const vcPath = path.join(outputDir, "validation-contract.json");
  fs.writeFileSync(vcPath, JSON.stringify(vc, null, 2), "utf8");

  console.log("[cortex-agent] ✓ live-artifact written to " + (path.relative(cwd, outputDir) || outputDir));
  for (const k of Object.keys(generated)) {
    const entry = generated[k];
    console.log("  · " + k.padEnd(20) + " " + path.relative(cwd, entry.path) + "  (" + entry.bytes + " bytes)");
  }
  console.log("  · vc                   validation-contract.json");

  return 0;
}

module.exports = {
  liveArtifactCommand,
  // exposed for tests
  _internal: {
    parseLiveArtifactArgs,
    buildTweaksManifest,
    buildIndexHtml,
    buildValidationContract,
    defaultSampleData,
    defaultSampleCsv,
    parseCsv,
    csvToSeries,
    VALID_DATA_SOURCES,
    VALID_TEMPLATES,
  },
};
