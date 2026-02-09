---
description: Used to propose, evaluate, and integrate new architectural ideas or solutions during the development process.
---

# Architectural Evolution and Design Workflow (/arch-design)

When you have new architectural ideas or need to refactor existing modules, follow this process to ensure design rigor and consistency:

## 1. Solution Conception and Current State Analysis

- **Read Core Principles**: **You must first read** the `.agent/rules/architecture-design.md` file, treating the core principles of the project architecture as the highest priority.
- **Understand Context**: Deeply explore the requirements proposed by the user or the technical bottlenecks encountered by the existing system.
- **Current State Review**: Search for relevant implementation logic in the current codebase.
- **Conflict Detection**: Analyze whether the new solution conflicts with the loaded architectural principles.

## 2. Design Output

- **Write Proposal**: Provide clear design descriptions, recommended to include:
  - Description of structural changes.
  - Core flowcharts or class diagrams (Mermaid).
  - API change list.
  - Impact on existing data flows.

## 3. Architectural Comparison and Evaluation

- **Call Audit Skill**: Use the `.agent/skills/architecture-audit` skill to audit the new proposal.
- **In-depth Comparison**: Produce a solution comparison table, comparing the Status Quo with the Proposal across these dimensions:
  - Architectural compliance
  - Scalability and maintenance cost
  - Runtime performance and system complexity
  - Implementation difficulty and migration cost
- **Risk Identification**: Clearly point out potential side effects introduced by the new solution (e.g., breaking backward compatibility, increasing system overhead).

## 4. Review and Decision

- **Present Conclusions**: Show the comparison analysis results to the user and provide the AI's recommendation.
- **Wait for Confirmation**: Fine-tune or confirm the solution based on user feedback.

## 5. Integration and Implementation

- **Update Documentation**: Archive approved designs to the project's documentation library (e.g., `docs/architecture/`).
- **Task Decomposition**: Convert the design solution into a specific task list and update the implementation plans under `.agent/plans/`.
