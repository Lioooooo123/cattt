#!/bin/sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
OUTPUT="$ROOT/ios/Maomao/Resources/YardWeb"
if [ "${SKIP_YARD_WEB_BUILD:-0}" = 1 ]; then
    if [ ! -f "$OUTPUT/app.html" ]; then
        echo 'error: SKIP_YARD_WEB_BUILD=1，但 YardWeb/app.html 不存在；请先运行 pnpm --dir web build:ios。' >&2
        exit 1
    fi
    echo '跳过 YardWeb 构建，使用已有资源。'
    exit 0
fi

export PATH="${PATH:-/usr/bin:/bin}:/opt/homebrew/bin:/usr/local/bin:$HOME/.volta/bin:$HOME/Library/pnpm:$HOME/.local/share/pnpm:$HOME/.local/bin:$HOME/.fnm/current/bin"
if ! command -v node >/dev/null 2>&1; then
    echo 'error: 找不到 Node.js；请安装 Node.js 22.12+，并将其目录加入 Xcode 的 PATH。' >&2
    exit 1
fi
if command -v pnpm >/dev/null 2>&1; then
    pnpm --dir "$ROOT/web" build:ios
elif command -v corepack >/dev/null 2>&1; then
    corepack pnpm --dir "$ROOT/web" build:ios
else
    echo 'error: 找不到 pnpm；请安装 pnpm 11（或启用 Corepack），安装 web 依赖后重新构建。' >&2
    exit 1
fi
