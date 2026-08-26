#!/usr/bin/env bash
# 在 tmux（allow-passthrough on）内通过 DCS passthrough 显示图片
# 序列包装: \x1bPtmux;\x1b + (APC 中所有 ESC 双写) + \x1b\\
set -euo pipefail

FILE="${1:-$(dirname "$0")/test.png}"
B64=$(base64 -w0 "$FILE" 2>/dev/null || base64 "$FILE" | tr -d '\n')

first=1
while [ -n "$B64" ]; do
  chunk="${B64:0:4096}"
  B64="${B64:4096}"
  if [ -n "$B64" ]; then m=1; else m=0; fi
  if [ "$first" -eq 1 ]; then
    inner=$(printf '\x1b_Ga=T,f=100,m=%s;%s\x1b\\' "$m" "$chunk")
    first=0
  else
    inner=$(printf '\x1b_Gm=%s;%s\x1b\\' "$m" "$chunk")
  fi
  # DCS passthrough 包装：内部 ESC 全部双写
  wrapped=${inner//$'\x1b'/$'\x1b\x1b'}
  printf '\x1bPtmux;%s\x1b\\' "$wrapped"
done
echo
