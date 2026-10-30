#!/usr/bin/env bash
# README must agree with the deployment files: a chain with deployments/<id>.json must list its escrow address in the
# root README, and a chain without one must say "not deployed".
set -euo pipefail
cd "$(dirname "$0")/.."
readme=../README.md
fail=0
for id in 4663 46630; do
  row="$(grep -E "^\| [^|]+ \| ${id} \|" "$readme" || true)"
  [ -n "$row" ] || { echo "readme-deploy-check: no row for chain $id"; fail=1; continue; }
  if [ -f "deployments/${id}.json" ]; then
    addr="$(jq -r '.contracts.IfsoEscrow.address' "deployments/${id}.json")"
    grep -qi "$addr" <<<"$row" || { echo "readme-deploy-check: chain $id is deployed but the README row lacks $addr"; fail=1; }
  else
    grep -q "not deployed" <<<"$row" || { echo "readme-deploy-check: chain $id has no deployment file but the README does not say 'not deployed'"; fail=1; }
  fi
done
[ "$fail" = 0 ] && echo "readme-deploy-check: README matches deployments/"
exit "$fail"
