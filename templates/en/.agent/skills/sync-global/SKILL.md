---
name: sync-global
description: Synchronize workflows and skills from the global ~/.agent directory to the current project using symbolic links.
---

# Global Sync Skill

## 🎯 Goal

Eliminate the cost of manually maintaining symbolic links and achieve "one-click import" of global capabilities.

## 🛠 Features

- Automatically scan `~/.agent/workflows/` and link them to the project.
- Automatically scan `~/.agent/skills/` and link them to the project.
- Keep physical files global, with only shortcuts stored within the project.

## 📝 Usage

Say to the Agent: "Execute sync-global" to complete the synchronization.
