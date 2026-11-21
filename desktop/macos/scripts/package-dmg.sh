#!/bin/bash
set -euo pipefail
set +x
ROOT=$(cd "$(dirname "$0")/../../.." && pwd)
SCRIPTS="$ROOT/desktop/macos/scripts"
OUT="$ROOT/desktop/macos/build"
VERSION=${CATTT_VERSION:-0.1.0}
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo 'CATTT_VERSION must be X.Y.Z' >&2; exit 1; }
[[ $(uname -m) = arm64 ]] || { echo 'Apple Silicon build host required' >&2; exit 1; }
mkdir -p "$OUT"
WORK=$(mktemp -d "$OUT/package.XXXXXX")
KEYCHAIN=""
cleanup() {
  if [ -n "$KEYCHAIN" ]; then security delete-keychain "$KEYCHAIN"; fi
  rm -rf "$WORK"
}
trap cleanup EXIT
IDENTITY=-
SIGN_ARGS=(--timestamp=none)
if [ -n "${APPLE_DEVELOPER_ID_APPLICATION:-}" ] && [ -n "${APPLE_CERTIFICATE_P12_BASE64:-}" ] && [ -n "${APPLE_CERTIFICATE_PASSWORD:-}" ]; then
  umask 077
  KEYCHAIN="$WORK/signing.keychain-db"
  KEYCHAIN_PASSWORD=$(openssl rand -hex 24)
  printf '%s' "$APPLE_CERTIFICATE_P12_BASE64" | base64 -D > "$WORK/certificate.p12"
  security create-keychain -p "$KEYCHAIN_PASSWORD" "$KEYCHAIN"
  security set-keychain-settings -lut 21600 "$KEYCHAIN"
  security unlock-keychain -p "$KEYCHAIN_PASSWORD" "$KEYCHAIN"
  security import "$WORK/certificate.p12" -k "$KEYCHAIN" -P "$APPLE_CERTIFICATE_PASSWORD" -T /usr/bin/codesign >/dev/null
  security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$KEYCHAIN_PASSWORD" "$KEYCHAIN" >/dev/null
  IDENTITY="$APPLE_DEVELOPER_ID_APPLICATION"
  SIGN_ARGS=(--timestamp --keychain "$KEYCHAIN")
else
  echo 'Signing credentials absent/incomplete: ad hoc signing; skipping notarization, stapling and spctl.'
fi
# 每次从空应用组装，避免上次构建的文件留在签名资源中。
umask 022
rm -rf "$OUT/Cattt.app"
CATTT_VERSION="$VERSION" CATTT_ASSEMBLE_ONLY=1 bash "$SCRIPTS/build-app.sh"
APP="$OUT/Cattt.app"
sign() { codesign --force --sign "$IDENTITY" "${SIGN_ARGS[@]}" --options runtime "$@"; }
while IFS= read -r -d '' binary; do
  if file -b "$binary" | /usr/bin/grep -q 'Mach-O'; then
    entitlement="$SCRIPTS/runtime.entitlements.plist"
    if [ "$IDENTITY" = - ] && [[ "$binary" = "$APP/Contents/Resources/postgres/"* ]]; then
      entitlement="$SCRIPTS/adhoc-postgres.entitlements.plist"
    fi
    if [ "$binary" = "$APP/Contents/Resources/node/bin/node" ]; then entitlement="$SCRIPTS/node.entitlements.plist"; fi
    sign --entitlements "$entitlement" "$binary"
  fi
done < <(find "$APP/Contents" -depth -type f -print0)
sign --entitlements "$SCRIPTS/runtime.entitlements.plist" "$APP"
codesign --verify --deep --strict --verbose=2 "$APP"
NOTARIZE=0
if [ "$IDENTITY" != - ] && [ -n "${APPLE_NOTARY_KEY_ID:-}" ] && [ -n "${APPLE_NOTARY_ISSUER_ID:-}" ] && [ -n "${APPLE_NOTARY_KEY_P8_BASE64:-}" ]; then
  NOTARIZE=1
  umask 077
  printf '%s' "$APPLE_NOTARY_KEY_P8_BASE64" | base64 -D > "$WORK/AuthKey.p8"
  umask 022
elif [ "$IDENTITY" != - ]; then
  echo 'Notary credentials absent/incomplete: skipping notarization, stapling and spctl.'
fi
notarize() {
  xcrun notarytool submit "$1" --key "$WORK/AuthKey.p8" --key-id "$APPLE_NOTARY_KEY_ID" --issuer "$APPLE_NOTARY_ISSUER_ID" --wait
}
if [ "$NOTARIZE" = 1 ]; then
  ditto -c -k --keepParent "$APP" "$WORK/Cattt.zip"
  notarize "$WORK/Cattt.zip"
  xcrun stapler staple "$APP"
fi
mkdir "$WORK/image"
ditto "$APP" "$WORK/image/Cattt.app"
ln -s /Applications "$WORK/image/Applications"
DMG="$OUT/Cattt-$VERSION-arm64.dmg"
hdiutil create -ov -volname Cattt -srcfolder "$WORK/image" -format UDZO "$DMG"
sign "$DMG"
codesign --verify --strict --verbose=2 "$DMG"
if [ "$NOTARIZE" = 1 ]; then
  notarize "$DMG"
  xcrun stapler staple "$DMG"
  codesign --verify --deep --strict --verbose=2 "$APP"
  spctl --assess --type execute --verbose=2 "$APP"
  spctl -a -t open --context context:primary-signature --verbose=2 "$DMG"
  xcrun stapler validate "$APP"
  xcrun stapler validate "$DMG"
fi
du -h "$DMG"
echo "$DMG"
