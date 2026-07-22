#!/bin/bash

# ~/.agent/skills/sync-global/scripts/sync.sh

GLOBAL_DIR="$HOME/.agent"
LOCAL_DIR=".agent"

echo "🔄 正在同步全局 Agent 配置到当前项目..."

if [ ! -d "$LOCAL_DIR" ]; then
    echo "⚠️ 本地 .agent 目录不存在，正在初始化..."
    mkdir -p "$LOCAL_DIR/workflows" "$LOCAL_DIR/skills" "$LOCAL_DIR/rules"
fi

# 1. 同步全局工作流 (Workflows)
if [ -d "$GLOBAL_DIR/workflows" ]; then
    echo "  > 同步工作流..."
    for f in "$GLOBAL_DIR/workflows"/*.md; do
        [ -e "$f" ] || continue
        FILENAME=$(basename "$f")
        # 建立符号链接，-f 参数确保如果已存在则更新
        ln -sf "$f" "$LOCAL_DIR/workflows/$FILENAME"
    done
fi

# 2. 同步全局技能 (Skills)
if [ -d "$GLOBAL_DIR/skills" ]; then
    echo "  > 同步通用技能..."
    for d in "$GLOBAL_DIR/skills"/*; do
        [ -d "$d" ] || continue
        DIRNAME=$(basename "$d")
        # 跳过同步技能本身，避免死循环
        if [ "$DIRNAME" == "sync-global" ]; then continue; fi
        ln -sf "$d" "$LOCAL_DIR/skills/$DIRNAME"
    done
fi

echo "✅ 同步完成！当前项目已加载所有全局能力。"
echo "💡 提示：如果 Slash 菜单未更新，请保存任意文件或重启编辑器。"
