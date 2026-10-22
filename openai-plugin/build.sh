#!/bin/sh
# Builds the ZIP uploaded on platform.openai.com → Plugins → VIVID → "Upload plugin to make changes".
# Skills come from ../skills (single source); bump "version" in plugin.json for every upload.
set -e
cd "$(dirname "$0")"
OUT="${1:-vivid-openai-plugin.zip}"
STAGE="$(mktemp -d)/vivid"
mkdir -p "$STAGE/skills"
cp plugin.json mcp.json "$STAGE/"
cp -R assets "$STAGE/assets"
for s in vivid-product-photos vivid-product-video vivid-brand-cast; do cp -R "../skills/$s" "$STAGE/skills/$s"; done
rm -f "$OUT"
(cd "$STAGE" && zip -qrX - .) > "$OUT"
echo "$(pwd)/$OUT"
unzip -l "$OUT"
