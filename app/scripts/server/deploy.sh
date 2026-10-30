#!/usr/bin/env bash
# Deploys one exact commit of the Ifso backend on the server prepared by provision.sh. Run ON THE SERVER as root
# (installed as /usr/local/sbin/ifso-deploy):
#
#   sudo ifso-deploy <40-hex sha>                  deploy that commit
#   sudo ifso-deploy --profile mainnet <sha>       state the network explicitly (default: /etc/ifso/profile)
#   sudo ifso-deploy --check                       health-check everything, change nothing
#   ifso-deploy --dry-run <sha>                    rehearse without root and without touching systemd (see below)
#
# Steps, in order. Everything before step 5 leaves the running release untouched, and a failure there exits 75
# ("nothing switched"): the same command can be run again.
#   1. check /etc/ifso: the files exist, no CHANGE_ME is left, CHAIN_ID matches the profile (testnet 46630, mainnet 4663),
#      NODE_ENV=production, key files are private, the first RPC answers with that chain id;
#   2. git fetch, then make sure the sha exists;
#   3. add a release directory /opt/ifso/releases/<sha> (a git worktree) and run `bun install --frozen-lockfile` there;
#   4. back up the database (/usr/local/sbin/ifso-backup) because migrations only go forward;
#   5. point /opt/ifso/current at the new release, run the migrations (`bun run db:migrate`), restart the services;
#   6. wait for GET /readyz to answer 200 and for every unit to stay active. Any failure from step 5 on puts /opt/ifso/current
#      back on the previous release, restarts the services and checks them again (exit 1 = rolled back, exit 2 = the rollback
#      failed too: the server needs a human).
# Exit codes: 0 done, 1 failed and rolled back, 2 failed and rollback failed, 64 bad usage or settings, 75 nothing switched.
#
# --dry-run: no root needed, no chown/runuser, systemctl is only logged (unless IFSO_SYSTEMCTL names a stand-in), the real
# git/bun/curl are used unless IFSO_GIT/IFSO_BUN/IFSO_CURL name stand-ins. deploy-local.test.sh drives this mode in CI.
# Paths and commands can be redirected with IFSO_ETC, IFSO_OPT, IFSO_STATE, IFSO_SYSTEMCTL, IFSO_BUN, IFSO_GIT, IFSO_CURL,
# IFSO_BACKUP_CMD, IFSO_HEALTH_URL, IFSO_HEALTH_TRIES, IFSO_HEALTH_WAIT, IFSO_SETTLE, IFSO_RETRY_WAITS, IFSO_API_USER,
# IFSO_WORKER_USER (tests only).
#
# sudo-rs note: this script reads every setting from files in /etc/ifso, never from environment variables passed through
# sudo (sudo-rs and sudo both drop most of them), so `sudo ifso-deploy <sha>` behaves the same on either.
set -euo pipefail
umask 022

ETC="${IFSO_ETC:-/etc/ifso}"
OPT="${IFSO_OPT:-/opt/ifso}"
STATE="${IFSO_STATE:-/var/lib/ifso}"
SYSTEMCTL="${IFSO_SYSTEMCTL:-systemctl}"
BUN="${IFSO_BUN:-/usr/local/bin/bun}"
GIT="${IFSO_GIT:-git}"
CURL="${IFSO_CURL:-curl}"
BACKUP_CMD="${IFSO_BACKUP_CMD:-/usr/local/sbin/ifso-backup}"
REPO="$OPT/repo"
RELEASES="$OPT/releases"
CURRENT="$OPT/current"
HEALTH_TRIES="${IFSO_HEALTH_TRIES:-30}"
HEALTH_WAIT="${IFSO_HEALTH_WAIT:-2}"
SETTLE="${IFSO_SETTLE:-10}"
KEEP_RELEASES=5
API_USER="${IFSO_API_USER:-ifso-api}"       # owner of the relayer key files
WORKER_USER="${IFSO_WORKER_USER:-ifso-worker}" # owner of the keeper and resolver key files

log() { printf '[deploy %s] %s\n' "$(date -u +%H:%M:%S)" "$*"; }
die() { printf 'deploy: %s\n' "$*" >&2; exit "${2:-64}"; }

PROFILE=""
DRY_RUN=0
CHECK_ONLY=0
SHA=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --profile) [[ $# -ge 2 ]] || die "--profile needs testnet or mainnet"; PROFILE="$2"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    --check) CHECK_ONLY=1; shift ;;
    -h | --help) sed -n '2,30p' "$0"; exit 0 ;;
    -*) die "unknown option $1 (try --help)" ;;
    *) [[ -z "$SHA" ]] || die "only one sha, got '$SHA' and '$1'"; SHA="$1"; shift ;;
  esac
done

if [[ "$CHECK_ONLY" == 0 ]]; then
  [[ "$SHA" =~ ^[0-9a-f]{40}$ ]] || die "give the full 40-character commit sha (a branch name can move, a sha cannot); got '${SHA:-nothing}'"
fi
if [[ "$DRY_RUN" == 0 ]]; then
  [[ "$(id -u)" == 0 ]] || die "run as root (sudo ifso-deploy <sha>), or use --dry-run to rehearse"
fi

# ---- small helpers -------------------------------------------------------------------------------------------------
as_ifso() { # run a command as the ifso user (as itself in --dry-run)
  if [[ "$DRY_RUN" == 1 ]]; then "$@"; else runuser -u ifso -- env HOME="$STATE" GIT_SSH_COMMAND="${GIT_SSH_COMMAND:-}" "$@"; fi
}
sysctl_() { # systemctl, or just a log line in --dry-run unless a stand-in is named
  if [[ "$DRY_RUN" == 1 && -z "${IFSO_SYSTEMCTL:-}" ]]; then log "dry-run: systemctl $*"; return 0; fi
  "$SYSTEMCTL" "$@"
}
envval() { # envval <file> <KEY>: the last KEY=value in a file, quotes stripped, without sourcing it
  local v
  [[ -r "$1" ]] || return 0
  v="$(grep -E "^$2=" "$1" | tail -1 | cut -d= -f2- || true)"
  v="${v%$'\r'}"; v="${v%\"}"; v="${v#\"}"; v="${v%\'}"; v="${v#\'}"
  printf '%s' "$v"
}
cfg() { # cfg <KEY>: from common.env, then api.env/worker.env
  local f v
  for f in common api worker; do
    v="$(envval "$ETC/$f.env" "$1")"
    [[ -z "$v" ]] || { printf '%s' "$v"; return 0; }
  done
}
retry() { # retry <what> <command...>: three tries, with waits, for network steps
  local what="$1" i=0 w
  shift
  for w in ${IFSO_RETRY_WAITS:-5 15} ""; do
    i=$((i + 1))
    if "$@"; then return 0; fi
    [[ -n "$w" ]] || break
    log "$what failed (try $i of 3), waiting ${w}s"
    sleep "$w"
  done
  return 1
}

# ---- profile and settings ------------------------------------------------------------------------------------------
[[ -n "$PROFILE" ]] || PROFILE="$(tr -d '[:space:]' <"$ETC/profile" 2>/dev/null || true)"
case "$PROFILE" in
  testnet) WANT_CHAIN=46630 ;;
  mainnet) WANT_CHAIN=4663 ;;
  *) die "profile must be testnet or mainnet (got '${PROFILE:-nothing}'): pass --profile or run provision.sh with PROFILE=..." ;;
esac
if [[ -r "$ETC/profile" && "$(tr -d '[:space:]' <"$ETC/profile")" != "$PROFILE" ]]; then
  die "this server was provisioned as '$(tr -d '[:space:]' <"$ETC/profile")', not '$PROFILE': refusing to switch networks"
fi

UNITS=(ifso-api ifso-worker)
if [[ -n "$(cfg TELEGRAM_BOT_TOKEN)" ]]; then UNITS+=(ifso-bot); fi

check_settings() {
  local f key p chain url hex got owner
  for f in common api worker db; do
    [[ -r "$ETC/$f.env" ]] || die "$ETC/$f.env is missing: run provision.sh" 64
  done
  if grep -l 'CHANGE_ME' "$ETC"/common.env "$ETC"/api.env "$ETC"/worker.env 2>/dev/null; then
    die "the files above still contain CHANGE_ME: fill them in (README step 4)"
  fi
  chain="$(cfg CHAIN_ID)"
  [[ "$chain" == "$WANT_CHAIN" ]] || die "profile $PROFILE needs CHAIN_ID=$WANT_CHAIN, the settings say '${chain:-unset}'"
  [[ "$(cfg NODE_ENV)" == production ]] || die "NODE_ENV must be production on a server"
  p="$(cfg TRUST_PROXY)"
  [[ -n "$(cfg WEB_ORIGINS)" ]] || log "warning: WEB_ORIGINS is empty in $ETC/api.env: only PUBLIC_APP_URL may call the API from a browser (CORS)"
  [[ -n "$p" && "$p" != none ]] || die "TRUST_PROXY is ${p:-unset} for the api role: set TRUST_PROXY=caddy in $ETC/api.env (behind Caddy every client would otherwise share one rate-limit bucket)"
  [[ -n "$(cfg ESCROW_ADDRESS)" ]] || die "ESCROW_ADDRESS is empty"
  for key in RELAYER KEEPER RESOLVER; do
    for f in "${key}_KEYSTORE" "${key}_PASSWORD_FILE"; do
      p="$(cfg "$f")"
      [[ -n "$p" ]] || die "$f is not set"
      [[ -f "$p" ]] || die "$f points at $p, which does not exist: copy the key file there (README step 5)"
      # shellcheck disable=SC2012
      if [[ "$(ls -ld "$p" | cut -c5-10)" != "------" ]]; then die "$p is readable by other users: chmod 600 it"; fi
      # review R2-L3: each key belongs to the one role that uses it (relayer: api; keeper, resolver: worker)
      if [[ "$key" == RELAYER ]]; then owner="$API_USER"; else owner="$WORKER_USER"; fi
      # shellcheck disable=SC2012
      got="$(ls -ld "$p" | awk '{print $3}')"
      [[ "$got" == "$owner" ]] || die "$p is owned by '$got', not $owner: run provision.sh --fix-key-perms (only the role that uses a key may read it)"
    done
  done
  url="$(cfg RHC_RPC_URLS)"
  url="${url%%,*}"
  if [[ -n "$url" ]]; then
    hex="$(printf '0x%x' "$WANT_CHAIN")"
    got="$("$CURL" -sS --max-time 10 -H 'content-type: application/json' \
      -d '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' "$url" 2>/dev/null || true)"
    [[ "$got" == *"\"$hex\""* ]] || die "the first RPC ($url) did not answer eth_chainId $hex: $got" 75
  else
    log "RHC_RPC_URLS is blank: the app's default endpoints are used (not checked here)"
  fi
}

health_url() {
  local port
  port="$(cfg PORT)"
  printf '%s' "${IFSO_HEALTH_URL:-http://127.0.0.1:${port:-8080}/readyz}"
}

units_active() { # every unit active
  local u bad=0
  for u in "${UNITS[@]}"; do
    if ! "$SYSTEMCTL" is-active --quiet "$u" 2>/dev/null; then
      if [[ "$DRY_RUN" == 1 && -z "${IFSO_SYSTEMCTL:-}" ]]; then continue; fi
      log "unit $u is not active"; bad=1
    fi
  done
  return "$bad"
}

wait_healthy() { # /readyz = 200, then the units still active after SETTLE seconds (catches a crash loop)
  local i code url
  url="$(health_url)"
  for ((i = 1; i <= HEALTH_TRIES; i++)); do
    code="$("$CURL" -s -o /dev/null -w '%{http_code}' --max-time 5 "$url" 2>/dev/null || true)"
    if [[ "$code" == 200 ]]; then break; fi
    if ((i == HEALTH_TRIES)); then log "readyz never answered 200 (last: ${code:-no answer}) at $url"; return 1; fi
    sleep "$HEALTH_WAIT"
  done
  sleep "$SETTLE"
  units_active || return 1
  code="$("$CURL" -s -o /dev/null -w '%{http_code}' --max-time 5 "$url" 2>/dev/null || true)"
  [[ "$code" == 200 ]] || { log "readyz answered ${code:-nothing} after the settle wait"; return 1; }
  return 0
}

if [[ "$CHECK_ONLY" == 1 ]]; then
  check_settings
  if wait_healthy; then log "healthy: readyz 200, ${UNITS[*]} active"; exit 0; fi
  exit 1
fi

# ---- one deploy at a time ------------------------------------------------------------------------------------------
mkdir -p "$STATE"
LOCK="$STATE/deploy.lock"
if ! mkdir "$LOCK" 2>/dev/null; then
  holder="$(cat "$LOCK/pid" 2>/dev/null || true)"
  if [[ -n "$holder" ]] && kill -0 "$holder" 2>/dev/null; then die "another deploy is running (pid $holder)" 75; fi
  log "removing a stale lock (pid ${holder:-unknown} is gone)"
  rm -rf "$LOCK"
  mkdir "$LOCK" || die "could not take the deploy lock" 75
fi
echo "$$" >"$LOCK/pid"
trap 'rm -rf "$LOCK"' EXIT

check_settings
[[ -d "$REPO/.git" || -f "$REPO/HEAD" ]] || die "$REPO is not a git clone: run provision.sh (REPO_URL) or git clone it there" 75

prev=""
if [[ -L "$CURRENT" ]]; then prev="$(basename "$(readlink "$CURRENT")")"; fi
log "profile $PROFILE (chain $WANT_CHAIN); deploying $SHA${prev:+ over $prev}"

# ---- 2. fetch ------------------------------------------------------------------------------------------------------
if [[ -n "$(as_ifso "$GIT" -C "$REPO" remote)" ]]; then
  retry "git fetch" as_ifso "$GIT" -C "$REPO" fetch --quiet --tags origin || die "git fetch failed; nothing switched" 75
else
  log "the clone has no remote: using the commits already in it"
fi
as_ifso "$GIT" -C "$REPO" cat-file -e "$SHA^{commit}" 2>/dev/null || die "commit $SHA is not in the repository (not pushed yet?); nothing switched" 75

# ---- 3. stage the release ------------------------------------------------------------------------------------------
abandon() { # abandon <sha>: remove a release that never went live
  [[ "$1" != "$prev" ]] || return 0
  as_ifso "$GIT" -C "$REPO" worktree remove --force "$RELEASES/$1" >/dev/null 2>&1 || rm -rf "${RELEASES:?}/$1"
  as_ifso "$GIT" -C "$REPO" worktree prune >/dev/null 2>&1 || true
}
install_release() {
  (cd "$RELEASES/$SHA/app" && as_ifso "$BUN" install --frozen-lockfile)
}
if [[ "$SHA" == "$prev" && -e "$RELEASES/$SHA/.healthy" ]]; then
  log "$SHA is already the current release: re-running migrations and restarting"
else
  mkdir -p "$RELEASES"
  if [[ -e "$RELEASES/$SHA" ]]; then abandon "$SHA"; fi
  as_ifso "$GIT" -C "$REPO" worktree add --detach --quiet "$RELEASES/$SHA" "$SHA" || die "could not check out $SHA; nothing switched" 75
  if ! retry "bun install" install_release; then
    abandon "$SHA"
    die "bun install --frozen-lockfile failed (is bun.lock committed with the change?); nothing switched" 75
  fi
  [[ -f "$RELEASES/$SHA/app/src/main.ts" ]] || { abandon "$SHA"; die "$SHA has no app/src/main.ts: wrong commit?; nothing switched" 75; }
fi

# ---- 4. backup (migrations only go forward) -------------------------------------------------------------------------
if [[ -x "$BACKUP_CMD" ]]; then
  "$BACKUP_CMD" >/dev/null || { abandon "$SHA"; die "the pre-deploy backup failed; nothing switched" 75; }
  log "database backed up"
elif [[ "$DRY_RUN" == 0 ]]; then
  log "WARNING: $BACKUP_CMD is missing: no backup before the migration"
fi

# ---- 5. switch, migrate, restart -----------------------------------------------------------------------------------
point() { ln -sfn "$RELEASES/$1" "$CURRENT"; }
migrate() {
  if [[ "$DRY_RUN" == 1 && -z "${IFSO_SYSTEMCTL:-}" ]]; then
    (cd "$CURRENT/app" && as_ifso "$BUN" run db:migrate)
  else
    "$SYSTEMCTL" start ifso-migrate.service
  fi
}
restart_all() { sysctl_ restart "${UNITS[@]}"; }

rollback() {
  if [[ -z "$prev" || ! -d "$RELEASES/$prev" ]]; then
    log "no previous release to go back to: the services are left as they are"
    exit 2
  fi
  log "ROLLING BACK to $prev"
  point "$prev"
  if restart_all && wait_healthy; then
    log "rolled back: $prev is live again (migrations are NOT undone; restore from /var/backups/ifso only if the data is wrong)"
    abandon "$SHA"
    exit 1
  fi
  log "ROLLBACK FAILED: $prev did not become healthy either. Look at: journalctl -u ifso-api -u ifso-worker -n 80"
  exit 2
}

point "$SHA"
log "current -> $SHA; running migrations"
migrate || { log "migrations failed"; rollback; }
log "restarting ${UNITS[*]}"
restart_all || { log "restart failed"; rollback; }
wait_healthy || { log "the new release is not healthy"; rollback; }

# ---- 6. done -------------------------------------------------------------------------------------------------------
touch "$RELEASES/$SHA/.healthy"
printf '%s\n' "$SHA" >"$STATE/current.sha"
if [[ -n "$prev" && "$prev" != "$SHA" ]]; then printf '%s\n' "$prev" >"$STATE/previous.sha"; fi

# keep the current, the previous and the newest healthy ones, KEEP_RELEASES in all; anything else goes
keep=0
# shellcheck disable=SC2012
while read -r d; do
  [[ -n "$d" ]] || continue
  if [[ "$d" == "$SHA" || "$d" == "$prev" ]]; then keep=$((keep + 1)); continue; fi
  if [[ -e "$RELEASES/$d/.healthy" && $keep -lt $KEEP_RELEASES ]]; then keep=$((keep + 1)); continue; fi
  abandon "$d"
done < <(ls -1t "$RELEASES" 2>/dev/null)
log "done: $SHA is live and healthy"
