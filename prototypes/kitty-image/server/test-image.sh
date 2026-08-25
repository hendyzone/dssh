#!/usr/bin/env bash
# 通过 Kitty graphics protocol 在终端内显示图片（分块传输，每块 ≤4096 字节）
# 用法: ./test-image.sh [图片路径]
set -euo pipefail

FILE="${1:-$(dirname "$0")/test.png}"
B64=$(base64 -w0 "$FILE" 2>/dev/null || base64 "$FILE" | tr -d '\n')

first=1
while [ -n "$B64" ]; do
  chunk="${B64:0:4096}"
  B64="${B64:4096}"
  if [ -n "$B64" ]; then m=1; else m=0; fi
  if [ "$first" -eq 1 ]; then
    # a=T: 传输并显示; f=100: PNG 格式
    printf '\x1b_Ga=T,f=100,m=%s;%s\x1b\\' "$m" "$chunk"
    first=0
  else
    printf '\x1b_Gm=%s;%s\x1b\\' "$m" "$chunk"
  fi
done
echo
