---
name: agent-visibility
description: Manages the visibility of the .agent directory in Git, resolving conflicts between plugin menu recognition and version control.
---

# Agent Visibility Manager

## 🎯 Goal

This skill aims to resolve the contradiction between the following through automated Git configuration:

1. **IDE Recognition Requirements**: Plugins typically require the `.agent` directory NOT to be in `.gitignore` to index the Slash (/) menu.
2. **De-sensitization/Privacy Requirements**: Users generally do not want project-specific or personal `.agent` configurations pushed to public repositories.

## 🛠 Parameters

Control behavior via the `mode` parameter:

- `private` (Default/Recommended):
  - Effect: IDE menu works, Git does not track files.
  - Logic: Remove `.agent` from `.gitignore`, add it to `.git/info/exclude`.
- `ignore`:
  - Effect: Git completely ignores files, IDE menu might not work.
  - Logic: Write `.agent` into `.gitignore` and remove it from `info/exclude`.
- `track`:
  - Effect: Git tracks and synchronizes files to remote normally.
  - Logic: Remove from all ignore lists and execute `git add .agent`.

## 📝 Usage Guide

Call this skill when the user asks to "configure .agent visibility" or "make the menu work".

### Script Location

`./scripts/manage.sh [mode]`
