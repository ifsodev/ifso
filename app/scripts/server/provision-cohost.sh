#!/usr/bin/env bash
# Co-host mode of provision.sh: puts the Ifso backend on a server that already runs another project's LIVE services.
# Start it through provision.sh (it hands over to this file), as root ON THE SERVER, from this folder:
#
#   bash provision.sh --cohost --check          READ ONLY. Lists what would be done, confirms ports 3201 and 6380 are free
#                                               and the other project's units are active, and stops with a FAIL line if
#                                               anything of the other project would change. Run it before AND after.
#   DOMAIN=api.<domain> bash provision.sh --cohost       the real setup (testnet; PROFILE defaults to testnet. PROFILE=mainnet
#                                               only through convert-network.sh: CONVERT_NETWORK + CONVERT_ARCHIVE)
#   DOMAIN=api.<domain> bash provision.sh --cohost --caddy-only    only the Caddy site file and the one import line
#
# The rules this mode keeps (each one has a check in deploy-local.test.sh):
#  - It never installs, upgrades, removes, restarts or reconfigures Postgres, Caddy, fail2ban, sshd, ufw, the firewall, the
#    swap, the clock or anything else that belongs to the other project. Packages: only those that are missing, simulated
#    first; if the simulation would upgrade or remove ANY package, or touch postgres/caddy/fail2ban, it stops.
#  - Caddy: /etc/caddy/Caddyfile is touched only to make sure ONE line exists, `import /etc/caddy/sites/*.caddy` (appended
#    when missing, timestamped backup first, `caddy validate` before and after, then `systemctl reload caddy`: a graceful
#    reload, never a restart). Ifso's site lives in /etc/caddy/sites/ifso.caddy (DOMAIN -> 127.0.0.1:3201).
#  - Postgres: a role `ifso` and a database `ifso_testnet` in the EXISTING cluster (connection limit on the role, no
#    extensions, no other database is read or changed). The password goes to /etc/ifso/db.env (0600).
#  - Redis: a SEPARATE instance, unit ifso-redis.service, 127.0.0.1:6380, password, maxmemory 256mb, noeviction. The default
#    redis-server unit (port 6379) that the package installs is disabled and masked, and only when this script installed it.
#  - Ports: the API on 127.0.0.1:3201, nothing else public. Users ifso-api, ifso-bot, ifso-worker, ifso-redis, ifso.
#    systemd limits (MemoryMax, CPUQuota, low CPU/IO weight, OOM score 500) on every Ifso unit.
#  - Bun 1.4.4 and cast 1.8.4 (checksum-verified) go to /opt/ifso/bin, NEVER to /usr/local/bin, where the other project may
#    keep its own Bun.
#  - Before and after, the identity of every protected unit (state, main pid, start time) is compared; a change exits 3.
#    Protected = caddy, fail2ban, ssh, postgresql@*, every unit file under /etc/systemd/system that is not ifso-*, plus
#    PROTECTED_UNITS="a.service b.service" if you name more.
# One global side effect is unavoidable: `systemctl daemon-reload` re-reads all unit files (it restarts nothing).
#
# Exit codes: 0 done, 1 a check failed (nothing of the other project was touched), 3 a protected unit changed (look now).
# Env (all optional): PROFILE (testnet only), DOMAIN (required for the real run), REPO_URL, REDIS_PKG/REDIS_BIN (default
# redis-server and its path; use REDIS_PKG=valkey-server if the release has no Redis package), PROTECTED_UNITS, PG_PORT.
# Tests only: IFSO_COHOST_TEST=1 (no root needed), IFSO_ETC, IFSO_OPT, IFSO_CADDYFILE, IFSO_CADDY_SITES, IFSO_OS_RELEASE,
# IFSO_MEMINFO; commands are looked up on PATH so a test can shadow them.
# shellcheck disable=SC2015,SC2013  # ok()/bad()/plan() always return 0; unit names never contain spaces
set -euo pipefail

BUN_VERSION="1.4.4"
FOUNDRY_VERSION="1.8.4"
API_PORT=3201
REDIS_PORT=6380
PG_PORT="${PG_PORT:-5432}"
DB_CONN_LIMIT=30

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ETC="${IFSO_ETC:-/etc/ifso}"
OPT="${IFSO_OPT:-/opt/ifso}"
CONF="$ETC/provision.conf"
KEYS_DIR="$ETC/keys"
BIN_DIR="$OPT/bin"
CADDYFILE="${IFSO_CADDYFILE:-/etc/caddy/Caddyfile}"
SITES_DIR="${IFSO_CADDY_SITES:-/etc/caddy/sites}"
IMPORT_LINE="import ${SITES_DIR}/*.caddy"
TESTMODE="${IFSO_COHOST_TEST:-0}"
REDIS_PKG="${REDIS_PKG:-redis-server}"
BASE_PKGS=(git build-essential ca-certificates curl gnupg unzip jq openssl openssh-client)
SYSD=/etc/systemd/system

log() { printf '[cohost %s] %s\n' "$(date -u +%H:%M:%S)" "$*"; }
warn() { printf '[cohost] WARNING: %s\n' "$*" >&2; }
die() { printf 'provision --cohost: %s\n' "$*" >&2; exit "${2:-1}"; }

NFAIL=0
NWARN=0
ok() { printf 'ok    %s\n' "$*"; }
bad() { printf 'FAIL  %s\n' "$*"; NFAIL=$((NFAIL + 1)); }
wrn() { printf 'warn  %s\n' "$*"; NWARN=$((NWARN + 1)); }
plan() { printf 'plan  %s\n' "$*"; }

MODE=run
case "${1:-}" in
  "") ;;
  --check) MODE=check ;;
  --caddy-only) MODE=caddy ;;
  -h | --help) sed -n '2,38p' "$0"; exit 0 ;;
  *) die "unknown argument $1 (try --help)" 64 ;;
esac
if [[ "$TESTMODE" != 1 ]]; then [[ "$(id -u)" == 0 ]] || die "run as root" 64; fi

PROFILE="${PROFILE:-testnet}"
# Mainnet in this layout exists only as the conversion of THIS testnet box (convert-network.sh, owner's choice): it needs
# CONVERT_NETWORK=testnet-to-mainnet AND CONVERT_ARCHIVE naming the testnet archive, whose MANIFEST must verify. Anything
# else stays refused, so an accidental PROFILE=mainnet never changes a box's network.
CONVERTING=0
if [[ "$PROFILE" != testnet ]]; then
  [[ "$PROFILE" == mainnet && "${CONVERT_NETWORK:-}" == testnet-to-mainnet ]] \
    || die "co-hosting is for the testnet phase only (PROFILE=testnet). To turn THIS testnet box into mainnet use convert-network.sh (CONVERT_NETWORK=testnet-to-mainnet)" 64
  arc="${CONVERT_ARCHIVE:-}"
  [[ -n "$arc" && -f "$arc/MANIFEST" && -f "$arc/ifso_testnet.dump" && -f "$arc/INFO" ]] \
    || die "PROFILE=mainnet needs CONVERT_ARCHIVE=<testnet archive dir> (MANIFEST, INFO, ifso_testnet.dump): convert-network.sh archive makes it" 64
  if command -v sha256sum >/dev/null 2>&1; then sumc=(sha256sum -c --quiet); else sumc=(shasum -a 256 -c --quiet); fi
  (cd "$arc" && "${sumc[@]}" MANIFEST) >/dev/null 2>&1 || die "the testnet archive $arc does not match its MANIFEST: refusing" 64
  grep -qx "profile=testnet" "$arc/INFO" || die "$arc/INFO does not say profile=testnet" 64
  CONVERTING=1
fi
DB_NAME="ifso_${PROFILE}"
DOMAIN="${DOMAIN:-}"
EDGE="${EDGE:-}"
[[ -z "$EDGE" || "$EDGE" == cloudflare ]] || die "EDGE must be empty or cloudflare" 64
domain_re='^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)+$'
[[ -z "$DOMAIN" || "$DOMAIN" =~ $domain_re ]] || die "DOMAIN '$DOMAIN' is not a domain name" 64
if [[ "$MODE" != check ]]; then
  [[ -n "$DOMAIN" ]] || die "set DOMAIN=api.<your-domain>: a shared Caddy needs a real site name (a catch-all would clash with the other sites)" 64
fi

# ---------------------------------------------------------------- read-only helpers
port_in_use() { ss -ltnH 2>/dev/null | awk '{print $4}' | grep -qE "[:.]$1\$"; }
pkg_installed() { dpkg-query -W -f='${Status}' "$1" 2>/dev/null | grep -q 'install ok installed'; }
psql_admin() { runuser -u postgres -- psql -X -q -v ON_ERROR_STOP=1 -p "$PG_PORT" -d postgres "$@"; }
unit_identity() { systemctl show "$1" -p ActiveState -p MainPID -p ActiveEnterTimestampMonotonic 2>/dev/null | LC_ALL=C sort | tr '\n' ' '; }
unit_active() { systemctl is-active --quiet "$1" 2>/dev/null; }
as_caddy_user() {
  local u
  u="$(systemctl show caddy -p User --value 2>/dev/null || true)"
  [[ -n "$u" ]] || u=caddy
  if [[ "$TESTMODE" == 1 ]]; then "$@"; else runuser -u "$u" -- "$@"; fi
}

PROTECTED=()
discover_protected() { # fills PROTECTED: the other project's units (read-only)
  local u frag extra
  PROTECTED=()
  while read -r u _; do
    [[ -n "$u" && "$u" == *.service && "$u" != ifso-* ]] || continue
    case "$u" in
      caddy.service | fail2ban.service | ssh.service | sshd.service | postgresql@*.service) PROTECTED+=("$u"); continue ;;
    esac
    frag="$(systemctl show "$u" -p FragmentPath --value 2>/dev/null || true)"
    [[ "$frag" == "$SYSD"/* ]] && PROTECTED+=("$u")
  done < <(systemctl list-units --type=service --state=active --no-legend --plain 2>/dev/null)
  for extra in ${PROTECTED_UNITS:-}; do
    printf '%s\n' "${PROTECTED[@]:-}" | grep -qxF "$extra" || PROTECTED+=("$extra")
  done
}
snapshot() { local u; for u in "${PROTECTED[@]}"; do printf '%s %s\n' "$u" "$(unit_identity "$u")"; done; }

# ---------------------------------------------------------------- the preflight (reads only)
preflight() {
  local osid osver avail_kb free_kb cpus u missing=() sim line pkg cand n hba ver have_ifso_state=0 own
  [[ -e "$ETC/db.env" ]] && have_ifso_state=1
  echo "--- system"
  if [[ -r "${IFSO_OS_RELEASE:-/etc/os-release}" ]]; then
    osid="$(sed -n 's/^ID=//p' "${IFSO_OS_RELEASE:-/etc/os-release}" | tr -d '"')"
    osver="$(sed -n 's/^VERSION_ID=//p' "${IFSO_OS_RELEASE:-/etc/os-release}" | tr -d '"')"
    if [[ "$osid" == ubuntu && "$osver" == 26.04 ]]; then ok "Ubuntu 26.04"
    elif [[ "$osid" == ubuntu ]]; then wrn "Ubuntu $osver (written for 26.04): package names and paths were not checked on it"
    else bad "this is ${osid:-unknown} $osver, not Ubuntu"; fi
  else bad "no /etc/os-release"; fi
  avail_kb="$(awk '/^MemAvailable:/ {print $2}' "${IFSO_MEMINFO:-/proc/meminfo}" 2>/dev/null || true)"
  avail_kb="${avail_kb:-0}"
  if ((avail_kb >= 2097152)); then ok "memory available: $((avail_kb / 1024)) MiB (Ifso's limits add up to under 2 GiB)"
  elif ((avail_kb >= 1048576)); then wrn "only $((avail_kb / 1024)) MiB of memory is available; Ifso's limits add up to 2 GiB"
  else bad "only $((avail_kb / 1024)) MiB of memory is available"; fi
  free_kb="$(df -Pk / | awk 'NR==2 {print $4}')"
  free_kb="${free_kb:-0}"
  if ((free_kb >= 10485760)); then ok "disk free: $((free_kb / 1048576)) GiB"; else bad "disk free: $((free_kb / 1048576)) GiB (need 10)"; fi
  cpus="$(nproc 2>/dev/null || echo 1)"
  ok "cpus: $cpus (Ifso's CPUQuota adds up to 3 cores at most)"
  [[ -n "$(swapon --show --noheadings 2>/dev/null || true)" ]] && ok "swap present (not touched)" || wrn "no swap on this machine (not touched: it is the other project's host)"
  command -v systemctl >/dev/null 2>&1 && ok "systemd present" || bad "systemctl not found"

  echo "--- ports (must be free)"
  for n in "$API_PORT" "$REDIS_PORT"; do
    if port_in_use "$n"; then
      own=0  # (each port by its own unit: with `a && b || c && d` a stopped ifso-api made Redis's 6380 count as foreign)
      if [[ "$n" == "$REDIS_PORT" ]] && unit_active ifso-redis.service; then own=1; fi
      if [[ "$n" == "$API_PORT" ]] && unit_active ifso-api.service; then own=1; fi
      if ((have_ifso_state && own)); then
        ok "port $n is in use by Ifso's own unit (re-run)"
      else bad "port $n is already in use"; fi
    else ok "port $n is free"; fi
  done
  plan "ports 6379 and 8080 are never used by Ifso here"

  echo "--- the other project (must be active, and stay as it is)"
  discover_protected
  if ((${#PROTECTED[@]} == 0)); then bad "no protected units found: is this the right server?"; fi
  for u in "${PROTECTED[@]}"; do
    if unit_active "$u"; then ok "protected unit $u is active"; else bad "protected unit $u is NOT active"; fi
  done
  unit_active caddy.service && ok "caddy is active (will be reloaded, never restarted)" || bad "caddy is not active"
  printf '%s\n' "${PROTECTED[@]:-}" | grep -q '^postgresql@' && ok "a postgresql@ cluster is active" || bad "no postgresql@ cluster is active"

  echo "--- postgres (the existing cluster)"
  if ver="$(psql_admin -tAc 'SHOW server_version_num' 2>/dev/null)"; then
    ok "cluster answers on port $PG_PORT, server_version_num $ver"
    if [[ "$(psql_admin -tAc "SELECT 1 FROM pg_roles WHERE rolname = 'ifso'")" == 1 ]]; then
      ((have_ifso_state)) && ok "role ifso exists and $ETC/db.env exists (re-run)" || bad "role ifso exists but $ETC/db.env does not: not created by this script, refusing to take it over"
    else plan "create role ifso (LOGIN, no superuser/createdb/createrole, connection limit $DB_CONN_LIMIT)"; fi
    if [[ "$(psql_admin -tAc "SELECT 1 FROM pg_database WHERE datname = '$DB_NAME'")" == 1 ]]; then
      ((have_ifso_state)) && ok "database $DB_NAME exists and is ours (re-run)" || bad "database $DB_NAME exists but $ETC/db.env does not: refusing to take it over"
    else plan "create database $DB_NAME owned by ifso (no other database is read or changed; no extensions)"; fi
    hba="$(psql_admin -tAc 'SHOW hba_file' 2>/dev/null || true)"
    if [[ -r "$hba" ]]; then
      grep -vE '^[[:space:]]*(#|$)' "$hba" | grep -qE '^host(ssl|nossl)?[[:space:]]+[^[:space:]]+[[:space:]]+[^[:space:]]+[[:space:]]+(127\.0\.0\.1/32|samehost)' \
        && ok "pg_hba.conf has a 127.0.0.1 rule (never edited by this script)" \
        || wrn "pg_hba.conf has no 127.0.0.1 host rule: the connection test at the end may fail (this script never edits pg_hba.conf)"
    fi
  else bad "cannot reach the Postgres cluster on port $PG_PORT as the postgres user"; fi
  command -v pg_dump >/dev/null 2>&1 && ok "pg_dump is installed (the daily backup needs it)" || bad "pg_dump is missing (postgresql-client): not installed by this mode, install the matching client yourself"

  echo "--- caddy"
  command -v caddy >/dev/null 2>&1 && ok "caddy binary: $(caddy version 2>/dev/null | head -1)" || bad "no caddy binary"
  if [[ -f "$CADDYFILE" ]]; then
    ok "$CADDYFILE exists"
    if has_import; then ok "the sites import line is already there (nothing to add)"; else plan "append ONE line to $CADDYFILE: $IMPORT_LINE (timestamped backup, validate, reload)"; fi
  else bad "$CADDYFILE does not exist"; fi
  [[ -d "$SITES_DIR" ]] && ok "$SITES_DIR exists" || plan "create $SITES_DIR (root, 0755)"
  [[ -e "$SITES_DIR/ifso.caddy" ]] && ok "ifso.caddy exists (will be refreshed)" || plan "write $SITES_DIR/ifso.caddy: ${DOMAIN:-<DOMAIN>} -> 127.0.0.1:$API_PORT"
  [[ -n "$DOMAIN" ]] || wrn "DOMAIN is not set: fine for --check, required for the real run"

  echo "--- packages (simulated; nothing is installed)"
  for pkg in "${BASE_PKGS[@]}" "$REDIS_PKG" redis-tools; do pkg_installed "$pkg" || missing+=("$pkg"); done
  cand="$(apt-cache policy "$REDIS_PKG" 2>/dev/null | sed -n 's/^ *Candidate: //p' | head -1)"
  if [[ -n "$cand" && "$cand" != "(none)" ]]; then
    ok "$REDIS_PKG candidate: $cand"
    [[ "$cand" == 7.* || "$cand" == 5:7.* || "$cand" == *:7.* ]] || wrn "$REDIS_PKG is $cand, not 7.x; BullMQ works on it, but compare with the testnet run on the Mac"
  elif pkg_installed "$REDIS_PKG"; then ok "$REDIS_PKG is already installed"
  else bad "no installable $REDIS_PKG: set REDIS_PKG (for example valkey-server) and REDIS_BIN"; fi
  if pkg_installed "$REDIS_PKG"; then plan "$REDIS_PKG already installed: its default unit is left exactly as it is"; else plan "install $REDIS_PKG (its default unit on 6379 is then disabled and masked)"; fi
  if ((${#missing[@]})); then
    plan "apt install: ${missing[*]}"
    sim="$(apt-get -s install --no-install-recommends "${missing[@]}" 2>&1 || true)"
    if grep -qE '^(Inst [^ ]+ \[|Remv |Purg )' <<<"$sim"; then
      bad "the simulation would UPGRADE or REMOVE installed packages: $(grep -E '^(Inst [^ ]+ \[|Remv |Purg )' <<<"$sim" | head -5 | tr '\n' ';')"
    else ok "the simulation installs new packages only, no upgrade, no removal"; fi
    while read -r line; do
      [[ "$line" == Inst* ]] || continue
      line="${line#Inst }"
      pkg="${line%% *}"
      if [[ "$pkg" =~ (postgres|caddy|fail2ban) ]]; then bad "the simulation would install/change $pkg"; fi
    done <<<"$sim"
  else ok "every needed package is already installed"; fi

  echo "--- users and files"
  for u in ifso ifso-api ifso-bot ifso-worker ifso-redis; do
    id "$u" >/dev/null 2>&1 && ok "user $u exists" || plan "create system user $u"
  done
  if [[ -r "$ETC/profile" && "$(tr -d '[:space:]' <"$ETC/profile")" != "$PROFILE" ]]; then
    if [[ "$CONVERTING" == 1 && "$(tr -d '[:space:]' <"$ETC/profile")" == testnet ]]; then
      plan "convert this server's Ifso profile testnet -> mainnet (archive ${CONVERT_ARCHIVE:-}; new database $DB_NAME)"
    else
      bad "this server's Ifso profile is $(tr -d '[:space:]' <"$ETC/profile"), not $PROFILE"
    fi
  fi
  [[ -e "$BIN_DIR/bun" ]] && ok "$BIN_DIR/bun exists" || plan "install Bun $BUN_VERSION and cast $FOUNDRY_VERSION into $BIN_DIR (never /usr/local/bin)"
  plan "install units: ifso-api/bot/worker (MemoryMax 512M/256M/768M, CPUQuota 100%/50%/150%), ifso-redis (448M, 50%), migrate, backup"
  plan "NOT touched: the other project's database, web server, intrusion-ban and ssh packages and configs, the firewall, kernel settings, swap, clock, log settings and automatic updates"
  if [[ -r "$ETC/cohost.protected" ]]; then
    for u in $(grep -vE '^[[:space:]]*(#|$)' "$ETC/cohost.protected"); do
      if unit_active "$u"; then :; else bad "unit $u from the earlier protected list is not active"; fi
    done
    ok "earlier protected list ($ETC/cohost.protected) checked"
  fi
  return 0
}

has_import() { grep -qE "^[[:space:]]*import[[:space:]]+${SITES_DIR}/" "$CADDYFILE" 2>/dev/null; }

# ---------------------------------------------------------------- Caddy: the site file and the one import line
caddy_env_lines() { # the environment caddy.service runs with, so `caddy validate` sees the same variables
  local f
  systemctl show caddy -p Environment --value 2>/dev/null | tr ' ' '\n' | grep -E '^[A-Za-z_][A-Za-z0-9_]*=' || true
  for f in $(systemctl show caddy -p EnvironmentFiles --value 2>/dev/null | tr ' ' '\n' | grep '^/' || true); do
    [[ -r "$f" ]] && grep -E '^[A-Za-z_][A-Za-z0-9_]*=' "$f" | tr -d '"' || true
  done
}
caddy_validate() { # caddy_validate <file>
  local envs=() l
  while IFS= read -r l; do [[ -n "$l" ]] && envs+=("$l"); done < <(caddy_env_lines)
  as_caddy_user env ${envs[@]+"${envs[@]}"} caddy validate --adapter caddyfile --config "$1" >/dev/null 2>&1
}
caddy_apply() {
  local stamp tmp cand site changed=0 backup=""
  stamp="$(date -u +%Y%m%dT%H%M%SZ)"
  [[ -f "$CADDYFILE" ]] || die "$CADDYFILE does not exist"
  [[ -d "$SITES_DIR" ]] || install -d -m 0755 "$SITES_DIR"
  site="$SITES_DIR/ifso.caddy"
  tmp="$(mktemp)"; cand="$(mktemp)"
  # shellcheck disable=SC2064
  trap "rm -f '$tmp' '$cand'" RETURN
  local tpl="$HERE/cohost/ifso.caddy"
  # EDGE=cloudflare: the API sits behind Cloudflare's proxy; the site answers Cloudflare only (cohost/ifso.cloudflare.caddy)
  [[ "${EDGE:-}" == cloudflare ]] && tpl="$HERE/cohost/ifso.cloudflare.caddy"
  sed "s/@DOMAIN@/$DOMAIN/g" "$tpl" >"$tmp"
  if ! cmp -s "$tmp" "$site"; then
    [[ -f "$site" ]] && cp -p "$site" "$site.bak.$stamp"
    install -m 0644 "$tmp" "$site"; changed=1
    log "wrote $site"
  fi
  if has_import; then
    cat "$CADDYFILE" >"$cand"
  else
    backup="$CADDYFILE.bak.$stamp"
    { cat "$CADDYFILE"; [[ -z "$(tail -c1 "$CADDYFILE")" ]] || echo; printf '\n# Added for a co-hosted project (provision.sh --cohost): one import line, nothing else.\n%s\n' "$IMPORT_LINE"; } >"$cand"
  fi
  chmod 0644 "$cand" # mktemp makes it 0600 root; validate runs as the caddy user (same content as the 0644 Caddyfile)
  if ! caddy_validate "$cand"; then
    [[ "$changed" == 1 ]] && mv -f "$site" "$site.rejected.$stamp"
    die "caddy validate rejected the configuration with the Ifso site: $CADDYFILE is unchanged, the site file was moved to $site.rejected.$stamp (try: caddy validate --adapter caddyfile --config $cand)"
  fi
  if [[ -n "$backup" ]]; then
    cp -p "$CADDYFILE" "$backup"
    cat "$cand" >"$CADDYFILE" # same file, same owner and mode
    changed=1
    log "appended the import line to $CADDYFILE (backup: $backup)"
  fi
  if [[ "$changed" == 0 ]]; then log "caddy: site file and import line already in place, no reload"; return 0; fi
  if ! systemctl reload caddy; then
    [[ -n "$backup" ]] && cat "$backup" >"$CADDYFILE"
    die "systemctl reload caddy failed: $CADDYFILE restored from ${backup:-nothing changed}; caddy keeps running its previous configuration" 1
  fi
  log "caddy reloaded gracefully (not restarted)"
}

# ---------------------------------------------------------------- mode: --check
if [[ "$MODE" == check ]]; then
  preflight
  echo "---"
  if [[ -r "$ETC/cohost.protected" ]]; then
    plan "the other project's units are compared by identity (state, pid, start time) around every real run"
  fi
  if ((NFAIL)); then printf 'CHECK FAILED: %s problem(s), %s warning(s). Nothing was changed.\n' "$NFAIL" "$NWARN"; exit 1; fi
  printf 'CHECK OK: %s warning(s). Nothing was changed. Protected units: %s\n' "$NWARN" "${PROTECTED[*]}"
  exit 0
fi

# ---------------------------------------------------------------- mode: --caddy-only
if [[ "$MODE" == caddy ]]; then
  discover_protected
  BEFORE="$(snapshot)"
  caddy_apply
  [[ "$(snapshot)" == "$BEFORE" ]] || die "a protected unit changed while the Caddy step ran" 3
  exit 0
fi

# ---------------------------------------------------------------- the real run
for f in systemd/ifso.target Caddyfile env.example backup.sh deploy.sh cohost/ifso.caddy cohost/ifso-redis.service cohost/dropins/ifso.target.conf; do
  [[ -e "$HERE/$f" ]] || die "missing $HERE/$f: run provision.sh from the app/scripts/server folder" 64
done
cd /
echo "== preflight"
preflight
if ((NFAIL)); then die "preflight failed ($NFAIL problem(s)); nothing was changed" 1; fi
BEFORE="$(snapshot)"

install -d -o root -g root -m 0711 "$ETC"
{
  echo "# The other project's units that Ifso must never disturb. Written by provision.sh --cohost; read by ifso-deploy."
  printf '%s\n' "${PROTECTED[@]}"
} >"$ETC/cohost.protected.tmp"
mv "$ETC/cohost.protected.tmp" "$ETC/cohost.protected"
chmod 0644 "$ETC/cohost.protected"

# ---- packages: only what is missing, nothing upgraded, no service restarted
export DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=l NEEDRESTART_SUSPEND=1
APT_OPTS=(-y -q -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold --no-upgrade --no-install-recommends)
missing=()
redis_preinstalled=0
pkg_installed "$REDIS_PKG" && redis_preinstalled=1
for p in "${BASE_PKGS[@]}" "$REDIS_PKG" redis-tools; do pkg_installed "$p" || missing+=("$p"); done
if ((${#missing[@]})); then
  log "apt update, then install only: ${missing[*]}"
  apt-get update -q
  sim="$(apt-get -s install "${APT_OPTS[@]}" "${missing[@]}" 2>&1 || true)"
  if grep -qE '^(Inst [^ ]+ \[|Remv |Purg )' <<<"$sim" || grep -E '^Inst ' <<<"$sim" | grep -qE ' (postgres|caddy|fail2ban)'; then
    die "the package list changed since the preflight and would now upgrade/remove something: stopped before installing"
  fi
  RC_D=/usr/sbin/policy-rc.d
  made_policy=0
  if [[ ! -e "$RC_D" ]]; then printf '#!/bin/sh\nexit 101\n' >"$RC_D"; chmod 0755 "$RC_D"; made_policy=1; fi
  rc=0
  apt-get install "${APT_OPTS[@]}" "${missing[@]}" || rc=$?
  ((made_policy == 0)) || rm -f "$RC_D"
  ((rc == 0)) || die "apt-get install failed (exit $rc)"
fi
if ((redis_preinstalled == 0)); then
  # We just installed the package: its default instance (6379) is not wanted. Nothing else was using it.
  systemctl disable redis-server.service >/dev/null 2>&1 || true
  if unit_active redis-server.service; then systemctl stop redis-server.service; fi
  systemctl mask redis-server.service >/dev/null 2>&1 || true
  log "the package's default redis-server unit (6379) is disabled and masked; Ifso uses ifso-redis on $REDIS_PORT"
fi
REDIS_BIN="${REDIS_BIN:-$(command -v "$REDIS_PKG" || command -v redis-server || true)}"
[[ -x "$REDIS_BIN" ]] || die "cannot find the $REDIS_PKG binary (set REDIS_BIN)"
redis_ver="$("$REDIS_BIN" --version | sed -n 's/.* v=\([0-9.]*\).*/\1/p')"
log "redis binary $REDIS_BIN, version ${redis_ver:-unknown}"

# ---- users and directories
for u in ifso-api ifso-bot ifso-worker ifso-redis; do
  id "$u" >/dev/null 2>&1 || { log "creating the $u system user"; useradd --system --user-group --home-dir "/var/lib/$u" --no-create-home --shell /usr/sbin/nologin "$u"; }
done
id ifso >/dev/null 2>&1 || { log "creating the ifso system user"; useradd --system --user-group --home-dir /var/lib/ifso --create-home --shell /usr/sbin/nologin ifso; }
install -d -o ifso -g ifso -m 0750 /var/lib/ifso
install -d -o ifso -g ifso -m 0755 "$OPT" "$OPT/releases"
install -d -o root -g root -m 0755 "$BIN_DIR"
install -d -o root -g root -m 0700 /var/backups/ifso
install -d -o root -g root -m 0711 "$KEYS_DIR"
git config --system --get-all safe.directory | grep -qxF "$OPT/repo" || git config --system --add safe.directory "$OPT/repo"
printf '%s\n' "$PROFILE" >"$ETC/profile"
: >"$ETC/cohost"
umask 077
{
  echo "# Written by provision.sh --cohost; read by provision.sh and ifso-backup."
  printf 'PROFILE=%q\nDOMAIN=%q\nREPO_URL=%q\nDB_NAME=%q\nCOHOST=1\n' "$PROFILE" "$DOMAIN" "${REPO_URL:-}" "$DB_NAME"
} >"$CONF"
umask 022
chmod 0600 "$CONF"; chmod 0644 "$ETC/cohost"

ensure_keys() { # only the role that uses a key can read it
  local f owner
  for f in "$KEYS_DIR"/*; do
    [[ -f "$f" ]] || continue
    case "$(basename "$f")" in
      relayer.json | relayer.password) owner=ifso-api ;;
      keeper.json | keeper.password | resolver.json | resolver.password) owner=ifso-worker ;;
      *.json | *.password) owner=root; warn "$f is not a key name this server knows (relayer, keeper, resolver): readable by root only" ;;
      *) warn "$f is not a .json keystore or .password file: left as it is"; continue ;;
    esac
    chown "$owner:$owner" "$f"; chmod 0600 "$f"
  done
}
ensure_keys

# ---- Bun and cast, pinned and checksum-verified, in /opt/ifso/bin only
install_bun() {
  if [[ -x "$BIN_DIR/bun" && "$("$BIN_DIR/bun" --version 2>/dev/null)" == "$BUN_VERSION" ]]; then log "bun $BUN_VERSION already in $BIN_DIR"; return; fi
  local asset tmp base
  case "$(uname -m)" in
    x86_64) asset=bun-linux-x64; grep -qw avx2 /proc/cpuinfo || asset=bun-linux-x64-baseline ;;
    aarch64 | arm64) asset=bun-linux-aarch64 ;;
    *) die "no Bun build for $(uname -m)" ;;
  esac
  log "installing bun $BUN_VERSION ($asset) into $BIN_DIR"
  tmp="$(mktemp -d)"
  base="https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}"
  curl -fsSL --retry 3 -o "$tmp/$asset.zip" "$base/$asset.zip"
  curl -fsSL --retry 3 -o "$tmp/SHASUMS256.txt" "$base/SHASUMS256.txt"
  (cd "$tmp" && grep -E " \*?${asset}\.zip\$" SHASUMS256.txt | sha256sum -c --quiet -) || die "bun download does not match SHASUMS256.txt"
  unzip -q "$tmp/$asset.zip" -d "$tmp"
  install -m 0755 "$tmp/$asset/bun" "$BIN_DIR/bun"
  rm -rf "$tmp"
  [[ "$("$BIN_DIR/bun" --version)" == "$BUN_VERSION" ]] || die "bun --version is not $BUN_VERSION after install"
}
install_cast() {
  if [[ -x "$BIN_DIR/cast" ]] && "$BIN_DIR/cast" --version 2>/dev/null | grep -qF "$FOUNDRY_VERSION"; then log "cast $FOUNDRY_VERSION already in $BIN_DIR"; return; fi
  local arch tmp url
  case "$(uname -m)" in
    x86_64) arch=amd64 ;;
    aarch64 | arm64) arch=arm64 ;;
    *) die "no Foundry build for $(uname -m)" ;;
  esac
  url="https://github.com/foundry-rs/foundry/releases/download/v${FOUNDRY_VERSION}/foundry_v${FOUNDRY_VERSION}_linux_${arch}.tar.gz"
  log "installing cast $FOUNDRY_VERSION into $BIN_DIR"
  tmp="$(mktemp -d)"
  if curl -fsSL --retry 3 -o "$tmp/foundry.tar.gz" "$url" && tar -xzf "$tmp/foundry.tar.gz" -C "$tmp" cast; then
    install -m 0755 "$tmp/cast" "$BIN_DIR/cast"
  else rm -rf "$tmp"; die "could not install cast from $url"; fi
  rm -rf "$tmp"
}
install_bun
install_cast

# ---- Postgres: a role and a database in the existing cluster, nothing else
db_password=""
redis_password=""
if [[ -f "$ETC/db.env" ]]; then
  db_password="$(sed -n 's#^DATABASE_URL=postgres://ifso:\([^@]*\)@.*#\1#p' "$ETC/db.env" | tail -1)"
  redis_password="$(sed -n 's#^REDIS_URL=redis://:\([^@]*\)@.*#\1#p' "$ETC/db.env" | tail -1)"
fi
[[ -n "$db_password" ]] || db_password="$(openssl rand -hex 24)"
[[ -n "$redis_password" ]] || redis_password="$(openssl rand -hex 24)"
[[ "$(psql_admin -tAc "SELECT 1 FROM pg_roles WHERE rolname = 'ifso'")" == 1 ]] \
  || psql_admin -c "CREATE ROLE ifso LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION CONNECTION LIMIT $DB_CONN_LIMIT"
# The password goes through stdin, never through a command line.
printf "ALTER ROLE ifso WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION CONNECTION LIMIT %s PASSWORD '%s';\n" "$DB_CONN_LIMIT" "$db_password" | psql_admin
[[ "$(psql_admin -tAc "SELECT 1 FROM pg_database WHERE datname = '$DB_NAME'")" == 1 ]] || runuser -u postgres -- createdb -p "$PG_PORT" --owner=ifso "$DB_NAME"
psql_admin -c "REVOKE ALL ON DATABASE $DB_NAME FROM PUBLIC"
psql_admin -c "GRANT CONNECT ON DATABASE $DB_NAME TO ifso"

# ---- Redis: our own instance
install -d -o root -g root -m 0711 "$ETC"
umask 077
{
  echo "# Written by provision.sh --cohost. Ifso's own Redis instance. Mode 0640 root:ifso-redis."
  echo "bind 127.0.0.1"
  echo "port $REDIS_PORT"
  echo "protected-mode yes"
  echo "requirepass $redis_password"
  echo "maxmemory 256mb"
  echo "maxmemory-policy noeviction"
  echo "appendonly yes"
  echo "appendfsync everysec"
  echo 'save ""'
  echo "dir /var/lib/ifso-redis"
  echo "daemonize no"
  echo 'logfile ""'
} >"$ETC/redis.conf.tmp"
umask 022
mv "$ETC/redis.conf.tmp" "$ETC/redis.conf"
chown root:ifso-redis "$ETC/redis.conf"; chmod 0640 "$ETC/redis.conf"

umask 077
{
  echo "# Written by provision.sh --cohost. Read by systemd (as root) for every ifso unit. Do not commit or copy."
  echo "DATABASE_URL=postgres://ifso:${db_password}@127.0.0.1:${PG_PORT}/${DB_NAME}"
  echo "REDIS_URL=redis://:${redis_password}@127.0.0.1:${REDIS_PORT}"
} >"$ETC/db.env.tmp"
mv "$ETC/db.env.tmp" "$ETC/db.env"
umask 022
chown root:root "$ETC/db.env"; chmod 0600 "$ETC/db.env"

# the connection test uses a throwaway password file, never a command line or the environment
pgpass="$(mktemp)"
printf '127.0.0.1:%s:%s:ifso:%s\n' "$PG_PORT" "$DB_NAME" "$db_password" >"$pgpass"; chmod 0600 "$pgpass"
if [[ "$(PGPASSFILE="$pgpass" psql -X -h 127.0.0.1 -p "$PG_PORT" -U ifso -d "$DB_NAME" -tAc 'SELECT 1' 2>/dev/null || true)" == 1 ]]; then
  log "role ifso connects to $DB_NAME over 127.0.0.1"
else
  rm -f "$pgpass"
  die "role ifso cannot log in over 127.0.0.1:$PG_PORT (pg_hba.conf?). This script never edits pg_hba.conf: add one scram rule for role ifso and database $DB_NAME yourself, reload Postgres with pg_ctlcluster/pg_reload_conf (a reload, not a restart), then run this again."
fi
rm -f "$pgpass"
unset db_password

# ---- /etc/ifso/{common,api,worker,bot}.env
split_env() {
  awk -v want="$1" '
    /^# \[section: / { s = $3; sub(/\]$/, "", s); on = (s == want); next }
    on { print }
  ' "$HERE/env.example"
}
umask 077
for role in common api worker; do
  if [[ ! -e "$ETC/$role.env" ]]; then
    { echo "# Ifso $role settings. Written by provision.sh from env.example. Mode 0600, root only."; split_env "$role"; } >"$ETC/$role.env"
    log "wrote $ETC/$role.env"
  fi
done
[[ -e "$ETC/bot.env" ]] || printf '# Settings for ifso-bot only (optional). Shared ones live in common.env.\n' >"$ETC/bot.env"
if grep -q '^PORT=' "$ETC/api.env"; then sed -i "s/^PORT=.*/PORT=$API_PORT/" "$ETC/api.env"; else echo "PORT=$API_PORT" >>"$ETC/api.env"; fi
if grep -q '^HOST=' "$ETC/api.env"; then sed -i 's/^HOST=.*/HOST=127.0.0.1/' "$ETC/api.env"; else echo "HOST=127.0.0.1" >>"$ETC/api.env"; fi
if grep -q '^IP_HASH_SALT=CHANGE_ME$' "$ETC/api.env"; then
  sed -i "s/^IP_HASH_SALT=CHANGE_ME\$/IP_HASH_SALT=$(openssl rand -hex 32)/" "$ETC/api.env"
  log "generated IP_HASH_SALT in api.env"
fi
chown root:root "$ETC"/*.env; chmod 0600 "$ETC"/*.env
umask 022
unset redis_password

# ---- deploy key and repo
if [[ ! -e /var/lib/ifso/.ssh/id_ed25519 ]]; then
  install -d -o ifso -g ifso -m 0700 /var/lib/ifso/.ssh
  runuser -u ifso -- ssh-keygen -q -t ed25519 -N '' -C "ifso-deploy@$(hostname)" -f /var/lib/ifso/.ssh/id_ed25519
  log "created a deploy key"
fi
cat >/var/lib/ifso/.ssh/config <<'EOF'
# Written by provision.sh --cohost: the ifso user pulls the repo with its own deploy key.
Host *
  IdentityFile /var/lib/ifso/.ssh/id_ed25519
  IdentitiesOnly yes
  BatchMode yes
  StrictHostKeyChecking accept-new
EOF
chown ifso:ifso /var/lib/ifso/.ssh/config; chmod 0600 /var/lib/ifso/.ssh/config
if [[ ! -d "$OPT/repo/.git" ]]; then
  if [[ -n "${REPO_URL:-}" ]]; then
    runuser -u ifso -- git clone --quiet "$REPO_URL" "$OPT/repo" || warn "clone failed: add the deploy key (printed below), then run: runuser -u ifso -- git clone <url> $OPT/repo"
  else
    runuser -u ifso -- git init --quiet "$OPT/repo"
    warn "no REPO_URL: created an empty $OPT/repo; add the remote (README step 3)"
  fi
fi

# ---- systemd units, limits, scripts
install_units() {
  local f d
  for f in "$HERE"/systemd/*.service "$HERE"/systemd/*.target "$HERE"/systemd/*.timer; do
    cmp -s "$f" "$SYSD/$(basename "$f")" || install -m 0644 "$f" "$SYSD/$(basename "$f")"
  done
  sed "s#@REDIS_BIN@#$REDIS_BIN#" "$HERE/cohost/ifso-redis.service" >"$SYSD/ifso-redis.service.new"
  chmod 0644 "$SYSD/ifso-redis.service.new"; mv "$SYSD/ifso-redis.service.new" "$SYSD/ifso-redis.service"
  for f in "$HERE"/cohost/dropins/*.conf; do
    d="$SYSD/$(basename "$f" .conf).d"
    install -d -m 0755 "$d"
    install -m 0644 "$f" "$d/10-cohost.conf"
  done
  cmp -s "$HERE/backup.sh" /usr/local/sbin/ifso-backup || install -m 0755 "$HERE/backup.sh" /usr/local/sbin/ifso-backup
  cmp -s "$HERE/deploy.sh" /usr/local/sbin/ifso-deploy || install -m 0755 "$HERE/deploy.sh" /usr/local/sbin/ifso-deploy
  systemctl daemon-reload
  systemctl enable --quiet ifso.target ifso-api.service ifso-worker.service ifso-bot.service
  systemctl enable --now --quiet ifso-redis.service || die "ifso-redis did not start"
  systemctl enable --now --quiet ifso-backup.timer || die "could not enable the backup timer"
  log "systemd units installed with co-host limits"
}
install_units

# ---- Redis answers on its own port, with its password, and nothing answers Ifso's password on 6379
for _ in $(seq 1 20); do port_in_use "$REDIS_PORT" && break; sleep 1; done
port_in_use "$REDIS_PORT" || die "ifso-redis is not listening on $REDIS_PORT: journalctl -u ifso-redis -n 40"
rpass="$(sed -n 's/^requirepass //p' "$ETC/redis.conf")"
if command -v redis-cli >/dev/null 2>&1; then
  [[ "$(REDISCLI_AUTH="$rpass" redis-cli -h 127.0.0.1 -p "$REDIS_PORT" ping 2>/dev/null || true)" == PONG ]] || die "redis-cli ping on $REDIS_PORT did not answer PONG"
  log "ifso-redis answers PONG on 127.0.0.1:$REDIS_PORT"
fi
unset rpass

# ---- Caddy
caddy_apply

# ---- the other project must be exactly as it was
AFTER="$(snapshot)"
if [[ "$AFTER" != "$BEFORE" ]]; then
  printf 'PROTECTED UNITS CHANGED:\n--- before\n%s\n--- after\n%s\n' "$BEFORE" "$AFTER" >&2
  exit 3
fi
log "the other project's ${#PROTECTED[@]} protected units are unchanged (state, pid, start time)"

cat <<MSG

provision --cohost: done ($PROFILE).
  Services   ifso-api (127.0.0.1:$API_PORT), ifso-bot, ifso-worker, with MemoryMax and CPUQuota; installed, not started until the first deploy
  Postgres   database $DB_NAME, role ifso (connection limit $DB_CONN_LIMIT), in the existing cluster; Redis ifso-redis on 127.0.0.1:$REDIS_PORT (both in /etc/ifso/db.env, 0600)
  Caddy      https://$DOMAIN -> 127.0.0.1:$API_PORT  (/etc/caddy/sites/ifso.caddy; the DNS A record must point at this server, grey cloud)
  Deploy key add this PUBLIC key as a read-only deploy key on the git host:
$(cat /var/lib/ifso/.ssh/id_ed25519.pub)
Next: docs/runbooks/cohost-setup.md, then ifso-deploy <sha>.
MSG
