#!/usr/bin/env bash
# Full deploy DRY RUN on a LOCAL anvil fork of Robinhood Chain mainnet (chain id stays 4663 on the fork), with the
# real USDG, Pyth and Chainlink feeds registered. Nothing leaves this machine: the script talks only to 127.0.0.1.
#
#   anvil --fork-url https://rpc.mainnet.chain.robinhood.com -p 8645 --silent &
#   bash script/fork-dryrun.sh 8645
#
# How the armed-flag guard is passed: IFSO_FORK_DRYRUN=1. DeployBase accepts it on chain 4663 ONLY when the node
# answers web3_clientVersion "anvil/..." and the anvil-only anvil_nodeInfo method, so the flag does nothing against
# a real RPC. This wrapper additionally refuses any RPC that is not 127.0.0.1.
#
# The deployer is a throwaway keystore made here (never an anvil default key: those are swept on 4663). The owner
# and panel are fresh 2-of-3 Safe 1.4.1 proxies created on the fork, so the post-deploy multisig checks run for
# real. Output: deployments/4663-fork.json (gitignored) with tx hashes, gas used and the fork block.
set -euo pipefail
port="${1:?usage: fork-dryrun.sh <anvil port>}"
rpc="http://127.0.0.1:${port}"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$here"

chain="$(cast chain-id --rpc-url "$rpc")"
client="$(cast rpc web3_clientVersion --rpc-url "$rpc" | tr -d '"')"
if [ "$chain" != "4663" ] || [ "${client#anvil/}" = "$client" ]; then
  echo "fork-dryrun: refusing, $rpc is chain $chain on '$client' (need a local anvil fork of 4663)" >&2
  exit 1
fi
fork_block="$(cast block-number --rpc-url "$rpc")"

tmp="$(mktemp -d "${TMPDIR:-/tmp}/ifso-fork-dryrun.XXXXXX")"
trap 'rm -rf "$tmp"' EXIT
first() { jq -r '(.data // .) | if type == "array" then .[0] else . end | '"$1"; }
new_addr() { cast wallet new --json | first .address; }

wallet="$(cast wallet new --json)"
deployer="$(first .address <<<"$wallet")"
cast wallet import ifso-fork --keystore-dir "$tmp" --unsafe-password "fork" \
  --private-key "$(first .private_key <<<"$wallet")" >/dev/null
unset wallet
cast rpc anvil_setBalance "$deployer" 0x56BC75E2D63100000 --rpc-url "$rpc" >/dev/null # 100 ETH, fork only

# Two fresh 2-of-3 Safes (SafeL2 1.4.1 singleton + factory, verified on 4663 in chain-facts.md)
SAFE_L2=0x29fcB43b46531BcA003ddC8FCB67FFE91900C762
SAFE_FACTORY=0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67
make_safe() {
  local init salt addr
  init="$(cast calldata 'setup(address[],uint256,address,bytes,address,address,uint256,address)' \
    "[$(new_addr),$(new_addr),$(new_addr)]" 2 0x0000000000000000000000000000000000000000 0x \
    0x0000000000000000000000000000000000000000 0x0000000000000000000000000000000000000000 0 \
    0x0000000000000000000000000000000000000000)"
  salt="$1"
  addr="$(cast call "$SAFE_FACTORY" 'createProxyWithNonce(address,bytes,uint256)(address)' "$SAFE_L2" "$init" "$salt" \
    --from "$deployer" --rpc-url "$rpc")"
  cast send "$SAFE_FACTORY" 'createProxyWithNonce(address,bytes,uint256)' "$SAFE_L2" "$init" "$salt" \
    --keystore "$tmp/ifso-fork" --password fork --rpc-url "$rpc" >/dev/null
  echo "$addr"
}
OWNER_MULTISIG="$(make_safe "$RANDOM$RANDOM")"
PANEL_MULTISIG="$(make_safe "$RANDOM$RANDOM")"
export OWNER_MULTISIG PANEL_MULTISIG
# A caller (app/scripts/fork-up.sh) may preset these so it holds the resolver service key; otherwise fresh throwaways.
export RESOLVER_CREATOR="${RESOLVER_CREATOR:-$(new_addr)}" FEE_WORK="${FEE_WORK:-$(new_addr)}" \
  FEE_TREASURY="${FEE_TREASURY:-$(new_addr)}" FEE_PERKS="${FEE_PERKS:-$(new_addr)}" FEE_BURN="${FEE_BURN:-$(new_addr)}"
export GIT_COMMIT="$(git rev-parse HEAD 2>/dev/null || echo unknown)"
export IFSO_FORK_DRYRUN=1 IFSO_ARMED=0

forge script script/Deploy.s.sol --rpc-url "$rpc" --keystore "$tmp/ifso-fork" --password "fork" \
  --sender "$deployer" --broadcast --slow -q

run="broadcast/Deploy.s.sol/4663/run-latest.json"
out="deployments/4663-fork.json"
jq --slurpfile run "$run" --arg fb "$fork_block" '
  def num: if type == "string" then (ltrimstr("0x") | ascii_downcase | explode
    | map(if . >= 97 then . - 87 else . - 48 end) | reduce .[] as $d (0; . * 16 + $d)) else . end;
  .txs = [$run[0].receipts[] as $r | $run[0].transactions[] | select(.hash == $r.transactionHash)
          | {hash, contractName, contractAddress, function, gasUsed: ($r.gasUsed | num)}]
  | .gasUsedTotal = ([.txs[].gasUsed] | add)
  | .forkBlock = ($fb | tonumber)
  | .deployBlock = ([$run[0].receipts[].blockNumber | num] | min)
  | del(.deployBlockAtSimulation)' "$out" >"$tmp/out.json"
mv "$tmp/out.json" "$out"

forge script script/PostDeployCheck.s.sol --rpc-url "$rpc" -q
echo "fork-dryrun: ok, chain 4663 (anvil fork of block $fork_block), $(jq '.txs | length' "$out") txs," \
  "gas used $(jq '.gasUsedTotal' "$out"), post-deploy assertions passed"
