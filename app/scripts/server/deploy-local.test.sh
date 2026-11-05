#!/usr/bin/env bash
# Proves deploy.sh without a server: --dry-run mode, a throwaway git repo, a fake systemctl, a fake bun and a fake curl, all
# inside a temp directory. It never touches /etc, /opt, systemd, the network or ssh, and it can run in CI:
#   bash app/scripts/server/deploy-local.test.sh
# shellcheck disable=SC2016  # the bash -c snippets below are single-quoted on purpose
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY="$HERE/deploy.sh"
T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT
mkdir -p "$T/bin" "$T/etc/keys" "$T/opt" "$T/state" "$T/ctl"
export IFSO_ETC="$T/etc" IFSO_OPT="$T/opt" IFSO_STATE="$T/state"
export IFSO_SYSTEMCTL="$T/bin/systemctl" IFSO_BUN="$T/bin/bun" IFSO_CURL="$T/bin/curl"
export IFSO_HEALTH_TRIES=2 IFSO_HEALTH_WAIT=0 IFSO_SETTLE=0 IFSO_RETRY_WAITS="0 0"
ME="$(id -un)"
export IFSO_API_USER="$ME" IFSO_WORKER_USER="$ME" # key owners: the test user stands in for ifso-api and ifso-worker
unset IFSO_BACKUP_CMD

# --- fakes. Behaviour switches are files in $T/ctl so each case can set them.
cat >"$T/bin/systemctl" <<FAKE
#!/usr/bin/env bash
echo "systemctl \$*" >>"$T/ctl/calls"
case "\$1" in
  start) [[ "\$2" == ifso-migrate.service && -e "$T/ctl/fail-migrate" ]] && exit 1 ;;
  restart) [[ -e "$T/ctl/prot-bump" ]] && echo "\$RANDOM\$RANDOM" >"$T/ctl/prot-pid"; [[ -e "$T/ctl/fail-restart" ]] && exit 1 ;;
  is-active) [[ -e "$T/ctl/inactive" ]] && exit 3
    [[ -e "$T/ctl/inactive-unit" && "\${@: -1}" == "\$(cat "$T/ctl/inactive-unit")" ]] && exit 3 ;;
  show) printf 'ActiveState=active\nMainPID=%s\nActiveEnterTimestampMonotonic=5\n' "\$(cat "$T/ctl/prot-pid" 2>/dev/null || echo 100)" ;;
esac
exit 0
FAKE
cat >"$T/bin/bun" <<FAKE
#!/usr/bin/env bash
echo "bun \$* (in \$(basename "\$(dirname "\$PWD")"))" >>"$T/ctl/calls"
[[ "\$1" == install && -e "$T/ctl/fail-install" ]] && exit 1
[[ "\$1" == run && -e "$T/ctl/fail-migrate" ]] && exit 1
exit 0
FAKE
cat >"$T/bin/curl" <<FAKE
#!/usr/bin/env bash
# JSON-RPC probe (has -d): answer the chain id of the profile. Health probe: status from ctl/ready-code (default 200),
# and "bad-after-switch:<sha>" makes readyz fail only while that release is current.
for a in "\$@"; do
  if [[ "\$a" == -d ]]; then printf '{"jsonrpc":"2.0","id":1,"result":"%s"}' "\$(cat "$T/ctl/chain-hex")"; exit 0; fi
done
cur="\$(basename "\$(readlink "$T/opt/current" 2>/dev/null)")"
if [[ -e "$T/ctl/bad-release" && "\$cur" == "\$(cat "$T/ctl/bad-release")" ]]; then printf 503; exit 0; fi
if [[ -e "$T/ctl/always-503" ]]; then printf 503; exit 0; fi
printf 200
FAKE
chmod +x "$T/bin/"*

# --- a throwaway repo with a "remote": three commits that each contain app/ with a lockfile
SRC="$T/src"; mkdir -p "$SRC/app/src"
git -C "$SRC" init -q -b main
gc() { git -C "$SRC" -c user.name=t -c user.email=t@t -c commit.gpgsign=false "$@"; }
commit() { echo "$1" >"$SRC/app/src/main.ts"; echo "$1" >"$SRC/app/bun.lock"; gc add -A; gc commit -q -m "$1"; git -C "$SRC" rev-parse HEAD; }
S1="$(commit one)"; S2="$(commit two)"; S3="$(commit three)"; S4="$(commit four)"
git clone -q "$SRC" "$T/opt/repo"
git -C "$T/opt/repo" config user.name t; git -C "$T/opt/repo" config user.email t@t
mkdir -p "$T/opt/releases"

# --- settings (testnet): no secrets, only file shapes
write_env() { # write_env <chain id> <hex>
  printf 'NODE_ENV=production\nCHAIN_ID=%s\nESCROW_ADDRESS=0x%040d\nRHC_RPC_URLS=https://rpc.invalid.test\nTELEGRAM_BOT_TOKEN=\n' "$1" 1 >"$T/etc/common.env"
  printf 'PORT=8080\nTRUST_PROXY=caddy\nRELAYER_KEYSTORE=%s/keys/relayer.json\nRELAYER_PASSWORD_FILE=%s/keys/relayer.password\n' "$T/etc" "$T/etc" >"$T/etc/api.env"
  printf 'RESOLVER_ADDRESS=0x%040d\nKEEPER_KEYSTORE=%s/keys/keeper.json\nKEEPER_PASSWORD_FILE=%s/keys/keeper.password\nRESOLVER_KEYSTORE=%s/keys/resolver.json\nRESOLVER_PASSWORD_FILE=%s/keys/resolver.password\n' 2 "$T/etc" "$T/etc" "$T/etc" "$T/etc" >"$T/etc/worker.env"
  printf 'DATABASE_URL=postgres://x\n' >"$T/etc/db.env"
  printf '%s' "$2" >"$T/ctl/chain-hex"
}
for k in relayer keeper resolver; do echo x >"$T/etc/keys/$k.json"; echo x >"$T/etc/keys/$k.password"; chmod 600 "$T/etc/keys/$k."*; done
write_env 46630 0xb626
echo testnet >"$T/etc/profile"

fail=0; n=0
check() { local name="$1"; shift; n=$((n + 1)); if "$@"; then printf 'ok   %s\n' "$name"; else printf 'FAIL %s\n' "$name"; fail=$((fail + 1)); fi; }
run() { OUT="$(bash "$DEPLOY" --dry-run "$@" 2>&1)"; RC=$?; }
cur() { basename "$(readlink "$T/opt/current" 2>/dev/null)"; }
calls() { cat "$T/ctl/calls" 2>/dev/null; }
reset() { rm -f "$T"/ctl/*; echo 0xb626 >"$T/ctl/chain-hex"; : >"$T/ctl/calls"; }
has() { grep -q -- "$1" <<<"$2"; }
lacks() { ! grep -q -- "$1" <<<"$2"; }
reset

# --- argument and settings checks
run "main"; check "a branch name is refused (64)" test "$RC" = 64
run "abc1234"; check "a short sha is refused (64)" test "$RC" = 64
run; check "no sha is refused (64)" test "$RC" = 64
run --profile mainnet "$S1"; check "mainnet profile on a testnet server is refused (64)" test "$RC" = 64
sed -i.bak 's/CHAIN_ID=46630/CHAIN_ID=4663/' "$T/etc/common.env"
run "$S1"; check "profile testnet with CHAIN_ID=4663 is refused (64)" test "$RC" = 64
check "  ... and says why" has "needs CHAIN_ID=46630" "$OUT"
write_env 46630 0xb626
echo "ESCROW_ADDRESS=CHANGE_ME" >>"$T/etc/common.env"
run "$S1"; check "a CHANGE_ME left in the settings is refused (64)" test "$RC" = 64
write_env 46630 0xb626
chmod 644 "$T/etc/keys/keeper.password"
run "$S1"; check "a world-readable key file is refused (64)" test "$RC" = 64
chmod 600 "$T/etc/keys/keeper.password"
sed -i.bak '/^TRUST_PROXY=/d' "$T/etc/api.env"
run "$S1"; check "TRUST_PROXY unset for the api role in production is refused (64)" test "$RC" = 64
check "  ... and says why" has "TRUST_PROXY is unset" "$OUT"
echo "TRUST_PROXY=none" >>"$T/etc/api.env"
run "$S1"; check "TRUST_PROXY=none in production is refused (64)" test "$RC" = 64
write_env 46630 0xb626
IFSO_WORKER_USER=ifso-worker-not-me run "$S1"; check "a keeper/resolver key not owned by the worker user is refused (64)" test "$RC" = 64
check "  ... and names the owner it wants" has "not ifso-worker-not-me" "$OUT"
IFSO_API_USER=ifso-api-not-me run "$S1"; check "a relayer key not owned by the api user is refused (64)" test "$RC" = 64
run --check; check "WEB_ORIGINS empty in production: a warning, not a failure" bash -c '[ "$1" != 64 ] && grep -q "WEB_ORIGINS is empty" <<<"$2"' _ "$RC" "$OUT"
echo 0x1 >"$T/ctl/chain-hex"
run "$S1"; check "an RPC on the wrong chain is refused, nothing switched (75)" test "$RC" = 75
reset
run "$(printf 'f%.0s' {1..40})"; check "a sha that is not in the repo: exit 75, nothing switched" test "$RC" = 75
check "  ... and no release was created" test -z "$(cur)"

# --- first deploy
reset
run "$S1"
check "first deploy exits 0" test "$RC" = 0
check "current points at the sha" test "$(cur)" = "$S1"
check "the release is the committed tree" grep -qx one "$T/opt/releases/$S1/app/src/main.ts"
check "bun install --frozen-lockfile --ignore-scripts ran in the release (no dependency install script runs as ifso; audit M-2)" has "bun install --frozen-lockfile --ignore-scripts (in $S1)" "$(calls)"
check "migrations ran (ifso-migrate.service started)" has "systemctl start ifso-migrate.service" "$(calls)"
check "the release is marked healthy" test -e "$T/opt/releases/$S1/.healthy"
check "current.sha was recorded" test "$(cat "$T/state/current.sha")" = "$S1"
check "no telegram token: the bot unit is not restarted" lacks ifso-bot "$OUT"
check "the lock is released" test ! -e "$T/state/deploy.lock"

# --- second deploy, with a bot token: previous.sha, bot restarted
sed -i.bak 's/^TELEGRAM_BOT_TOKEN=.*/TELEGRAM_BOT_TOKEN=fake/' "$T/etc/common.env"
reset; run "$S2"
check "second deploy exits 0, current moves" bash -c '[ "$1" = 0 ] && [ "$2" = "$3" ]' _ "$RC" "$(cur)" "$S2"
check "previous.sha is the first release" test "$(cat "$T/state/previous.sha")" = "$S1"
check "the bot unit is restarted once a token is set" has "ifso-bot" "$OUT"
check "services restarted after the migration" bash -c 'grep -n "" "$1" | grep -E "db:migrate|restart" | head -2 | tail -1 | grep -q restart' _ "$T/ctl/calls"

# --- failures before the switch leave everything alone (75)
reset; touch "$T/ctl/fail-install"; run "$S3"
check "bun install failure: exit 75" test "$RC" = 75
check "  ... current unchanged" test "$(cur)" = "$S2"
check "  ... no restart, no migration" bash -c '! grep -qE "restart|db:migrate" "$1"' _ "$T/ctl/calls"
check "  ... the half-built release is removed" test ! -e "$T/opt/releases/$S3"
check "  ... says nothing switched" has "nothing switched" "$OUT"

# --- failures after the switch roll back (1)
reset; touch "$T/ctl/fail-migrate"; run "$S3"
check "migration failure: exit 1 (rolled back)" test "$RC" = 1
check "  ... current is back on $S2" test "$(cur)" = "$S2"
check "  ... says it rolled back" has "rolled back" "$OUT"
check "  ... the failed release is gone" test ! -e "$T/opt/releases/$S3"

reset; touch "$T/ctl/fail-restart"; run "$S3"
check "restart failure: exit 2 when the rollback restart fails too" test "$RC" = 2
check "  ... says ROLLBACK FAILED" has "ROLLBACK FAILED" "$OUT"
rm -f "$T/ctl/fail-restart"

reset; echo "$S3" >"$T/ctl/bad-release"; run "$S3"
check "readyz 503 on the new release only: exit 1" test "$RC" = 1
check "  ... current is back on $S2" test "$(cur)" = "$S2"
check "  ... the rollback restarted the services and re-checked health" test "$(calls | grep -c restart)" -ge 2
check "  ... current.sha still names the live release" test "$(cat "$T/state/current.sha")" = "$S2"

reset; touch "$T/ctl/always-503"; run "$S3"
check "readyz 503 even after the rollback: exit 2" test "$RC" = 2

reset; touch "$T/ctl/inactive"; run "$S3"
check "a unit that is not active after restart counts as unhealthy (rolled back or failed, never 0)" test "$RC" != 0
rm -f "$T/ctl/inactive"

# --- same sha again, --check, locking, retention
reset; run "$S2"
check "redeploying the live sha works and keeps it live" bash -c '[ "$1" = 0 ] && [ "$2" = "$3" ]' _ "$RC" "$(cur)" "$S2"
reset; OUT="$(bash "$DEPLOY" --dry-run --check 2>&1)"; RC=$?
check "--check on a healthy server: exit 0, no restart" bash -c '[ "$1" = 0 ] && ! grep -q restart "$2"' _ "$RC" "$T/ctl/calls"
touch "$T/ctl/always-503"; OUT="$(bash "$DEPLOY" --dry-run --check 2>&1)"; RC=$?
check "--check on an unhealthy server: exit 1" test "$RC" = 1
rm -f "$T/ctl/always-503"
mkdir "$T/state/deploy.lock"; echo "$$" >"$T/state/deploy.lock/pid"
run "$S3"; check "a live lock holder blocks a second deploy (75)" test "$RC" = 75
rm -rf "$T/state/deploy.lock"
mkdir "$T/state/deploy.lock"; echo 99999999 >"$T/state/deploy.lock/pid"
reset; run "$S3"; check "a stale lock is cleared and the deploy runs" test "$RC" = 0
reset; run "$S4"
check "retention: at most 5 releases kept, current and previous among them" bash -c '[ "$(ls "$1" | wc -l)" -le 5 ] && [ -d "$1/$2" ] && [ -d "$1/$3" ]' _ "$T/opt/releases" "$S4" "$S3"

# --- static checks of the shipped files
check "every unit passes systemd's own syntax rules (sections and keys)" bash -c '
  for f in "$1"/systemd/*; do grep -qE "^\[(Unit|Service|Timer|Install)\]" "$f" || exit 1; done' _ "$HERE"
check "the migrate unit runs bun run db:migrate" grep -q "^ExecStart=/usr/local/bin/bun run db:migrate\$" "$HERE/systemd/ifso-migrate.service"
check "no unit puts a secret or a key on a command line" bash -c '! grep -E "^ExecStart=.*(PASSWORD|TOKEN|SECRET|KEY)" "$1"/systemd/*' _ "$HERE"
check "the three roles are the ones main.ts accepts" bash -c 'for r in api bot worker; do grep -q "main.ts $r\$" "$1/systemd/ifso-$r.service" || exit 1; done' _ "$HERE"
split() { awk -v want="$1" '/^# \[section: / { s = $3; sub(/\]$/, "", s); on = (s == want); next } on { print }' "$HERE/env.example"; }
check "env.example sections: common holds the escrow and resolver (the API builds outcome payments), api the relayer, worker the keeper" bash -c '
  split() { awk -v want="$1" "/^# \[section: / { s = \$3; sub(/\]\$/, \"\", s); on = (s == want); next } on { print }" "$2/env.example"; }
  split common "$1" | grep -q "^ESCROW_ADDRESS=" && split common "$1" | grep -q "^RESOLVER_ADDRESS=" && split api "$1" | grep -q "^RELAYER_KEYSTORE=" &&
  split worker "$1" | grep -q "^KEEPER_KEYSTORE=" && ! split worker "$1" | grep -q "^RESOLVER_ADDRESS="' _ "$HERE"
check "env.example api section: TRUST_PROXY=caddy and HOST=127.0.0.1 (review R2-M1)" bash -c '
  split() { awk -v want="$1" "/^# \[section: / { s = \$3; sub(/\]\$/, \"\", s); on = (s == want); next } on { print }" "$2/env.example"; }
  split api "$1" | grep -qx "TRUST_PROXY=caddy" && split api "$1" | grep -qx "HOST=127.0.0.1" && ! split common "$1" | grep -q "^TRUST_PROXY="' _ "$HERE"
check "each role runs as its own user; only the worker can see keeper/resolver keys, only the api the relayer key (R2-L3)" bash -c '
  d="$1/systemd"
  for r in api bot worker; do grep -qx "User=ifso-$r" "$d/ifso-$r.service" && grep -qx "Group=ifso-$r" "$d/ifso-$r.service" || exit 1; done
  for k in keeper resolver; do grep -q "^InaccessiblePaths=.*/keys/$k.json" "$d/ifso-api.service" && grep -q "^InaccessiblePaths=.*/keys/$k.json" "$d/ifso-bot.service" || exit 1; done
  grep -q "^InaccessiblePaths=.*/keys/relayer.json" "$d/ifso-worker.service" && grep -q "^InaccessiblePaths=.*/keys/relayer.json" "$d/ifso-bot.service" &&
  ! grep -q "^InaccessiblePaths=.*/keys/relayer" "$d/ifso-api.service" && ! grep -qE "^InaccessiblePaths=.*/keys/(keeper|resolver)" "$d/ifso-worker.service" &&
  ! grep -q "^User=ifso\$" "$d/ifso-api.service" "$d/ifso-bot.service" "$d/ifso-worker.service"' _ "$HERE"
check "provision.sh hands relayer keys to ifso-api and keeper/resolver keys to ifso-worker (R2-L3)" bash -c '
  p="$1/provision.sh"
  grep -q "relayer.json | relayer.password) owner=ifso-api" "$p" &&
  grep -q "keeper.json | keeper.password | resolver.json | resolver.password) owner=ifso-worker" "$p" &&
  grep -q "for u in ifso-api ifso-bot ifso-worker" "$p" && grep -q "install -d -o root -g root -m 0711 \"\$KEYS_DIR\"" "$p"' _ "$HERE"
check "env.example sets the mainnet resolver float alert MIN_RESOLVER_USDG=200 (two 100 USDG bonds)" grep -qx "MIN_RESOLVER_USDG=200" "$HERE/env.example"
check "env.example holds no real secret values" bash -c '! grep -E "^(TELEGRAM_BOT_TOKEN|OPS_BOT_TOKEN|ODDS_API_KEY|PYTH_API_KEY|ALCHEMY_KEY|TELEGRAM_WEBHOOK_SECRET|ZERODEV_PROJECT_ID)=.+" "$1/env.example"' _ "$HERE"
check "no leftovers from the project these scripts were adapted from" bash -c 'w="lem""niscate"; ! grep -rIil "$w" "$1" --exclude=deploy-local.test.sh' _ "$HERE"

# =====================================================================================================================
# Co-host mode: deploy.sh (dry-run, fake systemctl) -------------------------------------------------------------------
reset
write_env 46630 0xb626
sed -i.bak 's/^PORT=8080/PORT=3201\nHOST=127.0.0.1/' "$T/etc/api.env"
printf 'DATABASE_URL=postgres://ifso:x@127.0.0.1:5432/ifso_testnet\nREDIS_URL=redis://:x@127.0.0.1:6380\n' >"$T/etc/db.env"
mkdir -p "$T/opt/bin"
printf '#!/usr/bin/env bash\necho OWNBUN >>"%s/ctl/calls"\nexec "%s/bin/bun" "$@"\n' "$T" "$T" >"$T/opt/bin/bun"; chmod +x "$T/opt/bin/bun"
printf '# protected\ncaddy.service\npostgresql@18-main.service\nother-api.service\n' >"$T/etc/cohost.protected"
runc() { OUT="$(env -u IFSO_BUN bash "$DEPLOY" --dry-run "$@" 2>&1)"; RC=$?; }
rm -f "$T/etc/cohost"
runc --cohost "$S3"; check "co-host: --cohost without /etc/ifso/cohost is refused (64)" test "$RC" = 64
touch "$T/etc/cohost"
reset; runc "$S3"
check "co-host: a deploy works, exit 0, and uses Ifso's own Bun (never /usr/local/bin/bun)" bash -c '[ "$1" = 0 ] && grep -q OWNBUN "$2"' _ "$RC" "$T/ctl/calls"
check "co-host: current moved" test "$(cur)" = "$S3"
reset; echo other-api.service >"$T/ctl/inactive-unit"; runc "$S4"
check "co-host: a protected unit that is not active stops the deploy before any change (75)" test "$RC" = 75
check "  ... nothing switched" bash -c '[ "$1" = "$2" ] && ! grep -qE "restart|db:migrate" "$3"' _ "$(cur)" "$S3" "$T/ctl/calls"
reset; touch "$T/ctl/prot-bump"; runc "$S4"
check "co-host: a protected unit that changed during the deploy exits 3 and says so" bash -c '[ "$1" = 3 ] && grep -q "other project" <<<"$2"' _ "$RC" "$OUT"
reset; runc --check
check "co-host: --check on a healthy server exits 0" test "$RC" = 0
sed -i.bak 's/^PORT=3201/PORT=8080/' "$T/etc/api.env"; runc "$S4"
check "co-host: API port other than 3201 is refused (64)" bash -c '[ "$1" = 64 ] && grep -q "PORT must be 3201" <<<"$2"' _ "$RC" "$OUT"
sed -i.bak 's/^PORT=8080/PORT=3201/' "$T/etc/api.env"
sed -i.bak 's/^HOST=127.0.0.1/HOST=0.0.0.0/' "$T/etc/api.env"; runc "$S4"
check "co-host: API host other than 127.0.0.1 is refused (64)" test "$RC" = 64
sed -i.bak 's/^HOST=0.0.0.0/HOST=127.0.0.1/' "$T/etc/api.env"
sed -i.bak 's/6380/6379/' "$T/etc/db.env"; runc "$S4"
check "co-host: Redis on 6379 is refused (64)" bash -c '[ "$1" = 64 ] && grep -q 6380 <<<"$2"' _ "$RC" "$OUT"
sed -i.bak 's/6379/6380/' "$T/etc/db.env"
mv "$T/etc/cohost.protected" "$T/etc/cohost.protected.off"; runc "$S4"
check "co-host: a missing protected-unit list is refused (64)" test "$RC" = 64
mv "$T/etc/cohost.protected.off" "$T/etc/cohost.protected"
rm -f "$T/etc/cohost"
write_env 46630 0xb626

# Co-host mode: provision.sh --cohost --check / --caddy-only against shimmed system commands ---------------------------
SHIM="$T/shim"; C="$T/pc"; mkdir -p "$SHIM" "$C/etc" "$C/caddy/sites" "$C/state"
cat >"$SHIM/systemctl" <<FAKE
#!/usr/bin/env bash
echo "systemctl \$*" >>"$C/state/calls"
last="\${@: -1}"
case "\$1" in
  list-units) cat "$C/state/units" ;;
  is-active) grep -q "^\$last " "$C/state/units" && ! grep -qx "\$last" "$C/state/inactive" 2>/dev/null ;;
  show) if [[ "\$*" == *FragmentPath* ]]; then cat "$C/state/frag-\$2" 2>/dev/null; elif [[ "\$*" == *ActiveState* ]]; then printf 'ActiveState=active\nMainPID=%s\nActiveEnterTimestampMonotonic=7\n' "\$(cat "$C/state/pid" 2>/dev/null || echo 1)"; fi ;;
  reload) [[ ! -e "$C/state/fail-reload" ]] ;;
esac
FAKE
cat >"$SHIM/ss" <<FAKE
#!/usr/bin/env bash
cat "$C/state/ports" 2>/dev/null
FAKE
cat >"$SHIM/dpkg-query" <<FAKE
#!/usr/bin/env bash
grep -qx "\${@: -1}" "$C/state/installed" 2>/dev/null && printf 'install ok installed' || exit 1
FAKE
cat >"$SHIM/apt-cache" <<'FAKE'
#!/usr/bin/env bash
printf '%s:\n  Installed: (none)\n  Candidate: 7.0.15-1\n' "$2"
FAKE
cat >"$SHIM/apt-get" <<FAKE
#!/usr/bin/env bash
echo "apt-get \$*" >>"$C/state/calls"
if [[ "\$1" == -s ]]; then for a in "\$@"; do [[ "\$a" == -* || "\$a" == install ]] || echo "Inst \$a (1.0 Ubuntu:26.04 [amd64])"; done; cat "$C/state/apt-extra" 2>/dev/null; fi
exit 0
FAKE
cat >"$SHIM/psql" <<FAKE
#!/usr/bin/env bash
q="\$*"
case "\$q" in
  *server_version_num*) echo 180001 ;;
  *hba_file*) echo "$C/hba.conf" ;;
  *pg_roles*) [[ -e "$C/state/role" ]] && echo 1 ;;
  *pg_database*) [[ -e "$C/state/db" ]] && echo 1 ;;
esac
exit 0
FAKE
cat >"$SHIM/runuser" <<'FAKE'
#!/usr/bin/env bash
shift 2; [[ "$1" == -- ]] && shift; exec "$@"
FAKE
cat >"$SHIM/caddy" <<FAKE
#!/usr/bin/env bash
[[ "\$1" == version ]] && { echo v2.11.7; exit 0; }
echo "caddy \$*" >>"$C/state/calls"
cfg=""; while [[ \$# -gt 0 ]]; do [[ "\$1" == --config ]] && cfg="\$2"; shift; done
[[ -e "$C/state/caddy-invalid" ]] && exit 1
# the real validate runs as the caddy user: a config only root can read fails there (server, 2026-11-01)
[[ -z "\$cfg" ]] || [[ "\$(stat -f %Lp "\$cfg" 2>/dev/null || stat -c %a "\$cfg")" =~ [4-7]\$ ]] || { echo "caddy: permission denied: \$cfg" >&2; exit 1; }
! grep -q BROKEN "\$cfg"
FAKE
cat >"$SHIM/df" <<'FAKE'
#!/usr/bin/env bash
echo "Filesystem 1K-blocks Used Available Capacity Mounted"
echo "/dev/x 90000000 1 80000000 1% /"
FAKE
printf '#!/usr/bin/env bash\necho 6\n' >"$SHIM/nproc"
printf '#!/usr/bin/env bash\nexit 0\n' >"$SHIM/swapon"
chmod +x "$SHIM"/*
printf 'ID=ubuntu\nVERSION_ID="26.04"\n' >"$C/os-release"
printf 'MemAvailable:    4718592 kB\n' >"$C/meminfo"
printf 'local all postgres peer\nhost all all 127.0.0.1/32 scram-sha-256\n' >"$C/hba.conf"
pcn=0
pcreset() { # move the old state aside (the temp dir is removed on exit) and lay down a fresh "shared server"
  pcn=$((pcn + 1)); mkdir -p "$T/old$pcn"
  mv "$C/state" "$C/etc" "$C/caddy" "$T/old$pcn/" 2>/dev/null
  mkdir -p "$C/state" "$C/etc" "$C/caddy/sites"; : >"$C/state/calls"
  printf 'caddy.service loaded active running Caddy\nfail2ban.service loaded active running F\nssh.service loaded active running S\npostgresql@18-main.service loaded active running PG\nother-api.service loaded active running A\nother-vol.service loaded active running V\ncron.service loaded active running cron\n' >"$C/state/units"
  echo /etc/systemd/system/other-api.service >"$C/state/frag-other-api.service"
  echo /etc/systemd/system/other-vol.service >"$C/state/frag-other-vol.service"
  echo /usr/lib/systemd/system/cron.service >"$C/state/frag-cron.service"
  printf 'LISTEN 0 4096 0.0.0.0:80 0.0.0.0:*\nLISTEN 0 4096 0.0.0.0:3101 0.0.0.0:*\nLISTEN 0 244 127.0.0.1:5432 0.0.0.0:*\nLISTEN 0 4096 127.0.0.1:2019 0.0.0.0:*\n' >"$C/state/ports"
  printf '{\n\temail ops@example.test\n}\nexample.test {\n\trespond ok\n}\n' >"$C/caddy/Caddyfile"
}
pc() {
  OUT="$(env PATH="$SHIM:$PATH" IFSO_COHOST_TEST=1 IFSO_ETC="$C/etc" IFSO_OPT="$C/opt" IFSO_OS_RELEASE="$C/os-release" IFSO_MEMINFO="$C/meminfo" \
    IFSO_CADDYFILE="$C/caddy/Caddyfile" IFSO_CADDY_SITES="$C/caddy/sites" DOMAIN="${DOMAIN-api.example.test}" bash "$HERE/provision.sh" --cohost "$@" 2>&1)"; RC=$?
}
tree_sum() { (cd "$C" && find etc caddy -type f -exec shasum {} + 2>/dev/null | sort | shasum); }

pcreset; before="$(tree_sum)"; pc --check
check "cohost --check on a clean shared server: exit 0 and 'CHECK OK'" bash -c '[ "$1" = 0 ] && grep -q "CHECK OK" <<<"$2"' _ "$RC" "$OUT"
check "  ... lists the plan: role, database, Redis port, Caddy import" bash -c 'for w in "create role ifso" "create database ifso_testnet" "6380" "import " "3201"; do grep -q -- "$w" <<<"$1" || exit 1; done' _ "$OUT"
check "  ... lists the other project's units as protected (caddy, postgres cluster, its own unit files), not cron" bash -c 'grep -q "protected unit caddy.service" <<<"$1" && grep -q "protected unit postgresql@18-main.service" <<<"$1" && grep -q "protected unit other-api.service" <<<"$1" && ! grep -q "protected unit cron" <<<"$1"' _ "$OUT"
check "  ... changes nothing (files under etc and caddy identical)" test "$(tree_sum)" = "$before"
check "  ... no apt install, no reload, no restart was called (only a simulation)" bash -c '! grep -qE "reload|restart|stop|mask" "$1"; ! grep -E "^apt-get" "$1" | grep -qv -- " -s "' _ "$C/state/calls"
pcreset; echo 'LISTEN 0 128 127.0.0.1:3201 0.0.0.0:*' >>"$C/state/ports"; pc --check
check "cohost --check: port 3201 already used: FAIL, exit 1" bash -c '[ "$1" = 1 ] && grep -q "FAIL  port 3201" <<<"$2"' _ "$RC" "$OUT"
pcreset; echo 'LISTEN 0 128 127.0.0.1:6380 0.0.0.0:*' >>"$C/state/ports"; pc --check
check "cohost --check: port 6380 already used: FAIL, exit 1" bash -c '[ "$1" = 1 ] && grep -q "FAIL  port 6380" <<<"$2"' _ "$RC" "$OUT"
pcreset; PROTECTED_UNITS="other-hedger.service" pc --check
check "cohost --check: a named PROTECTED_UNITS entry that is not active is a FAIL" bash -c '[ "$1" = 1 ] && grep -q "other-hedger.service is NOT active" <<<"$2"' _ "$RC" "$OUT"
pcreset; sed -i.bak '/^postgresql@/d' "$C/state/units"; pc --check
check "cohost --check: no active postgresql@ cluster is a FAIL" test "$RC" = 1
pcreset; sed -i.bak '/^caddy/d' "$C/state/units"; pc --check
check "cohost --check: caddy not active is a FAIL" test "$RC" = 1
pcreset; touch "$C/state/role"; pc --check
check "cohost --check: a role ifso that this script did not create is a FAIL (never taken over)" bash -c '[ "$1" = 1 ] && grep -q "refusing to take it over" <<<"$2"' _ "$RC" "$OUT"
pcreset; touch "$C/state/db"; pc --check
check "cohost --check: a database ifso_testnet that this script did not create is a FAIL" test "$RC" = 1
pcreset; echo 'Inst libc6 [2.40-1] (2.41-1 Ubuntu:26.04 [amd64])' >"$C/state/apt-extra"; pc --check
check "cohost --check: a package simulation that would UPGRADE anything is a FAIL" bash -c '[ "$1" = 1 ] && grep -q "UPGRADE or REMOVE" <<<"$2"' _ "$RC" "$OUT"
pcreset; echo 'Inst postgresql-common (1.0 Ubuntu:26.04 [amd64])' >"$C/state/apt-extra"; pc --check
check "cohost --check: a simulation that touches postgres is a FAIL" bash -c '[ "$1" = 1 ] && grep -q "would install/change postgresql-common" <<<"$2"' _ "$RC" "$OUT"
pcreset; printf 'ID=ubuntu\nVERSION_ID="24.04"\n' >"$C/os-release"; pc --check
check "cohost --check: Ubuntu 24.04 is a warning, not a failure" bash -c '[ "$1" = 0 ] && grep -q "warn  Ubuntu 24.04" <<<"$2"' _ "$RC" "$OUT"
printf 'ID=ubuntu\nVERSION_ID="26.04"\n' >"$C/os-release"
pcreset; printf 'MemAvailable:    400000 kB\n' >"$C/meminfo"; pc --check
check "cohost --check: too little free memory is a FAIL" test "$RC" = 1
printf 'MemAvailable:    4718592 kB\n' >"$C/meminfo"
pcreset; PROFILE=mainnet pc; check "cohost refuses the mainnet profile (64)" test "$RC" = 64
pcreset; DOMAIN='' pc; check "cohost real run without DOMAIN is refused (64)" test "$RC" = 64
pcreset; DOMAIN='bad domain' pc --check; check "cohost refuses a malformed DOMAIN (64)" test "$RC" = 64

# Caddy: ONE import line, backup, validate, graceful reload
pcreset; cp "$C/caddy/Caddyfile" "$T/orig"; pc --caddy-only
check "caddy step: exit 0, the import line was appended exactly once" bash -c '[ "$1" = 0 ] && [ "$(grep -c "^import $2/\*.caddy$" "$3")" = 1 ]' _ "$RC" "$C/caddy/sites" "$C/caddy/Caddyfile"
check "  ... every original line is still there, in order, and only the import and its comment were added" bash -c 'head -n "$(wc -l <"$1")" "$2" | cmp -s - "$1" && [ "$(( $(wc -l <"$2") - $(wc -l <"$1") ))" -le 3 ]' _ "$T/orig" "$C/caddy/Caddyfile"
check "  ... a timestamped backup of the old Caddyfile exists and equals it" bash -c 'b=$(ls "$1"/Caddyfile.bak.* | head -1); cmp -s "$b" "$2"' _ "$C/caddy" "$T/orig"
check "  ... ifso.caddy points the domain at 127.0.0.1:3201" bash -c 'grep -q "^api.example.test {" "$1" && grep -q "reverse_proxy 127.0.0.1:3201" "$1"' _ "$C/caddy/sites/ifso.caddy"
check "  ... caddy was reloaded (never restarted)" bash -c 'grep -q "^systemctl reload caddy" "$1" && ! grep -qE "systemctl (restart|stop) caddy" "$1"' _ "$C/state/calls"
: >"$C/state/calls"; pc --caddy-only
check "caddy step again: nothing to do, no second import line, no reload" bash -c '[ "$1" = 0 ] && [ "$(grep -c "^import " "$2")" = 1 ] && ! grep -q reload "$3"' _ "$RC" "$C/caddy/Caddyfile" "$C/state/calls"
pcreset; printf 'import %s/*\n' "$C/caddy/sites" >>"$C/caddy/Caddyfile"; cp "$C/caddy/Caddyfile" "$T/orig"; pc --caddy-only
check "caddy step: an import of the sites folder that is already there is left alone (no append, no backup)" bash -c '[ "$1" = 0 ] && cmp -s "$2" "$3" && ! ls "$4"/Caddyfile.bak.* >/dev/null 2>&1' _ "$RC" "$T/orig" "$C/caddy/Caddyfile" "$C/caddy"
pcreset; cp "$C/caddy/Caddyfile" "$T/orig"; touch "$C/state/caddy-invalid"; pc --caddy-only
check "caddy step: a configuration that does not validate leaves the Caddyfile untouched, no reload, site file set aside" bash -c '[ "$1" != 0 ] && cmp -s "$2" "$3" && ! grep -q reload "$4" && [ ! -e "$5/ifso.caddy" ] && ls "$5"/ifso.caddy.rejected.* >/dev/null' _ "$RC" "$T/orig" "$C/caddy/Caddyfile" "$C/state/calls" "$C/caddy/sites"

# EDGE=cloudflare: the API behind Cloudflare's proxy answers Cloudflare's ranges only and passes its headers through
pcreset; EDGE=cloudflare pc --caddy-only
check "EDGE=cloudflare: the site answers Cloudflare only (abort for any other address) and keeps cf headers" bash -c 'f="$1/caddy/sites/ifso.caddy"; [ "$2" = 0 ] && grep -q "^api.example.test {" "$f" && grep -q "@not_cloudflare not remote_ip 173.245.48.0/20" "$f" && grep -q "abort @not_cloudflare" "$f" && grep -q "2400:cb00::/32" "$f" && ! grep -q "header_up -CF" "$f"' _ "$C" "$RC"
pcreset; pc --caddy-only
check "default edge: the site strips the cf headers (no Cloudflare in front)" bash -c 'grep -q "header_up -CF-IPCountry" "$1/caddy/sites/ifso.caddy" && ! grep -q "not_cloudflare" "$1/caddy/sites/ifso.caddy"' _ "$C"
pcreset; EDGE=fastly pc --caddy-only
check "an unknown EDGE is refused (exit 64)" test "$RC" = 64
pcreset; cp "$C/caddy/Caddyfile" "$T/orig"; touch "$C/state/fail-reload"; pc --caddy-only
check "caddy step: a failed reload restores the Caddyfile from the backup" bash -c '[ "$1" != 0 ] && cmp -s "$2" "$3"' _ "$RC" "$T/orig" "$C/caddy/Caddyfile"
pcreset; sed -i.bak 's/^example.test/BROKEN/' "$C/caddy/Caddyfile"; pc --caddy-only
check "caddy step: it validates the whole file, so a problem in the other project's part also stops it" bash -c '[ "$1" != 0 ]' _ "$RC"

# Usage-report prerequisites: an access log Caddy can always write, the visitor's address trusted from Cloudflare only
CFT="$HERE/cohost/ifso.cloudflare.caddy"
check "cloudflare site: an access log under /var/lib/caddy (the caddy user's home), rolled" bash -c 'f="$1"; grep -q "output file /var/lib/caddy/ifso-api.log" "$f" && grep -q "roll_size 20MiB" "$f" && grep -q "roll_keep 5" "$f" && ! grep -q "output file /var/log" "$f"' _ "$CFT"
check "cloudflare site: the log block sits inside the site, after the Cloudflare-only abort" bash -c 'f="$1"; a=$(grep -n "abort @not_cloudflare" "$f" | cut -d: -f1); l=$(grep -n "^	log {" "$f" | cut -d: -f1); s=$(grep -n "^@DOMAIN@ {" "$f" | cut -d: -f1); [ -n "$a" ] && [ -n "$l" ] && [ "$s" -lt "$a" ] && [ "$a" -lt "$l" ]' _ "$CFT"
check "own-server Caddyfile: global trusted_proxies = exactly the Cloudflare ranges of the cloudflare site, client_ip_headers CF-Connecting-IP" bash -c '
  cf=$(sed -n "s/^.*@not_cloudflare not remote_ip //p" "$1"); tp=$(sed -n "s/^[[:space:]]*trusted_proxies static //p" "$2")
  [ -n "$cf" ] && [ "$cf" = "$tp" ] && grep -q "^[[:space:]]*client_ip_headers CF-Connecting-IP$" "$2" && [ "$(grep -n "^{$" "$2" | head -1 | cut -d: -f1)" -lt "$(grep -n "^{\$DOMAIN" "$2" | cut -d: -f1)" ]' _ "$CFT" "$HERE/Caddyfile"
check "own-server Caddyfile: the access log is kept and the forgeable cf headers are still stripped" bash -c 'grep -q "output file /var/log/caddy/ifso-api.log" "$1" && grep -q "header_up -CF-Connecting-IP" "$1"' _ "$HERE/Caddyfile"
check "caddy templates: braces balance (a stray brace fails the reload of every site)" bash -c 'for f in "$@"; do o=$(grep -v "^[[:space:]]*#" "$f" | tr -cd "{" | wc -c); c=$(grep -v "^[[:space:]]*#" "$f" | tr -cd "}" | wc -c); [ "$o" = "$c" ] || exit 1; done' _ "$CFT" "$HERE/cohost/ifso.caddy" "$HERE/Caddyfile"

# Static guarantees of the co-host files
PC="$HERE/provision-cohost.sh"
check "cohost: never restarts, stops or reconfigures postgres, caddy, fail2ban, ssh (only reload caddy; stop/disable/mask only the package's own redis unit)" bash -c '
  ! grep -nE "systemctl +(restart|try-restart|stop|disable|mask|start|enable)[^#]*(caddy|postgres|fail2ban|ssh)" "$1" &&
  [ "$(grep -cE "^[[:space:]]*(if ! )?systemctl reload caddy" "$1")" = 1 ] && ! grep -nE "systemctl +restart" "$1" &&
  [ "$(grep -E "systemctl +(stop|disable|mask)" "$1" | grep -vc "redis-server.service")" = 0 ]' _ "$PC"
check "cohost: no apt upgrade, no ufw, no sysctl, no timedatectl, no swap, no sshd or fail2ban config, no pg_hba write" bash -c '
  ! grep -nE "^[^#]*(apt-get +[^#]*[[:space:]]upgrade|dist-upgrade|ufw |sysctl |timedatectl|mkswap|fallocate|fail2ban/|sshd_config|journald|pg_hba.conf *>|unattended-upgrades *$)" "$1"' _ "$PC"
check "cohost: Bun and cast go to /opt/ifso/bin, never /usr/local/bin" bash -c '! grep -nE "install .*/usr/local/bin/(bun|cast)" "$1" && grep -q "\"\$BIN_DIR/bun\"" "$1" && grep -q "^BIN_DIR=\"\$OPT/bin\"" "$1"' _ "$PC"
check "cohost: Bun 1.4.4 and cast 1.8.4 pinned, bun checksum verified" bash -c 'grep -q "^BUN_VERSION=\"1.4.4\"" "$1" && grep -q "^FOUNDRY_VERSION=\"1.8.4\"" "$1" && grep -q "sha256sum -c" "$1"' _ "$PC"
check "cohost: ports are API 3201, Redis 6380; the redis.conf carries port, password, 256mb and noeviction on 127.0.0.1" bash -c '
  grep -q "^API_PORT=3201" "$1" && grep -q "^REDIS_PORT=6380" "$1" && grep -q "echo \"port \$REDIS_PORT\"" "$1" && grep -q "requirepass" "$1" &&
  grep -q "maxmemory 256mb" "$1" && grep -q "maxmemory-policy noeviction" "$1" && grep -q "echo \"bind 127.0.0.1\"" "$1"' _ "$PC"
check "cohost: the package's default redis-server (6379) is masked, and only when this script installed it" bash -c 'grep -q "redis_preinstalled" "$1" && grep -q "systemctl mask redis-server.service" "$1" && grep -q "policy-rc.d" "$1"' _ "$PC"
check "cohost: db.env 0600; role without superuser and with a connection limit; no extension, no Timescale" bash -c '
  grep -q "chmod 0600 \"\$ETC/db.env\"" "$1" && grep -q "NOSUPERUSER NOCREATEDB NOCREATEROLE" "$1" && grep -q "CONNECTION LIMIT" "$1" && ! grep -v "^#" "$1" | grep -qiE "CREATE EXTENSION|timescaledb"' _ "$PC"
check "cohost: the identity of the protected units is compared before and after, exit 3 on a change" bash -c 'grep -q "BEFORE=\"\$(snapshot)\"" "$1" && grep -q "AFTER=\"\$(snapshot)\"" "$1" && grep -q "exit 3" "$1"' _ "$PC"
check "provision.sh hands --cohost over before it checks root or installs anything" bash -c '
  a=$(grep -n "== --cohost" "$1/provision.sh" | head -1 | cut -d: -f1); b=$(grep -n "id -u" "$1/provision.sh" | head -1 | cut -d: -f1); c=$(grep -n "^apt-get" "$1/provision.sh" | head -1 | cut -d: -f1)
  [ -n "$a" ] && [ "$a" -lt "$b" ] && [ "$a" -lt "$c" ]' _ "$HERE"
check "co-host drop-ins: MemoryMax api 512M, bot 256M, worker 768M and a CPUQuota on each" bash -c '
  d="$1/cohost/dropins"
  grep -qx "MemoryMax=512M" "$d/ifso-api.service.conf" && grep -qx "MemoryMax=256M" "$d/ifso-bot.service.conf" && grep -qx "MemoryMax=768M" "$d/ifso-worker.service.conf" &&
  for r in api bot worker migrate backup; do grep -q "^CPUQuota=" "$d/ifso-$r.service.conf" || exit 1; done' _ "$HERE"
check "co-host drop-ins: Ifso's own Bun, not /usr/local/bin/bun, and the right role arguments" bash -c '
  d="$1/cohost/dropins"
  for r in api bot worker; do grep -qx "ExecStart=/opt/ifso/bin/bun src/main.ts $r" "$d/ifso-$r.service.conf" || exit 1; done
  grep -qx "ExecStart=/opt/ifso/bin/bun run db:migrate" "$d/ifso-migrate.service.conf" && ! grep -rq "/usr/local/bin" "$d"' _ "$HERE"
check "co-host Redis unit: own user, its own config file, limits, no 6379" bash -c '
  u="$1/cohost/ifso-redis.service"
  grep -qx "User=ifso-redis" "$u" && grep -q "^ExecStart=@REDIS_BIN@ /etc/ifso/redis.conf" "$u" && grep -q "^MemoryMax=" "$u" && grep -q "^CPUQuota=" "$u" && ! grep -q 6379 "$u"' _ "$HERE"
check "co-host Caddy site: domain placeholder -> 127.0.0.1:3201 only" bash -c 'grep -q "^@DOMAIN@ {" "$1/cohost/ifso.caddy" && grep -q "reverse_proxy 127.0.0.1:3201" "$1/cohost/ifso.caddy" && ! grep -qE "8080|:80 " "$1/cohost/ifso.caddy"' _ "$HERE"
check "co-host files name the other project nowhere" bash -c 'w="lem""niscate"; ! grep -rIil "$w" "$1/cohost" "$1/provision-cohost.sh"' _ "$HERE"

# deploy.sh as_ifso (the real, non-dry-run path) through the runuser shim: an unset GIT_SSH_COMMAND must not become an
# empty one (git then runs "" and every fetch fails: server, 2026-11-01); a set one is passed through.
AS_IFSO="$(sed -n '/^as_ifso() {/,/^}/p' "$HERE/deploy.sh")"
check "deploy as_ifso: no empty GIT_SSH_COMMAND when unset" bash -c 'PATH="$1:$PATH"; eval "$2"; DRY_RUN=0 STATE=/x; unset GIT_SSH_COMMAND; ! as_ifso env | grep -q "^GIT_SSH_COMMAND="' _ "$SHIM" "$AS_IFSO"
check "deploy as_ifso: a set GIT_SSH_COMMAND is passed through" bash -c 'PATH="$1:$PATH"; eval "$2"; DRY_RUN=0 STATE=/x; GIT_SSH_COMMAND="ssh -i k" as_ifso env | grep -qx "GIT_SSH_COMMAND=ssh -i k"' _ "$SHIM" "$AS_IFSO"

if ((fail)); then printf '%s of %s failed\n' "$fail" "$n"; exit 1; fi
printf 'all %s passed\n' "$n"
