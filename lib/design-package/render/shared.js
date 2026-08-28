"use strict";

// Shared rendering helpers for board / page / dual renderers.
// All HTML is self-contained (no external script, no network, no CDN).
// Inputs are design-scene.v1 (see lib/design-package/scene.js).

function escapeHtml(value) {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

// Render a single scene node as a self-contained inline-styled <div>.
// Stable order; identical inputs produce identical output.
function renderNode(node, originX, originY) {
  if (!node || node.renderable === false) return "";
  if (node.visible === false) return "";
  const left = num(node.x) - num(originX);
  const top = num(node.y) - num(originY);
  const w = num(node.w);
  const h = num(node.h);
  const radius = num(node.style && node.style.radius);
  const fill = (node.style && node.style.fill) || "transparent";
  const attrs = `data-pixso-id="${escapeHtml(node.id)}" data-pixso-type="${escapeHtml(node.type)}" data-pixso-name="${escapeHtml(node.name)}"`;
  if (node.type === "TEXT") {
    const fontSize = num(node.content && node.content.fontSize) || 14;
    const fontFamily = (node.content && node.content.fontFamily) || "Noto Sans SC";
    const color = fill && fill !== "transparent" ? fill : "#1F2D41";
    const lineHeight = Math.max(fontSize, h || fontSize);
    return `<div class="pixso-node pixso-text" ${attrs} style="left:${left}px;top:${top}px;width:${w}px;height:${h}px;color:${escapeHtml(color)};background:transparent;font:${fontSize}px/${lineHeight}px ${escapeHtml(fontFamily)};overflow:hidden">${escapeHtml((node.content && node.content.text) || "")}</div>`;
  }
  if (node.type === "ELLIPSE") {
    return `<div class="pixso-node pixso-ellipse" ${attrs} style="left:${left}px;top:${top}px;width:${w}px;height:${h}px;background:${escapeHtml(fill)};border-radius:${Math.min(w, h) / 2}px"></div>`;
  }
  return `<div class="pixso-node pixso-frame" ${attrs} style="left:${left}px;top:${top}px;width:${w}px;height:${h}px;background:${escapeHtml(fill)};border-radius:${radius}px"></div>`;
}

// Render a flat list of scene nodes positioned relative to an origin.
function renderSceneNodes(scene, origin) {
  const originX = origin ? num(origin.x) : 0;
  const originY = origin ? num(origin.y) : 0;
  return (scene.nodes || [])
    .filter((n) => n.renderable && n.visible !== false)
    .map((n) => renderNode(n, originX, originY))
    .join("\n");
}

// Return scene nodes that belong to the page subtree (page node + all its
// descendants). Geometry is irrelevant here; the page identity is established
// by parent chain and the 1920x1080 constraint validated upstream.
function nodesWithinBounds(scene, page) {
  if (!scene || !page) return [];
  const all = Array.isArray(scene.nodes) ? scene.nodes : [];
  const childMap = new Map();
  for (const n of all) {
    if (!n || !n.parentId) continue;
    const list = childMap.get(n.parentId) || [];
    list.push(n);
    childMap.set(n.parentId, list);
  }
  const result = [];
  const stack = [page];
  while (stack.length > 0) {
    const cur = stack.pop();
    if (!cur) continue;
    if (cur.renderable !== false && cur.visible !== false) result.push(cur);
    const kids = childMap.get(cur.id) || [];
    for (const k of kids) stack.push(k);
  }
  return result;
}

// Render a scene node tree listing (id + name + type) for board sidebar.
function renderTree(scene, lang) {
  const isZh = lang !== "en";
  if (!scene || !Array.isArray(scene.nodes)) return "";
  const roots = scene.nodes.filter((n) => n.depth === 0);
  const out = [];
  out.push(`<ul class="pixso-tree" data-pixso-tree>`);
  for (const root of roots) {
    out.push(`<li><span class="pixso-tree-name" data-pixso-jump="${escapeHtml(root.id)}">${escapeHtml(root.name || root.type)}</span></li>`);
    const stack = [root];
    while (stack.length > 0) {
      const cur = stack.shift();
      const children = scene.nodes.filter((n) => n.parentId === cur.id);
      if (children.length > 0) {
        out.push(`<ul>`);
        for (const c of children) {
          out.push(`<li><span class="pixso-tree-name" data-pixso-jump="${escapeHtml(c.id)}">${escapeHtml(c.name || c.type)}</span></li>`);
          stack.push(c);
        }
        out.push(`</ul>`);
      }
    }
  }
  out.push(`</ul>`);
  const placeholder = isZh ? "在树中定位节点…" : "Locate a node…";
  return `<div class="pixso-tree-search"><input type="text" placeholder="${escapeHtml(placeholder)}" data-pixso-tree-filter /></div>` + out.join("");
}

// Stable hash of a scene for cache-busting / evidence. Not cryptographic.
function sceneDigest(scene) {
  if (!scene || !Array.isArray(scene.nodes)) return "0";
  let h = 0;
  for (const n of scene.nodes) {
    const s = `${n.id}|${n.type}|${n.x}|${n.y}|${n.w}|${n.h}|${n.depth}`;
    for (let i = 0; i < s.length; i += 1) {
      h = ((h * 31) + s.charCodeAt(i)) | 0;
    }
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

// Common inline chrome: doctype, head, shell scaffold, generic styles.
function htmlChrome({ title, lang, isZh, bodyClass, bodyAttrs, headExtra, bodyExtra }) {
  const css = `:root{--bg:#FAFAFA;--surface:#FFFFFF;--fg:#1F2D41;--muted:#5A6675;--border:#DADEE4;--accent:#2F6DEB;--canvas:#CAD7E7;--font:"Noto Sans SC","PingFang SC","Microsoft YaHei",system-ui,sans-serif;--mono:ui-monospace,"SF Mono","Cascadia Mono",Consolas,monospace;}
*{box-sizing:border-box;margin:0;padding:0}
html,body{height:100%}
body{background:#2b3542;font-family:var(--font);color:var(--fg);overflow:hidden;-webkit-font-smoothing:antialiased}
.od-shell{height:100%;display:flex;flex-direction:column}
.od-toolbar{height:36px;flex:0 0 36px;background:#1F2D41;color:#E2E7EF;display:flex;align-items:center;padding:0 12px;gap:12px;font-size:12px;font-family:var(--mono)}
.od-toolbar .label{opacity:.7}
.od-toolbar button{padding:2px 8px;border-radius:4px;background:#2F6DE8;color:#fff;border:none;font:inherit;cursor:pointer}
.od-toolbar button:hover{background:#396CEC}
.od-toolbar input{padding:2px 6px;border-radius:4px;border:1px solid #444;border:none;background:#0e1620;color:#fff;font:inherit;width:160px}
.od-stage{flex:1;position:relative;background:#E2E7EF;overflow:hidden}
.od-sidebar{position:absolute;top:8px;right:8px;width:280px;max-height:calc(100% - 16px);background:rgba(255,255,255,.96);border:1px solid #DADEE4;border-radius:6px;box-shadow:0 6px 24px rgba(0,0,0,.18);font-size:12px;overflow:hidden;display:flex;flex-direction:column}
.od-sidebar-head{padding:8px 10px;border-bottom:1px solid #DADEE4;font-weight:600;background:#F4F7FA}
.od-sidebar-body{flex:1;overflow:auto;padding:8px 10px}
.od-viewport{position:absolute;inset:0;overflow:hidden;cursor:grab}
.od-viewport.dragging{cursor:grabbing}
.od-canvas{position:absolute;top:0;left:0;transform-origin:0 0;background:#FFFFFF;box-shadow:0 8px 32px rgba(0,0,0,.18)}
.od-canvas.mode-1-1{cursor:default}
.pixso-node{position:absolute;box-sizing:border-box;overflow:hidden}
.pixso-text{padding:0 2px;line-height:1.2}
.pixso-tree{padding:0;margin:0;list-style:none}
.pixso-tree ul{padding-left:14px;margin:0;list-style:none}
.pixso-tree li{line-height:18px}
.pixso-tree-name{cursor:pointer;color:#1F2D41}
.pixso-tree-name:hover{color:#2F6DE8;text-decoration:underline}
.pixso-tree-search{padding:4px 0 8px}
.pixso-tree-search input{width:100%;padding:4px 6px;border:1px solid #DADEE4;border-radius:4px;font:inherit}
.pixso-selected{outline:2px solid #2F6DE8;outline-offset:-2px}
.pixso-coverage{font-family:var(--mono);font-size:11px;color:#5A6675;line-height:1.5}
.pixso-coverage .bad{color:#D94F4F}
`;
  const head = `<!DOCTYPE html>
<html lang="${isZh ? "zh-CN" : "en"}">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(title)}</title>
<style>${css}</style>
${headExtra || ""}
</head>
<body class="${escapeHtml(bodyClass || "")}" ${bodyAttrs || ""}>
${bodyExtra || ""}`;
  return head;
}

function htmlClose() {
  return `</body>
</html>
`;
}

module.exports = {
  escapeHtml,
  renderNode,
  renderSceneNodes,
  nodesWithinBounds,
  renderTree,
  sceneDigest,
  htmlChrome,
  htmlClose,
};