# IFSO contracts (Robinhood Chain 4663)

Solidity 0.8.28, dependency-free (all helpers vendored in `src/libraries`, `src/utils`; the test base in
`test/utils/TestBase.sol` declares the Foundry cheatcode interface directly, so no `forge install`).

| Contract | Role |
|---|---|
| `IfsoEscrow` | USDG escrow: create (allowance / EIP-2612 permit / EIP-3009 gasless / batch), claim links, two-sided accept, settle, decisions, cancel, refund (anyone, after expiry, never paused), refund redirects |
| `IfsoConditionEvaluator` | Typed conditions: TIME, PRICE (Chainlink AggregatorV3 with round proofs + Pyth adapter), OUTCOME; curated feed / price-id / resolver registry that only affects NEW escrows |
| `IfsoOutcomeResolver` | Bonded optimistic results (anyone proposes with a bond after `earliestResolve`, 2 h dispute window, fallback panel Safe, panel timeout => VOID), pull-paid bonds |
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

```bash
export DEPLOYER_PK=... OWNER_SAFE=... PANEL_SAFE=... RESOLVER_CREATOR=... FEE_WORK=... FEE_TREASURY=... FEE_PERKS=... FEE_BURN=...
forge script script/Deploy.s.sol --rpc-url rhc --broadcast --slow
```

Then from the brand Safe: `acceptOwnership()` on evaluator / resolver / router, and register the Stock Token
feeds with their token addresses (`setFeed(feed, true, token)`, token addresses from `api.robinhood.com/rhj/assets`).
