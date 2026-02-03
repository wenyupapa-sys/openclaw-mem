#!/bin/bash
# mem-search.sh - 记忆搜索包装脚本（自动处理中文 URL 编码）
# 用法: mem-search.sh "搜索词" [limit]

QUERY="$1"
LIMIT="${2:-10}"
PORT=18790

if [ -z "$QUERY" ]; then
  echo "用法: mem-search.sh \"搜索词\" [limit]"
  exit 1
fi

# 使用 POST + JSON 避免 URL 编码问题
curl -s -X POST "http://127.0.0.1:$PORT/search" \
  -H "Content-Type: application/json" \
  -d "{\"query\":\"$QUERY\",\"limit\":$LIMIT}"
