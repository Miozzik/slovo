#!/usr/bin/env bash
# Package a built .app into a distributable .dmg using only `hdiutil` — no
# AppleScript/Finder, so it works on headless CI runners (Tauri's own dmg
# bundler styles the window via AppleScript and fails on GitHub Actions).
#
# The dmg contains the app plus an /Applications symlink so users can drag-to-
# install. If an icon PNG is given, the dmg file also gets that Finder icon.
#
# Usage: scripts/package-dmg.sh <App.app> <out.dmg> [volume-name] [icon.png]
set -euo pipefail

APP="${1:?usage: package-dmg.sh <App.app> <out.dmg> [volname] [icon.png]}"
OUT="${2:?usage: package-dmg.sh <App.app> <out.dmg> [volname] [icon.png]}"
VOL="${3:-Slovo}"
ICON="${4:-}"

[ -d "$APP" ] || { echo "app not found: $APP" >&2; exit 1; }

HERE="$(cd "$(dirname "$0")" && pwd)"
STAGE="$(mktemp -d)/dmg"
trap 'rm -rf "$(dirname "$STAGE")"' EXIT
mkdir -p "$STAGE"

cp -R "$APP" "$STAGE/"
ln -s /Applications "$STAGE/Applications"      # drag-to-install target

rm -f "$OUT"
hdiutil create -volname "$VOL" -srcfolder "$STAGE" -ov -format UDZO "$OUT" >/dev/null

# Optional: give the .dmg file the app's Finder icon.
if [ -n "$ICON" ] && [ -f "$ICON" ]; then
  "$HERE/set-dmg-icon.sh" "$OUT" "$ICON"
fi

echo "Created $OUT"
