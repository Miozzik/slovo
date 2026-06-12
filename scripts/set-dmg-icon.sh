#!/usr/bin/env bash
# Give a .dmg a custom Finder icon (the app icon) instead of the generic
# disk-image icon. macOS only — needs Xcode Command Line Tools (Rez/DeRez/SetFile),
# which are present on GitHub's macOS runners.
#
# Usage: scripts/set-dmg-icon.sh <path/to.dmg> <path/to/icon.png>
set -euo pipefail

DMG="${1:?usage: set-dmg-icon.sh <dmg> <icon.png>}"
ICON="${2:?usage: set-dmg-icon.sh <dmg> <icon.png>}"

[ -f "$DMG" ]  || { echo "DMG not found: $DMG"  >&2; exit 1; }
[ -f "$ICON" ] || { echo "icon not found: $ICON" >&2; exit 1; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

cp "$ICON" "$TMP/icon.png"
sips -i "$TMP/icon.png" >/dev/null            # embed an icon resource into the png
DeRez -only icns "$TMP/icon.png" > "$TMP/icon.rsrc"
Rez -append "$TMP/icon.rsrc" -o "$DMG"        # attach it to the dmg's resource fork
SetFile -a C "$DMG"                           # flag the file as having a custom icon

echo "Set custom icon on $DMG"
