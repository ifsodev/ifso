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
# After the deploy it runs PostDeployCheck four ways: ownership pending (pass), handed-over mode while pending (must
# fail), a tampered FeeRouter runtime (must fail), and handed-over mode after the owner Safe accepted (pass).
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
# The Safes come from a second throwaway wallet, as on mainnet (the owner makes them from his own wallet), so the
# deployer is still at nonce 0 when Deploy.s.sol starts and the dry-run addresses match a real first deploy.
maker_wallet="$(cast wallet new --json)"
maker="$(first .address <<<"$maker_wallet")"
cast wallet import ifso-fork-maker --keystore-dir "$tmp" --unsafe-password "fork" \
  --private-key "$(first .private_key <<<"$maker_wallet")" >/dev/null
unset maker_wallet
cast rpc anvil_setBalance "$maker" 0x8AC7230489E80000 --rpc-url "$rpc" >/dev/null # 10 ETH, fork only

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
    --from "$maker" --rpc-url "$rpc")"
  cast send "$SAFE_FACTORY" 'createProxyWithNonce(address,bytes,uint256)' "$SAFE_L2" "$init" "$salt" \
    --keystore "$tmp/ifso-fork-maker" --password fork --rpc-url "$rpc" >/dev/null
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

nonce="$(cast nonce "$deployer" --rpc-url "$rpc")"
[ "$nonce" = "0" ] || { echo "fork-dryrun: deployer nonce is $nonce, expected 0 (a real first deploy)" >&2; exit 1; }
forge script script/Deploy.s.sol --rpc-url "$rpc" --keystore "$tmp/ifso-fork" --password "fork" \
  --sender "$deployer" --broadcast --slow -q

run="broadcast/Deploy.s.sol/4663/run-latest.json"
out="deployments/4663-fork.json"
bash script/fold-txs.sh "$rpc" "$out" "$run"
jq --arg fb "$fork_block" '.forkBlock = ($fb | tonumber)' "$out" >"$tmp/out.json"
mv "$tmp/out.json" "$out"

# Operator pins for the deploy-time addresses (PostDeployCheck refuses on 4663 without them).
export EXPECT_OWNER_MULTISIG="$OWNER_MULTISIG" EXPECT_PANEL_MULTISIG="$PANEL_MULTISIG" \
  EXPECT_RESOLVER_CREATOR="$RESOLVER_CREATOR" EXPECT_FEE_WORK="$FEE_WORK" EXPECT_FEE_TREASURY="$FEE_TREASURY" \
  EXPECT_FEE_PERKS="$FEE_PERKS" EXPECT_FEE_BURN="$FEE_BURN"
# --no-storage-caching: a fork keeps its block number across anvil_setCode, so a cached read would hide the change.
check() { REQUIRE_HANDED_OVER="$1" forge script script/PostDeployCheck.s.sol --rpc-url "$rpc" --no-storage-caching 2>&1; }
# must_fail <why> <expected message> <REQUIRE_HANDED_OVER>
must_fail() {
  local log
  if log="$(check "$3")"; then echo "fork-dryrun: $1 was not detected" >&2; exit 1; fi
  grep -q "$2" <<<"$log" || { echo "fork-dryrun: $1 failed for another reason:" >&2; tail -5 <<<"$log" >&2; exit 1; }
  echo "fork-dryrun: $1 detected ($2)"
}

check 0 >"$tmp/check.log" || { tail -20 "$tmp/check.log" >&2; exit 1; }
echo "fork-dryrun: post-deploy check passed (ownership pending)"
must_fail "pending handover in handed-over mode" "handed over: owner is not the multisig" 1

# Bytecode comparison: one flipped byte in the FeeRouter runtime must fail, then the real code is put back.
router="$(jq -r '.contracts.FeeRouter.address' "$out")"
code="$(cast code "$router" --rpc-url "$rpc")"
last="${code: -2}"
cast rpc anvil_setCode "$router" "${code:0:${#code}-2}$(printf '%02x' $((0x$last ^ 1)))" --rpc-url "$rpc" >/dev/null
must_fail "tampered FeeRouter runtime" "FeeRouter: runtime code differs from the build" 0
cast rpc anvil_setCode "$router" "$code" --rpc-url "$rpc" >/dev/null

# Hand over: the owner Safe accepts ownership of all four contracts (impersonated on the fork only), inside an anvil
# snapshot that is reverted afterwards, so callers (app/scripts/fork-up.sh) still find the 2-step handover pending.
snap="$(cast rpc evm_snapshot --rpc-url "$rpc" | tr -d '"')"
cast rpc anvil_setBalance "$OWNER_MULTISIG" 0x8AC7230489E80000 --rpc-url "$rpc" >/dev/null
cast rpc anvil_impersonateAccount "$OWNER_MULTISIG" --rpc-url "$rpc" >/dev/null
for name in IfsoConditionEvaluator IfsoOutcomeResolver FeeRouter IfsoEscrow; do
  cast send "$(jq -r ".contracts.$name.address" "$out")" 'acceptOwnership()' --from "$OWNER_MULTISIG" --unlocked \
    --rpc-url "$rpc" >/dev/null
done
cast rpc anvil_stopImpersonatingAccount "$OWNER_MULTISIG" --rpc-url "$rpc" >/dev/null
check 1 >"$tmp/check.log" || { tail -20 "$tmp/check.log" >&2; exit 1; }
echo "fork-dryrun: post-deploy check passed in handed-over mode (multisig owns all 4, deployer holds no role)"
[ "$(cast rpc evm_revert "$snap" --rpc-url "$rpc")" = "true" ] || { echo "fork-dryrun: snapshot revert failed" >&2; exit 1; }

echo "fork-dryrun: ok, chain 4663 (anvil fork of block $fork_block), $(jq '.txs | length' "$out") txs," \
  "gas used $(jq '.gasUsedTotal' "$out"), post-deploy assertions passed"
