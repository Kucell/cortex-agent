# Motion — 动效第 5 平面(HyperFrames)

> 品牌配色驱动动效 → 生成 + 实时预览 → 导出 MP4 直接拖进剪辑(Final Cut Pro / Premiere / 剪映 / CapCut / DaVinci Resolve),成片级质量。
>
> 引擎:[heygen-com/hyperframes](https://github.com/heygen-com/hyperframes)(Apache-2.0,"Write HTML. Render video. Built for agents.")。cortex-agent 只做编排 + 品牌绑定 + 剪辑协议 + 质量门(P-005 / D-ODI-004)。
>
> 命令入口:`cortex-agent motion {scaffold, style-tokens, lint, check, snapshot, preview, render, verify, presets, doctor}`

---

## 第 5 平面是什么

cortex-agent 已有 4 个平面:**plugin / skill / template / design-system**。动效(motion graphics)是第 5 平面:

| 平面 | 产物 | 命令 |
| :--- | :--- | :--- |
| plugin | 可执行工作流 | `cortex-agent plugin` |
| skill | 可复用技能 | `cortex-agent skill` |
| template | 内容模板 | `cortex-agent design template` |
| design-system | 视觉规范(DESIGN.md) | `cortex-agent design` |
| **motion(本平面)** | **HTML+CSS+GSAP → 确定性 MP4** | `cortex-agent motion` |

用户原话:"动态图形就是用 Hyperframes 在 OpenDesign 里做的:他用自己的品牌配色描述想要的效果,OpenDesign 便生成出来、实时预览,再导出成 MP4 — 直接拖进剪辑就能用,而且是他的观众所期待的那种成片级质量。"

## 数据布局

```text
.agent/motion/
├── .gitignore                 # 隐藏 .hyperframes-cache/(引擎缓存,不提交)
├── README.md                  # 本文档
├── style-tokens/
│   └── <design-system-id>.json # DESIGN.md → motion style tokens(HARD-GATE 产物)
└── <motion-id>/               # composition(只编辑 index.html 一处)
    ├── brief.md               # 用户品牌语言描述 → 结构化 brief(系统生成,锁定)
    ├── DESIGN.md              # 最小可溯源 DESIGN.md(系统生成,锁定)
    ├── hyperframes.json       # HF composition 契约(上游格式,锁定)
    ├── meta.json              # HF 元数据(锁定)
    ├── index.html             # HTML+CSS+GSAP ★ 唯一编辑对象
    ├── snapshots/
    │   └── contact-sheet.png  # proof 帧(渲染门控输入)
    └── renders/
        ├── <motion-id>-<preset>.mp4   # 交付级(ProRes / H.264 / WebM)
        └── render-manifest.json       # 质量矩阵 + 确定性哈希(审计)
```

## 工作流(Quick start)

```bash
# 0. 依赖检测(Chrome / FFmpeg / hyperframes / open-design daemon)
cortex-agent motion doctor

# 1. 脚手架起步(不 from scratch,秒级)
cortex-agent motion scaffold --motion-id m-001 --template kobe-lite --style <design-system-id>

# 2. 品牌门控:DESIGN.md → motion style tokens(HARD-GATE 产物)
cortex-agent motion style-tokens --motion-id m-001 --design-system <design-system-id>

# 3. 只编辑 .agent/motion/m-001/index.html(1-3 个 clip div + GSAP tween)

# 4. 静态校验(lint/check 可在 shell 直接跑)
cortex-agent motion lint --motion-id m-001
cortex-agent motion check --motion-id m-001

# 5. 实时预览(live reload)
cortex-agent motion preview --motion-id m-001

# 6. proof 帧(渲染门控:看过 contact-sheet 才渲染)
cortex-agent motion snapshot --motion-id m-001

# 7. 用户批准渲染(approve gate,不自动跑)
cortex-agent motion render --motion-id m-001 --preset fcp-4k --yes

# 8. ffprobe 质量门
cortex-agent motion verify --motion-id m-001 --preset fcp-4k
```

## 品牌驱动链路(HARD-GATE)

```
用户品牌语言描述 → DESIGN.md 4-level cascade → motion style tokens → HARD-GATE 校验
(调色板/字体可溯源) → composition(index.html) → 实时预览/snapshot → 用户批准 → 确定性渲染 → MP4
```

- **Visual Identity Gate**:每个 composition 的调色板 / 字体必须可溯源到 `style-tokens/<id>.json`(`derived_from` = DESIGN.md SHA-256)
- **3 个情绪问题**(渲染前必须回答,写入 brief.md):
  1. 这支动效想让观众**感觉**什么?(克制 / 兴奋 / 信任 / 惊喜 …)
  2. 画面应该是**明亮 / 暗调 / 中间调**?
  3. 只允许出现**一个品牌色**,它是什么?
- 来源优先级:① cascade 生效 DESIGN.md → ② 用户点名风格 → ③ 3 情绪问题兜底生成最小 DESIGN.md

## 质量矩阵(成片级)

| 维度 | 门槛 | 验证 |
| :--- | :--- | :--- |
| 确定性 | 同输入同输出 | render-manifest.json 含 indexHtmlSha256 |
| 帧率 | 24/25/30/60(按 preset) | manifest.render.fps + `motion verify` |
| 分辨率 | 1080p / 4K / 竖屏 9:16 | manifest + ffprobe |
| 编码 | ProRes / H.264 / VP9 | manifest + ffprobe |
| Alpha | WebM(VP9)/ MOV(ProRes 4444) | ffprobe pix_fmt 含 `yuva` |
| 色彩 | sRGB 默认,P3 可选 | `--color-space p3` flag |
| 动效 | 运动曲线可溯源到 style-tokens | HARD-GATE + `motion lint` |
| 视觉 | proof 帧人工确认 | `motion snapshot` + 用户 approve |
| 时长 | 与 brief 一致(±0.5s) | manifest.durationSec |
| 文件 | 大小合理、可播放 | `motion verify`(ffprobe) |

## 剪辑预设矩阵(拖进剪辑即用)

| preset id | 目标 | 编码 | 分辨率 | 帧率 | Alpha |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `fcp-1080p` | Final Cut Pro / DaVinci | ProRes 422 (yuv422p10le) | 1920×1080 | 24 | ❌ |
| `fcp-4k` | Final Cut Pro / DaVinci | ProRes 422 (yuv422p10le) | 3840×2160 | 24 | ❌ |
| `pp-1080p` | Premiere Pro / 剪映 / CapCut | H.264 High | 1920×1080 | 30 | ❌ |
| `pp-4k` | Premiere Pro | H.264 High | 3840×2160 | 30 | ❌ |
| `jianying-1080p` | 剪映 / CapCut 竖屏 | H.264 High | 1080×1920 | 30 | ❌ |
| `vertical-9x16` | TikTok / Reels / 抖音 / 快手 | H.264 High | 1080×1920 | 30 | ❌ |
| `overlay-webm` | Premiere / 剪映 / FCP 上叠 | VP9 (yuva420p) | 1920×1080 | 30 | ✅ |
| `overlay-mov` | FCP / DaVinci 专业后期 | ProRes 4444 (yuva444p10le) | 1920×1080 | 24 | ✅ |

> 注:ProRes / VP9 / WebM 免费编解码默认;H.264 需 FFmpeg 编译支持。透明 overlay 在 QuickTime 可能显示黑底(Premiere / 剪映 / FCP 支持)。

## 渲染路径

| 路径 | 谁跑 | 何时用 | 说明 |
| :--- | :--- | :--- | :--- |
| **A. open-design daemon dispatch**(默认,推荐) | daemon 无沙箱进程 | 有 OD daemon | `open-design media generate --motion-id <id> --preset <p>`,Chrome 不被 sandbox-exec 挂起 |
| B. `npx hyperframes render` 直跑 | 用户 shell | 无 OD daemon | 降级;Claude Code sandbox-exec 环境输出警告 |

> **为什么必须 daemon 渲染(实证)**:Claude Code 等 agent CLI 的 Bash 被 macOS sandbox-exec 包裹,puppeteer 的 Chrome 子进程在帧捕获中途挂起。daemon 进程无沙箱,渲染可靠完成。

## 编辑最小面(P-005 §4.5)

只改 `index.html` 一处,其余文件(`hyperframes.json` / `meta.json` / `DESIGN.md` / `brief.md`)由系统生成,锁定:

1. **Layout Before Animation**:先定位每个元素的 **hero frame** → 写静态 CSS
2. `.scene-content`:`width:100%; height:100%; padding:Npx; display:flex; flex-direction:column; gap:Npx; box-sizing:border-box`(禁止 absolute 定位内容容器)
3. 入场用 `gsap.from()`,出场用 `gsap.to()`;CSS 位置是 ground truth,tween 描述 journey
4. 编辑最小面:`data-duration`(根元素)+ `<style>` 调色板(用 style-tokens)+ 1-3 个 clip `<div>` + `window.__timelines["main"]` 里加 tween

## 渲染门控(approve gate)

渲染是**用户门控动作**,不自动跑:

1. `motion snapshot` 产出 proof 帧 contact-sheet
2. 用户查看 proof 帧,说"渲染"
3. `motion render --preset <id> --yes` 才进入渲染(非 TTY 环境必须 `--yes`)

## 安全模型

- **BYOK keyRef**:密钥只引用环境变量名(`keyRef`),绝不写入 manifest / brief / DESIGN.md
- **.gitignore**:`.hyperframes-cache/` 不入库;只有 `renders/*.mp4` 交付物可入库
- **零 npm 依赖**:`bin/cli.js` 与 `lib/motion/*` 只用 Node.js 内置模块;open-design / npx / ffmpeg / python3 / Chrome 是外部命令,`motion doctor` 检测缺失并给安装指引
- **平台**:HyperFrames 要求 macOS Apple Silicon / Linux x64;Windows 走 open-design Docker / daemon

## 范围外(Out of Scope)

- ❌ AI 视频生成(t2v/i2v)— 走 BYOK 模型路由(Seedance / Veo / Sora),不是本平面
- ❌ 音频混音 / 配音 — HyperFrames `/hyperframes-audio` + media-use 职责
- ❌ 重写 HyperFrames 引擎 — 直接依赖上游 20 skills

## 相关

- P-005 提案:`.agent/plans/proposals/projects/open-design-integration/proposals/P-005-motion-graphics-hyperframes-proposal.md`
- D-ODI-004 决策:`.agent/plans/proposals/projects/open-design-integration/decisions/D-ODI-004.md`
- 架构文档:`docs/architecture/motion-workflow-design.md`
- 上游:[heygen-com/hyperframes](https://github.com/heygen-com/hyperframes)
