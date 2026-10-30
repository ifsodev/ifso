#!/usr/bin/env bash
# Every onlyOwner function in the deployable sources must be listed in SECURITY.md's owner table (PRIV-1/PRIV-2).
set -euo pipefail
cd "$(dirname "$0")/.."
fns="$(grep -hE 'function [A-Za-z0-9_]+\(.*onlyOwner' src/*.sol src/utils/*.sol | sed -E 's/.*function ([A-Za-z0-9_]+)\(.*/\1/' | sort -u)"
fail=0; n=0
for f in $fns; do
  n=$((n+1))
  grep -q "\`$f\`" ../SECURITY.md || { echo "owner-powers-check: $f is onlyOwner but not listed in SECURITY.md"; fail=1; }
done
uses="$(grep -hE '\bonlyOwner\b' src/*.sol src/utils/*.sol | grep -vc 'modifier onlyOwner' || true)"
lines="$(grep -hcE 'function [A-Za-z0-9_]+\(.*onlyOwner' src/*.sol src/utils/*.sol | paste -sd+ - | bc)"
[ "$uses" = "$lines" ] || { echo "owner-powers-check: an onlyOwner function signature spans lines; list it by hand ($uses uses, $lines parsed)"; fail=1; }
[ "$fail" = 0 ] && echo "owner-powers-check: $n onlyOwner functions, all listed in SECURITY.md"
exit "$fail"
