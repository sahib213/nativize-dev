#!/usr/bin/env bash
# Copies the shared Nativize runtime modules into website/lib/ so the site is a
# self-contained static deploy (the web app at /app/ reuses the SAME code the
# extension runs). Re-run this whenever you change anything under ../src.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
SRC="$HERE/../src"
DEST="$HERE/lib"
mkdir -p "$DEST/vendor"

cp "$SRC/plans.js"          "$DEST/plans.js"
cp "$SRC/billing.js"        "$DEST/billing.js"
cp "$SRC/kit-generator.js"  "$DEST/kit-generator.js"
cp "$SRC/zip.js"            "$DEST/zip.js"
cp "$SRC/vendor/tweetnacl.js" "$DEST/vendor/tweetnacl.js"
cp "$SRC/vendor/blake2b.js" "$DEST/vendor/blake2b.js"
cp "$SRC/sealedbox.js"      "$DEST/sealedbox.js"
cp "$SRC/github.js"         "$DEST/github.js"
cp "$SRC/panel.js"          "$DEST/panel.js"

echo "Synced runtime modules into website/lib/"
