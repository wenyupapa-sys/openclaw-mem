#!/bin/bash
# mem-get.sh - 获取记忆详情
# 用法: mem-get.sh ID1 [ID2 ID3 ...]

if [ -z "$1" ]; then
  echo "用法: mem-get.sh ID1 [ID2 ID3 ...]"
  exit 1
fi

PORT=18790

# 构建 JSON 数组
IDS=""
for id in "$@"; do
  if [ -n "$IDS" ]; then
    IDS="$IDS,$id"
  else
    IDS="$id"
  fi
done

curl -s -X POST "http://127.0.0.1:$PORT/get_observations" \
  -H "Content-Type: application/json" \
  -d "{\"ids\":[$IDS]}"
