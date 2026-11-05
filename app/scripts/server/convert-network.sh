#!/usr/bin/env bash
# Turns THIS server from the testnet profile into the mainnet one, keeping the box (the owner's choice: reuse the testnet
# server instead of buying a new one). Written for the co-host layout provision.sh --cohost made (API 127.0.0.1:3201,
# Ifso's own Redis on 6380, Bun in /opt/ifso/bin, a database in the existing Postgres cluster, the Caddy site file
# /etc/caddy/sites/ifso.caddy). Nothing else on the box changes: no package, no Caddy edit, no unit file, no firewall.
# Run as root ON THE SERVER, from this folder (it calls ./provision.sh), in two steps with a pause between them:
#
#   CONVERT_NETWORK=testnet-to-mainnet bash convert-network.sh archive
#       Stops ifso-api, ifso-worker and ifso-bot, then archives into /var/backups/ifso/testnet-archive-<stamp>/ (root,
#       0700): the testnet database (pg_dump custom format, checked with pg_restore --list, plus a row count per table),
#       a snapshot of Ifso's Redis, /etc/ifso without the keys (etc-ifso.tar), the release runner's paths.conf, the Caddy
#       site file, and the three testnet bot keys, which are MOVED out of /etc/ifso/keys (testnet keys must never run on
#       mainnet). Then empties Ifso's own Redis (queued testnet jobs must never run on mainnet). Writes INFO and a sha256
#       MANIFEST. Changes no setting: the profile is still testnet. Prints ARCHIVE=<dir>.
#       Between the steps the owner copies the six mainnet key files into /etc/ifso/keys (mainnet-go.md).
#   CONVERT_NETWORK=testnet-to-mainnet bash convert-network.sh apply --archive <dir> --values <file> --sha <40-hex sha>
#       Proves the archive again (MANIFEST, pg_restore --list, a full restore into a scratch database whose row counts
#       must equal the archive's, then the scratch database is dropped); checks the values file (public settings only,
#       made by the `values` step below), that a chain-4663 RPC has code at every contract in it, and that the three
#       keystores in /etc/ifso/keys are exactly the mainnet hot wallets it names. Only then: provision.sh --cohost with
#       PROFILE=mainnet (a new, empty database ifso_mainnet, /etc/ifso/profile = mainnet; the Redis and Caddy site stay),
#       the network settings rewritten in common.env, api.env and worker.env (every other line kept as it was, the secrets
#       and ZERODEV_PROJECT_ID included; no testnet contract address may be left), the release runner's API_URL pointed at
#       the API's real port, `ifso-deploy --profile mainnet <sha>`, then `ifso-deploy --check`, the Caddy site unchanged
#       and valid, and `ifso-release-status`. The testnet database stays in the cluster, untouched, until drop-testnet-db.
#   bash convert-network.sh values --deployment <contracts/deployments/4663.json> --wallets <mainnet-addresses.json>
#       ON THE MAC: prints the values file for `apply` (public addresses and settings only). Refuses when the deployed
#       addresses differ from the predicted ones.
#   bash convert-network.sh status                         read only
#   CONVERT_NETWORK=testnet-to-mainnet bash convert-network.sh drop-testnet-db --archive <dir>
#       After mainnet is live and the archive is copied off the box: drops the database ifso_testnet (asks nothing else).
#
# The network guards stay: deploy.sh still refuses `--profile mainnet` on a testnet box, provision.sh still refuses to
# change a profile, and provision.sh --cohost accepts PROFILE=mainnet ONLY with CONVERT_NETWORK=testnet-to-mainnet AND
# CONVERT_ARCHIVE naming an archive whose MANIFEST verifies (this script passes both).
# Exit codes: 0 done, 1 failed after a change (read the last lines), 64 refused (bad usage, flag, values or state;
# nothing changed), 75 stopped before changing anything (fix and run the same command again).
# Tests only: IFSO_CONVERT_TEST=1 (no root), IFSO_ETC, IFSO_STATE, IFSO_BACKUPS, IFSO_RELEASE_ETC, IFSO_CADDY_SITES,
# IFSO_PROVISION_CMD, IFSO_DEPLOY_CMD, IFSO_RELEASE_STATUS, IFSO_CURL, IFSO_CAST, IFSO_SYSTEMCTL; other commands come from PATH.
set -euo pipefail
umask 077

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ETC="${IFSO_ETC:-/etc/ifso}"
STATE="${IFSO_STATE:-/var/lib/ifso}"
BACKUPS="${IFSO_BACKUPS:-/var/backups/ifso}"
REL_ETC="${IFSO_RELEASE_ETC:-/etc/ifso-release}"
SITES="${IFSO_CADDY_SITES:-/etc/caddy/sites}"
DEPLOY_CMD="${IFSO_DEPLOY_CMD:-/usr/local/sbin/ifso-deploy}"
RELEASE_STATUS="${IFSO_RELEASE_STATUS:-/usr/local/sbin/ifso-release-status}"
CURL="${IFSO_CURL:-curl}"
CAST="${IFSO_CAST:-/opt/ifso/bin/cast}"
SYSTEMCTL="${IFSO_SYSTEMCTL:-systemctl}"
TESTMODE="${IFSO_CONVERT_TEST:-0}"
FLAG_WANT="testnet-to-mainnet"
CONVERT_STATE="$STATE/convert-network.state"
MAINNET_CHAIN=4663
TESTNET_CHAIN=46630
DEFAULT_MAINNET_RPC="https://rpc.mainnet.chain.robinhood.com"
APP_UNITS=(ifso-api ifso-worker ifso-bot)

log() { printf '[convert %s] %s\n' "$(date -u +%H:%M:%S)" "$*"; }
die() { printf 'convert-network: %s\n' "$*" >&2; exit "${2:-64}"; }

# ---- small helpers -------------------------------------------------------------------------------------------------
envval() { # envval <file> <KEY>: the last KEY=value in a file, quotes stripped, never sourced
  local v
  [[ -r "$1" ]] || return 0
  v="$(grep -E "^$2=" "$1" | tail -1 | cut -d= -f2- || true)"
  v="${v%$'\r'}"; v="${v%\"}"; v="${v#\"}"; v="${v%\'}"; v="${v#\'}"
  printf '%s' "$v"
}
cfg() { local f v; for f in common api worker; do v="$(envval "$ETC/$f.env" "$1")"; [[ -z "$v" ]] || { printf '%s' "$v"; return 0; }; done; }
profile_now() { tr -d '[:space:]' <"$ETC/profile" 2>/dev/null || true; }
state_get() { [[ -r "$CONVERT_STATE" ]] && sed -n "s/^$1=//p" "$CONVERT_STATE" | tail -1 || true; }
state_set() { mkdir -p "$STATE"; printf '%s=%s\n' "$1" "$2" >>"$CONVERT_STATE"; chmod 0600 "$CONVERT_STATE"; }
sha_check() { # sha_check <manifest> (run inside the archive dir)
  if command -v sha256sum >/dev/null 2>&1; then sha256sum -c --quiet "$1"; else shasum -a 256 -c --quiet "$1"; fi
}
sha_of() { if command -v sha256sum >/dev/null 2>&1; then sha256sum "$@"; else shasum -a 256 "$@"; fi; }
db_url() { envval "$ETC/db.env" DATABASE_URL; }
db_name_of() { local u="${1%%\?*}"; printf '%s' "${u##*/}"; }
pg_port() { local u="${1#*@}"; u="${u%%/*}"; [[ "$u" == *:* ]] && printf '%s' "${u##*:}" || printf 5432; }
psql_admin() { PGOPTIONS='-c client_min_messages=warning' runuser -u postgres -- psql -X -q -v ON_ERROR_STOP=1 -p "$PGPORT" -d postgres "$@"; }
psql_db() { local d="$1"; shift; runuser -u postgres -- psql -X -q -v ON_ERROR_STOP=1 -p "$PGPORT" -d "$d" "$@"; }
row_counts() { # row_counts <db>: "schema.table<TAB>rows", sorted; every user table, the migrations table included
  local d="$1" t
  while read -r t; do
    [[ -n "$t" ]] || continue
    printf '%s\t%s\n' "$t" "$(psql_db "$d" -tAc "SELECT count(*) FROM $t")"
  done < <(psql_db "$d" -tAc "SELECT quote_ident(schemaname) || '.' || quote_ident(relname) FROM pg_stat_user_tables ORDER BY 1") | LC_ALL=C sort
}
unit_active() { "$SYSTEMCTL" is-active --quiet "$1" 2>/dev/null; }
need_flag() {
  [[ "${CONVERT_NETWORK:-}" == "$FLAG_WANT" ]] || die "refusing: this changes the server's network. Set CONVERT_NETWORK=$FLAG_WANT to confirm (owner only; got '${CONVERT_NETWORK:-nothing}')" 64
}
need_root() { [[ "$TESTMODE" == 1 || "$(id -u)" == 0 ]] || die "run as root" 64; }
release_runner_quiet() { # the release runner must not be able to deploy while the network changes
  [[ -d "$REL_ETC" ]] || return 0
  [[ ! -e "$REL_ETC/ALLOW_REAL_DEPLOY" ]] || die "the release runner is ARMED ($REL_ETC/ALLOW_REAL_DEPLOY): disarm it first (rm the file); nothing changed" 64
  if unit_active ifso-release.timer || unit_active ifso-release.service; then
    die "the release runner timer or a pass is active: sudo ifso-release-pause, systemctl disable --now ifso-release.timer; nothing changed" 64
  fi
}
redis_parts() { # sets RPASS RPORT from db.env REDIS_URL (redis://:<pass>@127.0.0.1:<port>)
  local u
  u="$(envval "$ETC/db.env" REDIS_URL)"
  RPASS="$(sed -n 's#^redis://:\([^@]*\)@.*#\1#p' <<<"$u")"
  RPORT="$(sed -n 's#^redis://[^@]*@[^:/]*:\([0-9]*\).*#\1#p' <<<"$u")"
}
verify_archive() { # verify_archive <dir>: MANIFEST, INFO says testnet, the dump lists. Exit 64 on any doubt.
  local a="$1"
  [[ -d "$a" && -f "$a/MANIFEST" && -f "$a/INFO" && -f "$a/ifso_testnet.dump" ]] || die "$a is not a testnet archive (MANIFEST, INFO, ifso_testnet.dump): run the archive step first" 64
  (cd "$a" && sha_check MANIFEST) >/dev/null 2>&1 || die "the archive $a does not match its MANIFEST (a file changed or is missing): refusing" 64
  grep -qx "profile=testnet" "$a/INFO" || die "$a/INFO does not say profile=testnet" 64
  pg_restore --list "$a/ifso_testnet.dump" >/dev/null 2>&1 || die "pg_restore cannot read $a/ifso_testnet.dump: refusing" 64
}

# ---- the values file (public settings only) --------------------------------------------------------------------------
# Written into the env files:
WRITE_KEYS=(CHAIN_ID ESCROW_ADDRESS EVALUATOR_ADDRESS RESOLVER_ADDRESS FEE_ROUTER_ADDRESS USDG_ADDRESS ESCROW_DEPLOY_BLOCK
  INTERNAL_ADDRESSES RHC_RPC_URLS RHC_WS_URL MIN_RESOLVER_USDG MIN_RELAYER_ETH MIN_KEEPER_ETH MIN_RESOLVER_ETH KEEPER_SHADOW
  ALERTS_ARMED CONFIRMATIONS PUBLIC_APP_URL WEB_ORIGINS TRUST_PROXY OPS_CHAT_ID)
# Checked, never written: the mainnet hot wallets the keystores must hold.
CHECK_KEYS=(EXPECT_RELAYER EXPECT_KEEPER EXPECT_RESOLVER_WALLET)
REQUIRED_KEYS=(CHAIN_ID ESCROW_ADDRESS EVALUATOR_ADDRESS RESOLVER_ADDRESS FEE_ROUTER_ADDRESS USDG_ADDRESS ESCROW_DEPLOY_BLOCK
  INTERNAL_ADDRESSES EXPECT_RELAYER EXPECT_KEEPER EXPECT_RESOLVER_WALLET)
ADDRESS_KEYS=(ESCROW_ADDRESS EVALUATOR_ADDRESS RESOLVER_ADDRESS FEE_ROUTER_ADDRESS USDG_ADDRESS EXPECT_RELAYER EXPECT_KEEPER EXPECT_RESOLVER_WALLET)
API_ONLY_KEYS=(WEB_ORIGINS TRUST_PROXY)
in_list() { local x="$1"; shift; local y; for y in "$@"; do [[ "$x" == "$y" ]] && return 0; done; return 1; }
# values live in VAL_<KEY> variables (no associative arrays: the tests also run on the Mac's bash 3.2)
vhas() { local n="VALSET_$1"; [[ -n "${!n:-}" ]]; }
vget() { local n="VAL_$1"; printf '%s' "${!n:-}"; }
vset() { printf -v "VAL_$1" '%s' "$2"; printf -v "VALSET_$1" 1; }
NVAL=0
read_values() { # read_values <file>: fills VAL, refuses anything that is not a known public setting
  local f="$1" line k v n=0
  [[ -f "$f" && -r "$f" ]] || die "values file $f not found" 64
  while IFS= read -r line || [[ -n "$line" ]]; do
    n=$((n + 1))
    line="${line%$'\r'}"
    [[ -z "$line" || "$line" == \#* ]] && continue
    [[ "$line" =~ ^([A-Z][A-Z0-9_]*)=(.*)$ ]] || die "values line $n is not KEY=value" 64
    k="${BASH_REMATCH[1]}"; v="${BASH_REMATCH[2]}"
    in_list "$k" "${WRITE_KEYS[@]}" "${CHECK_KEYS[@]}" || die "values line $n: $k is not a public network setting this step writes (secrets are never in the values file; they stay as they are on the server)" 64
    [[ "$v" =~ ^[A-Za-z0-9.,:/_@=+-]*$ ]] || die "values line $n: $k has characters a public setting never has (quotes, spaces, \$, backslash)" 64
    ! vhas "$k" || die "values line $n: $k is given twice" 64
    vset "$k" "$v"; NVAL=$((NVAL + 1))
  done <"$f"
  for k in "${REQUIRED_KEYS[@]}"; do [[ -n "$(vget "$k")" ]] || die "values file: $k is missing or empty" 64; done
  [[ "$(vget CHAIN_ID)" == "$MAINNET_CHAIN" ]] || die "values file: CHAIN_ID must be $MAINNET_CHAIN (got $(vget CHAIN_ID))" 64
  for k in "${ADDRESS_KEYS[@]}"; do [[ "$(vget "$k")" =~ ^0x[0-9a-fA-F]{40}$ ]] || die "values file: $k is not an address" 64; done
  [[ "$(vget ESCROW_DEPLOY_BLOCK)" =~ ^[1-9][0-9]*$ ]] || die "values file: ESCROW_DEPLOY_BLOCK must be the deploy block (a positive number)" 64
  local a
  IFS=, read -r -a _ia <<<"$(vget INTERNAL_ADDRESSES)"
  for a in "${_ia[@]}"; do [[ "$a" =~ ^0x[0-9a-fA-F]{40}$ ]] || die "values file: INTERNAL_ADDRESSES has '$a', not an address" 64; done
  if vhas TRUST_PROXY; then [[ "$(vget TRUST_PROXY)" =~ ^(caddy|cloudflare)$ ]] || die "values file: TRUST_PROXY must be caddy or cloudflare" 64; fi
  return 0
}

rpc_call() { # rpc_call <url> <method> <params json>: the raw JSON answer
  "$CURL" -sS --max-time 15 -H 'content-type: application/json' \
    -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"$2\",\"params\":$3}" "$1" 2>/dev/null || true
}
check_chain() { # contracts must exist on a chain-4663 RPC before any setting changes
  local url hex got k
  url="$(vget RHC_RPC_URLS)"; url="${url%%,*}"; [[ -n "$url" ]] || url="$DEFAULT_MAINNET_RPC"
  hex="$(printf '0x%x' "$MAINNET_CHAIN")"
  got="$(rpc_call "$url" eth_chainId '[]')"
  [[ "$got" == *"\"$hex\""* ]] || die "the RPC $url did not answer eth_chainId $hex (got: ${got:-nothing}); nothing changed" 75
  for k in ESCROW_ADDRESS EVALUATOR_ADDRESS RESOLVER_ADDRESS FEE_ROUTER_ADDRESS USDG_ADDRESS; do
    got="$(rpc_call "$url" eth_getCode "[\"$(vget "$k")\",\"latest\"]")"
    [[ "$got" == *'"result":"0x'[0-9a-fA-F]* ]] || die "the RPC $url has no code at $k $(vget "$k") (deploy the contracts and run PostDeployCheck first; got: ${got:0:80}); nothing changed" 75
  done
  log "chain $MAINNET_CHAIN at $url: code at the escrow, evaluator, resolver, fee router and USDG"
}
check_keys() { # the three keystores must be the mainnet hot wallets named in the values file
  local who file want got missing=()
  for who in relayer keeper resolver; do
    for file in "$ETC/keys/$who.json" "$ETC/keys/$who.password"; do [[ -f "$file" ]] || missing+=("$(basename "$file")"); done
  done
  if ((${#missing[@]})); then
    die "missing in $ETC/keys: ${missing[*]}. The owner copies the mainnet key files in (mainnet-go.md, section 'Bot keys'): nothing changed" 75
  fi
  for who in relayer keeper resolver; do
    case "$who" in relayer) want="$(vget EXPECT_RELAYER)" ;; keeper) want="$(vget EXPECT_KEEPER)" ;; resolver) want="$(vget EXPECT_RESOLVER_WALLET)" ;; esac
    # cast decrypts the keystore with its password file in memory and prints only the address (Foundry keystores carry
    # no address field); nothing secret is printed or written
    got="$("$CAST" wallet address --keystore "$ETC/keys/$who.json" --password-file "$ETC/keys/$who.password" 2>/dev/null || true)"
    got="$(tr 'A-F' 'a-f' <<<"${got#0x}")"; want="$(tr 'A-F' 'a-f' <<<"${want#0x}")"
    [[ "$got" =~ ^[0-9a-f]{40}$ ]] || die "cannot read the address of $ETC/keys/$who.json with its password file ($CAST wallet address): a wrong password file, or not a keystore; nothing changed" 64
    [[ "$got" == "$want" ]] || die "$ETC/keys/$who.json holds 0x$got, not the mainnet $who 0x$want (a testnet key?): nothing changed" 64
  done
  log "keys: relayer, keeper and resolver keystores are the mainnet hot wallets of the values file"
}

set_key() { # set_key <file> <KEY> <value>: replace every KEY= line, or append one; same owner and mode
  local f="$1" k="$2" v="$3" tmp
  tmp="$(mktemp "$f.XXXXXX")"
  awk -v k="$k" -v line="$k=$v" 'BEGIN { done = 0 } index($0, k "=") == 1 { print line; done = 1; next } { print } END { if (!done) print line }' "$f" >"$tmp"
  chmod 0600 "$tmp"; [[ "$TESTMODE" == 1 ]] || chown root:root "$tmp"
  mv -f "$tmp" "$f"
}
rewrite_env() {
  local k f placed
  for k in "${WRITE_KEYS[@]}"; do
    vhas "$k" || continue
    placed=0
    for f in common api worker; do
      if grep -qE "^$k=" "$ETC/$f.env"; then set_key "$ETC/$f.env" "$k" "$(vget "$k")"; placed=1; fi
    done
    if [[ "$placed" == 0 ]]; then
      if in_list "$k" "${API_ONLY_KEYS[@]}"; then set_key "$ETC/api.env" "$k" "$(vget "$k")"; else set_key "$ETC/common.env" "$k" "$(vget "$k")"; fi
    fi
  done
  # mainnet feeds are built into the app: the testnet mock feeds must go
  for f in common api worker; do if grep -qE '^TESTNET_FEEDS=' "$ETC/$f.env"; then set_key "$ETC/$f.env" TESTNET_FEEDS ""; fi; done
  log "settings rewritten: $NVAL values (${WRITE_KEYS[*]:0:8} ...); secrets, ZERODEV_PROJECT_ID and every other line kept"
}
no_testnet_address_left() { # every contract address of the archived testnet settings must be gone from the new ones
  local a="$1" tmp k v bad=0
  tmp="$(mktemp -d)"
  tar -xf "$a/etc-ifso.tar" -C "$tmp" 2>/dev/null || { rm -rf "$tmp"; die "cannot read $a/etc-ifso.tar" 1; }
  for k in ESCROW_ADDRESS EVALUATOR_ADDRESS RESOLVER_ADDRESS FEE_ROUTER_ADDRESS USDG_ADDRESS TESTNET_FEEDS; do
    for v in $(cat "$tmp"/*/common.env "$tmp"/*/api.env "$tmp"/*/worker.env "$tmp"/common.env "$tmp"/api.env "$tmp"/worker.env 2>/dev/null | sed -n "s/^$k=//p" | tr ',' '\n' | grep -oiE '0x[0-9a-f]{40}' | sort -u); do
      if grep -qiF "$v" "$ETC/common.env" "$ETC/api.env" "$ETC/worker.env"; then log "a testnet address ($k) is still in the settings"; bad=1; fi
    done
  done
  rm -rf "$tmp"
  [[ "$bad" == 0 ]] || die "testnet contract addresses are still in /etc/ifso/*.env: the services stay stopped; fix the env files by hand, then run apply again" 1
}

# ---- mode: values (on the Mac) -------------------------------------------------------------------------------------
mode_values() {
  local dep="" wal="" k pred got
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --deployment) dep="${2:-}"; shift 2 ;;
      --wallets) wal="${2:-}"; shift 2 ;;
      *) die "values: unknown argument $1" 64 ;;
    esac
  done
  [[ -f "$dep" && -f "$wal" ]] || die "usage: convert-network.sh values --deployment <deployments/4663.json> --wallets <mainnet-addresses.json>" 64
  command -v jq >/dev/null || die "values: jq is needed" 64
  [[ "$(jq -r '.chainId' "$dep")" == "$MAINNET_CHAIN" && "$(jq -r '.chainId' "$wal")" == "$MAINNET_CHAIN" ]] || die "values: both files must be chain $MAINNET_CHAIN" 64
  for k in IfsoConditionEvaluator FeeRouter IfsoOutcomeResolver IfsoEscrow; do
    got="$(jq -r ".contracts.$k.address // empty" "$dep")"; pred="$(jq -r ".predictedContracts.$k.address // empty" "$wal")"
    [[ -n "$got" && "$(tr 'A-F' 'a-f' <<<"$got")" == "$(tr 'A-F' 'a-f' <<<"$pred")" ]] || die "values: $k deployed at '${got:-?}', predicted '${pred:-?}': STOP, the record and the wallet pack disagree" 64
  done
  # shellcheck disable=SC2329
  d() { jq -r "$1" "$dep"; }
  # shellcheck disable=SC2329
  w() { jq -r "$1" "$wal"; }
  cat <<VALUES
# Mainnet values for convert-network.sh apply. Public addresses and settings only: no secret is ever in this file.
# From $(basename "$dep") (commit $(d .commit), deploy block $(d .deployBlock)) and $(basename "$wal").
CHAIN_ID=$MAINNET_CHAIN
ESCROW_ADDRESS=$(d .contracts.IfsoEscrow.address)
EVALUATOR_ADDRESS=$(d .contracts.IfsoConditionEvaluator.address)
RESOLVER_ADDRESS=$(d .contracts.IfsoOutcomeResolver.address)
FEE_ROUTER_ADDRESS=$(d .contracts.FeeRouter.address)
USDG_ADDRESS=$(d '.config.usdg // empty')
ESCROW_DEPLOY_BLOCK=$(d .deployBlock)
INTERNAL_ADDRESSES=$(w '[.hot.deployer, .hot.relayer, .hot.keeper, .hot.resolver] | join(",")')
RHC_RPC_URLS=
RHC_WS_URL=
MIN_RESOLVER_USDG=200
KEEPER_SHADOW=
WEB_ORIGINS=https://ifso.tech,https://www.ifso.tech
TRUST_PROXY=cloudflare
EXPECT_RELAYER=$(w .hot.relayer)
EXPECT_KEEPER=$(w .hot.keeper)
EXPECT_RESOLVER_WALLET=$(w .hot.resolver)
VALUES
}

# ---- mode: status (read only) --------------------------------------------------------------------------------------
mode_status() {
  local u
  echo "profile:  $(profile_now)"
  echo "chain id: $(cfg CHAIN_ID)"
  echo "database: $(db_name_of "$(db_url)")"
  echo "co-host:  $([[ -e "$ETC/cohost" ]] && echo yes || echo no)"
  echo "convert:  $(if [[ -r "$CONVERT_STATE" ]]; then tr '\n' ' ' <"$CONVERT_STATE"; else echo "not started"; fi)"
  for u in "${APP_UNITS[@]}" ifso-redis caddy; do echo "unit:     $u $("$SYSTEMCTL" is-active "$u" 2>/dev/null || true)"; done
  if [[ -d "$REL_ETC" ]]; then echo "runner:   $([[ -e "$REL_ETC/ALLOW_REAL_DEPLOY" ]] && echo ARMED || echo "not armed"), API_URL $(envval "$REL_ETC/paths.conf" API_URL)"; fi
}

# ---- mode: archive -------------------------------------------------------------------------------------------------
mode_archive() {
  [[ $# == 0 ]] || die "archive takes no arguments" 64
  need_flag; need_root
  local prev a stamp db url u sha
  prev="$(state_get archived)"
  if [[ -n "$prev" && -d "$prev" ]]; then log "already archived: ARCHIVE=$prev"; echo "ARCHIVE=$prev"; exit 0; fi
  [[ "$(profile_now)" == testnet ]] || die "this server's profile is '$(profile_now)', not testnet: nothing to archive" 64
  [[ "$(cfg CHAIN_ID)" == "$TESTNET_CHAIN" ]] || die "CHAIN_ID is '$(cfg CHAIN_ID)', not $TESTNET_CHAIN: refusing" 64
  url="$(db_url)"; db="$(db_name_of "$url")"; PGPORT="$(pg_port "$url")"
  [[ "$db" == ifso_testnet ]] || die "db.env names database '$db', not ifso_testnet: refusing" 64
  release_runner_quiet
  [[ "$(psql_admin -tAc "SELECT 1 FROM pg_database WHERE datname = 'ifso_testnet'")" == 1 ]] || die "database ifso_testnet does not exist" 64

  stamp="$(date -u +%Y%m%dT%H%M%SZ)"
  a="$BACKUPS/testnet-archive-$stamp"
  install -d -m 0700 "$BACKUPS" "$a" "$a/keys"
  log "archive: $a"

  # 1. stop the app (api first: no new request is accepted while the worker finishes its tick)
  for u in "${APP_UNITS[@]}"; do "$SYSTEMCTL" stop "$u" || die "systemctl stop $u failed: look at it, then run archive again" 1; done
  for u in "${APP_UNITS[@]}"; do ! unit_active "$u" || die "$u is still active after stop" 1; done
  log "stopped: ${APP_UNITS[*]} (testnet is now offline)"

  # 2. database
  runuser -u postgres -- pg_dump -p "$PGPORT" --format=custom --compress=6 --no-password ifso_testnet >"$a/ifso_testnet.dump.partial" \
    || die "pg_dump failed: the services are stopped, nothing else changed; start them with systemctl start ${APP_UNITS[*]}" 1
  pg_restore --list "$a/ifso_testnet.dump.partial" >/dev/null || die "pg_restore cannot list the dump: not an archive" 1
  mv "$a/ifso_testnet.dump.partial" "$a/ifso_testnet.dump"
  row_counts ifso_testnet >"$a/db-rows.tsv"
  log "database: ifso_testnet dumped ($(wc -c <"$a/ifso_testnet.dump" | tr -d ' ') bytes, $(wc -l <"$a/db-rows.tsv" | tr -d ' ') tables)"

  # 3. Ifso's Redis: snapshot, then emptied below once the archive is complete
  redis_parts
  if [[ -n "$RPORT" ]] && command -v redis-cli >/dev/null 2>&1; then
    REDISCLI_AUTH="$RPASS" redis-cli -h 127.0.0.1 -p "$RPORT" --no-auth-warning --rdb "$a/redis.rdb" >/dev/null 2>&1 \
      || die "redis snapshot failed (port $RPORT): services stopped, nothing else changed" 1
  else
    die "cannot snapshot Redis (no REDIS_URL port in db.env, or no redis-cli)" 1
  fi

  # 4. settings, runner paths, the Caddy site: copies (secrets stay inside this 0700 directory)
  tar -cf "$a/etc-ifso.tar" -C "$(dirname "$ETC")" --exclude "$(basename "$ETC")/keys" "$(basename "$ETC")"
  [[ -f "$REL_ETC/paths.conf" ]] && cp -p "$REL_ETC/paths.conf" "$a/release-paths.conf"
  [[ -f "$SITES/ifso.caddy" ]] && cp -p "$SITES/ifso.caddy" "$a/ifso.caddy"

  # 5. the testnet bot keys leave /etc/ifso/keys
  for u in "$ETC"/keys/*; do [[ -e "$u" ]] && mv "$u" "$a/keys/"; done
  log "testnet keys moved to $a/keys ($(find "$a/keys" -type f | wc -l | tr -d ' ') files); $ETC/keys is empty"

  # 6. INFO + MANIFEST, then check it
  sha="$(cat "$STATE/current.sha" 2>/dev/null || true)"
  {
    echo "profile=testnet"
    echo "chain_id=$(cfg CHAIN_ID)"
    echo "database=ifso_testnet"
    echo "release=${sha:-unknown}"
    echo "created=$stamp"
    echo "host=$(hostname 2>/dev/null || echo unknown)"
  } >"$a/INFO"
  (cd "$a" && find . -type f ! -name 'MANIFEST*' | sed 's#^\./##' | LC_ALL=C sort | while read -r f; do sha_of "$f"; done >MANIFEST.tmp && mv MANIFEST.tmp MANIFEST)
  (cd "$a" && sha_check MANIFEST) || die "the MANIFEST does not verify right after writing it" 1
  chmod -R go-rwx "$a"

  # 7. empty Ifso's own Redis (its jobs are testnet jobs)
  REDISCLI_AUTH="$RPASS" redis-cli -h 127.0.0.1 -p "$RPORT" --no-auth-warning FLUSHALL >/dev/null || die "redis FLUSHALL failed" 1
  log "Ifso's Redis on $RPORT emptied (snapshot in the archive)"
  state_set archived "$a"
  log "done. Next: the owner copies the six mainnet key files into $ETC/keys, then: CONVERT_NETWORK=$FLAG_WANT bash convert-network.sh apply --archive $a --values <file> --sha <sha>"
  echo "ARCHIVE=$a"
}

# ---- restore proof: the dump restores into a scratch database with the same row counts -------------------------------
restore_check() {
  local a="$1" scratch="ifso_testnet_restorecheck"
  psql_admin -c "DROP DATABASE IF EXISTS $scratch" >/dev/null
  psql_admin -c "CREATE DATABASE $scratch" >/dev/null
  # the dump is read by root and fed on stdin: the archive is root 0700, the postgres user cannot open it
  if ! runuser -u postgres -- pg_restore -p "$PGPORT" --no-owner --exit-on-error -d "$scratch" <"$a/ifso_testnet.dump" >/dev/null 2>&1; then
    psql_admin -c "DROP DATABASE IF EXISTS $scratch" >/dev/null
    die "the testnet dump does not restore into a scratch database: refusing (nothing changed)" 64
  fi
  if ! diff -q <(row_counts "$scratch") "$a/db-rows.tsv" >/dev/null; then
    psql_admin -c "DROP DATABASE IF EXISTS $scratch" >/dev/null
    die "the restored row counts differ from the archive's db-rows.tsv: refusing (nothing changed)" 64
  fi
  psql_admin -c "DROP DATABASE $scratch" >/dev/null
  log "restore proof: the dump restored into $scratch with the same row counts in $(wc -l <"$a/db-rows.tsv" | tr -d ' ') tables (scratch database dropped)"
}

# ---- mode: apply ---------------------------------------------------------------------------------------------------
mode_apply() {
  local a="" vf="" sha="" u site_before site_after domain edge port prof url
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --archive) a="${2:-}"; shift 2 ;;
      --values) vf="${2:-}"; shift 2 ;;
      --sha) sha="${2:-}"; shift 2 ;;
      *) die "apply: unknown argument $1" 64 ;;
    esac
  done
  need_flag; need_root
  [[ -n "$a" && -n "$vf" ]] || die "usage: apply --archive <dir> --values <file> --sha <40-hex sha>" 64
  [[ "$sha" =~ ^[0-9a-f]{40}$ ]] || die "--sha must be the full 40-character commit sha to deploy (got '${sha:-nothing}')" 64
  [[ -e "$ETC/cohost" ]] || die "this conversion is written for the co-host layout (/etc/ifso/cohost); this server has another layout" 64
  a="$(cd "$a" 2>/dev/null && pwd)" || die "archive directory not found" 64
  [[ "$(state_get archived)" == "$a" ]] || die "the archive step of THIS server recorded '$(state_get archived)', not $a: run archive first, or name its directory" 64
  if [[ -n "$(state_get converted)" ]]; then
    log "already converted ($(state_get converted)): nothing to do; checking health"
    "$DEPLOY_CMD" --check || die "ifso-deploy --check failed" 1
    exit 0
  fi
  prof="$(profile_now)"
  if [[ "$prof" != testnet ]]; then
    [[ "$prof" == mainnet && -n "$(state_get provisioned)" ]] || die "profile is '$prof' and this conversion did not provision it: refusing" 64
    log "resuming: the profile is already mainnet (provisioned by this conversion)"
  fi
  url="$(db_url)"; PGPORT="$(pg_port "$url")"

  # --- everything below up to the provision step only reads (exit 64/75 = nothing changed)
  verify_archive "$a"
  read_values "$vf"
  release_runner_quiet
  if [[ "$prof" == testnet ]]; then
    # still testnet: the app must be down (archive stopped it). On a resume (mainnet profile after a failed deploy) a
    # rollback may have started the units again on the mainnet settings, which is fine.
    for u in "${APP_UNITS[@]}"; do ! unit_active "$u" || die "$u is running: the archive step stops the app; run it (or stop $u) first" 64; done
    restore_check "$a"
  fi
  check_chain
  check_keys
  site_before="$(sha_of "$SITES/ifso.caddy" 2>/dev/null | cut -d' ' -f1 || true)"
  domain="$(sed -n 's/^DOMAIN=//p' "$ETC/provision.conf" 2>/dev/null | tail -1 | tr -d "'\"")"
  [[ -n "$domain" ]] || die "no DOMAIN in $ETC/provision.conf" 64
  edge=""; grep -q 'not_cloudflare' "$SITES/ifso.caddy" 2>/dev/null && edge=cloudflare

  # --- 1. provision mainnet in the same layout (new database ifso_mainnet, profile mainnet)
  log "provision.sh --cohost with PROFILE=mainnet (DOMAIN $domain${edge:+, EDGE $edge})"
  if [[ -n "${IFSO_PROVISION_CMD:-}" ]]; then
    local pcmd; read -r -a pcmd <<<"$IFSO_PROVISION_CMD"
    env CONVERT_NETWORK="$FLAG_WANT" CONVERT_ARCHIVE="$a" PROFILE=mainnet DOMAIN="$domain" EDGE="$edge" "${pcmd[@]}" --cohost || die "provision failed (exit $?): read its output above; the app stays stopped" 1
  else
    env CONVERT_NETWORK="$FLAG_WANT" CONVERT_ARCHIVE="$a" PROFILE=mainnet DOMAIN="$domain" EDGE="$edge" bash "$HERE/provision.sh" --cohost || die "provision failed (exit $?): read its output above; the app stays stopped" 1
  fi
  [[ "$(profile_now)" == mainnet ]] || die "provision finished but $ETC/profile is not mainnet" 1
  [[ "$(db_name_of "$(db_url)")" == ifso_mainnet ]] || die "provision finished but db.env does not name ifso_mainnet" 1
  [[ -n "$(state_get provisioned)" ]] || state_set provisioned "$(date -u +%Y%m%dT%H%M%SZ)"
  [[ "$(psql_db ifso_mainnet -tAc "SELECT count(*) FROM pg_stat_user_tables")" == 0 || -n "$(state_get deployed)" ]] \
    || log "note: ifso_mainnet already has tables (a re-run after a failed deploy?)"

  # --- 2. the network settings
  rewrite_env
  [[ "$(cfg CHAIN_ID)" == "$MAINNET_CHAIN" ]] || die "CHAIN_ID is not $MAINNET_CHAIN after the rewrite" 1
  [[ -z "$(cfg TESTNET_FEEDS)" ]] || die "TESTNET_FEEDS is still set after the rewrite" 1
  no_testnet_address_left "$a"
  log "no testnet contract address is left in common.env, api.env, worker.env"

  # --- 3. the release runner: unarmed, timer off, its post-release check pointed at the API's real port
  port="$(cfg PORT)"
  if [[ -f "$REL_ETC/paths.conf" ]]; then
    if [[ "$(envval "$REL_ETC/paths.conf" API_URL)" != "http://127.0.0.1:${port:-8080}" ]]; then
      cp -p "$REL_ETC/paths.conf" "$REL_ETC/paths.conf.bak.$(date -u +%Y%m%dT%H%M%SZ)"
      set_key "$REL_ETC/paths.conf" API_URL "http://127.0.0.1:${port:-8080}"
      chmod 0644 "$REL_ETC/paths.conf"
      log "release runner: API_URL -> http://127.0.0.1:${port:-8080} (it pointed at another port)"
    fi
  fi

  # --- 4. deploy, then the checks
  log "ifso-deploy --profile mainnet $sha"
  "$DEPLOY_CMD" --profile mainnet "$sha" || { u=$?; die "ifso-deploy exit $u (75 = nothing switched, fix and run apply again; 1 = rolled back; 2 = needs a human)" "$u"; }
  state_set deployed "$sha"
  "$DEPLOY_CMD" --check || die "ifso-deploy --check failed right after the deploy" 1
  site_after="$(sha_of "$SITES/ifso.caddy" 2>/dev/null | cut -d' ' -f1 || true)"
  [[ "$site_before" == "$site_after" ]] || die "the Caddy site file changed during the conversion (it must not)" 1
  unit_active caddy || die "caddy is not active" 1
  if [[ "$TESTMODE" != 1 ]] && command -v caddy >/dev/null 2>&1; then
    runuser -u caddy -- env DOMAIN="$domain" caddy validate --adapter caddyfile --config /etc/caddy/Caddyfile >/dev/null 2>&1 || die "caddy validate fails on /etc/caddy/Caddyfile" 1
    log "caddy: active, site file unchanged, the whole Caddyfile validates"
  fi
  if [[ -x "$RELEASE_STATUS" ]]; then
    local st
    st="$("$RELEASE_STATUS" 2>&1)" || die "ifso-release-status failed: $st" 1
    grep -q "NOT armed" <<<"$st" || die "ifso-release-status does not say 'NOT armed'" 1
    log "release runner: status OK, NOT armed, timer $(grep -m1 'timer enabled' <<<"$st" | awk '{print $NF}')"
  fi
  state_set converted "$(date -u +%Y%m%dT%H%M%SZ)"
  log "database ifso_mainnet tables and rows: $(row_counts ifso_mainnet | awk -F'\t' '{printf "%s=%s ", $1, $2}')"
  log "done: this server is mainnet (chain $MAINNET_CHAIN), $sha live. The testnet archive is $a; ifso_testnet is still in the cluster (drop-testnet-db later)."
}

# ---- mode: drop-testnet-db -----------------------------------------------------------------------------------------
mode_drop() {
  local a=""
  [[ "${1:-}" == --archive ]] && a="${2:-}"
  need_flag; need_root
  [[ -n "$(state_get converted)" ]] || die "the conversion is not finished on this server: refusing" 64
  [[ -n "$a" ]] || die "usage: drop-testnet-db --archive <dir>" 64
  a="$(cd "$a" && pwd)"
  [[ "$(state_get archived)" == "$a" ]] || die "that is not this server's archive" 64
  PGPORT="$(pg_port "$(db_url)")"
  verify_archive "$a"
  psql_admin -c "DROP DATABASE IF EXISTS ifso_testnet"
  state_set dropped_testnet_db "$(date -u +%Y%m%dT%H%M%SZ)"
  log "dropped ifso_testnet (the archive $a keeps it)"
}

MODE="${1:-}"
[[ $# -gt 0 ]] && shift
case "$MODE" in
  archive) mode_archive "$@" ;;
  apply) mode_apply "$@" ;;
  values) mode_values "$@" ;;
  status) mode_status ;;
  drop-testnet-db) mode_drop "$@" ;;
  -h | --help) sed -n '2,42p' "$0" ;;
  *) die "usage: convert-network.sh archive | apply --archive <dir> --values <file> --sha <sha> | values ... | status | drop-testnet-db (try --help)" 64 ;;
esac
