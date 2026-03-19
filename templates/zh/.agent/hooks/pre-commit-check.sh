#!/bin/bash
# Cortex Agent - Pre-Commit Check Hook
# Claude Code 钩子：在每次文件写入/编辑后自动触发
# 配置方式：在 .claude/settings.json 中添加 PostToolUse 事件
#
# settings.json 示例：
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

# 从 stdin 读取 Claude Code 传入的 JSON 上下文
INPUT=$(cat)

# 提取被修改的文件路径
FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // .tool_input.path // ""' 2>/dev/null || echo "")

if [ -z "$FILE_PATH" ] || [ ! -f "$FILE_PATH" ]; then
  exit 0
fi

ERRORS=""

# 1. 检查敏感信息（硬编码密钥/Token）
if grep -qiE "(api_key|secret_key|password|token)\s*=\s*['\"][^'\"]{8,}" "$FILE_PATH" 2>/dev/null; then
  ERRORS="${ERRORS}\n⚠️  [安全] 疑似硬编码密钥: $FILE_PATH"
fi

# 2. 对 JS/TS 文件运行 ESLint（若已安装）
if [[ "$FILE_PATH" =~ \.(js|ts|jsx|tsx)$ ]]; then
  if command -v eslint &>/dev/null; then
    if ! eslint --quiet "$FILE_PATH" 2>/dev/null; then
      ERRORS="${ERRORS}\n⚠️  [Lint] ESLint 检查失败: $FILE_PATH"
    fi
  fi
fi

# 3. 对 Python 文件运行 ruff（若已安装）
if [[ "$FILE_PATH" =~ \.py$ ]]; then
  if command -v ruff &>/dev/null; then
    if ! ruff check --quiet "$FILE_PATH" 2>/dev/null; then
      ERRORS="${ERRORS}\n⚠️  [Lint] Ruff 检查失败: $FILE_PATH"
    fi
  fi
fi

# 输出结果给 Claude Code
if [ -n "$ERRORS" ]; then
  # 返回提示信息，让 Claude Code 感知到问题（不阻断，仅告知）
  echo -e "🔍 Pre-commit 检查发现以下问题：$ERRORS" >&2
fi

exit 0
