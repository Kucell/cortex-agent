"use strict";

// Page renderer: 1:1 selected 1920x1080 page frame.

const shared = require("./shared");

function renderPageHtml(brief, scene, page, opts) {
  opts = opts || {};
  const isZh = opts.lang !== "en";
  const title = (brief && brief.title) || page.name || "Design Page";
  const taskId = (brief && brief.taskId) || "PAGE";
  const nodes = shared.nodesWithinBounds(scene, page);
  const coverage = scene.coverage || {};
  const nodesHtml = nodes
    .map((n) => shared.renderNode(n, page.x, page.y))
    .join("\n");
  const labelZoom = (label) => { return label; };
  const inlineJs = `<script>
(function(){
  var viewport = document.querySelector('[data-od-viewport]');
  var canvas = document.querySelector('[data-od-canvas]');
  var stage = document.querySelector('[data-od-stage]');
  var label = document.querySelector('[data-od-zoom]');
  if(!viewport || !canvas || !stage){return;}
  var scale = 1, ty = 0, tx = 0;
  function apply(){
    canvas.style.transform = 'translate(' + tx + 'px,' + ty + 'px) scale(' + scale + ')';
    canvas.style.width = 1920 + 'px';
    canvas.style.height = 1080 + 'px';
    if(label){label.textContent = (Math.round(scale * 1000) / 10).toFixed(1) + '%';}
  }
  viewport.addEventListener('wheel', function(e){
    e.preventDefault();
    var factor = (e.deltaY < 0) ? 1.1 : 1/1.1;
    scale = Math.max(0.25, Math.min(4, scale * factor));
    apply();
  }, {passive:false});
  function fit(){
    var r = stage.getBoundingClientRect();
    var sFit = Math.min(r.width / 1920, r.height / 1080) * 0.95;
    scale = (sFit > 0 && isFinite(sFit)) ? sFit : 1;
    apply();
  }
  document.querySelector('[data-od-fit]') && document.querySelector('[data-od-fit]').addEventListener('click', fit);
  document.querySelector('[data-od-reset]') && document.querySelector('[data-od-reset]').addEventListener('click', function(){scale=1;tx=0;ty=0;apply();});
  window.addEventListener('resize', fit);
  fit();
})();
</script>`;
  const bodyClass = "od-shell-host";
  const bodyExtra = `<div class="od-shell">
<div class="od-toolbar">
<span class="label">${shared.escapeHtml(isZh ? "页面" : "Page")}:</span>
<span>${shared.escapeHtml(title)}</span>
<span class="label">${shared.escapeHtml(isZh ? "尺寸" : "Size")}:</span>
<span>1920 × 1080</span>
<span class="label">${shared.escapeHtml(isZh ? "缩放" : "Zoom")}:</span>
<span data-od-zoom>100%</span>
<button type="button" data-od-fit>${shared.escapeHtml(isZh ? "适配" : "Fit")}</button>
<button type="button" data-od-reset>100%</button>
<span class="label">${shared.escapeHtml(isZh ? "任务" : "Task")}:</span>
<span>${shared.escapeHtml(taskId)}</span>
<span class="label">${shared.escapeHtml(isZh ? "源" : "Source")}:</span>
<span>${shared.escapeHtml((scene.source && scene.source.provider) || "unknown")}</span>
</div>
<div class="od-stage" data-od-stage>
<div class="od-viewport od-canvas mode-1-1" data-od-viewport>
<div class="od-canvas" data-od-canvas style="position:absolute;top:0;left:0;width:1920px;height:1080px;background:#FFFFFF">
${nodesHtml}
</div>
</div>
</div>
</div>
${inlineJs}`;
  return shared.htmlChrome({
    title,
    lang: opts.lang,
    isZh,
    bodyClass,
    bodyAttrs: 'data-od-render-mode="page" data-od-page-id="' + shared.escapeHtml(page.id) + '" data-od-source="' + shared.escapeHtml((scene.source && scene.source.provider) || "unknown") + '"',
    bodyExtra,
  }) + shared.htmlClose();
}

module.exports = { renderPageHtml };