# Assets

Cortex Agent 文档体系使用的静态资源（图片、SVG 演示、图标等）。

| 文件 | 类型 | 用途 |
| --- | --- | --- |
| `quick-start.svg` | SVG 动画 | README "快速开始" 节演示 5 步上手流程（CSS keyframes，无 JS 依赖） |

| `coordinator-dispatch.html` | Anime.js Web 原型 | Coordinator 多 agent 调度流程可交互演示（本地打开，无构建步骤） |

> 资源统一放这里，README / docs/*.md 用相对路径引用，例如 `../assets/quick-start.svg`。
> 新增资源时在本表追加一行，并保证符合 knowledge-lint 的 missing-README 检查。

---

## Rive 资源说明

[Rive](https://rive.app) 是一个用于创建高保真交互动画的工具，其 `.riv` 文件需要通过 `@rive-app/canvas` 加载。

评估结论详见 `docs/architecture/animation-library-evaluation.md`。

### 加载方式（CDN，无构建步骤）

```html
<script src="https://unpkg.com/@rive-app/canvas@latest/rive.js"></script>
<canvas id="rive-canvas" width="500" height="500"></canvas>
<script>
  const r = new rive.Rive({
    src: 'your-animation.riv',
    canvas: document.getElementById('rive-canvas'),
    autoplay: true,
    stateMachines: 'StateMachineName',
  });
</script>
```

### 加载方式（npm）

```bash
npm install @rive-app/canvas
```

```js
import { Rive } from '@rive-app/canvas';

const r = new Rive({
  src: '/assets/your-animation.riv',
  canvas: document.getElementById('rive-canvas'),
  autoplay: true,
});
```

### GitHub README 注意事项

- `.riv` 文件不能直接在 GitHub README 中渲染
- 应导出为 GIF / MP4 / PNG 作为 README 的静态 fallback
- 可交互版本放在 docs site 或独立 HTML 页面

### 候选升级路径

1. `quick-start.svg` → `quick-start.riv`：加入 hover 重放 + 跳步能力（T-A02）
2. Coordinator 调度演示 → `.riv` 状态机动画（T-A03，依赖 T-A01 试用验证）
