"use strict";

// Board renderer: full design-scene root, pan + zoom + tree-jump.

const shared = require("./shared");

function renderBoardHtml(brief, scene, opts) {
  opts = opts || {};
  const isZh = opts.lang !== "en";
  const title = (brief && brief.title) || (scene.root && scene.root.name) || "Design Board";
  const taskId = (brief && brief.taskId) || "BOARD";
  const canvas = scene.canvas || { width: 0, height: 0 };
  const cw = canvas.width || 1;
  const ch = canvas.height || 1;
  const coverage = scene.coverage || {};
  const nodesHtml = shared.renderSceneNodes(scene, { x: 0, y: 0 });
  const treeHtml = shared.renderTree(scene, opts.lang);
  const sidebar = `<aside class="od-sidebar" data-od-sidebar>
<div class="od-sidebar-head">${escape(isZh ? "节点树" : "Node tree")}</div>
<div class="od-sidebar-body">
${treeHtml}
<div class="pixso-coverage" data-od-coverage>
${escape(isZh ? "已知节点" : "Known")}: ${coverage.knownNodes || 0}<br>
${escape(isZh ? "可绘制" : "Drawable")}: ${coverage.drawableNodes || 0}<br>
${escape(isZh ? "省略子树" : "Omitted")}: ${coverage.omittedSubtrees || 0}<br>
${escape(isZh ? "不支持类型" : "Unsupported")}: ${(coverage.unsupportedTypes || []).map(escape).join(", ") || (isZh ? "无" : "none")}
</div>
</div>
</aside>`;
  const inlineJs = `<script>
(function(){
  var viewport = document.querySelector('[data-od-viewport]');
  var canvas = document.querySelector('[data-od-canvas]');
  var stage = document.querySelector('[data-od-stage]');
  var label = document.querySelector('[data-od-zoom]');
  var filter = document.querySelector('[data-pixso-tree-filter]');
  if(!viewport || !canvas || !stage){return;}
  var cw = ${JSON.stringify(cw)};
  var ch = ${JSON.stringify(ch)};
  var scale = 1;
  var tx = 0, ty = 0;
  var dragging = false, sx = 0, sy = 0;
  function fit(){
    var r = stage.getBoundingClientRect();
    var sxFit = r.width / cw;
    var syFit = r.height / ch;
    scale = Math.min(sxFit, syFit) * 0.95;
    if(scale <= 0 || !isFinite(scale)){scale = 0.1;}
    tx = (r.width - cw * scale) / 2;
    ty = (r.height - ch * scale) / 2;
    apply();
  }
  function apply(){
    canvas.style.transform = 'translate(' + tx + 'px,' + ty + 'px) scale(' + scale + ')';
    canvas.style.width = cw + 'px';
    canvas.style.height = ch + 'px';
    if(label){label.textContent = (Math.round(scale * 1000) / 10).toFixed(1) + '%';}
  }
  viewport.addEventListener('wheel', function(e){
    e.preventDefault();
    var factor = (e.deltaY < 0) ? 1.1 : 1/1.1;
    var r = stage.getBoundingClientRect();
    var mx = e.clientX - r.left;
    var my = e.clientY - r.top;
    var wx = (mx - tx) / scale;
    var wy = (my - ty) / scale;
    scale = Math.max(0.05, Math.min(8, scale * factor));
    tx = mx - wx * scale;
    ty = my - wy * scale;
    apply();
  }, {passive:false});
  viewport.addEventListener('mousedown', function(e){
    if(e.target.closest('[data-od-sidebar]')){return;}
    dragging = true; sx = e.clientX - tx; sy = e.clientY - ty;
    viewport.classList.add('dragging');
  });
  window.addEventListener('mousemove', function(e){
    if(!dragging){return;}
    tx = e.clientX - sx; ty = e.clientY - sy; apply();
  });
  window.addEventListener('mouseup', function(){dragging = false; viewport.classList.remove('dragging');});
  function jumpTo(id){
    var node = document.querySelector('[data-pixso-id="' + id.replace(/"/g, '\\\\"') + '"]');
    if(!node){return;}
    var r = node.getBoundingClientRect();
    var sr = stage.getBoundingClientRect();
    tx = (sr.width - r.width * scale) / 2 - r.left + sr.left;
    ty = (sr.height - r.height * scale) / 2 - r.top + sr.top;
    apply();
    document.querySelectorAll('.pixso-selected').forEach(function(el){el.classList.remove('pixso-selected');});
    node.classList.add('pixso-selected');
  }
  document.querySelectorAll('[data-pixso-jump]').forEach(function(el){
    el.addEventListener('click', function(){ jumpTo(el.getAttribute('data-pixso-jump')); });
  });
  if(filter){
    filter.addEventListener('input', function(){
      var q = filter.value.toLowerCase();
      document.querySelectorAll('[data-pixso-tree] li').forEach(function(li){
        var txt = li.textContent.toLowerCase();
        li.style.display = (!q || txt.indexOf(q) !== -1) ? '' : 'none';
      });
    });
  }
  window.addEventListener('resize', fit);
  fit();
})();
</script>`;
  const bodyClass = "od-shell-host";
  const bodyExtra = `<div class="od-shell">
<div class="od-toolbar">
<span class="label">${escape(isZh ? "设计板" : "Board")}:</span>
<span>${escape(title)}</span>
<span class="label">${escape(isZh ? "尺寸" : "Size")}:</span>
<span>${cw} × ${ch}</span>
<span class="label">${escape(isZh ? "缩放" : "Zoom")}:</span>
<span data-od-zoom>100%</span>
<button type="button" data-od-fit>${escape(isZh ? "适配" : "Fit")}</button>
<button type="button" data-od-reset>100%</button>
<span class="label">${escape(isZh ? "任务" : "Task")}:</span>
<span>${escape(taskId)}</span>
</div>
<div class="od-stage" data-od-stage>
<div class="od-viewport" data-od-viewport>
<div class="od-canvas" data-od-canvas style="position:absolute;top:0;left:0">
${nodesHtml}
</div>
${sidebar}
</div>
</div>
</div>
${inlineJs}`;
  let out = shared.htmlChrome({
    title,
    lang: opts.lang,
    isZh,
    bodyClass,
    bodyAttrs: 'data-od-render-mode="board" data-od-source="' + escape(scene.source && scene.source.provider ? scene.source.provider : "unknown") + '"',
    bodyExtra,
  });
  // Wire the Fit / Reset buttons in the inline JS too.
  out = out.replace("</script>", "document.querySelector('[data-od-fit]') && document.querySelector('[data-od-fit]').addEventListener('click', fit);\ndocument.querySelector('[data-od-reset]') && document.querySelector('[data-od-reset]').addEventListener('click', function(){scale=1;tx=0;ty=0;apply();});\n</script>");
  return out + shared.htmlClose();
}

function escape(value) {
  return shared.escapeHtml(value);
}

module.exports = { renderBoardHtml };