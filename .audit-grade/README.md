# Audit evidence

Everything an outside reviewer needs to re-run is in this repository. Nothing here is a screenshot or a claim without a
command next to it.

| File | What it shows | How to re-run |
|---|---|---|
| [mutation.md](mutation.md) | Mutation score: killed/total per source file, a mutant for every round-1 finding (M1 to M5, L1), survivors and equivalent mutants listed | `bash contracts/tools/mutation.sh` (CI job `mutation`, fails below 90% or on a stale mutant) |
| [halmos.md](halmos.md) | Symbolic proofs of the comparison, threshold, fee and cap arithmetic and of three round-1 fixes | `bash contracts/tools/halmos.sh` (CI job `halmos`) |
| [coverage.md](coverage.md) | Line, statement, branch and function coverage per source file | `bash contracts/tools/coverage.sh` (CI job `coverage`, floor 90% lines) |
| [reviews/](reviews/README.md) | Security review reports, published as each round closes | not yet populated |

## Mutation history

First run: 79/109 killed (72.5%). The 30 survivors were boundary and negative cases no test pinned (to the second at
every deadline, window and expiry; sequencer reported down; unreadable multiplier; zero threshold; double accept;
double withdraw and others). 29 were killed by new tests in `contracts/test/MutationKillers.t.sol`; one
(`X-activefrom`) is an equivalent mutant, because two-sided TOUCH challenges are refused so the acceptance time never
feeds a TOUCH window. Five mutants for the ownership and fee-router paths were added with `Governance.t.sol`.
Current run: see [mutation.md](mutation.md).

## View equals execution

The amount a user sees and signs must equal what the contract pulls. It is checked in two halves:

- Contracts: `contracts/test/ViewEqualsExecution.t.sol` runs the real escrow, evaluator, resolver and fee router on
  the cash-moving USDG double. For `create`, `createWithPermit`, `createWithAuthorization` and `createBatch`, for TIME
  and OUTCOME conditions, it asserts that the sender pays exactly `amount + feeFor(kind)`, the escrow keeps exactly
  `amount`, and the router gets exactly the fee, including after `setFees` changes. A signature made for the old fee
  fails after `setFees` (it can never pull more than the user signed), and a re-quote with the new fee pulls exactly the
  new total. Symbolic version: `check_CreatePullsAmountPlusReportedFee` in [halmos.md](halmos.md).
- Application: `app/test/typedData.test.ts` and `app/test/parity.test.ts` check that the builder's typed-data type
  strings, domains, digests, nonces and ids equal the contracts' own. A test that the builder's signed value equals
  `amount + feeFor(kind)` from the escrow, including after `setFees`, belongs in `app/test/typedData.test.ts`; that
  file is outside this change and the item is open until it exists.

## Other gates in CI

`.github/workflows/ci.yml`: format, size gate, NatSpec on every external and public function, README vs deployment
files, owner-power table, tests, gas snapshot, local deploy on anvil, invariants (10,000 runs x depth 50), Slither with an
exact-match allowlist, app tests, and the jobs above plus `gitleaks` (binary pinned by sha256, config in
`.github/gitleaks.toml`). `.github/scripts/pins-check.sh` fails the build if any action is not pinned by a full commit
sha, any container image lacks a digest, or any pip install is not hash-locked. See also [../CHANGELOG.md](../CHANGELOG.md).

## Not yet here

Live-deployment evidence (post-deploy check output and bytecode comparison against the build) is added when the
contracts are deployed; no deployment is claimed today.
