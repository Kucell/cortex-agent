---
title: "运行时产物落盘位置"
description: '按脚本、日志和输出的生命周期决定位置。跨命令、复核或交接后仍需存在的产物必须放在 .agent/；同进程临时文件只有在同一顶层命令内删除并验证后，才可使用系统临时目录。'
type: rule
scope: L1
applicable_to:
  - all
linked_workflows: []
linked_skills: []
owner: Kucell
last_verified: 2026-11-07
status: stable
linked_decisions: ["D-OKF-001"]
---

# 运行时产物落盘位置

> **核心规则**：按生命周期决定脚本、日志和输出的位置。只要一个文件需要在产生它的
> 进程退出后继续存在，或会被另一条命令、复核、交接或后续任务引用，它就必须进入项目
> 的 `.agent/` 目录。临时目录只允许承载真正一次性的进程管道。
>
> **跨命令即持久化**：用 `apply_patch` 创建脚本、把路径记入后续命令、让另一个 agent
> 读取结果，都会使该文件成为跨命令产物。这类文件不得放在 `/tmp`、`os.tmpdir()`、
> `%TEMP%` 或 `$TMPDIR`。

准确性由三个问题共同决定，不以文件扩展名或目录名单独判定：

1. 它是否需要在当前进程或当前顶层命令结束后继续存在？
2. 它是否会被后续命令、复核者、其他 agent 或任务续接读取？
3. 它是否是一次可复用的探针、测量或交付资产？

任一答案为“是”，就按下面的 `.agent/` 生命周期表落盘。

---

## 生命周期与位置

| 生命周期 / 用途 | 位置 | 收口要求 |
|---|---|---|
| 只在单个进程或单个顶层命令内有效 | OS 临时目录 | 同一顶层命令内删除并验证不存在 |
| 跨命令或短期复核需要，但不是长期证据 | `.agent/debug/temp/<task>-<run-id>/` | 建立文件清单，记录保留条件 |
| 可跨任务复用的脚本 | `.agent/skills/<skill>/scripts/` | 提供入口与测试 |
| Mission 专项脚本或长期证据 | `.agent/missions/<id>/scripts/` 或 `evidence/` | 关联源码版本与验证结果 |
| 给其他 agent 读取的机器可读摘要 | `.agent/artifacts/` | 保存紧凑摘要、引用与哈希 |

禁止只改文件名来规避规则。位置由生命周期和消费方式决定，不由 `temp`、`scratch`
或 `debug` 这类词决定。

---

## 为什么是 .agent/ 而不是 /tmp

`/tmp` 是寿命很短的暂存区：系统会回收它，会话结束会清掉它，容器重启会抹掉它。
后续会话、同事或独立复核者还需要读到的产物，因此不能放在那里。

`.agent/` 是项目持久的、与项目同生命周期的状态目录。放在这里的产物：

1. **跨会话、跨宿主存活** —— 从 Codex 切到 Claude 再切到 Qoder，产物跟着项目走，
   不会丢。
2. **位置可预测** —— 下一次会话知道去哪里找，不需要额外交代。
3. **可复核** —— 可以提交、可以 diff、可以审计；也可以经过明确决定后排除，
   而不是因为疏忽而丢失。

`.agent/` 本身是否纳入版本控制，是另一个按项目决定的选项
（`cortex-agent track` / `cortex-agent untrack`）。本规则管的是**产物落在哪里**，
不是目录是否被 Git 追踪：无论目录是否被追踪，放在 `.agent/` 的产物都能跨会话取到，
放在 `/tmp` 的产物则不能。

**脚本**同理：探针、fixture 生成器、一次性测量脚本是**可复用的资产**，不是暂存物。
应当写在 `.agent/` 下、放在它所产出的产物旁边，让下一个人能重跑。

---

## 落盘位置

    .agent/
    ├── runtime-evidence/          # feature 产出的运行时状态
    │   └── <feature>/<id>.<ext>   # 单次运行输出、单样本观测
    ├── debug/                     # AI 调试产物（不是 feature 状态）
    │   ├── screenshots/           # UI 截图
    │   ├── logs/                  # 临时服务 / 浏览器 / 命令日志
    │   └── temp/                  # 临时 JSON、探针输出
    ├── missions/<mission-id>/
    │   ├── evidence/              # 长期验证证据
    │   └── scripts/               # 可复用的探针 / 测量脚本
    ├── skills/<skill>/runs/       # skill 自身的单次运行输出
    └── metrics/                   # 健康 / 自检快照

### 怎么选目录

| 场景 | 路径 | 例 |
| :--- | :--- | :--- |
| feature 运行时状态（单次运行、单样本） | `.agent/runtime-evidence/<feature>/<id>.<ext>` | `.agent/runtime-evidence/telemetry/run-20261028.jsonl` |
| AI 调试产物（截图、暂存、日志） | `.agent/debug/<subdir>/` | `.agent/debug/screenshots/login-error-20261028.png` |
| 挂在某个 mission 上的证据 | `.agent/missions/<id>/evidence/` | `.agent/missions/M-025/evidence/P-008-attempt.json` |
| 可复用的探针或测量脚本 | `.agent/missions/<id>/scripts/` 或 `.agent/skills/<skill>/scripts/` | `.agent/missions/M-044/scripts/acl-win/privilege-probe.ps1` |
| skill 自身的单次运行输出 | `.agent/skills/<skill>/runs/` | `.agent/skills/retrieval-trajectory/runs/T-DEMO-001.jsonl` |

如果现有目录都不合适，就新建 `.agent/runtime-evidence/<feature-slug>/`。
**不要**在 `.agent/` 之外新建顶层目录。

---

## 命名

用 `<run-id-or-sample-id>.<ext>`：

- `<run-id>`：`R-<yyyyMMdd>-<short-uuid>`，或 feature 自己定义的稳定 id
  （`pipeline-20261028-174532`）。
- `<sample-id>`：样本自身的稳定 id（assessment id、receipt id 等），
  便于跨 run 关联。
- 脚本：kebab-case，名字说明它测什么
  （`privilege-context-probe.ps1`、`probe-07-toctou-and-pin.cjs`）。

---

## 不要做

- ❌ **不要把运行时产物或脚本写到 `/tmp`**（也不要写 `os.tmpdir()`、
  `%TEMP%`、`$TMPDIR`）。它们会被系统回收，随会话一起丢失。
- ❌ **不要写到项目根。** 那会污染 `git status`，并让它们对下一个会话不可见。
- ❌ **不要写到 `~/.agent/` 或 `~/.cache/`。** 那是宿主私有缓存，不随项目走。
- ❌ **不要把运行时产物加进 `.agent/.gitignore`。** 那等于把它们从项目状态目录里
  删除。如果某个目录太吵，用 retention policy 或按体积归档，并且把这个选择
  显式记录下来。
- ❌ **不要把 `.agent/debug/` 当发布证据目录。** 长期证据应放在
  `.agent/missions/<id>/evidence/` 或项目文档资产目录。

### 跨命令边界

一次“顶层命令”是指宿主发起的一次不可分割执行，并包含它在同一进程树中同步启动的
所有子进程。以下情况都已经跨过了这个边界：

- `apply_patch`、`Write`、`Edit` 创建文件后，再由另一条工具命令使用；
- 命令 A 创建脚本或输出，命令 B 通过绝对路径读取、上传、转发或继续修改；
- shell 重定向、`tee`、`cp`、`mv` 或程序参数把文件写到临时目录，但清理发生在
  另一条命令；
- 把临时路径写进任务进度、handoff、README、配置或其他持久文档。

跨命令材料必须直接创建在 `.agent/`。对于需要短期复核的探针和输出，使用
`.agent/debug/temp/<task>-<run-id>/`，并在该目录的 `inventory.json` 中记录每个
文件的用途和保留条件。

### 单命令临时文件

进程管道可以使用系统临时目录，但必须同时满足：

- 文件生命周期严格包含在当前顶层命令的可证明清理路径内；
- 使用 `trap`、`finally` 或等价机制，在成功、失败和中断路径都清理；
- 命令结束前验证路径已不存在；
- 临时路径不得写入持久文档、配置或需要由后续命令读取的变量表。

适用于：子进程私有 context 文件（权限 `0600`）、一次性编译目录、单个测试用例内部
的 fixture。不适用于需要在多条命令间反复复用的 PowerShell、Python、Node 或 shell
探针。

### 任务结束收口

任务结束前必须盘点本轮创建的所有临时路径，并将每项归入以下一种状态：

- `deleted`：已删除并验证不存在；
- `promoted`：已迁入 `.agent/debug/temp/` 或更长期位置，并更新全部引用；
- `owned_by_live_process`：仍由明确登记的运行中进程占用，记录进程与保留条件。

存在未分类路径时，收口状态为 `TEMP_ARTIFACT_CLOSEOUT_INCOMPLETE`。不得把
“以后会清理”当作完成状态。

---

## 修复路径

如果产物或脚本写到了错误位置：

1. 在 `.agent/` 下建好正确的目录。
2. 改掉源脚本的输出路径（通常是一两处 `path.join(root, ...)`）和输入路径。
3. 更新测试里的期望路径。
4. 用 `git mv` 移动旧文件，保留 history。
5. 重跑测试，然后单独落地这次改动。

**不要**用加 `.gitignore` 条目的方式"修复"——那是掩盖症状，产物仍然丢了。

---

## 机械检查

`pnpm check:runtime-artifact-location` 检查 L1 模板、技能、工作流和框架代码中可能把
产物写入临时目录的写法。检查器识别 Node 写文件 API、`apply_patch` 的
`Add/Update File` 目标、shell 重定向、`tee`、`cp`、`mv` 和常见 `--output` 参数；
无法判断生命周期的写法会 fail closed，由作者改为明确的 `.agent/` 路径或补充有理由
的例外。

宿主若提供 Stop 事件，应在结束前核对本轮临时路径并为每项记录 `deleted`、`promoted`
或 `owned_by_live_process`。宿主没有可阻断的 Stop 门禁时，同样的核对仍是任务完成
条件，且必须把检查结果写入任务报告。

---

## 交叉引用

- `.agent/rules/ai-debug-artifacts.md` —— `.agent/debug/` 是 AI 调试产物的专用位置，
  与 feature 状态区分开。
- `.agent/rules/runtime-state-integration.md` —— 每个有状态 feature 必须满足的契约，
  包含证据的落盘位置。
- `.agent/rules/core-principles.md` —— 指向本规则的那一条摘要。
