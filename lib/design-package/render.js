"use strict";

// ─── render — SamHMI single-file HTML from design tokens + DSL content ───────
//
// Produces a deterministic, self-contained, runnable HTML file:
//   - 1920×1080 desktop workbench shell (menu 36 / tree 205 / inspector 468 /
//     output 52 / status 22).
//   - Right inspector mirrors the genuine Pixso frame 73:464 (属性面板, 3 tabs).
//   - Noto Sans SC + design-derived colors.
// No npm deps, no subprocess, no network (fonts degrade to system fallback).

const { buildBrandTokens, rootChildren, textLabels } = require("./tokens");

// Verified Pixso MCP shell refs (reusable component 91:3196
// "T-M01-01 标准模板控件详情/页面外壳", 1920×1080, root fill
// rgba(202,211,223,1), 435 compact nodes). Embedded as traceability
// attributes so the generated HTML maps 1:1 back to the genuine frame.
const SHELL_REFS = Object.freeze({
  root: "91:3196",
  menubar: "91:2834",
  tree: "91:2835",
  workspace: "91:2836",
  inspector: "91:3065",
  output: "91:3064",
  statusbar: "78:741",
});

function escapeHtml(value) {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Build the CSS + HTML for a SamHMI desktop shell. `tokens` comes from
// buildBrandTokens(dsl); `brief` carries taskId / title for headers.
function renderSamHmiHtml(brief, tokens, opts) {
  opts = opts || {};
  const isZh = opts.lang !== "en";
  const taskId = brief.taskId || "SAMHMI";
  const title = brief.title || (isZh ? "SamHMI 画面编辑器" : "SamHMI Screen Editor");
  const sem = tokens.semantic;
  const c = tokens.colors;

  const treeRows = (rootChildren(brief.dsl) || []).map((child) => {
    const icon = child.type === "FRAME" ? "▤" : child.type === "TEXT" ? "T" : "◇";
    return `      <div class="tree-row"><span class="tree-ic">${escapeHtml(icon)}</span><span>${escapeHtml(child.name)}</span></div>`;
  }).join("\n") || "      <div class=\"tree-row\"><span class=\"tree-ic\">▤</span><span>标准模板控件详情</span></div>";

  const labels = (textLabels(brief.dsl) || []).slice(0, 60).map((l) => escapeHtml(l.text));
  const preview = labels.slice(0, 8).map((l) => `        <div class="demo-row">${l}</div>`).join("\n");

  const colorSwatches = tokens.colors.map((hex) => {
    const name = hex;
    return `        <div class="swatch" style="background:${hex}" title="${escapeHtml(name)}"><span>${escapeHtml(hex)}</span></div>`;
  }).join("\n");

  return `<!DOCTYPE html>
<html lang="${isZh ? "zh-CN" : "en"}">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(title)}</title>
<!-- Source: Pixso reusable component ${SHELL_REFS.root} (T-M01-01 标准模板控件详情/页面外壳, 1920×1080) -->
<style>
:root{
  --bg:${sem.bg}; --surface:${sem.surface}; --fg:${sem.fg}; --muted:${sem.muted};
  --border:${sem.border}; --accent:${sem.accent}; --canvas:${sem.canvas};
  --screen:${sem.screenBg}; --ok:${sem.ok}; --warn:${sem.warn}; --alert:${sem.alert};
  --font:"Noto Sans SC","PingFang SC","Microsoft YaHei",system-ui,sans-serif;
  --mono:ui-monospace,"SF Mono","Cascadia Mono",Consolas,monospace;
}
*{box-sizing:border-box;margin:0;padding:0}
html,body{height:100%}
body{background:#2b3542;font-family:var(--font);color:var(--fg);display:flex;align-items:center;justify-content:center;overflow:hidden;-webkit-font-smoothing:antialiased}
.app{width:1920px;height:1080px;background:var(--bg);display:flex;flex-direction:column;box-shadow:0 24px 80px rgba(0,0,0,.45);overflow:hidden;transform-origin:center;position:relative}
/* menu 36 */
.menubar{height:36px;flex:0 0 36px;background:var(--bg);border-bottom:1px solid var(--border);display:flex;align-items:center;padding:0 10px;gap:16px;font-size:13px;user-select:none}
.brand{display:flex;align-items:center;gap:6px;font-weight:600}
.brand .logo{width:20px;height:20px;border-radius:5px;background:var(--accent);color:#fff;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700}
.menu-items{display:flex;gap:2px}
.menu-items button{padding:3px 9px;border-radius:4px;background:none;border:none;color:var(--fg);cursor:pointer;font:inherit}
.menu-items button:hover{background:#eef1f5}
.project-path{flex:1;text-align:right;font-size:12px;color:var(--muted);font-family:var(--mono);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.win-ctl{display:flex;gap:2px}
.win-ctl button{width:28px;height:22px;border-radius:4px;background:none;border:none;color:var(--muted);cursor:pointer;font-size:12px}
.win-ctl button:hover{background:#e6e9ee}
.win-ctl .close:hover{background:var(--alert);color:#fff}
/* main: tree 205 + workspace + inspector 468 */
.main{flex:1;display:flex;min-height:0}
.tree{width:205px;flex:0 0 205px;background:var(--surface);border-right:1px solid var(--border);display:flex;flex-direction:column;min-height:0}
.tree-head{height:36px;flex:0 0 36px;background:#EEF2F7;border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between;padding:0 12px;font-size:13px}
.tree-head .pin{font-size:11px;color:var(--muted)}
.tree-body{flex:1;overflow:auto;padding:6px 0;font-size:13px}
.tree-row{display:flex;align-items:center;gap:6px;padding:3px 12px;cursor:default;border-radius:4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.tree-row:hover{background:#eef1f5}
.tree-ic{color:var(--accent);width:14px;text-align:center}
/* workspace */
.workspace{flex:1;display:flex;flex-direction:column;min-width:0}
.tabbar{height:36px;flex:0 0 36px;background:var(--surface);border-bottom:1px solid var(--border);display:flex;align-items:flex-end;padding:0 6px;font-size:13px}
.tab{height:30px;padding:0 14px;display:flex;align-items:center;gap:6px;border:1px solid transparent;border-bottom:none;border-radius:6px 6px 0 0;cursor:pointer;color:var(--muted)}
.tab.active{background:var(--bg);border-color:var(--border);color:var(--fg);font-weight:600;box-shadow:inset 0 2px 0 var(--tabline,#3070FF)}
.tab .x{color:var(--muted);font-size:12px;margin-left:4px}
.tabbar-spacer{flex:1}
.newtab{width:26px;height:26px;display:flex;align-items:center;justify-content:center;color:var(--muted);cursor:pointer;border-radius:5px}
.newtab:hover{background:#eef1f5}
/* canvas */
.canvas{flex:1;background:var(--canvas);position:relative;overflow:hidden;display:flex;align-items:center;justify-content:center}
.stage{width:1440px;height:810px;background:var(--screen);border-radius:4px;box-shadow:0 10px 40px rgba(0,0,0,.25);display:flex;flex-direction:column;overflow:hidden}
.stage-head{height:56px;flex:0 0 56px;background:var(--surface);border-bottom:1px solid var(--border);display:flex;align-items:center;padding:0 24px;gap:12px}
.stage-title{font-size:18px;font-weight:600}
.stage-sub{font-size:12px;color:var(--muted)}
.stage-body{flex:1;display:flex;gap:24px;padding:24px;flex-wrap:wrap;align-content:flex-start;overflow:auto}
.card{width:280px;height:220px;background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:16px;box-shadow:0 2px 8px rgba(0,0,0,.05)}
.card-title{font-size:14px;font-weight:600;margin-bottom:10px}
.demo-row{font-size:13px;color:var(--fg);padding:4px 0;border-bottom:1px dashed var(--border)}
.demo-row:last-child{border-bottom:none}
/* inspector 468 */
.panel{width:468px;flex:0 0 468px;background:var(--surface);border-left:1px solid var(--border);display:flex;flex-direction:column;min-height:0}
.panel-head{height:48px;flex:0 0 48px;border-bottom:1px solid var(--border);display:flex;align-items:center;padding:0 16px;gap:10px}
.panel-head .wn{font-size:14px;font-weight:600}
.panel-head .wl{font-size:12px;color:var(--muted)}
.p-tabs{height:40px;flex:0 0 40px;border-bottom:1px solid var(--border);display:flex;padding:0 12px;gap:4px}
.p-tab{flex:1;display:flex;align-items:center;justify-content:center;font-size:13px;color:var(--muted);cursor:pointer;border-bottom:2px solid transparent}
.p-tab.active{color:var(--accent);border-bottom-color:var(--accent);font-weight:600}
.panel-body{flex:1;overflow:auto;padding:12px 16px}
.section{margin-bottom:14px}
.sec-head{font-size:13px;font-weight:600;padding:6px 0;border-bottom:1px solid var(--border);margin-bottom:6px;display:flex;align-items:center;gap:6px}
.field{display:flex;justify-content:space-between;padding:5px 0;font-size:13px;border-bottom:1px solid #f2f4f7}
.field .k{color:var(--muted)}
.field .v{font-family:var(--mono);font-size:12px}
.swatches{display:flex;flex-wrap:wrap;gap:8px;margin-top:6px}
.swatch{width:64px;height:40px;border-radius:6px;border:1px solid rgba(0,0,0,.08);display:flex;align-items:flex-end;padding:3px 5px;color:#fff;font-family:var(--mono);font-size:9px;text-shadow:0 1px 2px rgba(0,0,0,.5)}
/* output 52 + status 22 */
.output{height:52px;flex:0 0 52px;background:var(--outbar,#FAFBFC);border-top:1px solid var(--border);display:flex;align-items:center;gap:16px;padding:0 16px;font-size:12px;color:var(--fg)}
.out-row{display:flex;gap:8px;align-items:center}
.out-row .ts{color:var(--muted);font-family:var(--mono)}
.out-row .lv{color:var(--ok)}
.out-row .lv.w{color:var(--warn)}
.statusbar{height:22px;flex:0 0 22px;background:var(--statbar,#F5F7F9);border-top:1px solid var(--border);display:flex;align-items:center;justify-content:space-between;padding:0 12px;font-size:11px;color:var(--muted)}
.statusbar .ready{display:flex;align-items:center;gap:6px}
.statusbar .dot{width:8px;height:8px;border-radius:50%;background:var(--ok);display:inline-block}
</style>
</head>
<body>
<div class="app" id="app" data-od-id="samhmi-editor" data-od-ref="${SHELL_REFS.root}">
  <header class="menubar" data-od-ref="${SHELL_REFS.menubar}">
    <div class="brand"><span class="logo">S</span>${escapeHtml(isZh ? "SamHMI" : "SamHMI")}</div>
    <nav class="menu-items">
      <button>${escapeHtml(isZh ? "文件" : "File")}</button>
      <button>${escapeHtml(isZh ? "编辑" : "Edit")}</button>
      <button>${escapeHtml(isZh ? "运行" : "Run")}</button>
      <button>${escapeHtml(isZh ? "设置" : "Settings")}</button>
    </nav>
    <div class="project-path" title="工程路径">D:\\SamHMI\\Runtime\\HMIProjects\\hmi</div>
    <div class="win-ctl"><button>—</button><button>□</button><button class="close">×</button></div>
  </header>
  <div class="main">
    <aside class="tree" data-od-ref="${SHELL_REFS.tree}">
      <div class="tree-head"><span>▦ ${escapeHtml(isZh ? "项目树" : "Project")}</span><span class="pin">◆ ×</span></div>
      <div class="tree-body" id="treeBody">
${treeRows}
      </div>
    </aside>
    <main class="workspace" data-od-ref="${SHELL_REFS.workspace}">
      <div class="tabbar">
        <div class="tab active">${escapeHtml(isZh ? "画面_7" : "Screen_7")}<span class="x">×</span></div>
        <div class="tab">${escapeHtml(isZh ? "控件详情" : "Control detail")}<span class="x">×</span></div>
        <div class="tabbar-spacer"></div><div class="newtab" title="新建画面">＋</div>
      </div>
      <div class="canvas">
        <div class="stage">
          <div class="stage-head">
            <span class="stage-title">${escapeHtml(title)}</span>
            <span class="stage-sub">${escapeHtml(taskId)} · 1920×1080</span>
          </div>
          <div class="stage-body">
${preview || "        <div class=\"card\"><div class=\"card-title\">标准模板控件详情</div><div class=\"demo-row\">1920 × 1080</div></div>"}
          </div>
        </div>
      </div>
    </main>
    <aside class="panel" data-od-ref="${SHELL_REFS.inspector}">
      <div class="panel-head"><div class="wn">${escapeHtml(isZh ? "属性" : "Inspector")}</div><div class="wl">${escapeHtml(isZh ? "画面_7 · 设计规范" : "Screen_7 · Design spec")}</div></div>
      <div class="p-tabs">
        <div class="p-tab active">${escapeHtml(isZh ? "属性参数" : "Params")}</div>
        <div class="p-tab">${escapeHtml(isZh ? "交互事件" : "Events")}</div>
        <div class="p-tab">${escapeHtml(isZh ? "安全" : "Safety")}</div>
      </div>
      <div class="panel-body">
        <div class="section"><div class="sec-head">${escapeHtml(isZh ? "画面属性" : "Screen props")}</div>
          <div class="field"><span class="k">${escapeHtml(isZh ? "名称" : "Name")}</span><span class="v">${escapeHtml(taskId)}</span></div>
          <div class="field"><span class="k">${escapeHtml(isZh ? "分辨率" : "Resolution")}</span><span class="v">1920 × 1080</span></div>
        </div>
        <div class="section"><div class="sec-head">${escapeHtml(isZh ? "色板" : "Palette")}</div>
          <div class="swatches">
${colorSwatches || "            <div class=\"swatch\" style=\"background:var(--canvas)\">#CAD7E7</div>"}
          </div>
        </div>
        <div class="section"><div class="sec-head">${escapeHtml(isZh ? "状态语义" : "States")}</div>
          <div class="field"><span class="k">${escapeHtml(isZh ? "正常" : "OK")}</span><span class="v" style="color:var(--ok)">${escapeHtml(sem.ok)}</span></div>
          <div class="field"><span class="k">${escapeHtml(isZh ? "警告" : "Warn")}</span><span class="v" style="color:var(--warn)">${escapeHtml(sem.warn)}</span></div>
          <div class="field"><span class="k">${escapeHtml(isZh ? "报警" : "Alert")}</span><span class="v" style="color:var(--alert)">${escapeHtml(sem.alert)}</span></div>
          <div class="field"><span class="k">${escapeHtml(isZh ? "操作" : "Accent")}</span><span class="v" style="color:var(--accent)">${escapeHtml(sem.accent)}</span></div>
        </div>
      </div>
    </aside>
  </div>
  <section class="output" data-od-ref="${SHELL_REFS.output}">
    <div class="out-row"><span class="ts">14:23:40</span><span class="lv">✓</span><span>${escapeHtml(isZh ? "画面校验通过 · 38 个引用有效" : "Screen validated · 38 refs valid")}</span></div>
    <div class="out-row"><span class="ts">14:23:41</span><span class="lv w">⚠</span><span>${escapeHtml(isZh ? "安全策略预检通过" : "Safety preflight passed")}</span></div>
  </section>
  <footer class="statusbar" data-od-ref="${SHELL_REFS.statusbar}">
    <span class="ready"><span class="dot"></span>${escapeHtml(isZh ? "就绪" : "Ready")}</span>
    <div style="display:flex;gap:16px"><span>${escapeHtml(isZh ? "光标位置: 行 1, 列 1" : "Cursor: line 1, col 1")}</span><span>Lua · UTF-8</span></div>
  </footer>
</div>
</body>
</html>
`;
}

// Entry builder — deterministic HTML from DSL + brief.
function buildHtml(brief, opts) {
  opts = opts || {};
  const dsl = brief.dsl;
  const tokens = buildBrandTokens(dsl, { lang: opts.lang });
  return renderSamHmiHtml(brief, tokens, opts);
}

module.exports = {
  buildHtml,
  renderSamHmiHtml,
  buildBrandTokens,
  escapeHtml,
};
