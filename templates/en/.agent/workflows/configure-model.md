---
name: configure-model
description: "交互式配置 AI 模型提供商、模型 ID 和每个 sub-agent 的角色分配。"
type: procedure
applicable_to:
  - all
inputs: []
outputs: []
linked_skills: []
linked_rules: []
linked_workflows: []
owner: Kucell
last_verified: 2026-08-06
status: stable
---

<!-- EN translation pending: structural English skeleton; the step-by-step body below is already English; only the description frontmatter and the Recalibration Tip closing section retain the Chinese source text. TODO: translate the frontmatter description and the recalibration tip fully into English. -->

# 🤖 Model Configuration Workflow (/configure-model)

Guides you through setting up your AI provider, model aliases, and role assignments, then automatically updates `config/reasoning-config.yml` and all sub-agent files.

---

## Step 1: Read Current Configuration

First, I'll read the existing config and display the current state:

1. Read `.agent/config/reasoning-config.yml`
2. Read the `model:` field from all sub-agents:
   - `sub-agents/planner.md`
   - `sub-agents/implementer.md`
   - `sub-agents/researcher.md`
   - `sub-agents/code-reviewer.md`
   - `sub-agents/documenter.md`
   - `sub-agents/entropy-scanner.md`
   - `sub-agents/session-manager.md`
3. Display a current config summary:

```
Current Configuration
──────────────────────────────
Provider:       {api.provider}
API Key Env:    {api.api_key_env}

Model Aliases:
  fast     → {models.fast}
  standard → {models.standard}
  premium  → {models.premium}

Role Assignments:
  planner         → {roles.planner}          ({resolved model ID})
  implementer     → {roles.implementer}      ({resolved model ID})
  researcher      → {roles.researcher}       ({resolved model ID})
  code_reviewer   → {roles.code_reviewer}    ({resolved model ID})
  documenter      → {roles.documenter}       ({resolved model ID})
  entropy_scanner → {roles.entropy_scanner}  ({resolved model ID})

Cost Mode: {active_mode or "per-role"}
──────────────────────────────
```

---

## Step 2: Choose AI Provider

**Select your AI provider:**

- [ ] **Anthropic** (default) — Claude model family
- [ ] **OpenAI** — GPT / o1 models
- [ ] **Azure OpenAI** — Azure-hosted OpenAI models
- [ ] **Ollama** — Local models (qwen / llama / mistral, etc.)
- [ ] **Custom** — Any OpenAI-compatible API provider
- [ ] Keep current setting

For non-Anthropic providers, also provide:
- `base_url`: API endpoint (`http://localhost:11434` for Ollama; required for Azure / Custom)
- `api_key_env`: Environment variable name holding your API key (e.g. `OPENAI_API_KEY`)

---

## Step 3: Configure Model Aliases

**Specify the real model ID for each alias:**

| Alias | Used For | Current | New |
|-------|----------|---------|-----|
| `fast` | Lightweight, high-frequency tasks (documenter, entropy-scanner) | {current} | |
| `standard` | Everyday development (implementer, researcher, reviewer) | {current} | |
| `premium` | Complex reasoning & architecture (planner) | {current} | |

**Common model IDs:**

```
Anthropic:  claude-haiku-4-5-20251001 / claude-sonnet-4-6 / claude-opus-4-6
OpenAI:     gpt-4o-mini / gpt-4o / o1
Azure:      Same as OpenAI; use your deployment name
Ollama:     qwen2.5-coder:7b / qwen2.5-coder:32b / llama3.1:70b
```

> Press Enter to skip and keep the current value.

---

## Step 4: Adjust Role Assignments (Optional)

**Do any roles need a different alias or model ID?**

Default assignments:

| Role | Default Alias | Notes |
|------|--------------|-------|
| `planner` | `premium` | Planning needs strongest reasoning |
| `implementer` | `standard` | Code execution |
| `researcher` | `standard` | Research and feasibility |
| `code_reviewer` | `standard` | Code review |
| `documenter` | `fast` | Docs generation |
| `entropy_scanner` | `fast` | High-frequency, cost-sensitive |

To override a role, specify the role name and a new alias (`fast` / `standard` / `premium`) or a full model ID.

---

## Step 5: Cost Mode Override (Optional)

**Enable a global cost mode to override all role assignments?**

- [ ] **Disabled** (leave empty — use per-role assignments from Step 4)
- [ ] **conservative** — All roles use `fast`, lowest cost
- [ ] **balanced** — All roles use `standard`, everyday default
- [ ] **quality** — planner + verification use `premium`, rest use `standard`

> When enabled, the cost mode overrides Step 4 role assignments.

---

## 🤖 My Actions

After collecting your answers, I will:

### 1. Update `config/reasoning-config.yml`

- Write new `api.provider` / `api.base_url` / `api.api_key_env`
- Update `models.fast` / `models.standard` / `models.premium`
- Update `roles` assignments
- Update `active_mode`

### 2. Sync `model:` in all sub-agent files

Resolve each alias to its actual model ID and update:

| Sub-agent File | Updated To |
|---------------|-----------|
| `sub-agents/planner.md` | `model: {resolved model ID for roles.planner}` |
| `sub-agents/implementer.md` | `model: {resolved model ID for roles.implementer}` |
| `sub-agents/researcher.md` | `model: {resolved model ID for roles.researcher}` |
| `sub-agents/code-reviewer.md` | `model: {resolved model ID for roles.code_reviewer}` |
| `sub-agents/documenter.md` | `model: {resolved model ID for roles.documenter}` |
| `sub-agents/entropy-scanner.md` | `model: {resolved model ID for roles.entropy_scanner}` |

### 3. Output Change Summary

```
✅ Model configuration updated
──────────────────────────────
Provider:    {new value}
API Key Env: {new value}

Model Alias Changes:
  fast     {old} → {new}
  standard {old} → {new}
  premium  {old} → {new}

Sub-agent Model Changes:
  planner         {old} → {new}
  implementer     {old} → {new}
  ...  (only changed roles shown)

Cost Mode: {new value}
──────────────────────────────
⚠️  Reminder: make sure {api.api_key_env} is set in your shell environment.
```

---

## ⚖️ 校准提示（Recalibration Tip）

> 切换 provider/model 后，建议运行 `/recalibrate` 重测基线。

- **suggestion only**：仅为提示，不自动运行、不自动触发任何模型切换或配置升级。
- 目的：换模型后能力边界可能漂移，用同一固化代表工作流（`/ship` REVIEW→COMMIT 链路或
  最小可复现 benchmark 子集）重跑，产出质量/成本/时长三维对比，写入
  `metrics/model-calibration.json`（模型维度唯一事实源）。
- 相关：`.agent/workflows/recalibrate.md`（持续校准闭环，P-003）。
