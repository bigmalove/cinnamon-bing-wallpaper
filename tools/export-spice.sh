#!/usr/bin/env bash
#
# Copy this extension into a checkout of linuxmint/cinnamon-spices-extensions
# using the layout required by Cinnamon Spices:
#
#   <spices>/UUID/info.json, README.md, screenshot.png, LICENSE
#   <spices>/UUID/files/UUID/...      (the extension itself, no .mo files)
#
# Usage: tools/export-spice.sh /path/to/cinnamon-spices-extensions
set -euo pipefail

UUID="bing-wallpaper@bigmalove"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SPICES="${1:?usage: $0 /path/to/cinnamon-spices-extensions}"
[ -x "$SPICES/validate-spice" ] || { echo "error: $SPICES is not a cinnamon-spices-extensions checkout" >&2; exit 1; }

DEST="$SPICES/$UUID"
rm -rf "$DEST"
mkdir -p "$DEST/files"
cp -r "$HERE/$UUID" "$DEST/files/$UUID"
find "$DEST/files" -name '*.mo' -delete
cp "$HERE/spice/info.json" "$HERE/spice/README.md" "$HERE/spice/screenshot.png" "$HERE/LICENSE" "$DEST/"
chmod -R u+rwX,go+rX "$DEST"

echo "Exported to $DEST"
(cd "$SPICES" && ./validate-spice "$UUID")
