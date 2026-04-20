---
name: configure-model
description: 交互式配置 AI 模型提供商、模型 ID 和每个 sub-agent 的角色分配。
---

# 🤖 模型配置工作流 (/configure-model)

引导你完成模型提供商、模型别名和角色分配的配置，自动更新 `config/reasoning-config.yml` 和所有 sub-agent 文件。

---

## 步骤一：读取当前配置

首先读取现有配置，展示当前状态：

1. 读取 `.agent/config/reasoning-config.yml`
2. 读取所有 sub-agent 的 `model:` 字段：
   - `sub-agents/planner.md`
   - `sub-agents/implementer.md`
   - `sub-agents/researcher.md`
   - `sub-agents/code-reviewer.md`
   - `sub-agents/documenter.md`
   - `sub-agents/entropy-scanner.md`
   - `sub-agents/session-manager.md`
3. 展示当前配置摘要：

```
当前配置摘要
──────────────────────────────
提供商：{api.provider}
API Key 环境变量：{api.api_key_env}

模型别名：
  fast     → {models.fast}
  standard → {models.standard}
  premium  → {models.premium}

角色分配：
  planner         → {roles.planner}     ({实际模型 ID})
  implementer     → {roles.implementer} ({实际模型 ID})
  researcher      → {roles.researcher}  ({实际模型 ID})
  code_reviewer   → {roles.code_reviewer}({实际模型 ID})
  documenter      → {roles.documenter}  ({实际模型 ID})
  entropy_scanner → {roles.entropy_scanner}({实际模型 ID})

成本模式：{active_mode 或 "逐角色配置"}
──────────────────────────────
```

---

## 步骤二：选择 AI 提供商

**请选择你的 AI 提供商：**

- [ ] **Anthropic**（默认）— Claude 系列模型
- [ ] **OpenAI** — GPT / o1 系列模型
- [ ] **Azure OpenAI** — Azure 托管的 OpenAI 模型
- [ ] **Ollama** — 本地模型（qwen / llama / mistral 等）
- [ ] **Custom** — 自定义兼容 OpenAI API 的提供商
- [ ] 不修改，保持当前设置

如果选择非 Anthropic 提供商，还需提供：
- `base_url`：API 地址（Azure / Custom 必填；Ollama 默认 `http://localhost:11434`）
- `api_key_env`：存储 API Key 的环境变量名（如 `OPENAI_API_KEY`）

---

## 步骤三：配置模型别名

**请为三个别名指定实际模型 ID：**

| 别名 | 用途 | 当前值 | 新值 |
|------|------|--------|------|
| `fast` | 轻量高频任务（documenter、entropy-scanner）| {当前值} | |
| `standard` | 日常开发（implementer、researcher、reviewer）| {当前值} | |
| `premium` | 复杂推理和架构决策（planner）| {当前值} | |

**常用模型 ID 参考：**

```
Anthropic:  claude-haiku-4-5-20251001 / claude-sonnet-4-6 / claude-opus-4-6
OpenAI:     gpt-4o-mini / gpt-4o / o1
Azure:      与 OpenAI 相同，填写部署名称
Ollama:     qwen2.5-coder:7b / qwen2.5-coder:32b / llama3.1:70b
```

> 直接回车跳过则保持当前值不变。

---

## 步骤四：调整角色分配（可选）

**是否需要为某个角色单独指定不同的别名或模型 ID？**

默认分配：

| 角色 | 默认别名 | 说明 |
|------|---------|------|
| `planner` | `premium` | 规划需要最强推理 |
| `implementer` | `standard` | 执行用标准模型 |
| `researcher` | `standard` | 调研用标准模型 |
| `code_reviewer` | `standard` | 代码审查用标准模型 |
| `documenter` | `fast` | 文档生成用快速模型 |
| `entropy_scanner` | `fast` | 熵扫描高频低成本 |

如需修改某个角色，请指定角色名和新的别名（`fast` / `standard` / `premium`）或完整模型 ID。

---

## 步骤五：选择成本模式（可选）

**是否启用全局成本模式覆盖？**

- [ ] **不启用**（留空，使用上面的逐角色分配）
- [ ] **conservative**：全部用 `fast`，最低成本
- [ ] **balanced**：全部用 `standard`，日常推荐
- [ ] **quality**：planner + verification 用 `premium`，其余 `standard`

> 启用后，成本模式会覆盖步骤四的角色分配。

---

## 🤖 我的操作

收到所有回答后，我将执行以下操作：

### 1. 更新 `config/reasoning-config.yml`

- 写入新的 `api.provider` / `api.base_url` / `api.api_key_env`
- 更新 `models.fast` / `models.standard` / `models.premium`
- 更新 `roles` 各角色分配
- 更新 `active_mode`

### 2. 同步所有 sub-agent 的 `model:` 字段

根据新的 `roles` 配置，将别名解析为实际模型 ID，逐一更新：

| Sub-agent 文件 | 更新为 |
|---------------|--------|
| `sub-agents/planner.md` | `model: {roles.planner 对应的模型 ID}` |
| `sub-agents/implementer.md` | `model: {roles.implementer 对应的模型 ID}` |
| `sub-agents/researcher.md` | `model: {roles.researcher 对应的模型 ID}` |
| `sub-agents/code-reviewer.md` | `model: {roles.code_reviewer 对应的模型 ID}` |
| `sub-agents/documenter.md` | `model: {roles.documenter 对应的模型 ID}` |
| `sub-agents/entropy-scanner.md` | `model: {roles.entropy_scanner 对应的模型 ID}` |

### 3. 输出变更摘要

```
✅ 模型配置已更新
──────────────────────────────
提供商：{新值}
API Key 环境变量：{新值}

模型别名变更：
  fast     {旧值} → {新值}
  standard {旧值} → {新值}
  premium  {旧值} → {新值}

Sub-agent 模型变更：
  planner         {旧值} → {新值}
  implementer     {旧值} → {新值}
  ...（仅列出有变更的角色）

成本模式：{新值}
──────────────────────────────
⚠️  注意：请确认 {api.api_key_env} 环境变量已在你的 shell 中设置。
```
