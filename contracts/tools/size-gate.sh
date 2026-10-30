#!/usr/bin/env bash
# Size gate for the deployable contracts: runtime <= 24,576 bytes (EIP-170) and initcode <= 49,152 (EIP-3860).
# Robinhood Chain itself allows more, but staying under the mainnet-Ethereum limits keeps every tool and fork working.
set -euo pipefail
cd "$(dirname "$0")/.."
limit=24576; init_limit=49152
json="$(forge build --sizes --json 2>/dev/null)"
fail=0
for c in IfsoEscrow IfsoConditionEvaluator IfsoOutcomeResolver FeeRouter; do
  rt="$(jq -r --arg c "$c" '.[$c].runtime_size' <<<"$json")"
  ini="$(jq -r --arg c "$c" '.[$c].init_size' <<<"$json")"
  [ "$rt" = "null" ] && { echo "size-gate: $c missing from build output"; fail=1; continue; }
  pct=$(( rt * 100 / limit ))
  printf 'size-gate: %-24s runtime %6s B (%3s%% of %s)  initcode %6s B\n' "$c" "$rt" "$pct" "$limit" "$ini"
  if [ "$rt" -gt "$limit" ] || [ "$ini" -gt "$init_limit" ]; then echo "size-gate: $c is over the limit"; fail=1; fi
done
exit "$fail"
