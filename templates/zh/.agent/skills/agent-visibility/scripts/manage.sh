#!/bin/bash

# .agent/skills/agent-visibility/scripts/manage.sh

MODE=$1
AGENT_DIR=".agent"
GITIGNORE=".gitignore"
LOCAL_EXCLUDE=".git/info/exclude"

# Function for cross-platform sed -i
sd_i() {
  local pattern=$1
  local file=$2
  if [[ "$OSTYPE" == "darwin"* ]]; then
    sed -i '' "$pattern" "$file"
  else
    sed -i "$pattern" "$file"
  fi
}

case $MODE in
  "private")
    echo "配置模式: private (IDE 可见, Git 忽略)"
    # 1. 从 .gitignore 移除
    if [ -f "$GITIGNORE" ]; then
      sd_i "/^\.agent$/d" "$GITIGNORE"
    fi
    # 2. 加入本地忽略
    mkdir -p .git/info
    grep -qxF "$AGENT_DIR" "$LOCAL_EXCLUDE" 2>/dev/null || echo "$AGENT_DIR" >> "$LOCAL_EXCLUDE"
    # 3. 确保不处于暂存区
    git reset "$AGENT_DIR" > /dev/null 2>&1
    echo "✅ 设置完成。请尝试输入 / 菜单。"
    ;;

  "ignore")
    echo "配置模式: ignore (Git 彻底忽略)"
    # 1. 移出本地忽略
    if [ -f "$LOCAL_EXCLUDE" ]; then
      sd_i "/^\.agent$/d" "$LOCAL_EXCLUDE"
    fi
    # 2. 加入 .gitignore
    grep -qxF "$AGENT_DIR" "$GITIGNORE" 2>/dev/null || echo "$AGENT_DIR" >> "$GITIGNORE"
    # 3. 如果已被追踪则移除索引
    git rm -r --cached "$AGENT_DIR" > /dev/null 2>&1
    echo "✅ 已彻底忽略。菜单可能失效。"
    ;;

  "track")
    echo "配置模式: track (Git 正常追踪)"
    if [ -f "$GITIGNORE" ]; then
      sd_i "/^\.agent$/d" "$GITIGNORE"
    fi
    if [ -f "$LOCAL_EXCLUDE" ]; then
      sd_i "/^\.agent$/d" "$LOCAL_EXCLUDE"
    fi
    git add "$AGENT_DIR"
    echo "✅ 现在 .agent 已进入 Git 追踪范围。"
    ;;

  *)
    echo "使用方法: $0 [private|ignore|track]"
    exit 1
    ;;
esac
