# cortex-agent × open-design 集成验证报告

> 验证日期：2026-09-01
> 验证人：DSH agent
> open-design 侧版本：daemon 0.21.1（Docker 镜像 ghcr.io/nexu-io/od:latest，2026-08-31 构建）
> cortex-agent 侧版本：1.13.0

## TL;DR

| 项 | 状态 | 说明 |
| --- | --- | --- |
| open-design 检测（motion doctor） | ✅ | `openDesign ✓ /usr/local/bin/open-design` |
| open-design 二进制可用 | ✅ | `/usr/local/bin/open-design` → `apps/daemon/bin/od.mjs`，需 PATH 里有 node |
| open-design daemon 健康 | ✅ | Docker 容器 healthy，`/api/health` 200 |
| **render 路径 A（daemon dispatch）** | ❌ **契约不匹配** | cortex-agent 调 `media generate --motion-id --preset`，open-design 不支持这两个 flag |
| render 路径 B（npx hyperframes fallback） | ⚠️ 不可达 | `selectRenderPath` 只要 `open-design` 在 PATH 就固定走路径 A，永不 fallback |
| motion doctor 整体 | ❌ | 仅因 `ffmpeg` 未在 PATH（实际已装于 /opt/homebrew/bin/ffmpeg） |

**结论：open-design 与 cortex-agent 的「检测/存在性」集成是通的；但「渲染派发」集成是断的，
且是 cortex-agent 侧的既有契约 bug，与本次 Docker/网关部署无关。**

## 详细结果

### 1. motion doctor（JSON）

```json
{
  "ok": false,
  "deps": {
    "node":       { "ok": true,  "version": "24.11.0" },
    "chrome":     { "ok": true,  "path": "/Applications/Google Chrome.app/..." },
    "ffmpeg":     { "ok": false, "path": null },
    "hyperframes":{ "ok": true,  "version": "0.8.6" },
    "openDesign": { "ok": true,  "path": "/usr/local/bin/open-design" }
  },
  "platform": { "id": "darwin-arm64", "supported": true }
}
```

- openDesign 检测通过：`lib/motion/doctor.js` 用 `findInPath("open-design")` 命中
  `/usr/local/bin/open-design`。
- `ok:false` 的唯一原因是 `ffmpeg`。但 ffmpeg **已安装**在 `/opt/homebrew/bin/ffmpeg`
  （v9.0.1）；doctor 未检测到是因为运行环境的 `PATH` 不含 `/opt/homebrew/bin`。
  用 `PATH=/opt/homebrew/bin:...` 重跑 doctor，ffmpeg 即显示 ✓。
  → 这是 PATH 环境问题，不是缺装。

### 2. render 路径 A 契约不匹配（核心发现）

cortex-agent 派发命令（`lib/motion/render.js:231`）：

```js
spawnChild("open-design", ["media","generate","--motion-id", motionId, "--preset", presetId])
```

open-design CLI 实际契约（`od media generate --help`）：

```
od media generate --surface <image|video|audio> --model <id> [opts]
```

实测：

```
$ open-design media generate --motion-id od-verify --preset fcp-1080p
unknown flag: --motion-id. Run with --help for the list of accepted flags.
```

**证据**：
- `grep -rln 'motion-id\|motionId' open-design/apps/daemon/{src,bin}` → 无任何命中。
- `git log -S 'motion-id' -- apps/daemon/src/cli.ts`（open-design 仓）→ 无提交。
- `git log -S '--preset' -- apps/daemon/src/cli.ts`（open-design 仓）→ 无提交。

→ open-design **从未**支持 `--motion-id` / `--preset`。cortex-agent 的这两个 commit
引入了该错误调用：
- `ab00e57 feat(motion): add /motion workflow with HyperFrames engine (P-005 MS-005)`
- `09f8a8f fix(motion): align hyperframes CLI contract + composition attrs (P-005 pilot)`

即：render 路径 A 自 motion 功能（P-005）诞生起就指向一个不存在的 open-design CLI 接口，
属既有 bug，非本次部署引入。

### 3. fallback 路径 B 不可达

`lib/motion/render.js:48` `selectRenderPath`：

```js
function selectRenderPath({ hasOpenDesign, hasNpx }) {
  if (hasOpenDesign) return "daemon";   // 只要 open-design 在 PATH 就走 daemon
  if (hasNpx) return "npx";
  ...
}
```

本机 `open-design` 在 PATH → 永远返回 `"daemon"` → 命中上面的契约 bug → render 失败。
npx/hyperframes fallback（路径 B）只在 `open-design` 不在 PATH 时才会被选中。

## 修复建议（cortex-agent 侧）

二选一：

1. **改派发命令对齐 open-design 真实契约**：`media generate` 需要 `--surface/--model`，
   而 cortex-agent 的 motion 渲染语义（motion-id + 编辑 preset）与 open-design 的
   媒体生成语义（surface + 生成 model）并不等价——需要先确认路径 A 究竟要做什么，
   再映射到正确子命令（或确认 open-design 是否另有 motion 渲染入口）。
2. **修正 `selectRenderPath`**：当 daemon dispatch 失败（未知 flag）时能回退到 npx，
   或在 detect 阶段就校验 `open-design media generate` 是否支持所需 flag。

另：doctor 的 ffmpeg 检测应不依赖调用方 PATH（可补充常见安装路径如
`/opt/homebrew/bin/ffmpeg`、`/usr/local/bin/ffmpeg`）。

## 复现命令

```bash
cd /Users/xueyq/myworks/cortex-agent
NODE=/Users/xueyq/.volta/tools/image/node/24.11.0/bin/node
PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin $NODE bin/cli.js motion doctor --json
PATH=... $NODE bin/cli.js motion scaffold --motion-id od-verify --template stat-counter
PATH=... $NODE bin/cli.js motion render --motion-id od-verify --preset fcp-1080p --yes
# → unknown flag: --motion-id
```
