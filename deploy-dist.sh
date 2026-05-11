#!/usr/bin/env bash
# deploy-dist.sh — Personal script: build and deploy to transfer.ccwu.cc (dist)
# NOT committed to git. Keep this file local only.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$SCRIPT_DIR/.env.dist"

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

echo "🚀 Deploying dist → transfer.ccwu.cc"
wrangler deploy -c "$SCRIPT_DIR/dist/wrangler.toml"

echo "✅ Done."
