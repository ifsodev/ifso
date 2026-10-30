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
unset IFSO_BACKUP_CMD

# --- fakes. Behaviour switches are files in $T/ctl so each case can set them.
cat >"$T/bin/systemctl" <<FAKE
#!/usr/bin/env bash
echo "systemctl \$*" >>"$T/ctl/calls"
case "\$1" in
  start) [[ "\$2" == ifso-migrate.service && -e "$T/ctl/fail-migrate" ]] && exit 1 ;;
  restart) [[ -e "$T/ctl/fail-restart" ]] && exit 1 ;;
  is-active) [[ -e "$T/ctl/inactive" ]] && exit 3 ;;
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
  printf 'PORT=8080\nRELAYER_KEYSTORE=%s/keys/relayer.json\nRELAYER_PASSWORD_FILE=%s/keys/relayer.password\n' "$T/etc" "$T/etc" >"$T/etc/api.env"
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
check "bun install --frozen-lockfile ran in the release" has "bun install --frozen-lockfile (in $S1)" "$(calls)"
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
check "env.example sections: common holds the escrow, api the relayer, worker the keeper and resolver" bash -c '
  split() { awk -v want="$1" "/^# \[section: / { s = \$3; sub(/\]\$/, \"\", s); on = (s == want); next } on { print }" "$2/env.example"; }
  split common "$1" | grep -q "^ESCROW_ADDRESS=" && split api "$1" | grep -q "^RELAYER_KEYSTORE=" &&
  split worker "$1" | grep -q "^KEEPER_KEYSTORE=" && split worker "$1" | grep -q "^RESOLVER_ADDRESS="' _ "$HERE"
check "env.example holds no real secret values" bash -c '! grep -E "^(TELEGRAM_BOT_TOKEN|OPS_BOT_TOKEN|ODDS_API_KEY|PYTH_API_KEY|ALCHEMY_KEY|TELEGRAM_WEBHOOK_SECRET|ZERODEV_PROJECT_ID)=.+" "$1/env.example"' _ "$HERE"
check "no leftovers from the project these scripts were adapted from" bash -c 'w="lem""niscate"; ! grep -rIil "$w" "$1" --exclude=deploy-local.test.sh' _ "$HERE"

if ((fail)); then printf '%s of %s failed\n' "$fail" "$n"; exit 1; fi
printf 'all %s passed\n' "$n"
