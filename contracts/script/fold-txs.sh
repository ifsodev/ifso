#!/usr/bin/env bash
# Folds the broadcast receipts into the deployment record: `.txs` (hash, contract, function, gas used),
# `.contracts.<name>.creationTx`, `.gasUsedTotal` and `.deployBlock`. Then proves each creationTx on chain: its
# receipt has status 1 and creates exactly the recorded address. Read-only against the RPC (cast receipt).
#
#   bash script/fold-txs.sh <rpc> <deployments/<chainid>.json> <broadcast/Deploy.s.sol/<chainid>/run-latest.json>
set -euo pipefail
rpc="${1:?rpc}" out="${2:?deployment json}" run="${3:?broadcast run json}"
tmp="$(mktemp "${TMPDIR:-/tmp}/ifso-fold.XXXXXX")"
trap 'rm -f "$tmp"' EXIT

jq --slurpfile run "$run" '
  def num: if type == "string" then (ltrimstr("0x") | ascii_downcase | explode
    | map(if . >= 97 then . - 87 else . - 48 end) | reduce .[] as $d (0; . * 16 + $d)) else . end;
  ($run[0]) as $r
  | .txs = [$r.receipts[] as $rc | $r.transactions[] | select(.hash == $rc.transactionHash)
            | {hash, contractName, contractAddress, function, gasUsed: ($rc.gasUsed | num)}]
  | .txs as $txs
  | .contracts |= with_entries(.value.address as $a
      | .value.creationTx = ([$txs[] | select((.contractAddress // "" | ascii_downcase) == ($a | ascii_downcase))
                              | .hash][0] // null))
  | .gasUsedTotal = ([.txs[].gasUsed] | add)
  | .deployBlock = ([$r.receipts[].blockNumber | num] | min)
  | del(.deployBlockAtSimulation)' "$out" >"$tmp"

missing="$(jq -r '.contracts | to_entries[] | select(.value.creationTx == null) | .key' "$tmp")"
if [ -n "$missing" ]; then
  echo "fold-txs: no creation tx for: $missing" >&2
  exit 1
fi
while read -r name addr hash; do
  status="$(cast receipt "$hash" status --rpc-url "$rpc")"
  created="$(cast receipt "$hash" contractAddress --rpc-url "$rpc")"
  case "${status%% *}" in 1 | true) ;; *) status=failed ;; esac
  if [ "$status" = failed ] || [ "$(tr 'A-F' 'a-f' <<<"$created")" != "$(tr 'A-F' 'a-f' <<<"$addr")" ]; then
    echo "fold-txs: $name creation tx $hash does not create $addr (status $status, created $created)" >&2
    exit 1
  fi
done < <(jq -r '.contracts | to_entries[] | "\(.key) \(.value.address) \(.value.creationTx)"' "$tmp")
mv "$tmp" "$out"
trap - EXIT
echo "fold-txs: $(jq '.txs | length' "$out") txs folded, $(jq '.contracts | length' "$out") creation txs proved on chain"
