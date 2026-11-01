#!/usr/bin/env bash
# Gas snapshot without the tests whose gas depends on the machine, not the code:
#  - fuzz tests (mean/median over generated inputs),
#  - tests that read files (the script scan in DeployTest, build artifacts in PostDeployCheckTest), whose cost follows
#    file and path sizes. Same filter for writing and checking:  tools/gas-snapshot.sh [--check]
set -euo pipefail
cd "$(dirname "$0")/.."
exec forge snapshot --no-match-test 'testFuzz|test_Deploy_EveryBroadcastingScriptIsGuarded|test_PostDeploy_RuntimeCodeMatchesBuild' "$@"
