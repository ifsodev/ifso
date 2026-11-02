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
# compile-only check with solc-js (no forge needed; `bun install --frozen-lockfile --ignore-scripts` fetches solc 0.8.28, bun.lock is committed)
node tools/solcjs-compile.mjs                     # all of src/, test/, script/
node tools/solcjs-compile.mjs --src-only --abi-ts-out ../app/src/abi   # regenerate service ABIs
```

## Deploy

The script reads **no private key**; the signer comes from the forge CLI (an encrypted keystore or a Ledger).
On Robinhood Chain (4663 / 46630) it refuses unless `IFSO_ARMED=1` **and** the gitignored file
`contracts/.armed-<chainid>` exist.

```bash
export OWNER_MULTISIG=... PANEL_MULTISIG=... RESOLVER_CREATOR=<RELAYER address> FEE_WORK=... FEE_TREASURY=... FEE_PERKS=... FEE_BURN=...
# RESOLVER_CREATOR is the relayer hot key (the api registers questions with it); never the resolver key, which bonds
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

The dry run folds every tx hash into the record (`script/fold-txs.sh`, which also proves each creation tx on chain),
then runs `PostDeployCheck` four ways: ownership pending (pass), handed-over mode while pending (must fail), a
tampered FeeRouter runtime (must fail), and handed-over mode after the owner multisig accepted (pass, inside an anvil
snapshot that is reverted).

`PostDeployCheck` on 4663 takes the launch values from constants (USDG, feed proxies, cap, fees, bond, windows,
multisig singletons (official SafeL2 contracts)), requires the operator to pin the deploy-time addresses (`EXPECT_OWNER_MULTISIG`,
`EXPECT_PANEL_MULTISIG`, `EXPECT_RESOLVER_CREATOR`, `EXPECT_FEE_WORK` / `_TREASURY` / `_PERKS` / `_BURN`), compares
each contract's runtime bytecode with the build (immutables masked), and with `REQUIRE_HANDED_OVER=1` asserts the
owner multisig accepted everywhere and the deployer holds no role. The real mainnet deploy is `script/deploy-mainnet.sh`,
run by the owner only (armed flag and file required).

## Checks run in CI

`forge fmt --check`, `tools/size-gate.sh` (24,576-byte runtime limit), `tools/natspec-check.py`, `forge doc`,
`forge test`, `tools/gas-snapshot.sh --check`, the local deploy above, the invariant profile (10,000 x 50), and Slither
gated by the exact-match allowlist `slither.allow` (`tools/slither-gate.py`).
