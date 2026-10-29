---
module: visualize-charts
module_path: .agent/references/visualize/charts.md
module_type: "Visualize Charts Handbook (上游 vendored)"
keywords: [visualize, charts, chartjs, svg, dsh-visualize, upstream]
status: stable
owner: cortex-agent
last_verified: 2026-08-20
verified_by: cortex-agent maintainers
sources:
  - https://github.com/Nagi-ovo/dsh-visualize/blob/main/assets/references/charts.md
  - https://github.com/Nagi-ovo/dsh-visualize/blob/main/LICENSE
summary: "Chart.js-first charting handbook + hand-rolled SVG rules — vendored from Nagi-ovo/dsh-visualize (BSD-3-Clause)"
---

# Charts — Chart.js + Hand-rolled SVG (vendored)

> **Source**: https://github.com/Nagi-ovo/dsh-visualize/blob/main/assets/references/charts.md
> **License**: BSD-3-Clause (Copyright (c) 2026 Jesse Zhang)
> **Vendored by**: cortex-agent on 2026-08-20

The text below is the upstream charts reference, vendored verbatim. It defines
the Chart.js setup, theme-color resolution, entrance animation recipes, and
hand-rolled SVG rules for inline-HTML fragments.

> **Note on examples**: The upstream `examples/interactive-simulator.html` and
> `examples/comparison-chart.html` are NOT vendored (license + size
> considerations). Their structure is described below; if you need the actual
> files, fetch them directly from upstream.

---

# Charts

## Choosing the tool

- **Standard chart shapes** — line, area, bar, scatter, doughnut — use
  Chart.js, starting from `../examples/interactive-simulator.html`. The
  library owns axis layout, tick spacing, and label collision, and its first
  render animates by default (lines sweep in, bars grow), so charts arrive
  with the entrance the design calls for at zero extra code. A curve with a
  baseline annotation or a second comparison series is still standard.
- **Custom visuals** — bespoke diagrams, spatial layouts, anything a chart
  library genuinely cannot express — hand-roll SVG per the rules below,
  starting from `../examples/comparison-chart.html`.
- D3 (pinned: `https://cdn.jsdelivr.net/npm/d3@7.9.0/dist/d3.min.js`) remains
  available for data-heavy custom work: scales, shapes, and geo projections.

## Chart.js setup

Load the pinned build:

```html
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.js"></script>
```

Canvas cannot resolve CSS variables — `'var(--viz-series-1)'` passed to
Chart.js silently paints nothing. Resolve tokens through a probe element
first:

```js
function themeColor(token) {
  var probe = document.createElement('span');
  probe.style.color = 'var(' + token + ')';
  document.body.appendChild(probe);
  var resolved = getComputedStyle(probe).color;
  probe.remove();
  return resolved;
}
Chart.defaults.color = themeColor('--muted-foreground');
Chart.defaults.borderColor = themeColor('--border');
Chart.defaults.font.family = 'inherit';
```

- Size through the container: a wrapping `div` with an explicit height and
  `responsive: true, maintainAspectRatio: false` in the chart options. Never
  fix the canvas width.
- First render animates by itself — do not disable it. Control-driven changes
  go through `chart.data` mutation + `chart.update()`, which transitions in
  place instead of replaying the entrance. Exactly the wanted behavior, free.
- Give the entrance two beats: a ~300ms fade on the chart container lets the
  axes settle first, then the data sweeps across them. One CSS `@keyframes`
  on the wrapper, as in the simulator example.
- A gradient area fill under a single measure: build a canvas gradient from
  the resolved series color at ~0.25 alpha down to transparent and set it as
  the dataset `backgroundColor` with `fill: true`.
- Tooltips and legends come themed via the defaults above; drop the legend
  entirely for a single series.

## Hand-rolled SVG rules

- Compute the domain from the data with padding; never hard-code it.
- Size from the measured container and redraw on `ResizeObserver`.
- Keep every mark inside the plot area; clip if a path can escape.
- After drawing, check that tick and value labels do not overlap; drop ticks
  or re-anchor labels rather than shipping a collision.
- Entrance, once: line draws in via `stroke-dashoffset` (~500ms ease-out),
  fills fade up behind it, labels after their marks. Guard with a flag so
  redraws never replay it; skip under `prefers-reduced-motion`.
- The soft vertical gradient under a single-measure curve (series color at
  ≈0.25 opacity fading to transparent) is the house look for area charts.