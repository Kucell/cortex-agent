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
    echo "Config mode: private (Visible to IDE, Ignored by Git)"
    # 1. Remove from .gitignore
    if [ -f "$GITIGNORE" ]; then
      sd_i "/^\.agent$/d" "$GITIGNORE"
    fi
    # 2. Add to local exclude
    mkdir -p .git/info
    grep -qxF "$AGENT_DIR" "$LOCAL_EXCLUDE" 2>/dev/null || echo "$AGENT_DIR" >> "$LOCAL_EXCLUDE"
    # 3. Ensure it's not staged
    git reset "$AGENT_DIR" > /dev/null 2>&1
    echo "✅ Setup complete. Try checking the / menu."
    ;;

  "ignore")
    echo "Config mode: ignore (Completely ignored by Git)"
    # 1. Remove from local exclude
    if [ -f "$LOCAL_EXCLUDE" ]; then
      sd_i "/^\.agent$/d" "$LOCAL_EXCLUDE"
    fi
    # 2. Add to .gitignore
    grep -qxF "$AGENT_DIR" "$GITIGNORE" 2>/dev/null || echo "$AGENT_DIR" >> "$GITIGNORE"
    # 3. Remove from cache if tracked
    git rm -r --cached "$AGENT_DIR" > /dev/null 2>&1
    echo "✅ Completely ignored. Menu may stop working."
    ;;

  "track")
    echo "Config mode: track (Normally tracked by Git)"
    if [ -f "$GITIGNORE" ]; then
      sd_i "/^\.agent$/d" "$GITIGNORE"
    fi
    if [ -f "$LOCAL_EXCLUDE" ]; then
      sd_i "/^\.agent$/d" "$LOCAL_EXCLUDE"
    fi
    git add "$AGENT_DIR"
    echo "✅ .agent is now being tracked by Git."
    ;;

  *)
    echo "Usage: $0 [private|ignore|track]"
    exit 1
    ;;
esac
