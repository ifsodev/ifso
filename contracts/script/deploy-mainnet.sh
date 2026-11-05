#!/usr/bin/env bash
# The REAL Robinhood Chain mainnet deploy, run by the owner by hand. It never runs in CI or from an agent.
#
#   IFSO_ARMED=1 DEPLOYER=0x.. DRYRUN_COMMIT=<sha the fork dry run ran on> bash script/deploy-mainnet.sh <rpc> --account <keystore name>
#   (or --ledger). Refuses unless the deployer is at nonce EXPECT_DEPLOYER_NONCE (default 0) and HEAD == DRYRUN_COMMIT.
#
# Order: (1) Deploy.s.sol with --broadcast (its armed-flag guard still needs IFSO_ARMED=1 AND contracts/.armed-4663),
# (2) fold-txs.sh writes every tx hash into deployments/4663.json and proves each creation tx on chain,
# (3) PostDeployCheck with the operator pins EXPECT_* (see PostDeployCheck.s.sol). After the owner Safe has called
# acceptOwnership() on all four contracts, run the check again with REQUIRE_HANDED_OVER=1.
# The owner runs this in a fresh Terminal where ~/.foundry/bin may not be on PATH yet (forge, cast, anvil).
export PATH="$HOME/.foundry/bin:$PATH"
set -euo pipefail
rpc="${1:?usage: deploy-mainnet.sh <rpc> --account <name> | --ledger}"
shift
here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$here"

chain="$(cast chain-id --rpc-url "$rpc")"
[ "$chain" = "4663" ] || { echo "deploy-mainnet: $rpc is chain $chain, not 4663" >&2; exit 1; }
[ "${IFSO_ARMED:-0}" = "1" ] && [ -f ".armed-4663" ] || { echo "deploy-mainnet: not armed" >&2; exit 1; }
for v in OWNER_MULTISIG PANEL_MULTISIG RESOLVER_CREATOR FEE_WORK FEE_TREASURY FEE_PERKS FEE_BURN; do
  [ -n "${!v:-}" ] || { echo "deploy-mainnet: $v is not set" >&2; exit 1; }
  export "EXPECT_$v=${!v}"
done
GIT_COMMIT="$(git rev-parse HEAD)"; export GIT_COMMIT
[ -z "$(git status --porcelain -- src script)" ] || { echo "deploy-mainnet: src/ or script/ has local changes" >&2; exit 1; }
# The addresses are fixed by the deployer's nonce, and the dry run proved one exact commit: refuse if either moved.
[ -n "${DEPLOYER:-}" ] || { echo "deploy-mainnet: DEPLOYER (the deploying address) is not set" >&2; exit 1; }
nonce="$(cast nonce "$DEPLOYER" --rpc-url "$rpc")"
[ "$nonce" = "${EXPECT_DEPLOYER_NONCE:-0}" ] || { echo "deploy-mainnet: $DEPLOYER is at nonce $nonce, expected ${EXPECT_DEPLOYER_NONCE:-0} (the dry-run addresses would not match)" >&2; exit 1; }
[ "${DRYRUN_COMMIT:-}" = "$GIT_COMMIT" ] || { echo "deploy-mainnet: DRYRUN_COMMIT (${DRYRUN_COMMIT:-unset}) is not HEAD $GIT_COMMIT: run fork-dryrun.sh on this commit first" >&2; exit 1; }

forge script script/Deploy.s.sol --rpc-url "$rpc" "$@" --broadcast --slow
bash script/fold-txs.sh "$rpc" deployments/4663.json broadcast/Deploy.s.sol/4663/run-latest.json
forge script script/PostDeployCheck.s.sol --rpc-url "$rpc" --no-storage-caching
echo "deploy-mainnet: deployed, tx hashes recorded in deployments/4663.json, post-deploy check passed."
echo "deploy-mainnet: next, the owner Safe accepts ownership; then REQUIRE_HANDED_OVER=1 forge script script/PostDeployCheck.s.sol --rpc-url <rpc>"
