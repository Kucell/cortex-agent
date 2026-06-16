# Architectural Design Proposal and Comparison Report (Template)

> **Status**: draft
> **Execution Vehicle**: pending approval
> **Archived Doc**: —
> **Created**: YYYY-MM-DD
> **Core Objective**: [One sentence describing the core problem or pain point this design aims to solve]

<!--
Status field — standard state machine (no other values allowed):
  draft       → working draft, not yet reviewed
  approved    → approved, waiting for execution vehicle (/approve command writes this)
  in-progress → executing; vehicle created (T-xxx or M-xxx)
  done        → complete; refined output archived to docs/architecture/
  superseded  → replaced by a newer proposal (note replacement path after this field)

Execution Vehicle: auto-filled by /approve (e.g. "T-006~T-008" or "M-002")
Archived Doc: auto-filled by /done or mission COMPLETE (e.g. "docs/architecture/xxx.md")
-->

---

## 📋 Executive Summary

### Current State & Pain Points

- 1. [Pain point description...]
- 2. [Pain point description...]

### Value Proposition

- 1. [Improvement point...]
- 2. [Improvement point...]

---

## 1. Comparative Analysis

### 1.1 Core Dimensions Comparison

| Dimension                     | Status Quo    | Proposal      | Impact                     |
| :---------------------------- | :------------ | :------------ | :------------------------- |
| **Design Compliance**         | [Description] | [Description] | [⭐/⚠️/❌]                 |
| **System Complexity**         | [Description] | [Description] | [Reduced/Stable/Increased] |
| **Maintenance & Scalability** | [Description] | [Description] | [Improved/Stable/Declined] |
| **Performance/Resources**     | [Description] | [Description] | [Improved/Stable/Declined] |

### 1.2 Key Code/Structural Change Comparison

#### [Current Implementation/Structure]

```
// Briefly describe the key logic or structural problem of the current implementation
```

#### [Proposed Implementation/Structure]

```
// Show logical evolution or structural optimization of the new solution
```

---

## 2. Detailed Design

### 2.1 Module and System Architecture Changes

- [Description of changes in module responsibilities]
- [Show new component relationships or class diagrams (Mermaid recommended)]

### 2.2 Data Flow and Interaction Logic

- [Description of changes in core data flow]
- [Show key process flows (Mermaid recommended)]

---

## 3. Architecture Compliance Audit

_Self-evaluation based on project-defined architectural principles_

- [ ] **Responsibility Division**: [Explanation]
- [ ] **Dependency Direction**: [Explanation]
- [ ] **Abstraction Level**: [Explanation]
- [ ] **Environment Independence**: [Explanation]

---

## 4. Implementation Plan

> This section determines scale routing when /approve is run:
> - ≤ 2 Phases, completable in a single session → /plan (small task)
> - ≥ 3 Phases, or cross-session, or milestone validation required → /mission (large task)

### Phase 1: [Phase Name]
- Goal: [What this phase delivers]
- Key files: [Main files involved]
- Acceptance: [At least 1 verifiable condition]

### Phase 2: [Phase Name]
- Goal: ...
- Acceptance: ...

### 4.2 Potential Risks

| Risk               | Severity       | Mitigation/Action |
| :----------------- | :------------- | :---------------- |
| [Risk description] | [High/Med/Low] | [Specific action] |

---

## 5. Next Steps

- [ ] **Action 1**: [Specific action]
- [ ] **Action 2**: [Specific action]
