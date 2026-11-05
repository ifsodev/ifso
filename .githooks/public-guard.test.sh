#!/usr/bin/env bash
# Tests for public-guard.sh, run in throwaway git repos (nothing in this repo is touched):
#   bash .githooks/public-guard.test.sh
# The 64-hex values are built at run time, so this file itself holds none (the guard scans it too).
set -uo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
tmp="$(mktemp -d "${TMPDIR:-/tmp}/public-guard-test.XXXXXX")"
trap 'rm -rf "$tmp"' EXIT

rep() { local s="" i; for ((i = 0; i < $2; i++)); do s="$s$1"; done; printf '%s' "$s"; }
TX="0x$(rep ab 32)"     # transaction-hash shaped
KEY="0x$(rep 4c 32)"    # private-key shaped (same shape: only the place it sits in tells them apart)
BARE="$(rep 5d 32)"     # 64 hex, no 0x

pass=0 fail=0
# case <name> <expected exit> <file path> <content>
case_() {
  local name="$1" want="$2" path="$3" content="$4" repo got out
  repo="$tmp/r$((pass + fail))"
  mkdir -p "$repo/.githooks" "$repo/$(dirname "$path")"
  cp "$here/public-guard.sh" "$repo/.githooks/"
  echo "notarealprivateword" >"$repo/.githooks/public-guard.denylist"
  printf '%s\n' "$content" >"$repo/$path"
  git -C "$repo" init -q
  git -C "$repo" add -A
  out="$(cd "$repo" && bash .githooks/public-guard.sh 2>&1)"
  got=$?
  if [ "$got" = "$want" ]; then
    pass=$((pass + 1))
  else
    fail=$((fail + 1))
    echo "FAIL $name: exit $got, want $want"
    sed 's/^/    /' <<<"$out"
  fi
}

record() { # a deployment record shaped like contracts/deployments/<chainId>.json
  cat <<EOF
{
  "chainId": 46630,
  "contracts": {
    "IfsoEscrow": {
      "address": "0x154Fb83621180f9Dfe80EC3382107C864e79626F",
      "constructorArgs": [250000],
      "creationTx": "$TX"
    }
  },
  "txs": [
    { "hash": "$TX", "contractName": "IfsoEscrow", "function": null, "gasUsed": 1 }
  ],
  "ownershipAccepted": { "by": "0xdAdC7f6694F214d3Ba250275e296Edd2DF6c5995", "txs": { "IfsoEscrow": "$TX" } },
  "deployBlockHash": "$TX"${1-}
}
EOF
}

# accepted: tx hashes in a deployment record and its web copy
case_ "tx hashes in contracts/deployments" 0 contracts/deployments/46630.json "$(record)"
case_ "tx hashes in the web copy" 0 web/src/config/deployments/46630.json "$(record)"
# rejected: a private key planted in a deployment record under any other key
case_ "key under \"key\"" 1 contracts/deployments/46630.json "$(record ", \"key\": \"$KEY\"")"
case_ "key under \"privateKey\"" 1 contracts/deployments/46630.json "$(record ", \"privateKey\": \"$KEY\"")"
case_ "key under contracts.X.deployerKey" 1 contracts/deployments/4663.json \
  "$(record | sed "s|\"creationTx\": \"$TX\"|\"creationTx\": \"$TX\", \"deployerKey\": \"$KEY\"|")"
case_ "key under txs.privateKey" 1 contracts/deployments/46630.json \
  "$(record | sed "s|\"txs\": { \"IfsoEscrow\"|\"txs\": { \"privateKey\": \"$KEY\", \"IfsoEscrow\"|")"
case_ "key in notes text" 1 contracts/deployments/46630.json "$(record ", \"notes\": [\"deployer $KEY\"]")"
case_ "bare 64 hex under creationTx" 1 contracts/deployments/46630.json \
  "$(record | sed "s|\"creationTx\": \"$TX\"|\"creationTx\": \"$BARE\"|")"
case_ "bare 64 hex under another key" 1 contracts/deployments/46630.json "$(record ", \"salt\": \"$BARE\"")"
case_ "64 hex as a JSON key" 1 contracts/deployments/46630.json "$(record ", \"$BARE\": 1")"
case_ "record that is not valid JSON" 1 contracts/deployments/46630.json "{ \"creationTx\": \"$TX\""
case_ "denylisted word in a deployment record" 1 contracts/deployments/46630.json \
  "$(record ", \"note\": \"notarealprivateword\"")"
# rejected: tx-hash-shaped values outside the deployment records, as before
case_ "hash key in another json" 1 app/config/other.json "{ \"creationTx\": \"$TX\" }"
case_ "deployments json in another folder" 1 app/deployments/46630.json "$(record)"
case_ "0x 64 hex in source" 1 app/src/x.ts "const k = \"$KEY\";"
# allowed with the existing same-line marker
case_ "marker in source" 0 app/src/x.ts "const h = \"$TX\"; // not-a-key: tx hash"

echo "public-guard tests: $pass passed, $fail failed"
[ "$fail" = 0 ]
