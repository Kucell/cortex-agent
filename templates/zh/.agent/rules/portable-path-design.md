---
title: "可移植路径设计"
description: '> cortex-agent 分发给所有受管项目，因此每条路径都必须在「不是作者这台机器」的环境里成立——不同的家目录、不同的包管理器布局、不同的平台。写死某台机器的绝对路径是缺陷，由 `check-portable-paths.js` 机械拦截。'
type: rule
scope: L1
applicable_to:
  - all
linked_workflows: []
linked_skills: []
owner: Kucell
last_verified: 2026-10-29
status: stable
---

# 可移植路径设计

> **核心规则**：cortex-agent 是**通用框架**。它安装进每一个受管项目的代码、
> 规则和工作流，必须在**不是作者这台机器**的环境里同样成立。
> 任何指向某一台机器的绝对路径都是缺陷，不是风格偏好。

---

## 为什么这不是洁癖

框架的分发面是所有用户。写死路径的代码有三种失败方式，**最糟的是第三种**：

1. **在别人机器上直接崩**——路径不存在，`require` 失败。容易发现。
2. **在别人机器上解析到别的东西**——路径碰巧存在，但不是你要的那个。
   比如 `.volta` 的包根在另一台机器上可能指向一个**旧版本**的包。
3. **看起来通过了，验的却是错的代码**——最难发现，也最危险。
   一个验证脚本若写死了包目录，在别人机器上会验到旧版本，
   而报告仍然显示「通过」。

第 3 种正是本规则要拦的：**门禁没坏，是被验证的对象错了。**

---

## 判定标准

写路径前问一句：**这个路径在别人的机器上还有意义吗？**

| 需求 | 可移植写法 | 反例 |
|---|---|---|
| 用户家目录 | `os.homedir()` | `"/Users/<you>/.agent"` |
| 环境相关位置 | `process.env.HOME` / `process.env.USERPROFILE` | `"/home/<you>"` |
| 包自身位置 | `path.resolve(__dirname, "..", "..")` | `"/opt/app/lib/node_modules/cortex-agent"` |
| 已安装的包 | `require.resolve("cortex-agent/package.json")` | 硬编码 prefix 拼包名 |
| 仓库内路径 | 从 `__dirname` 推导 | `"/Users/<you>/myworks/cortex-agent"` |
| 版本管理器目录 | 运行时探测 | `"/Users/<you>/.volta/tools/image/packages/..."` |
| 用户项目 | `--project` 参数 / cwd | 写死某个 demo 项目路径 |

### 允许的写法

- **占位符与示例**：文档里的 `/Users/<you>/myproject`、`/Users/.../myproj`
  是模板，不是绑定路径。
- **注释里的路径**：解释查找顺序时提到某个位置，允许。
- **运行时推导**：`os.homedir()`、`__dirname`、`require.resolve()`、
  环境变量、参数传入——这些本来就是可移植的，优先使用。

---

## 门禁

规则写成散文，散文挡不住代码。机械门禁：

```bash
node scripts/check-portable-paths.js
```

扫描面：`templates/`（分发到每个项目的树）、框架自身的治理树
`.agent/{skills,scripts,workflows,rules}`，以及 `.agent/runtime-evidence/`
（可复用验证脚本的实际落点）。

三类检出：

| 规则 | 含义 |
|---|---|
| `machine-specific-home-path` | 代码里写死了带真实用户名的家目录路径 |
| `machine-specific-manager-root` | 版本管理器安装根被逐字写出（`.volta/`、`.nvm/` …） |
| `machine-specific-windows-path` | 写死了某台机器的 Windows 目录 |

文档文件的判定更保守：代码块内与带示例标记的行视为文档示例，不报。

**门禁在 CI 中执行**（`.github/workflows/full-test.yml`），所以回退会在 PR
阶段被拦住，而不是等到某个用户在自己机器上踩到。

---

## 与 runtime-artifacts-location 的分工

两条规则管的是**两件不同的事**，不要互相替代。

| 规则 | 管什么 | 门禁 |
|---|---|---|
| `runtime-artifacts-location.md` | 产物**落在哪**（`.agent/`，不是 `/tmp`） | `check-runtime-artifact-location.js` |
| `portable-path-design.md`（本文） | 路径**怎么来**（运行时推导，不是写死） | `check-portable-paths.js` |

一个产物可以同时违反两条：写到 `/tmp` 既是落点错误，
写死 `/tmp/xxx` 这样的具体目录也是可移植性问题。

---

## 自检清单

- [ ] 这条路径在**别人的**机器上成立吗？
- [ ] 有没有把作者的家目录、版本管理器目录、仓库路径写进去？
- [ ] 验证脚本验的是**它声称要验的版本**，还是碰巧装在那个路径上的？
- [ ] 文档里的示例路径是占位符（`<you>` / `...`），不是真实用户名？
- [ ] 跑过 `pnpm check:portable-paths` 吗？

---

## 违反本规则的修复路径

1. 把字面量路径换成运行时推导（见上面的判定标准表）。
2. 如果某个根目录确实需要可覆盖，加**环境变量**或 **CLI 参数**，
   并给出推导出的默认值——不要写死。
3. 跑 `node scripts/check-portable-paths.js` 确认清零。
4. 跑一次该脚本，确认它在新环境下解析到**预期的那个版本**。

不要用豁免名单绕过——豁免要有理由，且理由是「这里不是绑定路径」，
不是「这里只是这次不方便」。
