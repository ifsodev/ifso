#!/usr/bin/env bash
# Proves convert-network.sh (testnet box -> mainnet box) without a server: a temp /etc/ifso, shims for systemctl, runuser,
# psql, pg_dump, pg_restore, redis-cli and curl, and stand-ins for provision.sh, ifso-deploy and ifso-release-status.
# It never touches /etc, systemd, Postgres, Redis, the network or ssh:
#   bash app/scripts/server/convert-network.test.sh
# shellcheck disable=SC2016  # the bash -c snippets below are single-quoted on purpose
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONV="$HERE/convert-network.sh"
T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT
SHIM="$T/shim"; CTL="$T/ctl"; mkdir -p "$SHIM" "$CTL"

# Addresses: testnet contracts (t*), mainnet contracts (m*), mainnet hot wallets (h*). Public-shaped, made up.
a() { printf '0x%040x' "$1"; }
TESC="$(a 0x7e1)"; TEVA="$(a 0x7e2)"; TRES="$(a 0x7e3)"; TFEE="$(a 0x7e4)"; TUSD="$(a 0x7e5)"; TFEED="$(a 0x7e6)"
MESC="$(a 0x4e1)"; MEVA="$(a 0x4e2)"; MRES="$(a 0x4e3)"; MFEE="$(a 0x4e4)"; MUSD="$(a 0x4e5)"
HREL="$(a 0xaa1)"; HKEE="$(a 0xaa2)"; HRSV="$(a 0xaa3)"; HDEP="$(a 0xaa0)"

# ---- shims ---------------------------------------------------------------------------------------------------------
cat >"$SHIM/systemctl" <<FAKE
#!/usr/bin/env bash
echo "systemctl \$*" >>"$CTL/calls"
last="\${@: -1}"
case "\$1" in
  stop) sed -i.bak "/^\$last\\\$/d" "$CTL/active"; [[ -e "$CTL/fail-stop" ]] && exit 1; exit 0 ;;
  is-active) grep -qx "\$last" "$CTL/active" && { [[ "\$2" == --quiet ]] || echo active; exit 0; }; [[ "\$2" == --quiet ]] || echo inactive; exit 3 ;;
esac
exit 0
FAKE
cat >"$SHIM/runuser" <<'FAKE'
#!/usr/bin/env bash
shift 2; [[ "$1" == -- ]] && shift; exec "$@"
FAKE
cat >"$SHIM/psql" <<FAKE
#!/usr/bin/env bash
db=""; q=""
while [[ \$# -gt 0 ]]; do case "\$1" in -d) db="\$2"; shift 2 ;; -c|-tAc) q="\$2"; shift 2 ;; *) shift ;; esac; done
echo "psql [\$db] \$q" >>"$CTL/calls"
case "\$q" in
  *"FROM pg_database WHERE datname = 'ifso_testnet'"*) echo 1 ;;
  *"quote_ident(schemaname)"*) [[ "\$db" == ifso_mainnet && ! -e "$CTL/mainnet-migrated" ]] || printf 'public.cursors\npublic.escrows\n' ;;
  *"count(*) FROM pg_stat_user_tables"*) echo 0 ;;
  *"count(*) FROM public.cursors"*) if [[ "\$db" == ifso_mainnet ]]; then echo 1; elif [[ "\$db" == *restorecheck && -e "$CTL/restore-diff" ]]; then echo 2; else echo 3; fi ;;
  *"count(*) FROM public.escrows"*) [[ "\$db" == ifso_mainnet ]] && echo 0 || echo 5 ;;
esac
exit 0
FAKE
cat >"$SHIM/pg_dump" <<FAKE
#!/usr/bin/env bash
echo "pg_dump \$*" >>"$CTL/calls"
[[ -e "$CTL/fail-dump" ]] && exit 1
printf 'PGDMP fake dump of %s\n' "\${@: -1}"
FAKE
cat >"$SHIM/pg_restore" <<FAKE
#!/usr/bin/env bash
echo "pg_restore \$*" >>"$CTL/calls"
f="\${@: -1}"; [[ -f "\$f" ]] || f=/dev/stdin; head -c5 "\$f" | grep -q PGDMP || exit 1
[[ "\$*" == *" -d "* && -e "$CTL/fail-restore" ]] && exit 1
exit 0
FAKE
cat >"$SHIM/redis-cli" <<FAKE
#!/usr/bin/env bash
echo "redis-cli \$* auth=\${REDISCLI_AUTH:+set}" >>"$CTL/calls"
while [[ \$# -gt 0 ]]; do [[ "\$1" == --rdb ]] && { echo REDIS0011 >"\$2"; }; shift; done
exit 0
FAKE
cat >"$SHIM/curl" <<FAKE
#!/usr/bin/env bash
body=""; while [[ \$# -gt 0 ]]; do [[ "\$1" == -d ]] && body="\$2"; shift; done
echo "curl \$body" >>"$CTL/calls"
case "\$body" in
  *eth_chainId*) printf '{"jsonrpc":"2.0","id":1,"result":"%s"}' "\$(cat "$CTL/chain-hex")" ;;
  *eth_getCode*) if [[ -e "$CTL/no-code" ]] && grep -qi "\$(cat "$CTL/no-code")" <<<"\$body"; then printf '{"jsonrpc":"2.0","id":1,"result":"0x"}'; else printf '{"jsonrpc":"2.0","id":1,"result":"0x6080"}'; fi ;;
esac
FAKE
cat >"$SHIM/cast" <<'FAKE'
#!/usr/bin/env bash
# stand-in for `cast wallet address --keystore f --password-file p`: the test keystores carry their address in a field
[[ "$1 $2" == "wallet address" ]] || exit 1
ks=""; pw=""; while [[ $# -gt 0 ]]; do case "$1" in --keystore) ks="$2"; shift 2 ;; --password-file) pw="$2"; shift 2 ;; *) shift ;; esac; done
[[ -r "$pw" ]] || exit 1
a="$(jq -r '.address // empty' "$ks" 2>/dev/null)"; [[ -n "$a" ]] || exit 1; echo "0x$a"
FAKE
cat >"$T/provision" <<FAKE
#!/usr/bin/env bash
# stand-in for provision.sh --cohost: records its environment, then does what the real one does to profile and db.env
echo "provision \$* CONVERT_NETWORK=\${CONVERT_NETWORK:-} CONVERT_ARCHIVE=\${CONVERT_ARCHIVE:-} PROFILE=\${PROFILE:-} DOMAIN=\${DOMAIN:-} EDGE=\${EDGE:-}" >>"$CTL/calls"
[[ -e "$CTL/fail-provision" ]] && exit 1
echo "\$PROFILE" >"$T/etc/profile"
sed -i.bak "s#/ifso_testnet#/ifso_\$PROFILE#" "$T/etc/db.env"; rm -f "$T/etc/db.env.bak"
exit 0
FAKE
cat >"$T/deploy" <<FAKE
#!/usr/bin/env bash
echo "deploy \$*" >>"$CTL/calls"
if [[ "\$1" == --check ]]; then exit 0; fi
touch "$CTL/mainnet-migrated"
exit "\$(cat "$CTL/deploy-rc" 2>/dev/null || echo 0)"
FAKE
cat >"$T/release-status" <<'FAKE'
#!/usr/bin/env bash
printf '== autopilot\ntimer enabled: disabled\nreal deploys: NOT armed\n'
FAKE
chmod +x "$SHIM"/* "$T/provision" "$T/deploy" "$T/release-status"

keystore() { printf '{"address":"%s","crypto":{"cipher":"aes-128-ctr"},"version":3}\n' "${1#0x}" >"$2"; }

lay_box() { # a fresh testnet co-host box in $T/etc etc.
  rm -rf "${T:?}/etc" "${T:?}/state" "${T:?}/backups" "${T:?}/rel" "${T:?}/sites" "${T:?}/vals" "${CTL:?}"; mkdir -p "$CTL" "$T/etc/keys" "$T/state" "$T/backups" "$T/rel" "$T/sites"
  : >"$CTL/calls"; printf '0xb626' >"$CTL/chain-hex"; printf '0x1237' >"$CTL/chain-hex.main"
  printf 'ifso-api\nifso-worker\nifso-bot\nifso-redis\ncaddy\n' >"$CTL/active"
  echo testnet >"$T/etc/profile"; : >"$T/etc/cohost"
  printf "PROFILE=testnet\nDOMAIN=api.example.test\nREPO_URL=''\nDB_NAME=ifso_testnet\nCOHOST=1\n" >"$T/etc/provision.conf"
  printf 'NODE_ENV=production\nCHAIN_ID=46630\nRHC_RPC_URLS=https://rpc.testnet.invalid\nESCROW_ADDRESS=%s\nEVALUATOR_ADDRESS=%s\nRESOLVER_ADDRESS=%s\nFEE_ROUTER_ADDRESS=%s\nUSDG_ADDRESS=%s\nESCROW_DEPLOY_BLOCK=149079876\nTESTNET_FEEDS=ETH=%s\nTELEGRAM_BOT_TOKEN=tg-secret-kept\nZERODEV_PROJECT_ID=zd-project-kept\nMIN_RESOLVER_USDG=\nPUBLIC_APP_URL=https://ifso.tech\n' \
    "$TESC" "$TEVA" "$TRES" "$TFEE" "$TUSD" "$TFEED" >"$T/etc/common.env"
  printf 'PORT=3201\nHOST=127.0.0.1\nTRUST_PROXY=cloudflare\nIP_HASH_SALT=salt-kept\nZERODEV_PROJECT_ID=\nWEB_ORIGINS=https://ifso.tech\n' >"$T/etc/api.env"
  printf 'KEEPER_KEYSTORE=/etc/ifso/keys/keeper.json\nRESOLVER_ADDRESS=%s\nODDS_API_KEY=\n' "$TRES" >"$T/etc/worker.env"
  printf 'DATABASE_URL=postgres://ifso:pw@127.0.0.1:5432/ifso_testnet\nREDIS_URL=redis://:rpw@127.0.0.1:6380\n' >"$T/etc/db.env"
  : >"$T/etc/bot.env"
  chmod 600 "$T/etc"/*.env
  for k in relayer keeper resolver; do keystore "$(a 0x46630)" "$T/etc/keys/$k.json"; echo pw >"$T/etc/keys/$k.password"; done
  printf 'API_URL=http://127.0.0.1:8080\nRPC_MAX_LAG_S=60\n' >"$T/rel/paths.conf"
  printf 'api.example.test {\n\t@not_cloudflare not remote_ip 173.245.48.0/20\n\tabort @not_cloudflare\n\treverse_proxy 127.0.0.1:3201\n}\n' >"$T/sites/ifso.caddy"
  echo d6b7a577e810ac9862f1b2d2db5469ebe3d9a0da >"$T/state/current.sha"
  {
    echo "CHAIN_ID=4663"; echo "ESCROW_ADDRESS=$MESC"; echo "EVALUATOR_ADDRESS=$MEVA"; echo "RESOLVER_ADDRESS=$MRES"
    echo "FEE_ROUTER_ADDRESS=$MFEE"; echo "USDG_ADDRESS=$MUSD"; echo "ESCROW_DEPLOY_BLOCK=107062443"
    echo "INTERNAL_ADDRESSES=$HDEP,$HREL,$HKEE,$HRSV"; echo "RHC_RPC_URLS="; echo "RHC_WS_URL="; echo "MIN_RESOLVER_USDG=200"
    echo "KEEPER_SHADOW="; echo "WEB_ORIGINS=https://ifso.tech,https://www.ifso.tech"; echo "TRUST_PROXY=cloudflare"
    echo "EXPECT_RELAYER=$HREL"; echo "EXPECT_KEEPER=$HKEE"; echo "EXPECT_RESOLVER_WALLET=$HRSV"
  } >"$T/vals"
}
mainnet_keys() { keystore "$HREL" "$T/etc/keys/relayer.json"; keystore "$HKEE" "$T/etc/keys/keeper.json"; keystore "$HRSV" "$T/etc/keys/resolver.json"
  for k in relayer keeper resolver; do echo pw >"$T/etc/keys/$k.password"; done; }
cv() { # cv <args...>: run the script in test mode
  OUT="$(env PATH="$SHIM:$PATH" IFSO_CONVERT_TEST=1 IFSO_ETC="$T/etc" IFSO_STATE="$T/state" IFSO_BACKUPS="$T/backups" \
    IFSO_RELEASE_ETC="$T/rel" IFSO_CADDY_SITES="$T/sites" IFSO_PROVISION_CMD="$T/provision" IFSO_DEPLOY_CMD="$T/deploy" \
    IFSO_RELEASE_STATUS="$T/release-status" IFSO_CURL="$SHIM/curl" IFSO_CAST="$SHIM/cast" IFSO_SYSTEMCTL="$SHIM/systemctl" bash "$CONV" "$@" 2>&1)"; RC=$?
}
etc_sum() { (cd "$T/etc" && find . -type f -exec shasum {} + | sort | shasum); }
archive_dir() { sed -n 's/^ARCHIVE=//p' <<<"$OUT" | tail -1; }
main_rpc() { printf '0x1237' >"$CTL/chain-hex"; }

fail=0; n=0
check() { local name="$1"; shift; n=$((n + 1)); if "$@"; then printf 'ok   %s\n' "$name"; else printf 'FAIL %s\n' "$name"; fail=$((fail + 1)); fi; }
has() { grep -q -- "$1" <<<"$2"; }

[[ -f "$CONV" ]] || { echo "FAIL convert-network.sh does not exist"; echo "1 of 1 failed"; exit 1; }

# ---- the flag guard ------------------------------------------------------------------------------------------------
lay_box; before="$(etc_sum)"
CONVERT_NETWORK='' cv archive
check "archive without CONVERT_NETWORK is refused (64)" test "$RC" = 64
check "  ... names the flag it wants" has "CONVERT_NETWORK=testnet-to-mainnet" "$OUT"
check "  ... and stopped nothing, changed nothing" bash -c '! grep -q "systemctl stop" "$1" && [ "$2" = "$3" ]' _ "$CTL/calls" "$before" "$(etc_sum)"
CONVERT_NETWORK=mainnet cv archive; check "a CONVERT_NETWORK other than testnet-to-mainnet is refused (64)" test "$RC" = 64
CONVERT_NETWORK='' cv apply --archive "$T/backups" --values "$T/vals" --sha d6b7a577e810ac9862f1b2d2db5469ebe3d9a0da
check "apply without CONVERT_NETWORK is refused (64)" test "$RC" = 64
export CONVERT_NETWORK=testnet-to-mainnet

# ---- archive refusals ----------------------------------------------------------------------------------------------
lay_box; echo mainnet >"$T/etc/profile"; cv archive
check "archive on a box whose profile is not testnet is refused (64)" test "$RC" = 64
lay_box; touch "$T/rel/ALLOW_REAL_DEPLOY"; before="$(etc_sum)"; cv archive
check "archive while the release runner is ARMED is refused (64), nothing stopped" bash -c '[ "$1" = 64 ] && ! grep -q "systemctl stop" "$2"' _ "$RC" "$CTL/calls"
lay_box; echo ifso-release.timer >>"$CTL/active"; cv archive
check "archive while the release timer is active is refused (64)" test "$RC" = 64
lay_box; touch "$CTL/fail-dump"; cv archive
check "a pg_dump failure stops the archive (1); the testnet keys and Redis are left as they were" bash -c '[ "$1" = 1 ] && [ -f "$2/keys/relayer.json" ] && ! grep -q FLUSHALL "$3"' _ "$RC" "$T/etc" "$CTL/calls"

# ---- archive -------------------------------------------------------------------------------------------------------
lay_box; before="$(etc_sum)"; cv archive; A="$(archive_dir)"
check "archive: exit 0 and prints ARCHIVE=<dir>" bash -c '[ "$1" = 0 ] && [ -d "$2" ]' _ "$RC" "$A"
check "  ... stopped ifso-api, ifso-worker, ifso-bot BEFORE the dump" bash -c 'a=$(grep -n "systemctl stop ifso-api" "$1" | head -1 | cut -d: -f1); d=$(grep -n "^pg_dump" "$1" | head -1 | cut -d: -f1); grep -q "systemctl stop ifso-worker" "$1" && grep -q "systemctl stop ifso-bot" "$1" && [ -n "$a" ] && [ "$a" -lt "$d" ]' _ "$CTL/calls"
check "  ... the archive holds the dump, row counts, Redis snapshot, etc tar, runner paths, Caddy site, INFO, MANIFEST" bash -c 'for f in ifso_testnet.dump db-rows.tsv redis.rdb etc-ifso.tar release-paths.conf ifso.caddy INFO MANIFEST; do [ -s "$1/$f" ] || exit 1; done' _ "$A"
check "  ... the MANIFEST verifies and covers every file" bash -c 'cd "$1" && shasum -a 256 -c --quiet MANIFEST && [ "$(wc -l <MANIFEST)" = "$(find . -type f ! -name MANIFEST | wc -l)" ]' _ "$A"
check "  ... INFO says profile=testnet, chain 46630, the running release" bash -c 'grep -qx profile=testnet "$1/INFO" && grep -qx chain_id=46630 "$1/INFO" && grep -qx release=d6b7a577e810ac9862f1b2d2db5469ebe3d9a0da "$1/INFO"' _ "$A"
check "  ... the etc tar holds the env files but not the keys" bash -c 'tar -tf "$1/etc-ifso.tar" | grep -q "common.env" && ! tar -tf "$1/etc-ifso.tar" | grep -q "keys/"' _ "$A"
check "  ... the six testnet key files were MOVED into the archive; /etc/ifso/keys is empty" bash -c '[ "$(find "$1/keys" -type f | wc -l | tr -d " ")" = 6 ] && [ -z "$(ls -A "$2/keys")" ]' _ "$A" "$T/etc"
check "  ... the archive is private (no group/other bits)" bash -c '! find "$1" -perm -g=r -o -perm -o=r | grep -q .' _ "$A"
check "  ... Redis: snapshot first, then FLUSHALL, password via REDISCLI_AUTH (never argv), port 6380" bash -c 'r=$(grep -n -- "--rdb" "$1" | cut -d: -f1); f=$(grep -n FLUSHALL "$1" | cut -d: -f1); [ -n "$r" ] && [ "$r" -lt "$f" ] && grep FLUSHALL "$1" | grep -q "6380.*auth=set" && ! grep -q rpw "$1"' _ "$CTL/calls"
check "  ... no setting changed: profile testnet, env files identical apart from the moved keys" bash -c '[ "$(cat "$1/profile")" = testnet ] && cmp -s "$1/common.env" <(tar -xOf "$2/etc-ifso.tar" "$(basename "$1")/common.env")' _ "$T/etc" "$A"
cv archive; check "archive again: says it is already archived, same dir, changes nothing" bash -c '[ "$1" = 0 ] && grep -q "already archived" <<<"$2" && [ "$(sed -n "s/^ARCHIVE=//p" <<<"$2")" = "$3" ]' _ "$RC" "$OUT" "$A"

# ---- apply refusals (nothing changes) ------------------------------------------------------------------------------
SHA=d6b7a577e810ac9862f1b2d2db5469ebe3d9a0da
ap() { cv apply --archive "$A" --values "$T/vals" --sha "$SHA"; }
snap() { before="$(etc_sum)"; : >"$CTL/calls"; }
unchanged() { [ "$(etc_sum)" = "$before" ] && ! grep -qE "^(provision|deploy)" "$CTL/calls"; }
mainnet_keys; main_rpc
snap; cv apply --archive "$A" --values "$T/vals" --sha main; check "apply with a branch name instead of a sha is refused (64)" bash -c '[ "$1" = 64 ]' _ "$RC"
snap; cv apply --values "$T/vals" --sha "$SHA"; check "apply without --archive is refused (64)" test "$RC" = 64
snap; cv apply --archive "$T/backups" --values "$T/vals" --sha "$SHA"; check "apply with a directory that is not this box's archive is refused (64)" test "$RC" = 64
cp "$A/ifso_testnet.dump" "$T/dump.keep"; echo tampered >>"$A/ifso_testnet.dump"
snap; ap; check "apply with an archive that no longer matches its MANIFEST is refused (64), nothing changed" bash -c '[ "$1" = 64 ] && grep -q MANIFEST <<<"$2"' _ "$RC" "$OUT"; check "  ... nothing changed" unchanged
cp "$T/dump.keep" "$A/ifso_testnet.dump"
touch "$CTL/restore-diff"; snap; ap
check "apply when the dump restores with other row counts is refused (64), nothing changed" bash -c '[ "$1" = 64 ] && grep -q "row counts differ" <<<"$2"' _ "$RC" "$OUT"
check "  ... and the scratch database was dropped again" bash -c 'grep -q "DROP DATABASE IF EXISTS ifso_testnet_restorecheck" "$1"' _ "$CTL/calls"
rm -f "$CTL/restore-diff"
touch "$CTL/fail-restore"; snap; ap; check "apply when the dump does not restore is refused (64)" test "$RC" = 64; rm -f "$CTL/fail-restore"
vcase() { # vcase <name> <sed expression or append line>
  cp "$T/vals" "$T/vals.keep"; eval "$2"; snap; ap; check "values: $1 is refused (64), nothing changed" bash -c '[ "$1" = 64 ]' _ "$RC"; cp "$T/vals.keep" "$T/vals"
}
vcase "CHAIN_ID 46630" 'sed -i.bak "s/^CHAIN_ID=.*/CHAIN_ID=46630/" "$T/vals"'
vcase "a missing ESCROW_ADDRESS" 'sed -i.bak "/^ESCROW_ADDRESS=/d" "$T/vals"'
vcase "a malformed address" 'sed -i.bak "s/^USDG_ADDRESS=.*/USDG_ADDRESS=0x1234/" "$T/vals"'
vcase "a secret key (TELEGRAM_BOT_TOKEN)" 'echo TELEGRAM_BOT_TOKEN=123:abc >>"$T/vals"'
vcase "an unknown key" 'echo SOMETHING_ELSE=1 >>"$T/vals"'
vcase "a quoted value" "echo \"PUBLIC_APP_URL='x y'\" >>\"\$T/vals\""
vcase "a key given twice" 'echo CHAIN_ID=4663 >>"$T/vals"'
vcase "ESCROW_DEPLOY_BLOCK 0" 'sed -i.bak "s/^ESCROW_DEPLOY_BLOCK=.*/ESCROW_DEPLOY_BLOCK=0/" "$T/vals"'
vcase "a bad INTERNAL_ADDRESSES entry" 'sed -i.bak "s/^INTERNAL_ADDRESSES=.*/INTERNAL_ADDRESSES=0xabc,$HREL/" "$T/vals"'
printf '0xb626' >"$CTL/chain-hex"; snap; ap
check "apply when the RPC answers the testnet chain id: exit 75, nothing changed" bash -c '[ "$1" = 75 ]' _ "$RC"; check "  ... nothing changed" unchanged
main_rpc; echo "${MESC#0x}" >"$CTL/no-code"; snap; ap
check "apply when the escrow has no code on 4663 (contracts not deployed yet): exit 75" bash -c '[ "$1" = 75 ] && grep -q "no code at ESCROW_ADDRESS" <<<"$2"' _ "$RC" "$OUT"; check "  ... nothing changed" unchanged
rm -f "$CTL/no-code"
rm -f "$T/etc/keys/"*; snap; ap
check "apply with no key files in /etc/ifso/keys: exit 75 and says the owner copies them" bash -c '[ "$1" = 75 ] && grep -q "owner copies the mainnet key files" <<<"$2"' _ "$RC" "$OUT"
cp "$A/keys/"* "$T/etc/keys/"; snap; ap
check "apply with the TESTNET keys put back: refused (64), names the wanted mainnet relayer" bash -c '[ "$1" = 64 ] && grep -q "not the mainnet relayer" <<<"$2"' _ "$RC" "$OUT"; check "  ... nothing changed" unchanged
mainnet_keys; keystore "$(a 0xbad)" "$T/etc/keys/keeper.json"; snap; ap
check "apply with one wrong mainnet keystore (keeper): refused (64)" bash -c '[ "$1" = 64 ] && grep -q "mainnet keeper" <<<"$2"' _ "$RC" "$OUT"
mainnet_keys; echo ifso-worker >>"$CTL/active"; snap; ap
check "apply while an app unit runs again is refused (64)" test "$RC" = 64
sed -i.bak '/^ifso-worker$/d' "$CTL/active"
touch "$T/rel/ALLOW_REAL_DEPLOY"; snap; ap; check "apply while the runner is armed is refused (64)" test "$RC" = 64; rm -f "$T/rel/ALLOW_REAL_DEPLOY"
touch "$CTL/fail-provision"; snap; ap
check "a failing provision step: exit 1, profile still testnet, no deploy" bash -c '[ "$1" = 1 ] && [ "$(cat "$2/profile")" = testnet ] && ! grep -q "^deploy" "$3"' _ "$RC" "$T/etc" "$CTL/calls"
rm -f "$CTL/fail-provision"

# ---- apply ---------------------------------------------------------------------------------------------------------
cp "$T/etc/api.env" "$T/api.before"; snap; ap
check "apply: exit 0" bash -c '[ "$1" = 0 ] || { echo "$2" | tail -5; exit 1; }' _ "$RC" "$OUT"
check "  ... provision ran as --cohost with PROFILE=mainnet, the flag, this archive, the saved DOMAIN and EDGE=cloudflare" bash -c 'grep -q "^provision --cohost CONVERT_NETWORK=testnet-to-mainnet CONVERT_ARCHIVE=$2 PROFILE=mainnet DOMAIN=api.example.test EDGE=cloudflare$" "$1"' _ "$CTL/calls" "$A"
check "  ... the restore proof ran before provision" bash -c 'r=$(grep -n "pg_restore.* -d ifso_testnet_restorecheck" "$1" | head -1 | cut -d: -f1); p=$(grep -n "^provision" "$1" | cut -d: -f1); [ -n "$r" ] && [ "$r" -lt "$p" ]' _ "$CTL/calls"
check "  ... profile mainnet, db.env names ifso_mainnet" bash -c '[ "$(cat "$1/profile")" = mainnet ] && grep -q "/ifso_mainnet$" "$1/db.env"' _ "$T/etc"
c() { grep -E "^$1=" "$T/etc/$2.env" | tail -1 | cut -d= -f2-; }
check "  ... common.env: CHAIN_ID 4663 and the four mainnet contracts, USDG, deploy block" bash -c '[ "$1" = 4663 ] && [ "$2" = "$6" ] && [ "$3" = "$7" ] && [ "$4" = "$8" ] && [ "$5" = 107062443 ]' _ "$(c CHAIN_ID common)" "$(c ESCROW_ADDRESS common)" "$(c RESOLVER_ADDRESS common)" "$(c USDG_ADDRESS common)" "$(c ESCROW_DEPLOY_BLOCK common)" "$MESC" "$MRES" "$MUSD"
check "  ... worker.env's own RESOLVER_ADDRESS line is the mainnet resolver too (the later file wins for the worker)" test "$(c RESOLVER_ADDRESS worker)" = "$MRES"
check "  ... TESTNET_FEEDS and RHC_RPC_URLS emptied; INTERNAL_ADDRESSES and MIN_RESOLVER_USDG 200 added" bash -c '[ -z "$1" ] && [ -z "$2" ] && [ "$3" = "$5" ] && [ "$4" = 200 ]' _ "$(c TESTNET_FEEDS common)" "$(c RHC_RPC_URLS common)" "$(c INTERNAL_ADDRESSES common)" "$(c MIN_RESOLVER_USDG common)" "$HDEP,$HREL,$HKEE,$HRSV"
check "  ... WEB_ORIGINS in api.env; secrets, salt, ZERODEV_PROJECT_ID and PUBLIC_APP_URL kept as they were" bash -c '[ "$1" = "https://ifso.tech,https://www.ifso.tech" ] && [ "$2" = tg-secret-kept ] && [ "$3" = zd-project-kept ] && [ "$4" = salt-kept ] && [ "$5" = https://ifso.tech ]' _ "$(c WEB_ORIGINS api)" "$(c TELEGRAM_BOT_TOKEN common)" "$(c ZERODEV_PROJECT_ID common)" "$(c IP_HASH_SALT api)" "$(c PUBLIC_APP_URL common)"
check "  ... the EXPECT_* check values were not written into any env file" bash -c '! grep -q "^EXPECT_" "$1"/*.env' _ "$T/etc"
check "  ... no testnet contract or feed address is left in any env file" bash -c 'for v in "$2" "$3" "$4" "$5" "$6" "$7"; do grep -qiF "$v" "$1"/common.env "$1"/api.env "$1"/worker.env && exit 1; done; exit 0' _ "$T/etc" "$TESC" "$TEVA" "$TRES" "$TFEE" "$TUSD" "$TFEED"
check "  ... env files stay 0600" bash -c 'for f in "$1"/common.env "$1"/api.env "$1"/worker.env; do [ "$(stat -f %Lp "$f" 2>/dev/null || stat -c %a "$f")" = 600 ] || exit 1; done' _ "$T/etc"
check "  ... the release runner's API_URL now points at the API port 3201 (it said 8080), with a backup" bash -c 'grep -qx "API_URL=http://127.0.0.1:3201" "$1/paths.conf" && ls "$1"/paths.conf.bak.* >/dev/null' _ "$T/rel"
check "  ... ifso-deploy --profile mainnet <sha>, then ifso-deploy --check" bash -c 'grep -q "^deploy --profile mainnet $2$" "$1" && grep -q "^deploy --check$" "$1"' _ "$CTL/calls" "$SHA"
check "  ... the Caddy site file is unchanged" bash -c 'grep -q "abort @not_cloudflare" "$1/ifso.caddy" && grep -q "reverse_proxy 127.0.0.1:3201" "$1/ifso.caddy"' _ "$T/sites"
check "  ... the state file records archived, provisioned, deployed, converted" bash -c 'for k in archived provisioned deployed converted; do grep -q "^$k=" "$1/convert-network.state" || exit 1; done' _ "$T/state"
check "  ... no secret value is printed" bash -c '! grep -qE "tg-secret-kept|salt-kept|rpw|:pw@" <<<"$1"' _ "$OUT"

# ---- after the conversion ------------------------------------------------------------------------------------------
cv status; check "status: read only, says mainnet and 4663" bash -c '[ "$1" = 0 ] && grep -q "profile:  mainnet" <<<"$2" && grep -q "chain id: 4663" <<<"$2"' _ "$RC" "$OUT"
cv archive; check "archive after the conversion: reports the existing archive, does not stop or dump again" bash -c '[ "$1" = 0 ] && grep -q "already archived" <<<"$2"' _ "$RC" "$OUT"
: >"$CTL/calls"; CONVERT_NETWORK='' cv drop-testnet-db --archive "$A"; check "drop-testnet-db without the flag is refused (64)" bash -c '[ "$1" = 64 ] && ! grep -q "DROP DATABASE IF EXISTS ifso_testnet$" "$2"' _ "$RC" "$CTL/calls"
cv drop-testnet-db --archive "$A"; check "drop-testnet-db with the flag after the conversion drops ifso_testnet" bash -c '[ "$1" = 0 ] && grep -q "DROP DATABASE IF EXISTS ifso_testnet$" "$2"' _ "$RC" "$CTL/calls"

# deploy rollback on the mainnet deploy: apply passes the exit code up
lay_box; cv archive; A="$(archive_dir)"; mainnet_keys; main_rpc; echo 1 >"$CTL/deploy-rc"; ap
check "apply when ifso-deploy rolls back: exit 1 is passed up and the state has no 'converted'" bash -c '[ "$1" = 1 ] && ! grep -q "^converted=" "$2/convert-network.state"' _ "$RC" "$T/state"
rm -f "$CTL/deploy-rc"; printf 'ifso-api\nifso-worker\n' >>"$CTL/active"; ap
check "apply again after the fix (the rollback left the units running): resumes on the mainnet profile and finishes (0)" bash -c '[ "$1" = 0 ] && grep -q "resuming" <<<"$2"' _ "$RC" "$OUT"
: >"$CTL/calls"; ap
check "apply once more on the converted box: 'already converted', only ifso-deploy --check, exit 0" bash -c '[ "$1" = 0 ] && grep -q "already converted" <<<"$2" && ! grep -q "^provision" "$3" && grep -qx "deploy --check" "$3" && ! grep -q "^deploy --profile" "$3"' _ "$RC" "$OUT" "$CTL/calls"

# ---- values (Mac side) ---------------------------------------------------------------------------------------------
printf '{"chainId":4663,"commit":"%s","deployBlock":107062443,"config":{"usdg":"%s"},"contracts":{"IfsoConditionEvaluator":{"address":"%s"},"FeeRouter":{"address":"%s"},"IfsoOutcomeResolver":{"address":"%s"},"IfsoEscrow":{"address":"%s"}}}\n' \
  "$SHA" "$MUSD" "$MEVA" "$MFEE" "$MRES" "$MESC" >"$T/4663.json"
printf '{"chainId":4663,"hot":{"deployer":"%s","relayer":"%s","keeper":"%s","resolver":"%s"},"predictedContracts":{"IfsoConditionEvaluator":{"address":"%s"},"FeeRouter":{"address":"%s"},"IfsoOutcomeResolver":{"address":"%s"},"IfsoEscrow":{"address":"%s"}}}\n' \
  "$HDEP" "$HREL" "$HKEE" "$HRSV" "$MEVA" "$MFEE" "$MRES" "$MESC" >"$T/wallets.json"
cv values --deployment "$T/4663.json" --wallets "$T/wallets.json"
check "values: builds the values file from the deploy record and the wallet pack" bash -c '[ "$1" = 0 ] && grep -qx "ESCROW_ADDRESS=$3" <<<"$2" && grep -qx "EXPECT_KEEPER=$4" <<<"$2" && grep -qx "ESCROW_DEPLOY_BLOCK=107062443" <<<"$2"' _ "$RC" "$OUT" "$MESC" "$HKEE"
printf '%s\n' "$OUT" >"$T/vals.made"; lay_box; cv archive; A="$(archive_dir)"; mainnet_keys; main_rpc; cv apply --archive "$A" --values "$T/vals.made" --sha "$SHA"
check "  ... and apply accepts the file it made" test "$RC" = 0
sed 's/"IfsoEscrow":{"address":"0x[0-9a-f]*"}/"IfsoEscrow":{"address":"0x00000000000000000000000000000000000000ee"}/' "$T/4663.json" >"$T/4663.moved.json"
cv values --deployment "$T/4663.moved.json" --wallets "$T/wallets.json"
check "values: a deployed escrow that differs from the prediction is refused (64)" bash -c '[ "$1" = 64 ] && grep -q "disagree" <<<"$2"' _ "$RC" "$OUT"

# ---- the existing guards still hold ----------------------------------------------------------------------------------
check "deploy.sh still refuses to switch networks (the guard line is there and unconditional)" bash -c 'grep -q "refusing to switch networks" "$1/deploy.sh" && ! grep -q "CONVERT_NETWORK" "$1/deploy.sh"' _ "$HERE"
check "provision.sh (own-server mode) still refuses to change a profile" bash -c 'grep -q "refusing to turn it into" "$1/provision.sh"' _ "$HERE"
check "provision-cohost.sh accepts mainnet only with the flag AND a verified archive" bash -c 'grep -q "CONVERT_NETWORK" "$1/provision-cohost.sh" && grep -q "CONVERT_ARCHIVE" "$1/provision-cohost.sh" && grep -q "MANIFEST" "$1/provision-cohost.sh"' _ "$HERE"
check "convert-network.sh: shell syntax" bash -n "$CONV"
if command -v shellcheck >/dev/null 2>&1; then check "convert-network.sh: shellcheck clean" shellcheck -x "$CONV"; fi

if ((fail)); then printf '%s of %s failed\n' "$fail" "$n"; exit 1; fi
printf 'all %s passed\n' "$n"
