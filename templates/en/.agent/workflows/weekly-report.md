---
name: weekly-report
description: Generate weekly reports based on Git records, supporting custom storage paths.
---

# 📊 Weekly Report Generation Workflow (/weekly-report)

When you need to generate a development weekly report, follow this process:

## 1. Core Parameter Acquisition

- **Date Range**: Please specify the date range (e.g., `1.24-1.31`).
- **Custom Path**: (Optional) If you want to save to a specific folder, please provide the path (defaults to `~/.agent/reports/`).

## 2. Data Collection and Processing

- **Git Log Reading**:
  - I will automatically execute `git log --since="YYYY-MM-DD" --until="YYYY-MM-DD"` based on the input dates (defaulting to the current year).
- **Data Anonymization**: Automatically remove commit hashes and emails, keeping only the author, date, and commit message.

## 3. Content Generation

- **Smart Categorization**:
  - 🚀 **Features**
  - 🐛 **Fixes**
  - 🔧 **Chore/Build**
- **Value Extraction**: Summarize messy commit records into concise sentences.

## 4. Storage and Archiving

// turbo

- **Directory Check**: I will automatically create the specified folder if it doesn't exist.
- **Save Path**:
  - Project Name: Extracted from `package.json` or the directory name.
  - Filename Format: `weekly-report_[project_name]_[date].md`.
- **Persistence**: Write to the file and provide the full path.

## 5. Tips

> This weekly report is stored in the `reports` folder under the global directory for easier cross-project management.
