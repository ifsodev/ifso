#!/usr/bin/env bash
# Test-only deploy on a LOCAL anvil (chain 31337) with a throwaway key that is generated here, never printed and
# never an anvil default key. Writes deployments/31337.json (with tx hashes + deploy block from the broadcast
# record), then re-runs the post-deploy assertions against the chain.
#
#   anvil -p 8645 --silent &   bash script/local-deploy.sh 8645
set -euo pipefail
port="${1:?usage: local-deploy.sh <anvil port>}"
rpc="http://127.0.0.1:${port}"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$here"

chain="$(cast chain-id --rpc-url "$rpc")"
if [ "$chain" != "31337" ]; then
  echo "local-deploy: refusing, $rpc is chain $chain (only a local anvil, 31337, is allowed)" >&2
  exit 1
fi

tmp="$(mktemp -d "${TMPDIR:-/tmp}/ifso-local-deploy.XXXXXX")"
trap 'rm -rf "$tmp"' EXIT
new_addr() { cast wallet new --json | jq -r '(.data // .) | if type == "array" then .[0] else . end | .address'; }

# Throwaway deployer in a temporary keystore: the deploy runs through the same --keystore path as a real one.
wallet="$(cast wallet new --json)"
deployer="$(jq -r '(.data // .) | if type == "array" then .[0] else . end | .address' <<<"$wallet")"
cast wallet import ifso-local --keystore-dir "$tmp" --unsafe-password "local" \
  --private-key "$(jq -r '(.data // .) | if type == "array" then .[0] else . end | .private_key' <<<"$wallet")" >/dev/null
unset wallet
cast rpc anvil_setBalance "$deployer" 0x56BC75E2D63100000 --rpc-url "$rpc" >/dev/null # 100 ETH, local only

export OWNER_MULTISIG="$(new_addr)" PANEL_MULTISIG="$(new_addr)" RESOLVER_CREATOR="$(new_addr)"
export FEE_WORK="$(new_addr)" FEE_TREASURY="$(new_addr)" FEE_PERKS="$(new_addr)" FEE_BURN="$(new_addr)"
export GIT_COMMIT="$(git rev-parse HEAD 2>/dev/null || echo unknown)"

forge script script/Deploy.s.sol --rpc-url "$rpc" --keystore "$tmp/ifso-local" --password "local" \
  --sender "$deployer" --broadcast --slow -q

# Fold the real tx hashes and deploy block from the broadcast record into the deployment file.
run="broadcast/Deploy.s.sol/31337/run-latest.json"
out="deployments/31337.json"
jq --slurpfile run "$run" '
  def num: if type == "string" then (ltrimstr("0x") | ascii_downcase | explode
    | map(if . >= 97 then . - 87 else . - 48 end) | reduce .[] as $d (0; . * 16 + $d)) else . end;
  .txs = [$run[0].transactions[] | {hash, contractName, contractAddress, function}]
  | .deployBlock = ([$run[0].receipts[].blockNumber | num] | min)
  | del(.deployBlockAtSimulation)' "$out" >"$tmp/out.json"
mv "$tmp/out.json" "$out"

forge script script/PostDeployCheck.s.sol --rpc-url "$rpc" -q
echo "local-deploy: ok, chain 31337, deployer $deployer, $(jq '.txs | length' "$out") txs, assertions passed"
