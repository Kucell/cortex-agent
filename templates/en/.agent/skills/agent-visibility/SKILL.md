---
name: agent-visibility
description: Manage the visibility of the .agent directory in Git, resolving conflicts between plugin menu recognition and version control.
---

# Agent Visibility Manager

## 🎯 Goal

This Skill aims to resolve the following contradiction through automated Git configuration:

1. **IDE Recognition Requirement**: Plugins usually need `.agent` not to be in `.gitignore` to index the Slash (/) menu.
2. **De-sensitization/Privacy Requirement**: Users usually don't want to push personal or project `.agent` configurations to public repositories.

## 🛠 Parameter Description

Behavior is controlled by the parameter `mode`:

- `private` (Default/Recommended):
  - Effect: IDE menu works, Git does not track files.
  - Logic: Remove `.agent` from `.gitignore`, add it to `.git/info/exclude`.
- `ignore`:
  - Effect: Git completely ignores the files, IDE menu may not be recognized.
  - Logic: Write `.agent` to `.gitignore`, and remove it from `info/exclude`.
- `track`:
  - Effect: Git tracks and syncs files to remote normally.
  - Logic: Remove from all ignore lists and execute `git add .agent`.

## 📝 Usage Guide

Call this Skill when a user asks to "configure .agent visibility" or "make the menu work".

### Script Location

`./scripts/manage.sh [mode]`
