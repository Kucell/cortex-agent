---
name: weekly-report
description: Automatically generates weekly reports based on Git commit records and supports global/local storage management.
---

# Weekly Report Skill

## 🎯 Goal

Automate the summarization of developer's Git contributions and generate structured weekly report documents.

## 🛠 Parameters

- `date_range`: Date range, e.g., "2024.1.24-2024.1.31" or shortened "1.24-1.31".
- `output_path`: (Optional) Storage path, defaults to `~/.agent/reports/`.

## 📝 Execution Logic

1. **Date Processing**: Convert input into Git-compatible `--since` and `--until` formats.
2. **Git Extraction**: Retrieve `git log` within the specified interval.
3. **AI Summary**: Categorize the raw logs (feat/fix/chore) and extract key values.
4. **Persistence**: Generate a Markdown file and save it.
