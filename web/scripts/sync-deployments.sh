#!/usr/bin/env bash
# Copies the deployment records (contracts/deployments/<chainId>.json, the one source of truth) into
# src/config/deployments, so `web/` builds on its own (Vercel uses web/ as the root). A chain with no record gets an
# empty placeholder. test/deployments-sync.test.ts fails when a copy differs. After a (re)deploy: replace the record,
# run this, update the README Deployment row.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
src="$here/../contracts/deployments"
dst="$here/src/config/deployments"
[ -d "$src" ] || { echo "sync-deployments: contracts/deployments not found next to web/" >&2; exit 1; }
for id in 4663 46630 31337; do
  if [ -f "$src/$id.json" ]; then cp "$src/$id.json" "$dst/$id.json"; else printf '{\n  "chainId": %s,\n  "contracts": {}\n}\n' "$id" > "$dst/$id.json"; fi
done
echo "sync-deployments: copied the records for $(ls "$src" | grep -c '\.json$' || true) chain(s)"
