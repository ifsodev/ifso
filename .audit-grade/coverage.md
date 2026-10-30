# Coverage

`forge coverage --report summary` over the deployable sources (`src/`, mocks excluded), default test profile. Re-run: `bash contracts/tools/coverage.sh`.
Fork tests are skipped without an RPC, so fork-only paths are not counted here.

| File | Lines | Statements | Branches | Functions |
|---|---|---|---|---|
| `src/FeeRouter.sol` | 100.00% (30/30) | 97.67% (42/43) | 75.00% (3/4) | 100.00% (5/5) |
| `src/IfsoConditionEvaluator.sol` | 93.43% (185/198) | 88.39% (312/353) | 68.97% (80/116) | 100.00% (18/18) |
| `src/IfsoEscrow.sol` | 98.42% (312/317) | 97.69% (465/476) | 91.04% (122/134) | 98.04% (50/51) |
| `src/IfsoOutcomeResolver.sol` | 96.40% (107/111) | 90.14% (128/142) | 59.38% (19/32) | 88.24% (15/17) |
| `src/libraries/ECDSA.sol` | 100.00% (19/19) | 79.17% (19/24) | 0.00% (0/5) | 100.00% (3/3) |
| `src/libraries/SafeTransferLib.sol` | 100.00% (11/11) | 94.44% (17/18) | 66.67% (2/3) | 100.00% (3/3) |
| `src/libraries/SignatureChecker.sol` | 100.00% (9/9) | 85.71% (18/21) | 25.00% (1/4) | 100.00% (1/1) |
| `src/utils/EIP712.sol` | 90.91% (10/11) | 100.00% (10/10) | 50.00% (1/2) | 75.00% (3/4) |
| `src/utils/Owned2Step.sol` | 100.00% (14/14) | 100.00% (13/13) | 100.00% (3/3) | 100.00% (4/4) |
| `src/utils/ReentrancyGuard.sol` | 100.00% (4/4) | 75.00% (3/4) | 0.00% (0/1) | 100.00% (1/1) |
| **Total** | **96.82% (701/724)** | **93.03% (1027/1104)** | **75.99% (231/304)** | **96.26% (103/107)** |

**Line coverage 96.82%, branch coverage 75.99%.**
