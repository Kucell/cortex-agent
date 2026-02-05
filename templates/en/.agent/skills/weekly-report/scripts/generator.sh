#!/bin/bash

# ~/ .agent/skills/weekly-report/scripts/generator.sh

RANGE=$1
TARGET_DIR=$2
PROJECT_NAME=$(basename "$(pwd)")

# 默认全局存储
DEFAULT_REPORT_DIR="$HOME/.agent/reports/$PROJECT_NAME"

if [ -z "$RANGE" ]; then
    echo "❌ 错误: 请提供日期范围，如 1.24-1.31"
    exit 1
fi

# 解析日期 (假设为当年)
YEAR=$(date +%Y)
START_DATE=$(echo "$RANGE" | cut -d'-' -f1)
END_DATE=$(echo "$RANGE" | cut -d'-' -f2)

# 转换为 YYYY-MM-DD
FS=$(echo "$YEAR-$START_DATE" | sed 's/\./-/g')
FE=$(echo "$YEAR-$END_DATE" | sed 's/\./-/g')

# 确保存储目录
FINAL_DIR=${TARGET_DIR:-$DEFAULT_REPORT_DIR}
mkdir -p "$FINAL_DIR"

OUTPUT_FILE="$FINAL_DIR/weekly-report_${FS}_to_${FE}.md"

echo "📅 正在获取 Git 记录 ($FS 至 $FE)..."

# 导出原始日志
git log --since="$FS 00:00:00" --until="$FE 23:59:59" --pretty=format:"* %ad [%an] %s" --date=short > "$OUTPUT_FILE.tmp"

if [ ! -s "$OUTPUT_FILE.tmp" ]; then
    echo "⚠️ 警告: 该时段内未发现提交记录。"
    rm "$OUTPUT_FILE.tmp"
    exit 0
fi

echo "✅ 原始数据已提取，准备交由 AI 总结。"
# 这里脚本主要负责数据准备，后续由 AI Agent 读取 tmp 文件进行总结并写入最终文件。
# AI 任务结束后，应删除 .tmp 文件。
echo "TMP_FILE: $OUTPUT_FILE.tmp"
echo "FINAL_FILE: $OUTPUT_FILE"
