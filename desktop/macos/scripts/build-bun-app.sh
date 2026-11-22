#!/bin/bash
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/../../.." && pwd)
PKG="$ROOT/desktop/macos"
BUILD="$PKG/build"
APP="$BUILD/CatttBunHost.app"
BUN=${CATTT_BUN:-bun}
VERSION=${CATTT_VERSION:-0.1.0}
HOST_SOURCE=$(cd "${CATTT_HOST_SOURCE:-$ROOT/host}" && pwd)
PINNED_BUN=$(cat "$HOST_SOURCE/.bun-version")

if [ "$(uname -sm)" != 'Darwin arm64' ]; then
  echo 'Bun 开发应用需在 Apple Silicon Mac 上构建' >&2
  exit 1
fi
if [ "$("$BUN" --version)" != "$PINNED_BUN" ]; then
  echo "请安装 Bun $PINNED_BUN，或用 CATTT_BUN 指定该版本的绝对路径" >&2
  exit 1
fi

for input in src/backup/index.ts src/world/routes.ts src/ticket-workers/compute-worker.ts; do
  test -f "$HOST_SOURCE/$input" || { echo "Bun 宿主源码缺少 $input，请使用合体后的 host/" >&2; exit 1; }
done

mkdir -p "$BUILD"
STAGE=$(mktemp -d "$BUILD/bun-assembly.XXXXXX")
trap 'rm -rf "$STAGE"' EXIT
BUNDLE="$STAGE/CatttBunHost.app"
BIN="$BUNDLE/Contents/MacOS"
mkdir -p "$BIN" "$BUNDLE/Contents/Resources"
pnpm --dir "$ROOT/web" build:ios
ditto "$ROOT/ios/Maomao/Resources/YardWeb" "$BUNDLE/Contents/Resources/YardWeb"
test -f "$BUNDLE/Contents/Resources/YardWeb/app.html"

(
  cd "$HOST_SOURCE"
  "$BUN" install --frozen-lockfile
  # SQLite migrations are imported from store/migrations.generated.ts by the entry point.
  "$BUN" build --compile --no-compile-autoload-dotenv --no-compile-autoload-bunfig src/main.ts src/ticket-workers/compute-worker.ts --outfile "$BIN/cattt-host"
)
swift build --package-path "$PKG" -c release --arch arm64 --product CatttBunHost
cp "$PKG/.build/release/CatttBunHost" "$BIN/CatttBunHost"

PLIST="$BUNDLE/Contents/Info.plist"
/usr/libexec/PlistBuddy -c 'Add :CFBundleIdentifier string app.cattt.host.bun-development' \
  -c 'Add :CFBundleExecutable string CatttBunHost' -c 'Add :CFBundleName string 团子开发宿主' \
  -c 'Add :CFBundlePackageType string APPL' -c "Add :CFBundleVersion string $VERSION" \
  -c "Add :CFBundleShortVersionString string $VERSION" -c 'Add :LSMinimumSystemVersion string 14.0' \
  -c 'Add :LSUIElement bool false' "$PLIST"
codesign --force -s - "$BIN/cattt-host"
codesign --force -s - "$BUNDLE"
codesign --verify --deep --strict "$BUNDLE"

rm -rf "$APP"
mv "$BUNDLE" "$APP"
echo "$APP"
