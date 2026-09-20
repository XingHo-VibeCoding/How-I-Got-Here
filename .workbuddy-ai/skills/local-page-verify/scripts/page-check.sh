#!/usr/bin/env bash
# 本地页面渲染校验脚手架（可 source）
#
# 用法：
#   source page-check.sh
#   CHROME=$(find_browser)
#   TMPD=$(mktemp -d)
#   D=$(render_dom "http://127.0.0.1:8000/#/levels")
#   check "关卡格子数 = 28" "$(echo "$D" | count 'class="cell is-')" "28"
#   report
#   cleanup
#
# 注意：本文件必须被 source 使用（依赖内部函数与全局变量 PASS/FAIL）。

# ── 找浏览器 ─────────────────────────────────────────────
find_browser() {
  local p
  for p in \
    "/c/Program Files/Google/Chrome/Application/chrome.exe" \
    "/c/Program Files (x86)/Google/Chrome/Application/chrome.exe" \
    "/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe" \
    "/c/Program Files/Microsoft/Edge/Application/msedge.exe" \
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
    "/usr/bin/google-chrome" \
    "/usr/bin/chromium" ; do
    if [ -f "$p" ]; then echo "$p"; return 0; fi
  done
  echo "找不到 Chrome 或 Edge" >&2
  return 1
}

# ── 内部：拼公共参数 ─────────────────────────────────────
_browser_args() {
  # 用法：_browser_args [预算毫秒]
  echo "--headless=new --disable-gpu --no-sandbox --user-data-dir=${TMPD}/profile --virtual-time-budget=${1:-3000}"
}

# ── 取渲染后的 DOM ───────────────────────────────────────
render_dom() {
  # 用法：render_dom <url> [预算毫秒]
  "$CHROME" $(_browser_args "$2") --dump-dom "$1" 2>/dev/null
}

# ── 截图 ─────────────────────────────────────────────────
render_shot() {
  # 用法：render_shot <url> <输出png路径> [窗口尺寸]
  local url="$1" out="$2" size="${3:-1180,1000}"
  "$CHROME" $(_browser_args 3500) --window-size="$size" --screenshot="$out" "$url" 2>/dev/null
  [ -f "$out" ] && echo "截图已保存：$out" || { echo "截图失败" >&2; return 1; }
}

# ── 计数：统计某个字符串在输入里出现多少次 ───────────────
count() { grep -o "$1" | wc -l | tr -d ' '; }

# ── 计数（按行）：某行是否出现 ───────────────────────────
count_lines() { grep -c "$1"; }

# ── 打印某个关键词前后的上下文，用于排查断言失败 ─────────
show_context() {
  # 用法：echo "$D" | show_context "第 5 关"
  grep -o ".\{0,40\}$1.\{0,40\}"
}

# ── 断言 ─────────────────────────────────────────────────
check() {
  # 用法：check "用例名" "实际值" "期望值"
  if [ "$2" = "$3" ]; then
    echo "PASS  $1"
    PASS=$((PASS + 1))
  else
    echo "FAIL  $1  (实际=[$2] 期望=[$3])"
    FAIL=$((FAIL + 1))
  fi
}

# ── 汇总 ─────────────────────────────────────────────────
report() {
  echo "----------------------------------------"
  echo "通过 ${PASS:-0} 项，失败 ${FAIL:-0} 项"
  echo "----------------------------------------"
  [ "${FAIL:-0}" -eq 0 ] && return 0 || return 1
}

# ── 清理 ─────────────────────────────────────────────────
cleanup() {
  # 用法：cleanup [额外的临时文件或目录...]
  local p
  for p in "$TMPD" "$@"; do
    [ -n "$p" ] && [ -e "$p" ] && rm -rf "$p"
  done
  echo "临时文件已清理"
}
