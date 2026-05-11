#!/usr/bin/env bash
# deploy-dist2.sh — Personal script: build, sync, and deploy to mydev.ccwu.cc (dist2)
# NOT committed to git. Keep this file local only.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$SCRIPT_DIR/.env.dist2"
DIST_SRC="$SCRIPT_DIR/dist"
DIST2="$SCRIPT_DIR/dist2"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "❌ Missing $ENV_FILE — create it with CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID"
  exit 1
fi

# Load credentials into the current shell
set -a
# shellcheck source=/dev/null
source "$ENV_FILE"
set +a

echo "🔨 Building..."
npm --prefix "$SCRIPT_DIR" run build

echo "📋 Syncing worker code from dist → dist2..."
mkdir -p "$DIST2"
cp "$DIST_SRC/_worker.js" "$DIST2/_worker.js"
echo "✅ Copied _worker.js to dist2/"

TOML_SRC="$SCRIPT_DIR/wrangler.dist2.toml"
if [[ ! -f "$TOML_SRC" ]]; then
  echo "❌ Missing $TOML_SRC"
  exit 1
fi
cp "$TOML_SRC" "$DIST2/wrangler.toml"
echo "✅ Copied wrangler.dist2.toml → dist2/wrangler.toml"

echo "🚀 Deploying dist2 → mydev.ccwu.cc"
wrangler deploy -c "$DIST2/wrangler.toml"

echo "✅ Done."
