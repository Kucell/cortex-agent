---
name: proposal-share
description: "导出 / 导入可移植提案包（proposals + missions + topology + 双仓 peer 卷），支持跨开发者、跨仓库共享提案目录；内置绝对路径 token 化、符号链接重建、结构校验与 /handoff 交接集成。"
type: procedure
applicable_to:
  - all
inputs: []
outputs: []
linked_skills: []
linked_rules:
  - .agent/rules/proposal-structure.md
linked_workflows:
  - .agent/workflows/handoff.md
owner: Kucell
last_verified: 2026-08-20
status: stable
---

# 提案包共享工作流 (/proposal-share)

当一个提案包需要共享给**另一个开发者 / 另一个仓库 / 另一台机器**时，使用 `/proposal-share`。
它把「标准目录结构 + 文件可移植」变成一键操作：把项目级提案组（含关联 missions、topology、
以及双仓联合提案的 peer 分册）打包成一个自包含 tar.gz，并在接收侧恢复到标准路径。

典型场景：

- **双仓联合提案**：csm-view-1（后台/网关） + samkoonyun-mobile（移动端）共同交付，两边各有一份
  `.agent/plans/proposals/projects/<slug>/` 分册，需要一起共享，不能只给一边。
- `.agent/` 通常被 gitignore（`git check-ignore .agent` 返回 0），**不能靠 git clone/push 传递**，
  必须用 tar/zip 打包或直接复制目录。
- 提案文档里写死的**绝对路径**（`cross_project_peers`、`relations.md`、`index.md`、topology
  `host_root`）在新机器上会失效，需要重写。
- 移动端通过**符号链接**镜像共享决策（如 `D-005-enforcement.md`），打包会打散链接，接手后要重建。

## 使用方式

```text
/proposal-share export <slug> [--out <dir>] [--peers <root,...>] [--missions <M-xxx,...>] [--handoff <file>]
/proposal-share import <package.tar.gz> [--root <dir>] [--root-map 'repo=/abs/path,...'] [--dry-run]
/proposal-share verify <package.tar.gz> [--root <dir>]
```

对应脚本（任意项目内直接可跑，引擎是唯一事实来源）：

```bash
node .agent/scripts/proposal-share.js export --slug mobile-device-variable-cards --root .
node .agent/scripts/proposal-share.js import --package proposal-share-xxx.tar.gz --root .
node .agent/scripts/proposal-share.js verify --package proposal-share-xxx.tar.gz --root .
```

## 名词

- **主卷（primary volume）**：当前仓库 `.agent/plans/proposals/projects/<slug>/`，必须有 `index.md` 入口。
- **peer 卷（peer volume）**：双仓联合提案的另一侧分册 —— 其他仓库根目录下同样存在
  `.agent/plans/proposals/projects/<slug>/index.md` 的目录。自动发现来源：topology
  `peers[].host_root`、frontmatter `cross_project_peers`（绝对路径）、文档中的绝对路径扫描、
  或 `--peers` 显式指定。
- **token**：打包时把每个仓库绝对根路径替换成 `@ROOT:<repo>@` 占位符，保证包可移植；
  导入时按 `--root-map`（或主 token 默认映射到目标项目根）还原。

## EXPORT

1. 确认提案包存在且合规：`<root>/.agent/plans/proposals/projects/<slug>/index.md` 必须存在，
   `proposals/` 非空（.agent/rules/proposal-structure.md）。
2. 运行导出：
   ```bash
   node .agent/scripts/proposal-share.js export --slug <slug> --root <project-root> --out <out-dir>
   ```
   默认输出到 `<root>/.agent/artifacts/proposal-packages/proposal-share-<slug>-<时间戳>.tar.gz`。
3. 引擎自动：
   - 复制主卷（解引用符号链接，链接信息记入 MANIFEST）。
   - 发现并复制**关联 missions**：扫描 `.agent/missions/*/mission-plan.md` 中引用
     `projects/<slug>` 的目录；或 `--missions M-xxx,M-yyy` / `--all-missions` 显式指定。
   - 复制 `.agent/topology/projects.json`（默认包含，`--with-topology`）。
   - 发现并复制 **peer 卷**（含 peer 的 missions / topology）——双仓分册一起打包。
   - 把全部已知绝对根路径替换为 `@ROOT:<repo>@` token，记录改写文件清单。
   - 生成 `MANIFEST.json`（schema v1.0：volumes / missions / topology / symlinks / path_rewrites）
     与 `README.md`（交接说明，含安装命令、token 映射、需重建的符号链接、导出 warnings）。
4. 如需附带**运行时状态交接**，先按 `.agent/workflows/handoff.md` 生成 /handoff 双格式产物，
   再用 `--handoff <handoff.md|json>` 把它放进包里：
   ```bash
   node .agent/scripts/proposal-share.js export --slug <slug> --handoff .agent/handoffs/H-YYYYMMDD-HHMMSS-focus.json
   ```
5. 检查输出 summary：volumes（应含全部 peer）、missions、symlinks 数量、path_rewrites、warnings。
   有 warning 时先处理再分发（例如显式 `--peers` 指错了路径）。
6. 分发：把 tar.gz（自包含，不依赖 git）交给对方；同时把 /handoff 文档单独给出或已随包。

## IMPORT

1. 接收方把 tar.gz 放到目标项目（`--root`，默认当前目录），先 dry-run 看计划：
   ```bash
   node .agent/scripts/proposal-share.js import --package <file>.tar.gz --root <project-root> --dry-run
   ```
2. 无 `--root-map` 时：主卷、missions、topology 安装到目标项目标准路径；
   **未映射的 peer 卷**会暂存到 `.agent/plans/proposals/imports/<slug>/peers/<repo>/`
   （token 原样保留），由接手方手动放到对应仓库的标准路径。
3. 若接手方同时有 peer 仓库，用 `--root-map` 直接合并到标准路径（已有文件合并、绝不删除）：
   ```bash
   node .agent/scripts/proposal-share.js import --package <file>.tar.gz --root <project-root> \
     --root-map 'samkoonyun-mobile=/new/path/samkoonyun-mobile'
   ```
4. 引擎自动：结构校验（MANIFEST + index.md + proposals/）→ 安装 → token 还原 → **符号链接重建**
   （按 MANIFEST.symlinks，目标路径经 token 还原后创建）→ 汇总报告。
5. 目标路径已存在且未加 `--force` 时拒绝覆盖；missions 重复时跳过并提示。
6. 导入后用 `verify` 复核，再按包内 README / handoff 的 Next Steps 继续。

## VERIFY

```bash
node .agent/scripts/proposal-share.js verify --package <file>.tar.gz --root <project-root>
```

- 校验：MANIFEST schema、主卷 `index.md` + `proposals/` 存在、missions/topology 路径存在、
  **token 覆盖**（包内不允许出现未声明的 `@ROOT:` token）。
- 退出码 0 = 可分发/可安装；非 0 = 修复后重打。

## 质量标准

- 包必须自包含：不依赖 git、不依赖源机器绝对路径、不依赖符号链接原指向（已解引用进包）。
- MANIFEST 是机器可读事实源；README 是人可读交接说明，两者不得矛盾。
- 主卷必须满足 proposal-structure 规范（index.md 入口 + proposals/）。
- 导入默认**合并**而非覆盖：映射到已有仓库时不得删除该仓库任何既有文件。
- 未解决的 token（peer 未映射）必须显式报告，不得静默丢弃。
- `.agent/` 与运行时状态（锁、分支、未合并 commit、Decision/Waitpoint/Run）不属于本包；
  运行时状态一律走 `/handoff` 双格式产物。

## 与 /handoff 的分工

| 载体 | 负责内容 |
| :--- | :--- |
| 本包（tar.gz） | 提案目录本身：proposals / decisions / references / relations、missions、validation-contract、topology、peer 分册 |
| /handoff（md+json） | 运行时状态与下一步：任务上下文、未完成动作、验证状态、锁/分支、resume prompt |

正确姿势：`/handoff create` 生成交接 → `/proposal-share export --handoff <file>` 随包分发 →
接手方 `/proposal-share import`（+ `--root-map` 映射 peer）→ `/handoff resume` 继续。