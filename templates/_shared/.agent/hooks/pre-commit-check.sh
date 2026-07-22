#!/bin/bash
# Cortex Agent - Pre-Commit Check Hook
# Claude Code hook: fires automatically after each file write/edit
# Configure in .claude/settings.json under PostToolUse event
#
# settings.json example:
# {
#   "hooks": {
#     "PostToolUse": [
#       {
#         "matcher": "Write|Edit|MultiEdit",
#         "hooks": [{ "type": "command", "command": ".claude/hooks/pre-commit-check.sh" }]
#       }
#     ]
#   }
# }

set -euo pipefail

# Read JSON context passed by Claude Code via stdin
INPUT=$(cat)

# Extract the modified file path
FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // .tool_input.path // ""' 2>/dev/null || echo "")

if [ -z "$FILE_PATH" ] || [ ! -f "$FILE_PATH" ]; then
  exit 0
fi

ERRORS=""

# 1. Scan for hardcoded secrets / API keys
if grep -qiE "(api_key|secret_key|password|token)\s*=\s*['\"][^'\"]{8,}" "$FILE_PATH" 2>/dev/null; then
  ERRORS="${ERRORS}\n⚠️  [Security] Possible hardcoded secret in: $FILE_PATH"
fi

# 2. Run ESLint on JS/TS files (if installed)
if [[ "$FILE_PATH" =~ \.(js|ts|jsx|tsx)$ ]]; then
  if command -v eslint &>/dev/null; then
    if ! eslint --quiet "$FILE_PATH" 2>/dev/null; then
      ERRORS="${ERRORS}\n⚠️  [Lint] ESLint check failed: $FILE_PATH"
    fi
  fi
fi

# 3. Run ruff on Python files (if installed)
if [[ "$FILE_PATH" =~ \.py$ ]]; then
  if command -v ruff &>/dev/null; then
    if ! ruff check --quiet "$FILE_PATH" 2>/dev/null; then
      ERRORS="${ERRORS}\n⚠️  [Lint] Ruff check failed: $FILE_PATH"
    fi
  fi
fi

# 4. Run go vet on Go files (if installed)
if [[ "$FILE_PATH" =~ \.go$ ]]; then
  if command -v go &>/dev/null; then
    FILE_DIR=$(dirname "$FILE_PATH")
    if ! go vet "$FILE_DIR" 2>/dev/null; then
      ERRORS="${ERRORS}\n⚠️  [Lint] go vet check failed: $FILE_PATH"
    fi
  fi
fi

# 5. Run checkstyle on Java files (if installed and checkstyle.xml exists)
if [[ "$FILE_PATH" =~ \.java$ ]]; then
  if command -v checkstyle &>/dev/null && [ -f "checkstyle.xml" ]; then
    if ! checkstyle -c checkstyle.xml "$FILE_PATH" 2>/dev/null; then
      ERRORS="${ERRORS}\n⚠️  [Lint] Checkstyle check failed: $FILE_PATH"
    fi
  fi
fi

# 6. Run swiftlint on Swift files (if installed)
if [[ "$FILE_PATH" =~ \.swift$ ]]; then
  if command -v swiftlint &>/dev/null; then
    if ! swiftlint lint --quiet "$FILE_PATH" 2>/dev/null; then
      ERRORS="${ERRORS}\n⚠️  [Lint] SwiftLint check failed: $FILE_PATH"
    fi
  fi
fi

# Report findings back to Claude Code
if [ -n "$ERRORS" ]; then
  # Output as stderr and block execution (Layer 1: deterministic checks)
  echo -e "❌ Pre-commit check BLOCKED:$ERRORS" >&2
  exit 1
fi

# All checks passed
exit 0
