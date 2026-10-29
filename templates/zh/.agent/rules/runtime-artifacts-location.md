---
title: "运行时产物落盘位置"
description: '> cortex-agent 管理的项目里，agent 运行与调试产生的一切产物——日志、探针脚本、单次运行输出、观测数据、临时 JSON——必须落在项目的 .agent/ 目录下，不得写入 /tmp、home 目录或项目根。'
type: rule
scope: L1
applicable_to:
  - all
linked_workflows: []
linked_skills: []
owner: Kucell
last_verified: 2026-10-28
status: stable
linked_decisions: ["D-OKF-001"]
---

# 运行时产物落盘位置

> **核心规则**：在 cortex-agent 管理的项目里，agent 运行、调试、排查过程中产生的一切产物
> ——日志、探针脚本、单次运行输出、观测数据、临时 JSON、截图——都必须落在项目的
> `.agent/` 目录下。**不得**写入 `/tmp`、home 目录或项目根。

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

### 唯一正当的例外

短命的**进程管道**（process plumbing）可以用系统临时目录，前提是它确实用完即弃、
不承载任何需要在进程退出后仍然存在的内容：

- 传给子进程的私有 context 文件，用完立即删除；
- 一次性编译用的临时构建目录；
- 单个测试用例内部创建并清理的 fixture 目录。

判据很简单：**产物在进程退出后还有价值，就必须落在 `.agent/` 下。**
含密钥的 context 文件也不该持久化——它必须是 `0600` 权限并在结束时删除，
这正是它属于进程管道而不是运行时产物的原因。

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

## 交叉引用

- `.agent/rules/ai-debug-artifacts.md` —— `.agent/debug/` 是 AI 调试产物的专用位置，
  与 feature 状态区分开。
- `.agent/rules/runtime-state-integration.md` —— 每个有状态 feature 必须满足的契约，
  包含证据的落盘位置。
- `.agent/rules/core-principles.md` —— 指向本规则的那一条摘要。
