# Design Systems

本目录存放 `cortex-agent design install` 拉取的设计系统。每个子目录对应一个上游 package(Apache-2.0 / MIT / 等,见 `manifest.json`),包含 `DESIGN.md`(视觉规范 prose)+ `manifest.json`(元数据)+ `tokens.css`(可选,语义 token)。

> **快速跳转**:
> - **本文档**:讲清"装了什么 / 怎么装 / 怎么用"
> - **设计提案**:`.agent/plans/proposals/design-system/cortex-agent-open-design-integration-proposal.md`
> - **架构文档**:`docs/architecture/design-system.md`
> - **任务**:`.agent/tasks/T-OD-001.json`

---

## 工作流(Quick start)

```bash
# 1. 查看可安装列表(从 open-design 上游 151 套)
cortex-agent design list --available

# 2. 安装并 ack license
cortex-agent design install linear-app

# 3. 查看当前生效链(4 级 cascade)
cortex-agent design resolved

# 4. 升级所有 installed system
cortex-agent design upgrade

# 5. 移除
cortex-agent design remove linear-app
```

更多子命令:`cortex-agent design {list,install,upgrade,remove,show,resolved,refresh-catalog} --help`

---

## 4 级 Cascade 解析

任何时候,AI agent 实际消费的视觉规范由以下优先级决定(从高到低):

```
1. <project_root>/DESIGN.md                              ← 用户项目根自写(最高优先)
2. <project_root>/.agent/DESIGN.md                       ← agent 上下文级
3. <project_root>/.agent/design-systems/<id>/DESIGN.md   ← 已 install 的 system (LIFO,后装的覆盖先装的)
4. cortex-agent 自带 starter(本目录的 README 不算,详见 templates/{zh,en}/.agent/DESIGN.md)  ← 兜底
```

查看当前链:

```bash
cortex-agent design resolved
# 1. /Users/.../myproj/DESIGN.md                    [layer=1, user override]
# 2. /Users/.../myproj/.agent/DESIGN.md             [layer=2, agent context]
# 3. /Users/.../myproj/.agent/design-systems/default/DESIGN.md     [layer=3, fetch order 1]
# 4. .../.agent/design-systems/warm-editorial/DESIGN.md           [layer=3, fetch order 2, LIFO 胜]
# 5. templates/zh/.agent/DESIGN.md                  [layer=4, starter fallback]
```

> **LIFO 含义**:最近一次 `cortex-agent design install` 的 system 优先级最高,跟 npm 解析直觉一致。

---

## License 治理

### 规则

- **强制 ack**:`install` 时必须显示 license + 来源 + category 警示,用户必须输入 `y` 才能继续
- **brand-referencing 警示**:`AI & LLM` / `Developer Tools` / `Fintech` / `E-commerce` / `Media` / `Automotive` / `Other` category(非 `Starters`)会额外显示 "Aesthetic inspirations, not official assets of the brands they reference"
- **license 缺失 fail-closed**:manifest 中无 license 字段时,默认 abort;可 `--force` 覆盖
- **`--yes` flag**:脚本场景可跳过 ack,但 license 仍记录到 lock file

### License 分类

| License | 数量(粗估) | 风险 | 处理 |
|---|---|---|---|
| Apache-2.0(open-design 主仓库) | 多数 | 低 | 默认 enable |
| MIT(从 VoltAgent/awesome-design-md 派生) | ~70 | 低 | 默认 enable |
| MIT(从 bergside/awesome-design-skills 派生) | ~57 | 中(逐个 source 校验) | enable 时显示 source 链 |
| brand 命名(airbnb / apple / claude / linear-app / spotify / stripe / 等) | ~50+ | 中(企业法务) | 强制显示 "inspiration, not official" 提示 |
| 未知 / 缺失 | 不定 | 高 | fail-closed 拒绝 install(可 `--force`) |

### 企业白名单(可选)

需要限制可安装 category 的企业用户,可在 `~/.cortex-agent/design-config.json` 中配置:

```json
{
  "allowed_categories": ["Starters"],
  "allowed_licenses": ["Apache-2.0", "MIT"]
}
```

设置后,非白名单 category / license 的 install 自动拒绝。

---

## Lock file 格式

路径:`<project_root>/.agent/design-systems.lock`

```json
{
  "lockfileVersion": 1,
  "schemaVersion": "od-design-system-project/v1",
  "fetched_at": "2026-08-04T...",
  "upstream": "https://raw.githubusercontent.com/nexu-io/open-design/main",
  "systems": [
    {
      "id": "default",
      "sha256_manifest": "ab12...",
      "sha256_design": "cd34...",
      "sha256_tokens": "ef56...",
      "license": "Apache-2.0",
      "category": "Starters",
      "source": { "type": "upstream", "origin": "nexu-io/open-design" },
      "fetched_at": "2026-08-04T..."
    }
  ]
}
```

- **commit-friendly**:lock file 应提交到 git,确保 team 共享同一份已 install system
- **upgrade** 主动拉新 hash 与 lock 对比,显示 delta
- **content-addressed**:相同 SHA-256 不重复 fetch

---

## 默认行为

| 维度 | 默认值 | 备注 |
|---|---|---|
| 默认 enable | `default` + `warm-editorial` | 起步器,无 brand 风险 |
| 升级策略 | 手动 (`cortex-agent design upgrade`) | 不自动 fetch 上游 |
| 网络 | 上游 GitHub raw content | `CORTEX_AGENT_DESIGN_UPSTREAM` env 可覆盖 |
| Catalog cache | `~/.cortex-agent/catalog-cache.json` | 24h TTL,`refresh-catalog` 主动刷新 |
| Lock file | `.agent/design-systems.lock` | git 共享 |
| Exit code | 0 成功 / 1 通用 / 2 参数 / 3 网络 / 4 license 拒绝 | 脚本友好 |

---

## 常见问题

**Q: 为什么不做成本地 copy 所有 151 套 system?**
A: license 治理爆炸(每套需要单独确认)+ 体积过大(每个 5-50 KB,151 套 = 7-15 MB)+ 上游演进同步负担。content-addressed fetch 解决。

**Q: 跟 M-003 的 `cortex-agent plugin` 有什么区别?**
A: plugin 是**可执行**的工作流(带 SKILL.md,跑任务用);design system 是**静态规范**文件(带 DESIGN.md,规范 agent 输出用)。两者走不同的 cascade。

**Q: 跟 prd-visualization 提案的 OpenPencil 是什么关系?**
A: prd-visualization 管**设计稿**(节点树 .pen 文件);design system 管**视觉规范**(DESIGN.md prose);agent-dashboard-prd-ui 管**UI 渲染**。三层递进。

**Q: 跟 cortex-agent 自带 starter 冲突怎么办?**
A: starter 是 layer 4(最低优先级),用户任何自定义都会覆盖。`cortex-agent design resolved` 可看到完整 cascade。

**Q: brand 类(airbnb / apple / claude / 等)能商用吗?**
A: open-design 上游声明 "Aesthetic inspirations, not official assets of the brands they reference" — 视觉风格启发用,非官方品牌资产。商用前请咨询法务。

---

## 上游来源

| 来源 | 派生 system 数 | License | 同步方式 |
|---|---|---|---|
| [nexu-io/open-design](https://github.com/nexu-io/open-design) | 151 | Apache-2.0(主)+ 各 system 自带 license | 默认 upstream |
| [VoltAgent/awesome-design-md](https://github.com/VoltAgent/awesome-design-md) | ~70 | MIT | open-design 通过 `scripts/sync-design-systems.ts` 同步 |
| [bergside/awesome-design-skills](https://github.com/bergside/awesome-design-skills) | ~57 | (逐个校验) | open-design 同步 |
| [tw93/kami](https://github.com/tw93/kami) | 1 | MIT | `kami` package |
| [Tom-Opencart/tom-modern-html-style-rule](https://github.com/Tom-Opencart/tom-modern-html-style-rule) | 1 | MIT | `tom-modern` package |

---

## 已知限制

- **M1**:MVP 不解析 `tokens.css`(Phase 2 才加)— agent 只消费 `DESIGN.md` prose
- **M2**:MVP 不支持 DESIGN.md 强校验 — open-design upstream 接受 legacy DESIGN.md-only / 7+ H2 / 9-section 多种格式
- **M3**:MVP 不做 MCP server 双向桥接 — 跟 open-design 桌面 app 联动是 Phase 3
- **M4**:MVP 不做 design fork — 用户基于已 install system 派生自己的 brand 是 Phase 5
- **M5**:MVP 不跟 dispatch / dashboard 联动 — 全栈集成是 Phase 6

---

## 反馈 / 问题

- GitHub issue:https://github.com/nexu-io/open-design/issues
- 集成问题:cortex-agent repo issue / discussion
- 任务: `.agent/tasks/T-OD-001.json`
