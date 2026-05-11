#!/usr/bin/env bash
# delete-dist.sh — Personal script: delete the tunnel-worker on the transfer.ccwu.cc account
# NOT committed to git. Keep this file local only.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$SCRIPT_DIR/.env.dist"
WORKER_NAME="tunnel-worker"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "❌ Missing $ENV_FILE — create it with CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID"
  exit 1
fi

# Load credentials into the current shell
set -a
# shellcheck source=/dev/null
source "$ENV_FILE"
set +a

echo "⚠️  This will permanently delete worker '${WORKER_NAME}' from the transfer.ccwu.cc account."
read -r -p "Are you sure? [y/N] " confirm
if [[ "${confirm,,}" != "y" ]]; then
  echo "Aborted."
  exit 0
fi

echo "🗑️  Deleting worker: ${WORKER_NAME}..."
wrangler delete --name "$WORKER_NAME"

echo "✅ Worker '${WORKER_NAME}' deleted. Run ./deploy-dist.sh to redeploy."
