#!/usr/bin/env bash
# Release packaging (macOS, arm64): release build → ad-hoc signature → .dmg (with an Applications link) and .zip
# in ../release/, then mounts/unzips both and verifies the signature of what's inside. Prints SHA-256 sums.
set -euo pipefail
cd "$(dirname "$0")/.."

VERSION=$(node -p 'require("./package.json").version')
NAME="Courier-$VERSION-arm64"
OUT="$(cd .. && pwd)/release"
# Cargo's build directory (it can be moved with CARGO_TARGET_DIR or a .cargo/config.toml).
TARGET=$(cd src-tauri && cargo metadata --format-version 1 --no-deps | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).target_directory))')
APP="$TARGET/aarch64-apple-darwin/release/bundle/macos/Courier.app"
mkdir -p "$OUT"
rm -f "$OUT/$NAME.dmg" "$OUT/$NAME.zip"

echo "building Courier $VERSION (release, arm64)…"
npx tauri build --target aarch64-apple-darwin --bundles app

echo "signing ad hoc…"
codesign --force --deep --sign - "$APP"
codesign --verify --deep --strict --verbose=2 "$APP"

echo "making the disk image…"
STAGE=$(mktemp -d -t courier-dmg)
ditto "$APP" "$STAGE/Courier.app"
ln -s /Applications "$STAGE/Applications"
hdiutil create -volname "Courier $VERSION" -srcfolder "$STAGE" -fs HFS+ -format UDZO -ov "$OUT/$NAME.dmg" >/dev/null
rm -rf "$STAGE"

echo "making the zip…"
ditto -c -k --sequesterRsrc --keepParent "$APP" "$OUT/$NAME.zip"

echo "checking both…"
MNT=$(mktemp -d -t courier-mnt)
hdiutil attach -nobrowse -readonly -mountpoint "$MNT" "$OUT/$NAME.dmg" >/dev/null
[ -L "$MNT/Applications" ] || { echo "no Applications link in the image"; hdiutil detach "$MNT" >/dev/null; exit 1; }
codesign --verify --deep --strict "$MNT/Courier.app"
hdiutil detach "$MNT" >/dev/null
UNZ=$(mktemp -d -t courier-unzip)
ditto -x -k "$OUT/$NAME.zip" "$UNZ"
codesign --verify --deep --strict "$UNZ/Courier.app"
file "$UNZ/Courier.app/Contents/MacOS/Courier" | grep -q "arm64" || { echo "binary isn't arm64"; exit 1; }
rm -rf "$UNZ"

echo
(cd "$OUT" && shasum -a 256 "$NAME.dmg" "$NAME.zip" | tee "$NAME.sha256")
