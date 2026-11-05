#!/usr/bin/env bash
# Everything that can run on this machine: shellcheck on every shell script, byte-compile + unit tests of the Python, then the
# whole-runner sandbox (local mode). Prints one summary line; exit 1 on any failure.
#   bash app/scripts/release/test-local.sh          Needs: shellcheck (optional, skipped with a notice), python3, git, ssh-keygen, curl
#   bash app/scripts/release/test-local.sh --ci [COUNTS.json]
#        what GitHub CI and ci-local.sh run (audit I-21): py_compile, the unit tests (lib/test_*.py) and the hardening cases, no
#        shell lint (its findings follow the linter version) and no whole-runner sandbox; COUNTS.json gets the passed-test counts.
set -uo pipefail
ci=0; counts=""
if [[ "${1:-}" == --ci ]]; then ci=1; counts="${2:-}"; fi
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$HERE" || exit 2
bad=0
if [[ $ci == 1 ]]; then :
elif command -v shellcheck >/dev/null; then
  if shellcheck -S style ./*.sh sbin/* sandbox/*.sh sandbox/fakes/bun sandbox/fakes/node sandbox/fakes/systemctl; then echo "shellcheck: clean"; else echo "shellcheck: FINDINGS"; bad=1; fi
else echo "shellcheck: not installed (skipped)"; fi
python3 -m py_compile lib/*.py sandbox/fake_world.py sandbox/fakes/flock && echo "py_compile: ok" || bad=1
find . -name __pycache__ -prune -exec rm -rf {} + 2>/dev/null
unit="$(python3 -B -m unittest discover -s lib -p 'test_*.py' 2>&1)"
if echo "$unit" | grep -q '^OK'; then echo "unit tests: $(echo "$unit" | grep '^Ran')"; else echo "unit tests: FAILED"; echo "$unit"; bad=1; fi
hard="$(bash sandbox/hardening-cases.sh 2>&1)"; echo "$hard" | grep FAIL; echo "$hard" | grep 'hardening cases'
echo "$hard" | grep -q ' 0 failed' || bad=1
if [[ $ci == 1 ]]; then
  nu="$(echo "$unit" | sed -n 's/^Ran \([0-9]*\) tests.*/\1/p')"; nh="$(echo "$hard" | sed -n 's/^hardening cases: \([0-9]*\) passed.*/\1/p')"
  { echo "$unit" | grep -q '^OK'; } || nu=0
  [[ -z "$counts" ]] || printf '{"hardening-cases.sh": %s, "lib/test_*.py": %s}\n' "${nh:-0}" "${nu:-0}" >"$counts"
  [[ $bad == 0 ]] && echo "ALL GREEN (ci: unit $nu, hardening $nh)" || echo "NOT GREEN"
  exit $bad
fi
box="$(bash sandbox/run-sandbox.sh 2>&1)"; echo "$box" | grep FAIL; echo "$box" | tail -n 3 | grep 'sandbox (local)'
echo "$box" | grep -q ' 0 failed' || bad=1
[[ $bad == 0 ]] && echo "ALL GREEN" || echo "NOT GREEN"
exit $bad
