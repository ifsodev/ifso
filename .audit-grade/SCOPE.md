# Audit scope

Audited commit: `b9af4a44a02446f24a8fe180a52b26d93b97f876` (`b9af4a4`, the commit the first audit-grade report grades; see [REPORT.md](REPORT.md)). The audit tag is
cut by the owner at release; no tag exists yet. This list is the scope in the meantime: a file is in scope when it appears
below at that commit. Blob ids are git object ids (`git ls-tree -r b9af4a4 -- <path>`), so any later change to a listed file is
visible as a different id.

Regenerate the lists: `git ls-tree -r b9af4a4 -- contracts/src app/src app/scripts contracts/script app/drizzle`.

Out of scope: `web/` (frontend), tests and fixtures (read for evidence, not graded as
product code), `contracts/test`, `app/test`.

## Deployable contracts

Solidity that is deployed (including the helpers and interfaces it compiles in).

| Blob | File |
|---|---|
| `5edcb6d76be6` | `contracts/src/FeeRouter.sol` |
| `18dc8cd58691` | `contracts/src/IfsoConditionEvaluator.sol` |
| `6be1209ec11f` | `contracts/src/IfsoEscrow.sol` |
| `46145b269ff1` | `contracts/src/IfsoOutcomeResolver.sol` |
| `5edb985beb79` | `contracts/src/interfaces/AggregatorV3Interface.sol` |
| `2fd19773988e` | `contracts/src/interfaces/IERC1271.sol` |
| `58af79c37403` | `contracts/src/interfaces/IERC20.sol` |
| `62844332a6cf` | `contracts/src/interfaces/IERC8056.sol` |
| `40f7fbb752ee` | `contracts/src/interfaces/IIfsoCcipOutcomeReceiver.sol` |
| `fedeac1f485b` | `contracts/src/interfaces/IIfsoConditionEvaluator.sol` |
| `eeb337b731a1` | `contracts/src/interfaces/IIfsoEscrow.sol` |
| `fd075327ce80` | `contracts/src/interfaces/IIfsoOutcomeResolver.sol` |
| `626eec069092` | `contracts/src/interfaces/IPyth.sol` |
| `a979a9e4677f` | `contracts/src/interfaces/IUSDG.sol` |
| `93dec22a4c4d` | `contracts/src/libraries/ECDSA.sol` |
| `7c3ea66aa7e7` | `contracts/src/libraries/IfsoTypes.sol` |
| `e65ac2319489` | `contracts/src/libraries/SafeTransferLib.sol` |
| `3de7ba50ec01` | `contracts/src/libraries/SignatureChecker.sol` |
| `f4bac92f1b43` | `contracts/src/utils/EIP712.sol` |
| `98df9687d1fd` | `contracts/src/utils/Owned2Step.sol` |
| `82ba144d7e33` | `contracts/src/utils/ReentrancyGuard.sol` |

## Deploy and verification scripts

Foundry scripts and shell wrappers that deploy, check and verify the contracts.

| Blob | File |
|---|---|
| `6cda53dd34ba` | `contracts/script/Deploy.s.sol` |
| `8e87160e96fb` | `contracts/script/DeployBase.sol` |
| `5bc97f406755` | `contracts/script/PostDeployCheck.s.sol` |
| `1fee6aafae24` | `contracts/script/fork-dryrun.sh` |
| `d1c26f7a71bd` | `contracts/script/local-deploy.sh` |
| `9c0fb8f89f91` | `contracts/script/verify-sourcify.sh` |

## Off-chain service (`app/src`)

API, relayer, bot, keepers, resolver, indexer, notifier, price watcher, signers.

| Blob | File |
|---|---|
| `290e88efd158` | `app/src/abi/FeeRouter.ts` |
| `198503263827` | `app/src/abi/IfsoConditionEvaluator.ts` |
| `66d581c321c9` | `app/src/abi/IfsoEscrow.ts` |
| `ce18278b599a` | `app/src/abi/IfsoOutcomeResolver.ts` |
| `976c788279f9` | `app/src/abi/external.ts` |
| `d2ac27518a10` | `app/src/abi/index.ts` |
| `cc051d2e5cbc` | `app/src/api/app.ts` |
| `bde47a0a5792` | `app/src/api/batchPlan.ts` |
| `19561e27a019` | `app/src/api/claim.ts` |
| `dc445ae572b5` | `app/src/api/clientIp.ts` |
| `d30888187fd6` | `app/src/api/fixtures.ts` |
| `76c0cfb800fa` | `app/src/api/linkToken.ts` |
| `750b7a684028` | `app/src/api/linkWallet.ts` |
| `9e502a1e747b` | `app/src/api/perks.ts` |
| `8b49cf861cfc` | `app/src/api/rateLimit.ts` |
| `b20783d13ce3` | `app/src/api/router.ts` |
| `5b2d1643f545` | `app/src/api/signers.ts` |
| `8da1e1fb8682` | `app/src/api/stats.ts` |
| `e4542fa39c06` | `app/src/api/verify.ts` |
| `a4aea4c566c8` | `app/src/bot/bot.ts` |
| `5d4efd89232c` | `app/src/bot/flow.ts` |
| `480afd30e11b` | `app/src/bot/store.ts` |
| `ea09ab103b2c` | `app/src/bot/webhook.ts` |
| `21a87f069e45` | `app/src/chain/index.ts` |
| `c4ca3614118f` | `app/src/chain/keys.ts` |
| `af3dbb490a90` | `app/src/chain/rpc.ts` |
| `61d18694423f` | `app/src/client/claimPage.ts` |
| `9ac29eef1080` | `app/src/client/copyRules.ts` |
| `7589ffea944e` | `app/src/client/index.ts` |
| `55e434e3798c` | `app/src/client/package.json` |
| `872f03ea8b7f` | `app/src/client/verifyBuild.ts` |
| `8a553cca863d` | `app/src/config/chain.ts` |
| `6febc205f55c` | `app/src/config/env.ts` |
| `2abf7acd8b45` | `app/src/core/builder.ts` |
| `49a4cb0d0149` | `app/src/core/condition.ts` |
| `59d888d19f67` | `app/src/core/copy.ts` |
| `75759defe1ff` | `app/src/core/disputePolicy.ts` |
| `29971cc7f1c1` | `app/src/core/geo.ts` |
| `1360136a2369` | `app/src/core/link.ts` |
| `8fee19481818` | `app/src/core/linkWallet.ts` |
| `b4d1727af5e2` | `app/src/core/money.ts` |
| `e1a811529abb` | `app/src/core/outcome.ts` |
| `3364a57fed8f` | `app/src/core/paramsJson.ts` |
| `912ef49df9cf` | `app/src/core/parser.ts` |
| `bad02a08389d` | `app/src/core/perks.ts` |
| `b5a1fba09f0d` | `app/src/core/price.ts` |
| `0f544416ccef` | `app/src/core/stats.ts` |
| `61d48f809c0c` | `app/src/core/typedData.ts` |
| `84f92edb9ff9` | `app/src/core/types.ts` |
| `15d1f8b213ed` | `app/src/core/tz.ts` |
| `1e34051ad548` | `app/src/db/client.ts` |
| `93d37977420e` | `app/src/db/migrate.ts` |
| `ac89877da0dc` | `app/src/db/schema.ts` |
| `c8356b472911` | `app/src/main.ts` |
| `427a735a2acb` | `app/src/ops/alerts.ts` |
| `de0a4b3a68e4` | `app/src/ops/health.ts` |
| `261075656c1f` | `app/src/ops/monitors.ts` |
| `a57ac3699c67` | `app/src/sources/http.ts` |
| `ed73501df00c` | `app/src/sources/hyperliquid.ts` |
| `0e927e12fd04` | `app/src/sources/index.ts` |
| `0073e8665ff2` | `app/src/sources/polymarket.ts` |
| `e3fa5d09a582` | `app/src/sources/theOddsApi.ts` |
| `2409d3f751a5` | `app/src/sources/theSportsDb.ts` |
| `a2dc3180f0ba` | `app/src/workers/deps.ts` |
| `51900499ec73` | `app/src/workers/indexer.ts` |
| `2a388f3e9d0b` | `app/src/workers/keeper.ts` |
| `16df3f956de1` | `app/src/workers/notifier.ts` |
| `f18b44143f96` | `app/src/workers/priceWatcher.ts` |
| `8f0a492b1f32` | `app/src/workers/pyth.ts` |
| `207fa3fd823d` | `app/src/workers/queues.ts` |
| `af307daa6073` | `app/src/workers/resolver.ts` |
| `260ae61044a9` | `app/src/workers/rounds.ts` |
| `e48644304f3b` | `app/src/workers/tx.ts` |

## Database schema and migrations



| Blob | File |
|---|---|
| `0a62fc270e57` | `app/drizzle.config.ts` |
| `a2f72898a344` | `app/drizzle/0000_init.sql` |
| `aeb53313f92a` | `app/drizzle/0001_bot_tz_intent_expiry.sql` |
| `7b8c53a9976f` | `app/drizzle/0002_cursor_block_hash.sql` |
| `34d8c420f0cf` | `app/drizzle/0003_question_disputed_at.sql` |
| `bc41f0736db3` | `app/drizzle/0004_void_owed.sql` |
| `26e045120a9a` | `app/drizzle/0005_chain_event_block_time.sql` |
| `4005fc831a09` | `app/drizzle/0006_link_requests.sql` |
| `a68306345850` | `app/drizzle/0007_question_dispute_kind.sql` |
| `784baa93dfab` | `app/drizzle/meta/0000_snapshot.json` |
| `7215b42023ce` | `app/drizzle/meta/0001_snapshot.json` |
| `9939467c43c4` | `app/drizzle/meta/0002_snapshot.json` |
| `167e9074382f` | `app/drizzle/meta/0003_snapshot.json` |
| `1d45c7babb7d` | `app/drizzle/meta/0004_snapshot.json` |
| `43eadf6252b0` | `app/drizzle/meta/0005_snapshot.json` |
| `c09276a8df3f` | `app/drizzle/meta/0006_snapshot.json` |
| `bb68380f30fa` | `app/drizzle/meta/0007_snapshot.json` |
| `c2cdc42f65d5` | `app/drizzle/meta/_journal.json` |

## Server and release automation (`app/scripts`)

Provisioning, deploy, and the root-run release runner wrappers.

| Blob | File |
|---|---|
| `8887bfa016dd` | `app/scripts/fork-down.sh` |
| `da2d9d9b0b9f` | `app/scripts/fork-up.sh` |
| `8cc31bf88168` | `app/scripts/fork/dev-wallet.js` |
| `2d98bac9bc93` | `app/scripts/fork/exercise.ts` |
| `26a6f44db2b6` | `app/scripts/fork/serve.ts` |
| `5fd3e318d6dc` | `app/scripts/fork/setup.ts` |
| `b984c8d848f3` | `app/scripts/ifso-cli.ts` |
| `e923c018ad1b` | `app/scripts/print-vectors.ts` |
| `11b64eef3ef6` | `app/scripts/record-resolver-fixtures.ts` |
| `7a60b85e148f` | `app/scripts/release/.gitignore` |
| `3f6e96e059c9` | `app/scripts/release/README.md` |
| `492be226df88` | `app/scripts/release/arm.sh` |
| `fb3f9e2be9ca` | `app/scripts/release/forbidden.txt.example` |
| `6ee3ce8f47a3` | `app/scripts/release/install.sh` |
| `2248ba3727da` | `app/scripts/release/lib/preflight.py` |
| `75bf979b62e8` | `app/scripts/release/lib/release.py` |
| `ab58633518e8` | `app/scripts/release/lib/test_release.py` |
| `ad6cfd55c71a` | `app/scripts/release/push-queue.sh` |
| `3efba15eba81` | `app/scripts/release/sandbox/docker-sandbox.sh` |
| `4e4c671ad134` | `app/scripts/release/sandbox/fake_world.py` |
| `943bb2bc32b6` | `app/scripts/release/sandbox/fakes/bun` |
| `ad4662e29600` | `app/scripts/release/sandbox/fakes/flock` |
| `8a517cf1767c` | `app/scripts/release/sandbox/fakes/ifso-deploy` |
| `fbb34edde80f` | `app/scripts/release/sandbox/fakes/systemctl` |
| `eefb58faac21` | `app/scripts/release/sandbox/run-sandbox.sh` |
| `ca32f447ac31` | `app/scripts/release/sbin/common.sh` |
| `995089992ac3` | `app/scripts/release/sbin/ifso-deploy-release` |
| `253e10e2a6b9` | `app/scripts/release/sbin/ifso-release-abort` |
| `c43d4b1851c9` | `app/scripts/release/sbin/ifso-release-ghrelease` |
| `3f411837fcae` | `app/scripts/release/sbin/ifso-release-notify` |
| `47923234bd24` | `app/scripts/release/sbin/ifso-release-pause` |
| `f80ac4418e0c` | `app/scripts/release/sbin/ifso-release-preflight` |
| `7cdebbf67928` | `app/scripts/release/sbin/ifso-release-resume` |
| `47da15e1dec7` | `app/scripts/release/sbin/ifso-release-retry` |
| `fc2c79999219` | `app/scripts/release/sbin/ifso-release-status` |
| `9177c4e18456` | `app/scripts/release/sudoers` |
| `34f0ac3b967d` | `app/scripts/release/systemd/ifso-release.service` |
| `0fb6d29b574b` | `app/scripts/release/systemd/ifso-release.timer` |
| `47bf94f95f41` | `app/scripts/release/test-local.sh` |
| `25f9552c50ae` | `app/scripts/server/Caddyfile` |
| `ea1823fe31f2` | `app/scripts/server/README.md` |
| `8bb8e1275c3e` | `app/scripts/server/backup.sh` |
| `9aa8c2077758` | `app/scripts/server/cohost/dropins/ifso-api.service.conf` |
| `cd8c8c780e5b` | `app/scripts/server/cohost/dropins/ifso-backup.service.conf` |
| `4a161d53fb5c` | `app/scripts/server/cohost/dropins/ifso-bot.service.conf` |
| `56c4604e1b15` | `app/scripts/server/cohost/dropins/ifso-migrate.service.conf` |
| `874e50dd61f1` | `app/scripts/server/cohost/dropins/ifso-worker.service.conf` |
| `c603bd58a439` | `app/scripts/server/cohost/dropins/ifso.target.conf` |
| `ca635b661443` | `app/scripts/server/cohost/ifso-redis.service` |
| `700eac1fd69e` | `app/scripts/server/cohost/ifso.caddy` |
| `0687fffdd065` | `app/scripts/server/deploy-local.test.sh` |
| `2be6ba427b22` | `app/scripts/server/deploy.sh` |
| `edef298c7922` | `app/scripts/server/env.example` |
| `db3df08b74b4` | `app/scripts/server/provision-cohost.sh` |
| `24ee969b27fb` | `app/scripts/server/provision.sh` |
| `7dfbfc634df7` | `app/scripts/server/systemd/ifso-api.service` |
| `acaf17f97eeb` | `app/scripts/server/systemd/ifso-backup.service` |
| `772b3e3144f6` | `app/scripts/server/systemd/ifso-backup.timer` |
| `cbb54fcdfd8a` | `app/scripts/server/systemd/ifso-bot.service` |
| `a7ea0530369c` | `app/scripts/server/systemd/ifso-migrate.service` |
| `f228995f63e0` | `app/scripts/server/systemd/ifso-worker.service` |
| `6590032b7cdf` | `app/scripts/server/systemd/ifso.target` |
| `b8c02f12e0f3` | `app/scripts/synthesize-odds-fixtures.ts` |
| `df41ba61a0de` | `app/scripts/user-count.ts` |
| `ed3f42886011` | `app/scripts/webhook-url.ts` |

## Test-only contracts (not deployed, not scored)

Mocks under `contracts/src/mocks`; never part of a deployment.

| Blob | File |
|---|---|
| `700b90d8a0a0` | `contracts/src/mocks/MockAggregator.sol` |
| `3eb27f172692` | `contracts/src/mocks/MockERC1271Wallet.sol` |
| `cef1410185c0` | `contracts/src/mocks/MockPyth.sol` |
| `0f4a0a8b7379` | `contracts/src/mocks/MockSequencerFeed.sol` |
| `fee9e7c176c3` | `contracts/src/mocks/MockStockToken.sol` |
| `b896e74aed3c` | `contracts/src/mocks/MockUSDG.sol` |

