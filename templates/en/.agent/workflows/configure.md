---
name: configure
description: Interactively configure the Cortex Agent for a new project.
---

# 🚀 Agent Configuration Workflow (/configure)

Hi! I'm Cortex Agent. To serve you better, I need to understand your project. Please answer the questions below and I'll generate the initial configuration files for you.

## 1. Project Briefing

**In a few sentences, what is the core goal of this project? Who are its main users?**

> (Your answer here)

## 2. Tech Stack

**What programming languages, frameworks, and key libraries does this project primarily use?** (e.g. TypeScript, React, Node.js, Express, PostgreSQL)

> (Your answer here)

## 3. Primary Language

**Please select one or more primary languages so I can load the matching language-specific rules:**

- [ ] TypeScript / JavaScript
- [ ] Python
- [ ] Go
- [ ] Java
- [ ] Swift
- [ ] Other (please specify)

> (Check all that apply)

## 4. Architecture Principles

**Does the project follow a specific architectural pattern? (e.g. layered, hexagonal, microservices) Are there any core design principles you want me to follow?** (e.g. "keep modules decoupled", "services must be stateless")

> (Your answer here)

---
## 🤖 My Actions

After receiving your answers I will:

1. **Update `task-progress.md`** — fill in the project roadmap with your goals.
2. **Update `tech-stack.md`** — write your tech stack into the rules file.
3. **Activate language rules** — based on step 3, append the relevant language rule file (e.g. `rules/languages/typescript.md`) into `tech-stack.md` so I follow language-level conventions.
4. **Update `architecture-design.md`** — record your architecture principles.

Once done, I'll be your project-dedicated AI engineer. Let's get started!
