#!/bin/bash
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../../.." && pwd)
PKG="$ROOT/desktop/macos"
CACHE="$HOME/Library/Caches/cattt-build"
VERSION=${CATTT_VERSION:-0.1.0}
mkdir -p "$CACHE" "$PKG/build"
fetch() {
  local url=$1 file=$2 sha=$3
  if [ ! -f "$file" ]; then curl --fail --location --retry 3 "$url" -o "$file"; fi
  echo "$sha  $file" | shasum -a 256 -c -
}
fetch https://nodejs.org/dist/v22.16.0/node-v22.16.0-darwin-arm64.tar.gz "$CACHE/node-22.16.0.tar.gz" 1d7f34ec4c03e12d8b33481e5c4560432d7dc31a0ef3ff5a4d9a8ada7cf6ecc9
fetch https://get.enterprisedb.com/postgresql/postgresql-17.7-1-osx-binaries.zip "$CACHE/postgresql-17.7-1.zip" 344e3cbd890fa110d4115b308a9f87ef3f3a3a304cabac5c9f7b861bc98f54b8
if [ ! -d "$CACHE/pg-17.7" ]; then mkdir -p "$CACHE/pg-17.7"; ditto -xk "$CACHE/postgresql-17.7-1.zip" "$CACHE/pg-17.7"; fi
APP="$PKG/build/Cattt.app"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources/node" "$APP/Contents/Resources/postgres"
tar -xzf "$CACHE/node-22.16.0.tar.gz" -C "$APP/Contents/Resources/node" --strip-components=1 node-v22.16.0-darwin-arm64/bin/node
for dir in bin lib share; do ditto "$CACHE/pg-17.7/pgsql/$dir" "$APP/Contents/Resources/postgres/$dir"; done
rm -rf "$APP/Contents/Resources/postgres/share/doc" "$APP/Contents/Resources/postgres/share/man"
# 只发布数据库运行依赖，不发布管理界面和文档。
for binary in postgres initdb pg_dump pg_restore pg_isready psql; do
  otool -L "$APP/Contents/Resources/postgres/bin/$binary"
done
pnpm --dir "$ROOT/server" exec node scripts/bundle-host.mjs "$APP/Contents/Resources/server"
test -f "$APP/Contents/Resources/server/model-setup.mjs"
swift build --package-path "$PKG" -c release
cp "$PKG/.build/release/CatttHost" "$APP/Contents/MacOS/CatttHost"
/usr/libexec/PlistBuddy -c 'Clear dict' "$APP/Contents/Info.plist" 2>/dev/null || true
/usr/libexec/PlistBuddy -c 'Add :CFBundleIdentifier string app.cattt.host' "$APP/Contents/Info.plist"
/usr/libexec/PlistBuddy -c 'Add :CFBundleExecutable string CatttHost' "$APP/Contents/Info.plist"
/usr/libexec/PlistBuddy -c 'Add :CFBundleName string 团子' "$APP/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Add :CFBundleShortVersionString string $VERSION" "$APP/Contents/Info.plist"
/usr/libexec/PlistBuddy -c 'Add :CFBundlePackageType string APPL' "$APP/Contents/Info.plist"
/usr/libexec/PlistBuddy -c 'Add :LSMinimumSystemVersion string 14.0' "$APP/Contents/Info.plist"
/usr/libexec/PlistBuddy -c 'Add :LSUIElement bool true' "$APP/Contents/Info.plist"
find "$APP/Contents/Resources" -type f -perm +111 -print0 | while IFS= read -r -d '' file; do
  if file "$file" | rg -q Mach-O; then codesign --force -s - "$file"; fi
done
codesign --force --deep -s - "$APP"
"$APP/Contents/Resources/postgres/bin/pg_dump" --version
"$APP/Contents/Resources/node/bin/node" --version
hdiutil create -ov -volname 团子 -srcfolder "$APP" -format UDZO "$PKG/build/Cattt-$VERSION.dmg"
du -h "$PKG/build/Cattt-$VERSION.dmg"
echo "$APP"
