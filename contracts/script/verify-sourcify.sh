#!/usr/bin/env bash
# Submits every contract in deployments/<chainid>.json to Sourcify (API v2) and prints match / creationMatch.
# Sourcify lists Robinhood Chain 4663 and testnet 46630 as supported (GET /server/chains, checked 2026-10-30).
#
#   bash script/verify-sourcify.sh <chainid>            # submit, wait, print the result per contract
#   bash script/verify-sourcify.sh <chainid> --dry-run  # build and check the request bodies only, no network
#
# Env: SOURCIFY_URL (default https://sourcify.dev/server). Needs forge, jq, curl, python3.
# Fails (exit 1) if any contract ends without a "match"/"exact_match" for both runtime and creation code.
set -euo pipefail
chain="${1:?usage: verify-sourcify.sh <chainid> [--dry-run]}"
mode="${2:-}"
api="${SOURCIFY_URL:-https://sourcify.dev/server}"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$here"
dep="deployments/${chain}.json"
[ -f "$dep" ] || { echo "verify-sourcify: $dep not found" >&2; exit 1; }

forge build --skip test --skip script -q
tmp="$(mktemp -d "${TMPDIR:-/tmp}/ifso-sourcify.XXXXXX")"
trap 'rm -rf "$tmp"' EXIT

# Request body for one contract: {metadata, sources, creationTransactionHash?}
build_body() { # $1 contract name, $2 creation tx hash or "", $3 output path
  python3 -I - "$1" "$2" "$3" <<'PY'
import json, sys, pathlib
name, tx, out = sys.argv[1], sys.argv[2], sys.argv[3]
src_file = {"MockUSDG": "MockUSDG.sol", "MockAggregator": "MockAggregator.sol"}.get(name, name + ".sol")
art = json.loads(pathlib.Path("out", src_file, name + ".json").read_text())
meta = json.loads(art["rawMetadata"])
sources = {}
for path, info in meta["sources"].items():
    text = pathlib.Path(path).read_text()
    sources[path] = text
body = {"metadata": meta, "sources": sources}
if tx:
    body["creationTransactionHash"] = tx
target = meta["settings"]["compilationTarget"]
assert list(target.values()) == [name], f"compilation target mismatch for {name}: {target}"
pathlib.Path(out).write_text(json.dumps(body))
print(f"{name}: {len(sources)} sources, compiler {meta['compiler']['version']}")
PY
}

fail=0
names="$(jq -r '.contracts | keys[]' "$dep")"
for name in $names; do
  addr="$(jq -r --arg n "$name" '.contracts[$n].address' "$dep")"
  tx="$(jq -r --arg n "$name" '[.txs[]? | select(.contractName == $n and .function == null) | .hash][0] // ""' "$dep")"
  body="$tmp/${name}.json"
  build_body "$name" "$tx" "$body"
  if [ "$mode" = "--dry-run" ]; then
    echo "  dry-run: would POST $api/v2/verify/metadata/$chain/$addr"
    continue
  fi
  code="$(curl -sS -o "$tmp/resp.json" -w '%{http_code}' -X POST -H 'content-type: application/json' \
    --data-binary @"$body" "$api/v2/verify/metadata/$chain/$addr")"
  if [ "$code" = "202" ]; then
    vid="$(jq -r '.verificationId' "$tmp/resp.json")"
    for _ in $(seq 1 60); do
      curl -sS "$api/v2/verify/$vid" -o "$tmp/job.json"
      [ "$(jq -r '.isJobCompleted' "$tmp/job.json")" = "true" ] && break
      sleep 5
    done
    jq -c '{job: .verificationId, error: (.error.customCode // null)}' "$tmp/job.json"
  elif [ "$code" != "409" ]; then # 409 = already verified
    echo "verify-sourcify: $name POST returned $code: $(head -c 400 "$tmp/resp.json")" >&2
  fi
  curl -sS "$api/v2/contract/$chain/$addr" -o "$tmp/c.json"
  match="$(jq -r '.match // "none"' "$tmp/c.json")"
  creation="$(jq -r '.creationMatch // "none"' "$tmp/c.json")"
  runtime="$(jq -r '.runtimeMatch // "none"' "$tmp/c.json")"
  echo "$name $addr match=$match creationMatch=$creation runtimeMatch=$runtime"
  case "$runtime" in match|exact_match) ;; *) fail=1;; esac
  case "$creation" in match|exact_match) ;; *) fail=1;; esac
done
[ "$fail" = 0 ] || { echo "verify-sourcify: at least one contract is not fully verified" >&2; exit 1; }
echo "verify-sourcify: done (chain $chain)"
