#!/bin/bash
# Bump the patch version, rebuild the extension, and sync it into the folder
# Chrome actually loaded from (preserving the extension ID and its IndexedDB
# history). Run this after code changes instead of a manual reload.
set -e

ROOT="$(cd "$(dirname "$0")" && pwd)"
MANIFEST="$ROOT/static/manifest.chrome.json"
LOADED_DIR="$HOME/Library/Application Support/Google/Chrome/Profile 1/UnpackedExtensions/sitegeist-latest_uTeviD"

# Bump patch version (x.y.z -> x.y.(z+1)) in the source manifest.
CURRENT=$(node -e "console.log(require('$MANIFEST').version)")
NEXT=$(node -e "const [a,b,c]=require('$MANIFEST').version.split('.'); console.log(\`\${a}.\${b}.\${+c+1}\`)")
node -e "const fs=require('fs'); const m=JSON.parse(fs.readFileSync('$MANIFEST','utf8')); m.version='$NEXT'; fs.writeFileSync('$MANIFEST', JSON.stringify(m,null,'\t')+'\n')"
echo "Version: $CURRENT -> $NEXT"

# Rebuild JS + CSS.
node "$ROOT/scripts/build.mjs"
npx tailwindcss -i "$ROOT/src/app.css" -o "$ROOT/dist-chrome/app.css" --minify >/dev/null 2>&1

# Sync into the loaded folder, preserving _metadata (integrity/rulesets) and
# dropping sourcemaps. --delete keeps it an exact mirror of dist-chrome.
if [ -d "$LOADED_DIR" ]; then
	rsync -a --delete --exclude='_metadata/' --exclude='*.map' "$ROOT/dist-chrome/" "$LOADED_DIR/"
	echo "Synced into loaded extension folder."
else
	echo "WARNING: loaded folder not found; only dist-chrome was built."
	echo "  Expected: $LOADED_DIR"
fi

echo "Done. Reload Sitegeist in chrome://extensions/ (version should read $NEXT), then close and reopen the side panel."
