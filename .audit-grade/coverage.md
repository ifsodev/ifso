# Coverage

`forge coverage --report summary` over the deployable sources (`src/`, mocks excluded), default test profile. Re-run: `bash contracts/tools/coverage.sh`.
Fork tests are skipped without an RPC, so fork-only paths are not counted here.

| File | Lines | Statements | Branches | Functions |
|---|---|---|---|---|
| `src/FeeRouter.sol` | 100.00% (30/30) | 97.67% (42/43) | 75.00% (3/4) | 100.00% (5/5) |
| `src/IfsoConditionEvaluator.sol` | 94.58% (192/203) | 89.83% (318/354) | 71.19% (84/118) | 100.00% (18/18) |
| `src/IfsoEscrow.sol` | 98.42% (312/317) | 97.06% (462/476) | 88.81% (119/134) | 98.04% (50/51) |
| `src/IfsoOutcomeResolver.sol` | 98.41% (124/126) | 93.79% (151/161) | 76.47% (26/34) | 94.74% (18/19) |
| `src/libraries/ECDSA.sol` | 100.00% (19/19) | 79.17% (19/24) | 0.00% (0/5) | 100.00% (3/3) |
| `src/libraries/SafeTransferLib.sol` | 100.00% (11/11) | 94.44% (17/18) | 66.67% (2/3) | 100.00% (3/3) |
| `src/libraries/SignatureChecker.sol` | 100.00% (9/9) | 85.71% (18/21) | 25.00% (1/4) | 100.00% (1/1) |
| `src/utils/EIP712.sol` | 90.91% (10/11) | 100.00% (10/10) | 50.00% (1/2) | 75.00% (3/4) |
| `src/utils/Owned2Step.sol` | 100.00% (14/14) | 100.00% (13/13) | 100.00% (3/3) | 100.00% (4/4) |
| `src/utils/ReentrancyGuard.sol` | 100.00% (4/4) | 75.00% (3/4) | 0.00% (0/1) | 100.00% (1/1) |
| **Total** | **97.45% (725/744)** | **93.68% (1053/1124)** | **77.60% (239/308)** | **97.25% (106/109)** |

**Line coverage 97.45%, branch coverage 77.60%.**
