# IFSO contracts (Robinhood Chain 4663)

Solidity 0.8.28, dependency-free (all helpers vendored in `src/libraries`, `src/utils`; the test base in
`test/utils/TestBase.sol` declares the Foundry cheatcode interface directly, so no `forge install`).

| Contract | Role |
|---|---|
| `IfsoEscrow` | USDG escrow: create (allowance / EIP-2612 permit / EIP-3009 gasless / batch), claim links, two-sided accept, settle, decisions, cancel, refund (anyone, after expiry, never paused), refund redirects |
| `IfsoConditionEvaluator` | Typed conditions: TIME, PRICE (Chainlink AggregatorV3 with round proofs + Pyth adapter), OUTCOME; curated feed / price-id / resolver registry that only affects NEW escrows |
| `IfsoOutcomeResolver` | Bonded optimistic results (anyone proposes with a bond after `earliestResolve`, 2 h dispute window, fallback panel multisig, panel timeout => VOID), pull-paid bonds |
| `FeeRouter` | Flat-fee revenue split 80/10/5/5 (work / treasury / perks / burn) |
| `mocks/*` | USDG (permit + EIP-3009 + blocklist), Chainlink proxy with phases, Pyth, ERC-8056 token, sequencer feed, EIP-1271 wallet |

## Build and test

```bash
forge build --sizes && forge test -vvv            # primary
# no forge? (Hardhat 3 runs the same .t.sol files)
npm i && SOLC_JS=$PWD/node_modules/solc/soljson.js npx hardhat test solidity
# compile-only check with solc-js
node tools/solcjs-compile.mjs                     # all of src/, test/, script/
node tools/solcjs-compile.mjs --src-only --abi-ts-out ../app/src/abi   # regenerate service ABIs
```

## Deploy

The script reads **no private key**; the signer comes from the forge CLI (an encrypted keystore or a Ledger).
On Robinhood Chain (4663 / 46630) it refuses unless `IFSO_ARMED=1` **and** the gitignored file
`contracts/.armed-<chainid>` exist.

```bash
export OWNER_MULTISIG=... PANEL_MULTISIG=... RESOLVER_CREATOR=... FEE_WORK=... FEE_TREASURY=... FEE_PERKS=... FEE_BURN=...
export GIT_COMMIT=$(git rev-parse HEAD)          # MAX_AMOUNT defaults to 1_000e6 (the launch cap)
forge script script/Deploy.s.sol --rpc-url rhc --account <keystore name> --broadcast --slow
forge script script/PostDeployCheck.s.sol --rpc-url rhc   # re-run the assertions from deployments/4663.json
bash script/verify-sourcify.sh 4663                       # Sourcify v2, prints match / creationMatch
```

The script deploys the four contracts, registers the feeds and the resolver, sets the launch cap, starts the
two-step ownership transfer of every contract to the owner multisig, asserts the result (USDG decimals == 6,
pending owners, fees, cap, feeds, resolver panel and bond, fee recipients) and writes
`deployments/<chainid>.json`. Then from the owner multisig: `acceptOwnership()` on all four contracts. On 4663 the
deploy registers the ETH/USD feed and the SPY, NVDA, TSLA and AAPL feeds with their Stock Tokens; feeds are always
Chainlink proxy addresses, never the aggregator behind a proxy.

Local rehearsal (anvil, throwaway keystore, never an anvil default key):

```bash
anvil -p 8645 --silent & bash script/local-deploy.sh 8645
```

Fork proofs against real Robinhood Chain state (USDG EIP-3009 and permit, Chainlink rounds, Stock Token multipliers,
Pyth Core). They skip when `RHC_FORK_RPC` is unset; `RHC_FORK_BLOCK` pins a block (the public RPC keeps only minutes
of state, so the proofs are written to hold at any later block):

```bash
RHC_FORK_RPC=https://rpc.mainnet.chain.robinhood.com forge test --match-path 'test/fork/*' -vv
```

Full deploy dry run on a local anvil fork of 4663 (the chain id stays 4663; `IFSO_FORK_DRYRUN=1` passes the armed
guard only when the node proves it is anvil; the record goes to the gitignored `deployments/4663-fork.json`):

```bash
anvil --fork-url https://rpc.mainnet.chain.robinhood.com -p 8645 --silent & bash script/fork-dryrun.sh 8645
```

## Checks run in CI

`forge fmt --check`, `tools/size-gate.sh` (24,576-byte runtime limit), `tools/natspec-check.py`, `forge doc`,
`forge test`, `forge snapshot --check`, the local deploy above, the invariant profile (10,000 x 50), and Slither
gated by the exact-match allowlist `slither.allow` (`tools/slither-gate.py`).
