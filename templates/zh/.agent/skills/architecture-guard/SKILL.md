---
name: architecture-guard
description: Guards project architecture through automated audits and manual reviews. Ensures code changes comply with architectural principles defined in `.agent/rules/architecture-design.md`.
---
# Architecture Guard Skill

## Goal
This skill protects architectural integrity through:
- **Automated Audits**: Script-based violation detection
- **Manual Reviews**: Deep architectural analysis across multiple dimensions

## When to Use
Activate this skill when:
- Planning new features (understand architectural impact)
- Performing code reviews (check architectural consistency)
- Refactoring core modules
- Comparing multiple design approaches

## How to Use

### Layer 1: Automated Audit
Run the automated audit script to detect rule violations:

```bash
node .agent/skills/architecture-guard/scripts/index.js
```

The script will:
1. Read architectural rules from `.agent/rules/architecture-design.md`
2. Scan source files for violations
3. Output structured violation reports

**Analyze Output**: Present findings to the user with:
- Clear explanation of each violation
- Why it's problematic
- Suggested solutions

### Layer 2: Manual Review
For code changes or design proposals, perform multi-dimensional review:

#### 1. 职责边界检查 (Responsibility Boundaries)
- Is logic placed in the wrong layer? (e.g., business logic in UI components)
- Does it violate Single Responsibility Principle (SRP)?

#### 2. 依赖关系检查 (Dependency Analysis)
- Are there circular dependencies?
- Is coupling between modules excessive?
- Does it violate defined dependency directions? (e.g., core logic depending on infrastructure details)

#### 3. 可维护性与扩展性检查 (Maintainability & Extensibility)
- Are extension points properly defined?
- Is it over-engineered or under-engineered?

#### 4. 平台与环境检查 (Platform & Environment)
- Is the logic portable across platforms?
- Are platform-specific APIs (Browser API, Node.js API) properly isolated?

---

## 方案对比审计 (Comparative Audit)

When comparing multiple design approaches:

1. **核心原则对齐**: Evaluate how well each approach aligns with core principles (performance, availability, low coupling)
2. **风险评估**: Identify technical debt, performance overhead, or security risks
3. **权衡分析**: Document pros and cons for each approach

## Audit Report Format

Provide structured feedback:

| 评估维度 | 合规状态 | 发现的问题 | 改进建议 |
| :------- | :------- | :--------- | :------- |
| 职责分配 | ✅/❌/⚠️   | [描述问题] | [具体建议] |
| 依赖关系 | ✅/❌/⚠️   | [描述问题] | [具体建议] |
| 代码质量 | ✅/❌/⚠️   | [描述问题] | [具体建议] |

**结论**: [简要总结审计结果并给出最终建议]
