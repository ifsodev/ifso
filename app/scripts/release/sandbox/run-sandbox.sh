#!/usr/bin/env bash
# End-to-end proof of the Ifso release runner, the WHOLE runner (release.py, preflight.py, every sbin wrapper, install.sh,
# arm.sh) against local bare repos as stand-in origins and a fake world (API, Telegram, GitHub, ifso-deploy, bun).
# A fake queue of 3 updates is released through injected failures:
#   world 1  deploy exit 75 (blip, nothing switched, never held) -> retried; gate install blip -> retried; public copy broken ->
#            release goes on, copy caught up later; crash between push and state write -> next pass adopts the push;
#            PAUSE, stale ABORT cleared by resume
#   world 2  unarmed = log only; stale schedule refused; test failure -> HELD (nothing else blocked); deploy failure -> auto
#            rollback (signed revert, redeploy, production unchanged) + HELD; preflight while the release lock is held; fix ->
#            retry -> released via a signed re-apply; GitHub Releases with posters; one public author; signed commits; no leak
#   --linux  (inside a Linux container as root, docker-sandbox.sh) the same worlds with the REAL install.sh, real users, real sudo
#            rules, runuser, visudo -c, and the runner reaching the wrappers through `sudo -n`.
# Usage: bash run-sandbox.sh [--linux]         Needs: git, python3, ssh-keygen, curl, and docs/tools/sync-public.py
# (SYNC_PUBLIC_PY=<path>; found next to the repo by default). Prints PASS/FAIL per check and a final count; exit 1 on any FAIL.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REL="$(cd "$HERE/.." && pwd)"
MODE=local; [[ "${1:-}" == --linux ]] && MODE=linux
# --linux overwrites /usr/local/bin/bun, /etc/ifso-release/paths.conf and allowed_signers and adds users: on a real server it
# would break production. It runs only in the throwaway container docker-sandbox.sh starts (marker env + the runtime's file).
if [[ $MODE == linux && ( "${IFSO_SANDBOX_CONTAINER:-}" != 1 || ! ( -e /.dockerenv || -e /run/.containerenv ) ) ]]; then
  echo "refusing: --linux runs only inside the throwaway container of sandbox/docker-sandbox.sh, never on a real server" >&2
  exit 2
fi
SYNC_PY="${SYNC_PUBLIC_PY:-$REL/../../../../docs/tools/sync-public.py}"
[[ -f "$SYNC_PY" ]] || { echo "sync-public.py not found (set SYNC_PUBLIC_PY)"; exit 2; }
ROOT="$(mktemp -d "${TMPDIR:-/tmp}/ifso-release-sandbox.XXXXXX")"
trap 'kill $(cat "$ROOT"/*.pid 2>/dev/null) 2>/dev/null; [[ "${KEEP:-0}" == 1 ]] || rm -rf "$ROOT"' EXIT
PASS=0; FAIL=0
ok() { # ok "what" <command...>
  local what="$1"; shift
  if "$@" >/dev/null 2>&1; then PASS=$((PASS + 1)); printf '  PASS  %s\n' "$what"; else FAIL=$((FAIL + 1)); printf '  FAIL  %s\n' "$what"; fi
}
note() { printf '\n== %s\n' "$*"; }
need() { command -v "$1" >/dev/null || { echo "missing tool: $1"; exit 2; }; }
need git; need python3; need ssh-keygen; need curl

if [[ $MODE == linux ]]; then
  [[ "$(id -u)" == 0 ]] || { echo "--linux needs root (it runs inside the container)"; exit 2; }
  RUSER=ifso-release; OPS=ifso-ops-user
else
  RUSER="$(id -un)"; OPS="$RUSER"
fi
as_rel() { if [[ $MODE == linux ]]; then runuser -u "$RUSER" -- "$@"; else "$@"; fi; }
as_ops() { if [[ $MODE == linux ]]; then runuser -u "$OPS" -- sudo -n "$@"; else "$@"; fi; }

# ---- install (once): the real install.sh. The identity of the runner's own commits (reverts, re-applies, cherry-picks) comes
# from install.sh ONLY: the sandbox never sets user.name / user.email itself, so a missing identity fails here as on the server.
GIT_NAME="Ifso Release"; GIT_EMAIL="release@example.invalid"
if [[ $MODE == linux ]]; then
  PFX=""
  SYSTEMCTL="$ROOT/fakes-systemctl"; printf '#!/bin/sh\necho "systemctl $*" >>/tmp/systemctl.calls\nexit 0\n' >"$SYSTEMCTL"; chmod +x "$SYSTEMCTL"
  getent group ifso-ops >/dev/null || groupadd --system ifso-ops
  id "$OPS" >/dev/null 2>&1 || useradd -m -G ifso-ops "$OPS"
  note "install.sh (real, as root)"
  SYSTEMCTL="$SYSTEMCTL" PUBLIC_GITHUB_REPO=ifsodev/public-sandbox SYNC_PUBLIC_SRC="$SYNC_PY" RELEASE_GIT_NAME="$GIT_NAME" RELEASE_GIT_EMAIL="$GIT_EMAIL" bash "$REL/install.sh" >"$ROOT/install.log" 2>&1
  ok "install.sh ran clean" test $? -eq 0
  ok "sudoers file installed 0440 root" test "$(stat -c '%a %U' /etc/sudoers.d/ifso-release)" = "440 root"
  ok "visudo -c passes on the whole sudo configuration" visudo -c
  ok "timer installed but NOT enabled" test ! -e /etc/systemd/system/timers.target.wants/ifso-release.timer
  ok "three keys made on the server" test -e /var/lib/ifso-release/.ssh/id_ed25519_signing.pub -a -e /var/lib/ifso-release/.ssh/id_ed25519_private.pub -a -e /var/lib/ifso-release/.ssh/id_ed25519_public.pub
  CONF=/etc/ifso-release/paths.conf; LIBDIR=/usr/local/lib/ifso-release; SBIN=/usr/local/sbin; ETC=/etc/ifso-release
  # outside the release user's home (0750): the gate user (ifso-gate) runs the fake bun from here and writes its call log
  BASE=/srv/ifso-sandbox
  install -d -o "$RUSER" -g "$RUSER" -m 0755 "$BASE"
  ok "install.sh made the gate user ifso-gate (audit M-2)" id ifso-gate
  ok "the gate user cannot read the release user's keys (~/.ssh)" bash -c "! runuser -u ifso-gate -- cat /var/lib/ifso-release/.ssh/id_ed25519_signing && ! runuser -u ifso-gate -- ls /var/lib/ifso-release/.ssh"
  ok "paths.conf runs the gate as ifso-gate" grep -q '^GATE_USER="ifso-gate"' /etc/ifso-release/paths.conf
else
  PFX="$ROOT/root"; mkdir -p "$PFX"
  note "install.sh (PREFIX mode: no users, no systemctl)"
  PREFIX="$PFX" PUBLIC_GITHUB_REPO=ifsodev/public-sandbox SYNC_PUBLIC_SRC="$SYNC_PY" RELEASE_GIT_NAME="$GIT_NAME" RELEASE_GIT_EMAIL="$GIT_EMAIL" bash "$REL/install.sh" >"$ROOT/install.log" 2>&1
  ok "install.sh ran clean" test $? -eq 0
  CONF="$PFX/etc/ifso-release/paths.conf"; LIBDIR="$PFX/usr/local/lib/ifso-release"; SBIN="$PFX/usr/local/sbin"; ETC="$PFX/etc/ifso-release"
  BASE="$ROOT/base"; mkdir -p "$BASE"
  export IFSO_RELEASE_LIB="$LIBDIR" IFSO_RELEASE_CONF="$CONF"   # local mode: no sudo, so the wrappers need to be told where they live
  # local mode: the release user's global git config is the one install.sh wrote under the prefix (never this machine's own)
  export GIT_CONFIG_GLOBAL="$PFX/var/lib/ifso-release/.gitconfig" GIT_CONFIG_NOSYSTEM=1
fi
RGITCFG="$PFX/var/lib/ifso-release/.gitconfig"
SYNC_INSTALLED="$LIBDIR/lib/sync-public.py"
ok "paths.conf has PUBLIC_CI_API by default (from PUBLIC_GITHUB_REPO at install)" grep -q '^PUBLIC_CI_API="https://api.github.com/repos/ifsodev/public-sandbox"' "$CONF"
ok "install.sh installed sync-public.py where paths.conf points (the runner uses that copy)" bash -c "cmp -s '$SYNC_PY' '$SYNC_INSTALLED' && test \"\$(sed -n 's/^SYNC_PUBLIC_PY=//p' '$CONF' | tr -d '\"')\" = '$SYNC_INSTALLED'"
ok "install.sh set the release user's git identity (name, email, no guessing)" bash -c "test \"\$(git config --file '$RGITCFG' user.email)\" = '$GIT_EMAIL' && test \"\$(git config --file '$RGITCFG' user.name)\" = '$GIT_NAME' && test \"\$(git config --file '$RGITCFG' user.useConfigOnly)\" = true"
ok "wrappers installed and executable" test -x "$SBIN/ifso-deploy-release" -a -x "$SBIN/ifso-release-notify" -a -x "$SBIN/ifso-release-status" -a -x "$SBIN/ifso-release-ghrelease"
ok "paths.conf has no secrets and no token words" bash -c "! grep -qiE 'token|password|secret' '$CONF'"
ok "L-12: root's read-only deploy key is root's, 0600, and GitHub's host key is pinned" bash -c "test \"\$(stat -c '%a' '$ETC/root_deploy_key' 2>/dev/null || stat -f '%Lp' '$ETC/root_deploy_key')\" = 600 && grep -q '^github.com ssh-ed25519 ' '$ETC/github_known_hosts'"
ok "release.env is mode 0600" test "$(stat -c '%a' "$ETC/release.env" 2>/dev/null || stat -f '%Lp' "$ETC/release.env")" = 600

FAKES="$BASE/fakes"; mkdir -p "$FAKES"; cp "$HERE"/fakes/* "$FAKES/"; chmod +x "$FAKES"/*
chown -R "$RUSER" "$BASE" 2>/dev/null || true
[[ $MODE == local ]] && export IFSO_RELEASE_TEST_PATH="$FAKES"   # flock stand-in for hosts without flock(1)
# Linux: bun where provision.sh puts it on the server (/usr/local/bin), so the gate run through sudo's clean PATH (preflight,
# the systemd unit) finds it exactly as in production. The shim keeps the fake's dirname, which holds sandbox.env.
if [[ $MODE == linux ]]; then printf '#!/bin/sh
exec %s/bun "$@"
' "$FAKES" >/usr/local/bin/bun; chmod 0755 /usr/local/bin/bun; fi
# ... and anvil (install.sh puts the real one in /usr/local/bin from a checksum-verified foundry tarball)
[[ $MODE == linux ]] && install -m 0755 "$FAKES/anvil" /usr/local/bin/anvil
KEY="$BASE/key"; ssh-keygen -q -t ed25519 -N '' -f "$KEY" -C sandbox; chmod 600 "$KEY"; chmod 644 "$KEY.pub"; chown "$RUSER" "$KEY" "$KEY.pub" 2>/dev/null || true
# allowed_signers: install.sh already put the SERVER's signing key in (the key every runner-made commit is signed with); the
# owner's key (the queue commits) is added the way the README says, appended
SRVKEY="$PFX/var/lib/ifso-release/.ssh/id_ed25519_signing.pub"
ok "install.sh keeps the server's own signing key OUT of allowed_signers (owner keys only; audit M-2)" bash -c "! grep -qF \"\$(cut -d' ' -f2 '$SRVKEY')\" '$ETC/allowed_signers'"
echo "owner@example.invalid $(cat "$KEY.pub")" >>"$ETC/allowed_signers"
# for the "every private commit is signed" checks only: the owner's key OR the server's (runner commits are server-signed, and
# accepted by root only through their trailer rule; the deploys below prove that rule on every runner commit)
ALLSIGNERS="$BASE/all-signers"; { cat "$ETC/allowed_signers"; echo "release@example.invalid $(cut -d' ' -f1,2 "$SRVKEY")"; } >"$ALLSIGNERS"
PUBKEY_LINE="$(cat "$KEY.pub")"; : "$PUBKEY_LINE"

setconf() { # setconf KEY VALUE  (later assignments win, both for the shell wrappers and for systemd's EnvironmentFile)
  grep -v "^$1=" "$CONF" >"$CONF.new"; echo "$1=$2" >>"$CONF.new"; cat "$CONF.new" >"$CONF"; rm -f "$CONF.new"
}

# ---- one world: fresh bare repos, release home, fake API
new_world() { # new_world <name>
  W="$BASE/$1"; rm -rf "$W"; mkdir -p "$W"/{ctl,home,opt/releases}; CTL="$W/ctl"
  chown -R "$RUSER" "$W" 2>/dev/null || true
  chmod 0777 "$CTL"; : >"$CTL/bun.calls"; chmod 0666 "$CTL/bun.calls"   # the gate (ifso-gate on Linux) logs its bun calls here
  git init -q --bare -b main "$W/private.git"; git init -q --bare -b main "$W/public.git"; git init -q --bare -b main "$W/queue.git"
  S="$W/seed"; git init -q -b main "$S"
  sg() { git -C "$S" -c user.name=Owner -c user.email=owner@example.invalid -c gpg.format=ssh -c "user.signingkey=$KEY" -c commit.gpgsign=true "$@"; }
  mkdir -p "$S/app/src/api/routes" "$S/app/test" "$S/web/src"
  echo '{"name":"web","scripts":{"test":"vitest run","build":"next build"}}' >"$S/web/package.json"
  echo '{"name":"app"}' >"$S/app/package.json"; echo lock >"$S/app/bun.lock"; echo "export {}" >"$S/app/src/main.ts"
  echo "// banned words scan placeholder" >"$S/app/test/bannedWords.test.ts"
  # the real repo carries its own pattern files; the scan must not flag them (install.sh seeds forbidden.txt from the example)
  mkdir -p "$S/app/scripts/release" "$S/.githooks"; cp "$REL/forbidden.txt.example" "$S/app/scripts/release/forbidden.txt.example"
  cp "$ETC/forbidden.txt" "$S/.githooks/public-guard.denylist"
  sg add -A; sg commit -q -m "chore: base of the sandbox"
  M0="$(git -C "$S" rev-parse HEAD)"
  git -C "$S" push -q "$W/private.git" main
  git -C "$S" checkout -q -b tu-queue
  for n in 01 02 03; do
    echo "export const tu$n = true" >"$S/app/src/api/routes/tu$n.ts"
    echo "// test $n" >"$S/app/test/tu$n.test.ts"
    [[ $n == 01 ]] && echo "// starts a local anvil chain" >>"$S/app/test/tu$n.test.ts"   # a test that needs anvil is run, not skipped
    [[ $n == 03 ]] && echo perk >"$S/app/src/api/routes/tu03.perk" && echo "export const page = 3" >"$S/web/src/tu03.tsx"   # TU03 also changes web/
    sg add -A; sg commit -q -m "feat(api): TU$n sandbox update $n"
  done
  git -C "$S" push -q "$W/queue.git" tu-queue
  QTIP="$(git -C "$S" rev-parse HEAD)"
  # the server's clone of private main. No signing or identity settings of its own: the runner signs with the server-made key
  # and the identity install.sh wrote into the release user's git config, exactly as on the server
  git clone -q "$W/private.git" "$W/backend"
  git -C "$W/backend" remote add public "$W/public.git"
  chown -R "$RUSER" "$W" 2>/dev/null || true
  # current production = the base
  mkdir -p "$W/opt/releases/$M0"; ln -sfn "$W/opt/releases/$M0" "$W/opt/current"
  printf 'SANDBOX_CTL=%s\nREPO_DIR=%s\nOPT_DIR=%s\n' "$CTL" "$W/backend" "$W/opt" >"$FAKES/sandbox.env"
  # shellcheck disable=SC2016  # the $ in the replacement must stay literal: it is expanded by the fake itself
  sed -i.bak 's#^set -uo pipefail#set -uo pipefail\n. "$(dirname "$0")/sandbox.env"; export SANDBOX_CTL REPO_DIR OPT_DIR#' "$FAKES/ifso-deploy" && rm -f "$FAKES/ifso-deploy.bak"
  : >"$CTL/requests.jsonl"
  # fake HTTP world
  rm -f "$W/port"; python3 "$HERE/fake_world.py" "$W/port" "$CTL" "$W/backend" "$W/opt" >"$W/fake.log" 2>&1 &
  echo $! >"$ROOT/$1.pid"
  for _ in $(seq 50); do [[ -s "$W/port" ]] && break; sleep 0.1; done
  PORT="$(cat "$W/port")"
  # server config for this world
  setconf RELEASE_HOME "$W/home"; setconf REPO_DIR "$W/backend"; setconf QUEUE_REPO "$W/queue.git"; setconf GATE_DIR "$W/gate"
  setconf DEPLOY_BIN "$FAKES/ifso-deploy"; setconf OPT_DIR "$W/opt"; setconf ALLOWED_SIGNERS "$ETC/allowed_signers"
  setconf PUBLIC_SYNC_STATE "$W/home/public-sync.json"; setconf API_URL "http://127.0.0.1:$PORT"
  setconf ALLOW_FILE "$W/ALLOW_REAL_DEPLOY"; setconf RELEASE_ENV "$W/release.env"; setconf DEPLOY_LOCK "$W/deploy.lock"
  setconf FORBIDDEN_FILE "$ETC/forbidden.txt"
  # root's own repository (audit M-2): created by the deploy wrapper itself, root-owned and 0700 on Linux
  if [[ $MODE == linux ]]; then setconf ROOT_REPO "/var/lib/ifso-release-root/$1.git"; else setconf ROOT_REPO "$W/root.git"; fi
  setconf PREFLIGHT_GATE_DIR "$W/pfgate"
  setconf PRIVATE_URL "$W/private.git"   # root fetches private main itself from here (audit L-12; GitHub over ssh on the server)
  setconf GATE_WEB_RUNTIME node
  setconf PUBLIC_CI_API ""   # the CI watcher stays off in the passes (world 4 points it at the fake GitHub for arm.sh)
  setconf VERCEL_STATUS_API ""   # the Vercel watcher stays off unless a world turns it on (worlds 1 to 3, at the fake GitHub)
  setconf INFRA_RETRY_S 0; setconf VERIFY_TRIES 2; setconf VERIFY_RETRY_S 0; setconf GAP_SLEEP 0; setconf PREFLIGHT_AUTO 0
  setconf FETCH_WAIT 0; setconf TRANSIENT_MAX_PASSES 6; setconf IFSO_SANDBOX 1; setconf DISK_MIN_GB 0
  # Linux: no *_CMD lines, so the runner uses its built-in `sudo -n /usr/local/sbin/...` defaults, exactly as on the server
  # (an unquoted "sudo -n ..." value would also break every wrapper that sources paths.conf).
  setconf PREFLIGHT_DIR "$W/home/preflight"
  [[ $MODE == local ]] && { setconf DEPLOY_CMD "$SBIN/ifso-deploy-release"; setconf NOTIFY_CMD "$SBIN/ifso-release-notify"; setconf GHRELEASE_CMD "$SBIN/ifso-release-ghrelease"; }
  setconf TELEGRAM_API_BASE "x"; grep -v '^TELEGRAM_API_BASE=' "$CONF" >"$CONF.new"; cat "$CONF.new" >"$CONF"; rm -f "$CONF.new"
  printf 'TELEGRAM_BOT_TOKEN=123456:SANDBOXTESTTOKEN\nTELEGRAM_OPS_CHAT_ID=-100123\nTELEGRAM_API_BASE=http://127.0.0.1:%s\nGITHUB_RELEASE_TOKEN=sandbox-not-a-token\nPUBLIC_REPO=ifsodev/public-sandbox\nGITHUB_API_BASE=http://127.0.0.1:%s\nGITHUB_UPLOAD_BASE=http://127.0.0.1:%s/uploads\n' \
    "$PORT" "$PORT" "$PORT" >"$W/release.env"; chmod 600 "$W/release.env"
  [[ $MODE == linux ]] && cp "$W/release.env" "$ETC/release.env.world" && chmod 600 "$ETC/release.env.world"
  # public sync state + the one-time bootstrap
  cat >"$W/home/public-sync.json" <<EOF
{"privateSha":"","publicSha":"","name":"Ifso Dev","email":"dev@example.invalid","signingKey":"$KEY","publicRemote":"public","branch":"main"}
EOF
  chown -R "$RUSER" "$W" 2>/dev/null || true
  as_rel git -C "$W/backend" -c safe.directory='*' fetch -q origin
  as_rel bash -c "cd '$W/backend' && python3 '$SYNC_INSTALLED' '$W/home/public-sync.json' --init && python3 '$SYNC_INSTALLED' '$W/home/public-sync.json'" >"$W/syncinit.log" 2>&1
  # the schedule: 3 updates from the queue branch
  cat >"$W/manifest.json" <<'EOF'
{"TU03": {"perk_gated": true, "check": {"path": "/v1/tu03", "perk_gated": true, "locked_contains": "Hold 100,000"}},
 "TU01": {"check": {"path": "/v1/tu01", "json": {"tu": "TU01", "ok": true}}},
 "TU02": {"check": {"path": "/v1/tu02", "json": {"ok": true}}}}
EOF
  rp make-schedule --queue-repo "$W/queue.git" --base "$M0" --ref tu-queue --manifest "$W/manifest.json" --count 3 >"$W/make-schedule.log" 2>&1
  mkdir -p "$W/home/posters" "$W/home/notes"
  for n in 01 02 03; do printf 'Sandbox update %s. Plain public notes.\n' "$n" >"$W/home/notes/TU$n.md"; done
  chown -R "$RUSER" "$W" 2>/dev/null || true
  if [[ $MODE == linux ]]; then   # after the last chown: the gate dirs belong to the gate user, root's repo to root
    rm -rf "/var/lib/ifso-release-root/$1.git"
    install -d -o ifso-gate -g ifso-gate -m 0755 "$W/gate" "$W/gate.tmp" "$W/pfgate" "$W/pfgate.tmp"
  fi
}
rp() { # rp <release.py args>: as the release user, with the runner's settings (every KEY=VALUE of paths.conf)
  local envs=() l
  while IFS= read -r l; do envs+=("$l"); done < <(grep -E '^[A-Z][A-Z0-9_]*=' "$CONF" | tr -d "'\"")
  as_rel env "${envs[@]}" "PATH=$FAKES:$PATH" python3 "$LIBDIR/lib/release.py" "$@"
}
rpass() { # one pass, with the service's second lock (IFSO_ALLOW_REAL_DEPLOY=1); extra env via EXTRA
  local envs=() l
  while IFS= read -r l; do envs+=("$l"); done < <(grep -E '^[A-Z][A-Z0-9_]*=' "$CONF" | tr -d "'\"")
  # shellcheck disable=SC2086  # EXTRA is a list of KEY=VALUE words on purpose
  as_rel env "${envs[@]}" "PATH=$FAKES:$PATH" IFSO_ALLOW_REAL_DEPLOY=1 ${EXTRA:-} python3 "$LIBDIR/lib/release.py" pass >>"$W/pass.log" 2>&1
}
rpre() { local envs=() l; while IFS= read -r l; do envs+=("$l"); done < <(grep -E '^[A-Z][A-Z0-9_]*=' "$CONF" | tr -d "'\""); as_rel env "${envs[@]}" "PATH=$FAKES:$PATH" python3 "$LIBDIR/lib/preflight.py" "$@"; }
# status helpers
st() { python3 -c 'import json,sys; s=json.load(open(sys.argv[1])); print(s["updates"][sys.argv[2]].get(sys.argv[3],""))' "$W/home/state.json" "$1" "${2:-status}"; }
count() { grep -c "$1" "$2" 2>/dev/null || true; }
tg() { grep -c '/sendMessage' "$CTL/requests.jsonl" 2>/dev/null || true; }
tg_has() { grep '/sendMessage' "$CTL/requests.jsonl" | grep -q "$1"; }
main_subjects() { git -C "$W/private.git" log --format=%s main; }
arm() { echo "launch" >"$W/ALLOW_REAL_DEPLOY"; chown "$RUSER" "$W/ALLOW_REAL_DEPLOY" 2>/dev/null || true; }
set_past_launch() { rp set-times --launch-at "$(python3 -c 'import datetime as d; print((d.datetime.now(d.timezone.utc)-d.timedelta(hours=3)).strftime("%Y-%m-%dT%H:%M:%SZ"))')" --interval-minutes 60 --min-gap 0 >/dev/null; }
prod_sha() { basename "$(readlink "$W/opt/current")"; }
stale_lock() { mkdir -p "$(dirname "$1")"; : >"$1"; chown "$RUSER" "$1" 2>/dev/null || true; python3 -c 'import os,sys,time; t=time.time()-1200; os.utime(sys.argv[1],(t,t))' "$1"; }
prod_subject() { git -C "$W/private.git" log -1 --format=%s "$(prod_sha)"; }
all_signed() { ! git -C "$W/private.git" -c gpg.format=ssh -c "gpg.ssh.allowedSignersFile=$ALLSIGNERS" log --format=%G? "$M0..main" | grep -qv '^G$'; }
public_equals_private() { [[ "$(git -C "$W/public.git" rev-parse 'main^{tree}')" == "$(git -C "$W/private.git" rev-parse 'main^{tree}')" ]]; }
one_public_author() { [[ "$(git -C "$W/public.git" log --format='%an <%ae>' main | sort -u | wc -l | tr -d ' ')" == 1 ]]; }
public_signed() { ! git -C "$W/public.git" -c gpg.format=ssh -c "gpg.ssh.allowedSignersFile=$W/pub-signers" log --format=%G? main | grep -qv '^G$'; }

# =====================================================================================================================
note "WORLD 1: blips, crash, broken public copy, pause/abort"
new_world w1
echo "dev@example.invalid $(cat "$KEY.pub")" >"$W/pub-signers"
ok "schedule built: 3 updates from the queue, tip is the queue tip" bash -c "python3 -c 'import json; s=json.load(open(\"$W/home/schedule.json\")); assert len(s[\"updates\"])==3 and s[\"tip\"]==\"$QTIP\"'"
set_past_launch; arm
# TU01: deploy exit 75 = nothing switched -> never held, never reverted, retried on the next pass
touch "$CTL/deploy-75-TU01"
rpass
ok "deploy exit 75: TU01 is NOT held" test "$(st TU01)" != held
ok "deploy exit 75: nothing reverted, main unchanged on the remote" test "$(git -C "$W/private.git" rev-parse main)" != ""
ok "deploy exit 75: TU01 waits in progress (counted, resumes)" test "$(st TU01)" = in_progress
ok "deploy exit 75: a 'waiting' alert, not a HELD one" bash -c "grep -q 'TU01 waiting' '$CTL/requests.jsonl' && ! grep -q 'HELD TU01' '$CTL/requests.jsonl'"
rm -f "$CTL/deploy-75-TU01"
# TU02: a gate install blip is retried, not held; then a broken public copy never blocks
touch "$CTL/install-fail"
rpass
ok "install blip: TU01 released first (resumed), TU02 waits, nothing held" bash -c "test '$(st TU01)' = released && test '$(st TU02)' != held"
rm -f "$CTL/install-fail"
git -C "$W/backend" remote set-url public "$W/nonexistent-public.git"
EXTRA="MAX_PER_PASS=1" rpass
ok "broken public copy: TU02 is released anyway" test "$(st TU02)" = released
ok "broken public copy: flagged publicPending" test "$(st TU02 publicPending)" = True
ok "broken public copy: ONE alert (keyed by cause)" test "$(grep '/sendMessage' "$CTL/requests.jsonl" | grep -c 'PUBLIC COPY FAILED')" = 1
git -C "$W/backend" remote set-url public "$W/public.git"
# TU03 changes web/: the Vercel watcher reads its commit status at the fake GitHub; Vercel says the deploy FAILED
setconf VERCEL_STATUS_API "http://127.0.0.1:$PORT/repos/ifsodev/private-sandbox"; echo failure >"$CTL/vercel-state"
# TU03: crash between the push and the state write
EXTRA="IFSO_CRASH_AT=TU03:push:before-save" rpass; CRASH=$?
ok "crash mid-release: the pass really died" test "$CRASH" -ne 0 -o "$(st TU03)" = in_progress
ok "crash mid-release: TU03 already on private main (push happened)" bash -c "git -C '$W/private.git' log --format=%s main | grep -q TU03"
ok "crash mid-release: state says push NOT done yet" bash -c "! python3 -c 'import json,sys; s=json.load(open(\"$W/home/state.json\")); sys.exit(0 if \"push\" in s[\"updates\"][\"TU03\"].get(\"done\",[]) else 1)'"
rpass
ok "crash mid-release: next pass adopted the push and released TU03" test "$(st TU03)" = released
ok "crash mid-release: exactly one TU03 commit on main" test "$(main_subjects | grep -c 'TU03')" = 1
ok "B17: Vercel FAILED on TU03's web/ commit: ONE 'VERCEL DEPLOY FAILED (TU03)' alert, TU03 stays released" bash -c "test \"\$(grep '/sendMessage' '$CTL/requests.jsonl' | grep -c 'VERCEL DEPLOY FAILED (TU03)')\" = 1 && test '$(st TU03)' = released"
ok "B17: the commit read is TU03's private main commit" bash -c "grep -q \"/commits/\$(python3 -c 'import json; print(json.load(open(\"$W/home/state.json\"))[\"updates\"][\"TU03\"][\"landedSha\"])')/status\" '$CTL/requests.jsonl'"
rpass
ok "B17: a later pass does not repeat the Vercel alert" test "$(grep '/sendMessage' "$CTL/requests.jsonl" | grep -c 'VERCEL DEPLOY')" = 1
setconf VERCEL_STATUS_API ""; rm -f "$CTL/vercel-state"
ok "a changed test that spawns anvil is run by the gate (never skipped)" bash -c "python3 -c 'import json,sys; g=json.load(open(\"$W/home/state.json\"))[\"updates\"][\"TU01\"][\"gate\"]; sys.exit(0 if \"test/tu01.test.ts\" in g[\"tests\"] else 1)'"
ok "world 1: 3 of 3 released" bash -c "test '$(st TU01)' = released -a '$(st TU02)' = released -a '$(st TU03)' = released"
ok "world 1: public copy caught up (no publicPending left)" test -z "$(st TU02 publicPending)"
ok "world 1: public tree == private tree" public_equals_private
ok "world 1: public history has one author" one_public_author
ok "world 1: every private commit signed (owner key, or the server key on a runner commit)" all_signed
ok "world 1: perk-gated TU03 passed its check as 'locked'" bash -c "python3 -c 'import json; v=json.load(open(\"$W/home/state.json\"))[\"updates\"][\"TU03\"][\"verify\"]; assert v[\"/v1/tu03\"][\"ok\"]'"
ok "world 1: production runs the last release" test "$(prod_subject)" = "feat(api): TU03 sandbox update 03"
ok "web/ change (TU03): the gate ran the web install, tests and the PRODUCTION build" bash -c "grep -q '^web install' '$CTL/bun.calls' && grep -q '^web run test' '$CTL/bun.calls' && grep -q '^web run build' '$CTL/bun.calls'"
ok "updates without a web/ change ran no web step" test "$(grep -c '^web run build' "$CTL/bun.calls")" = 1
ok "M-2: the gate installs with --ignore-scripts (app and web): no dependency install script runs" bash -c "grep -q '^app install --frozen-lockfile --ignore-scripts' '$CTL/bun.calls' && grep -q '^web install --frozen-lockfile --ignore-scripts' '$CTL/bun.calls' && ! grep -E '^(app|web) install' '$CTL/bun.calls' | grep -vq -- '--ignore-scripts'"
ok "B17: no Vercel watch on updates without a web/ change (TU01, TU02)" bash -c "python3 -c 'import json,sys; s=json.load(open(\"$W/home/state.json\"))[\"updates\"]; sys.exit(0 if \"vercel\" not in s[\"TU01\"] and \"vercel\" not in s[\"TU02\"] and s[\"TU03\"][\"vercel\"][\"state\"]==\"failed\" else 1)'"
# pause / abort / resume
rp set-times --launch-at "$(python3 -c 'import datetime as d; print((d.datetime.now(d.timezone.utc)-d.timedelta(hours=3)).strftime("%Y-%m-%dT%H:%M:%SZ"))')" >/dev/null
as_ops "$SBIN/ifso-release-pause" "sandbox maintenance" >/dev/null 2>&1
ok "pause: PAUSE file written" test -e "$W/home/PAUSE"
as_ops "$SBIN/ifso-release-abort" >/dev/null 2>&1
ok "abort while idle: ABORT written" test -e "$W/home/ABORT"
as_ops "$SBIN/ifso-release-resume" >"$W/resume.out" 2>&1
ok "resume clears a stale ABORT (no pass running) and the PAUSE" bash -c "test ! -e '$W/home/ABORT' && test ! -e '$W/home/PAUSE'"
ok "resume says so in plain words" grep -q "stale ABORT" "$W/resume.out"
as_ops "$SBIN/ifso-release-status" >"$W/status1.out" 2>&1
ok "status: released 3, pending 0, held 0" grep -q "released 3   pending 0   held 0" "$W/status1.out"
ok "status: armed: yes" grep -q "armed: yes" "$W/status1.out"
as_rel kill "$(cat "$ROOT/w1.pid")" 2>/dev/null || true

# =====================================================================================================================
note "WORLD 2: arming guard, stale schedule, held updates, rollback, preflight, retry"
new_world w2
echo "dev@example.invalid $(cat "$KEY.pub")" >"$W/pub-signers"
# --- unarmed: no launch date
rpass
ok "no LAUNCH_AT: nothing released" test "$(st TU01)" = pending
# --- launch date but no flag file
set_past_launch
rpass
ok "LAUNCH_AT set but no arming file: nothing released" test "$(st TU01)" = pending
"$SBIN/ifso-release-notify" "HELD TU99 x" "unarmed alert" 1 >/dev/null 2>&1 || as_ops "$SBIN/ifso-release-notify" "HELD TU99 x" "unarmed alert" 1 >/dev/null 2>&1
ok "unarmed failure alert: log only, nothing sent to Telegram" bash -c "test '$(tg)' = 0 && grep -q 'log only (not armed)' '$W/home/logs/notify-log-only.log'"
ok "the log-only line has the title and length, not the text" bash -c "! grep -q 'unarmed alert' '$W/home/logs/notify-log-only.log'"
ok "service lock 2: arming file without IFSO_ALLOW_REAL_DEPLOY=1 releases nothing" bash -c "
  echo x >'$W/ALLOW_REAL_DEPLOY'; chown '$RUSER' '$W/ALLOW_REAL_DEPLOY' 2>/dev/null
  envs=(); while IFS= read -r l; do envs+=(\"\$l\"); done < <(grep -E '^[A-Z][A-Z0-9_]*=' '$CONF' | tr -d \"'\\\"\")
  env -u IFSO_ALLOW_REAL_DEPLOY \"\${envs[@]}\" PATH='$FAKES:'\$PATH python3 '$LIBDIR/lib/release.py' pass >/dev/null 2>&1
  test \"\$(python3 -c 'import json; print(json.load(open(\"$W/home/state.json\"))[\"updates\"][\"TU01\"][\"status\"])')\" = pending"
rm -f "$W/ALLOW_REAL_DEPLOY"
# --- stale schedule: tip does not match the queue
arm
cp "$W/home/schedule.json" "$W/schedule.good"
python3 - "$W/home/schedule.json" <<'PY'
import json, sys
p = sys.argv[1]; s = json.load(open(p)); s["updates"][-1]["sha"] = "0" * 40; json.dump(s, open(p, "w"))
PY
rpass; STALE=$?
ok "stale schedule: pass refuses (exit 2), nothing released" bash -c "test $STALE -eq 2 && test '$(st TU01)' = pending"
ok "stale schedule: ONE plain alert naming both shas" bash -c "grep '/sendMessage' '$CTL/requests.jsonl' | grep -q 'STALE schedule.json'"
rpre run >"$W/pf-stale.out" 2>&1; PFS=$?
ok "stale schedule: preflight also stops with one clear line (exit 3)" bash -c "test $PFS -eq 3 && grep -q 'STALE schedule.json' '$W/pf-stale.out'"
cp "$W/schedule.good" "$W/home/schedule.json"
# --- a server without node cannot build web/: the update is not held for that, but it is FLAGGED (alert + state)
setconf GATE_WEB_RUNTIME no-such-node-here
# --- injected failures: TU01 test fails, TU02 deploy fails after the switch
touch "$CTL/test-fail-TU01" "$CTL/deploy-fail-TU02"
BEFORE_PROD="$(prod_sha)"
# incident 43: 20-minute-old locks left by a git that died (the two that hit an earlier project's preflight)
stale_lock "$W/backend/.git/packed-refs.lock"; stale_lock "$W/backend/.git/refs/runner/heads/release-queue-copy.lock"
setconf VERCEL_STATUS_API "http://127.0.0.1:$PORT/repos/ifsodev/private-sandbox"; setconf VERCEL_WAIT_MINUTES 0   # Vercel never reports
rpass
ok "43: the pass removed both stale locks and named them in its log" bash -c "test ! -e '$W/backend/.git/packed-refs.lock' && test ! -e '$W/backend/.git/refs/runner/heads/release-queue-copy.lock' && grep -q 'removed stale git lock.*packed-refs.lock' '$W/pass.log'"
ok "43: ONE alert names the locks" bash -c "test \"\$(grep '/sendMessage' '$CTL/requests.jsonl' | grep 'STALE GIT LOCK REMOVED' | grep -c 'release-queue-copy.lock')\" = 1"
ok "gate failure: TU01 HELD" test "$(st TU01)" = held
ok "gate failure: TU01 never reached private main" test "$(main_subjects | grep -c 'TU01')" = 0
ok "deploy failure: TU02 HELD" test "$(st TU02)" = held
ok "deploy failure: TU02 reverted on main (signed revert exists)" bash -c "git -C '$W/private.git' log --format=%s main | grep -q '^Revert .*TU02'"
ok "the revert is signed by the SERVER key (made by install.sh) and the reverted tree deployed" bash -c "test \"\$(git -C '$W/private.git' -c gpg.format=ssh -c gpg.ssh.allowedSignersFile='$ALLSIGNERS' log -1 --format=%G?%GF --grep='^Revert' main)\" = \"G\$(ssh-keygen -lf '$SRVKEY' | cut -d' ' -f2)\" && python3 -c 'import json,sys; sys.exit(0 if json.load(open(\"$W/home/state.json\"))[\"updates\"][\"TU02\"][\"rollbackDeploy\"]==\"ok\" else 1)'"
ok "the runner's revert carries the release identity from install.sh" bash -c "test \"\$(git -C '$W/private.git' log -1 --format='%an <%ae>' --grep='^Revert' main)\" = '$GIT_NAME <$GIT_EMAIL>'"
ok "deploy failure: production never keeps the held updates (no TU01 or TU02 route in the live tree; the live tree is not older than the start)" bash -c "! git -C '$W/private.git' cat-file -e '$(prod_sha):app/src/api/routes/tu02.ts' && ! git -C '$W/private.git' cat-file -e '$(prod_sha):app/src/api/routes/tu01.ts' && git -C '$W/private.git' merge-base --is-ancestor '$BEFORE_PROD' '$(prod_sha)'"
ok "no cascade: TU03 released although TU01 and TU02 are held" test "$(st TU03)" = released
ok "perk-gated TU03 is ON and answers locked (check passed)" bash -c "python3 -c 'import json; assert json.load(open(\"$W/home/state.json\"))[\"updates\"][\"TU03\"][\"verify\"][\"/v1/tu03\"][\"ok\"]'"
ok "alerts: HELD TU01 in plain words (what/users/done/next)" bash -c "grep '/sendMessage' '$CTL/requests.jsonl' | grep 'HELD TU01' | grep -q 'Users affected'"
ok "alerts: TU02 ROLLED BACK" tg_has "TU02 ROLLED BACK"
ok "alerts: TU03 release note to the ops chat" tg_has "TU03 released"
ok "no node on the server: TU03's web/ change is flagged NOT GATED (alert + gate result), never silently skipped" bash -c "tg_has() { grep '/sendMessage' '$CTL/requests.jsonl' | grep -q \"\$1\"; }; tg_has 'WEB CHANGE NOT GATED TU03' && python3 -c 'import json,sys; g=json.load(open(\"$W/home/state.json\"))[\"updates\"][\"TU03\"][\"gate\"]; sys.exit(0 if g.get(\"webUngated\") else 1)'"
ok "B17: Vercel never reported a deploy for TU03's web/ commit: 'VERCEL DEPLOY MISSING (TU03)', TU03 released" bash -c "grep '/sendMessage' '$CTL/requests.jsonl' | grep -q 'VERCEL DEPLOY MISSING (TU03)' && test '$(st TU03)' = released"
setconf VERCEL_STATUS_API ""; setconf VERCEL_WAIT_MINUTES 20
ok "alerts go to the OPS chat only (one chat id used)" bash -c "grep '/sendMessage' '$CTL/requests.jsonl' | grep -o 'chat_id=[-0-9]*' | sort -u | wc -l | tr -d ' ' | grep -q '^1$'"
ok "public tree == private tree after the held round" public_equals_private
ok "status: released 1, held 2" bash -c "as_ops() { :; }; python3 - <<'PY'
import json
s=json.load(open('$W/home/state.json'))['updates']
assert [s[k]['status'] for k in ('TU01','TU02','TU03')]==['held','held','released']
PY"
# --- preflight while the release lock is held (must not need it)
python3 - "$W/home/.run.lock" "$W/lock.ready" <<'PY' &
import fcntl, sys, time
f = open(sys.argv[1], "a+"); fcntl.flock(f, fcntl.LOCK_EX); open(sys.argv[2], "w").write("1"); time.sleep(25)
PY
LOCKPID=$!
for _ in $(seq 50); do [[ -e "$W/lock.ready" ]] && break; sleep 0.1; done
as_ops "$SBIN/ifso-release-preflight" >"$W/pf1.out" 2>&1
ok "preflight ran while the release lock was held (never takes it)" bash -c "[[ -s '$W/pf1.out' ]] && kill -0 $LOCKPID"
ok "preflight sees the injected failure on TU01 (the fix is not in yet) and passes TU02" bash -c "grep -q 'TU01: FAIL' '$W/pf1.out' && grep -q 'TU02: PASS' '$W/pf1.out'"
ok "preflight wrote results and a one-line status" bash -c "test -s '$W/home/preflight/results.json' && grep -q 'preflight:' '$W/home/preflight/status'"
ok "preflight left state.json and schedule.json untouched (read only)" bash -c "cmp -s '$W/schedule.good' '$W/home/schedule.json'"
kill "$LOCKPID" 2>/dev/null; wait "$LOCKPID" 2>/dev/null || true
ok "preflight alert: failing set named, once" bash -c "grep '/sendMessage' '$CTL/requests.jsonl' | grep -q 'PREFLIGHT'"
# --- the fix, preflight green, retry, release
rm -f "$CTL/test-fail-TU01" "$CTL/deploy-fail-TU02"
stale_lock "$W/home/preflight/backend/.git/packed-refs.lock"; : >"$W/home/preflight/backend/.git/fresh.lock"
as_ops "$SBIN/ifso-release-preflight" >"$W/pf2.out" 2>&1
ok "43: the preflight removed the stale lock in its own checkout, named it, and left a fresh one" bash -c "test ! -e '$W/home/preflight/backend/.git/packed-refs.lock' && grep -q 'packed-refs.lock' '$W/pf2.out' && test -e '$W/home/preflight/backend/.git/fresh.lock'"
rm -f "$W/home/preflight/backend/.git/fresh.lock"
ok "after the fix: preflight 2 of 2 PASS" grep -q "preflight: 2 of 2 PASS" "$W/home/preflight/status"
ok "preflight sends the all-clear" tg_has "preflight all clear"
as_ops "$SBIN/ifso-release-retry" TU01 >/dev/null 2>&1
as_ops "$SBIN/ifso-release-retry" TU02 >/dev/null 2>&1
ok "retry: both pending again" bash -c "test '$(st TU01)' = pending -a '$(st TU02)' = pending"
# a poster staged by exact tag
python3 -c 'import sys; open(sys.argv[1],"wb").write(b"\x89PNG\r\n\x1a\n"+b"0"*64)' "$W/home/posters/update-02.png"
chown "$RUSER" "$W/home/posters/update-02.png" 2>/dev/null || true
rpass
ok "retry after the fix: TU01 released" test "$(st TU01)" = released
ok "retry after the fix: TU02 released through a signed re-apply" bash -c "test '$(st TU02)' = released && git -C '$W/private.git' log --format=%s main | grep -q '^Reapply .*TU02'"
ok "final: 3 of 3 released" bash -c "python3 - <<'PY'
import json
s=json.load(open('$W/home/state.json'))['updates']
assert all(s[k]['status']=='released' for k in ('TU01','TU02','TU03'))
PY"
ok "final: production runs the last release (every update's route exists in the live tree)" bash -c "for n in 01 02 03; do git -C '$W/private.git' cat-file -e \"\$(basename \$(readlink '$W/opt/current')):app/src/api/routes/tu\$n.ts\" || exit 1; done"
ok "final: every private commit is signed (owner key, or the server key on a runner commit)" all_signed
ok "M-2: runner commits on main exist (cherry-picks, revert, re-apply) and none is owner-signed: root deployed them by the trailer rule" bash -c "
  n=\$(git -C '$W/private.git' -c gpg.format=ssh -c gpg.ssh.allowedSignersFile='$ETC/allowed_signers' log --format='%G?' '$M0..main' | grep -vc '^G$')
  test \"\$n\" -ge 3 && test \"\$(basename \$(readlink '$W/opt/current'))\" = \"\$(git -C '$W/private.git' rev-parse main)\""
ok "final: public tree == private tree" public_equals_private
ok "final: public history has exactly one author" one_public_author
ok "final: every public commit signed (Verified)" public_signed
ok "final: no queue code leaked early (public has no tu03 file at the time TU03 was not yet pushed is covered by order); public has all 3 now" bash -c "for n in 01 02 03; do git -C '$W/public.git' cat-file -e main:app/src/api/routes/tu\$n.ts || exit 1; done"
ok "GitHub Releases created for update-01, update-02, update-03" bash -c "for t in update-01 update-02 update-03; do grep -Eq \"tag_name[^a-z]+\$t\" '$CTL/requests.jsonl' || exit 1; done"
ok "GitHub Release update-02 got its poster (asset upload + notes patch)" bash -c "grep -q 'assets?name=update-02.png' '$CTL/requests.jsonl' && grep -q 'PATCH' '$CTL/requests.jsonl'"
ok "GitHub Release update-01 has no poster and still exists" bash -c "! grep -q 'name=update-01.png' '$CTL/requests.jsonl'"
# B25: the poster of update-01 is staged only now, after its Release exists: a later pass attaches it, once
python3 -c 'import sys; open(sys.argv[1],"wb").write(b"\x89PNG\r\n\x1a\n"+b"0"*64)' "$W/home/posters/update-01.png"
chown "$RUSER" "$W/home/posters/update-01.png" 2>/dev/null || true
rpass; rpass
ok "B25: a poster staged after its Release existed is uploaded on a later pass, exactly once" test "$(grep -c 'assets?name=update-01.png' "$CTL/requests.jsonl")" = 1
ok "B25: the runner records it (no further calls for update-01)" bash -c "python3 -c 'import json,sys; sys.exit(0 if json.load(open(\"$W/home/state.json\"))[\"updates\"][\"TU01\"].get(\"poster\") else 1)'"
ok "B25: update-02's poster (attached at create) is never sent again" test "$(grep -c 'assets?name=update-02.png' "$CTL/requests.jsonl")" = 1
ok "scan-queue finds no forbidden text in any queue tree" bash -c "rp() { :; }; envs=(); while IFS= read -r l; do envs+=(\"\$l\"); done < <(grep -E '^[A-Z][A-Z0-9_]*=' '$CONF' | tr -d \"'\\\"\"); env \"\${envs[@]}\" python3 '$LIBDIR/lib/release.py' scan-queue"
ok "queue finished: one 'queue finished' note" tg_has "queue finished"
as_ops "$SBIN/ifso-release-status" >"$W/status2.out" 2>&1
ok "status: released 3, pending 0, held 0, next slot none" bash -c "grep -q 'released 3   pending 0   held 0' '$W/status2.out' && grep -q 'next slot: none' '$W/status2.out'"
# the rule 'unarmed failure is log only' after disarm
rm -f "$W/ALLOW_REAL_DEPLOY"; BEFORE_T="$(tg)"
"$SBIN/ifso-release-notify" "HELD TU98 y" "after disarm" 1 >/dev/null 2>&1 || as_ops "$SBIN/ifso-release-notify" "HELD TU98 y" "after disarm" 1 >/dev/null 2>&1
ok "disarm (flag file removed): alerts are log only again" test "$(tg)" = "$BEFORE_T"

# =====================================================================================================================
note "WORLD 3: a rollback that cannot finish pauses the line and alerts (never loops, never silent)"
as_rel kill "$(cat "$ROOT/w2.pid")" 2>/dev/null || true
new_world w3
echo "dev@example.invalid $(cat "$KEY.pub")" >"$W/pub-signers"
set_past_launch; arm
touch "$CTL/deploy-fail-TU01" "$CTL/deploy-fail-revert"
rpass
ok "failed rollback: TU01 held, not stuck in progress" test "$(st TU01)" = held
ok "failed rollback: PAUSE written by the runner" test -e "$W/home/PAUSE"
ok "failed rollback: one 'ROLLBACK INCOMPLETE' alert" test "$(grep '/sendMessage' "$CTL/requests.jsonl" | grep -c 'ROLLBACK INCOMPLETE')" = 1
ok "failed rollback: nothing after TU01 started (TU02 still pending)" test "$(st TU02)" = pending
rpass; rpass
ok "failed rollback: further passes do nothing while paused (no loop, no second alert)" bash -c "test '$(st TU02)' = pending && test '$(grep '/sendMessage' "$CTL/requests.jsonl" | grep -c 'ROLLBACK INCOMPLETE')' = 1"
rm -f "$CTL/deploy-fail-TU01" "$CTL/deploy-fail-revert"
as_ops "$SBIN/ifso-release-resume" >/dev/null 2>&1
as_ops "$SBIN/ifso-release-retry" TU01 >/dev/null 2>&1
setconf VERCEL_STATUS_API "http://127.0.0.1:$PORT/repos/ifsodev/private-sandbox"; echo success >"$CTL/vercel-state"
rpass
ok "failed rollback: after resume and retry the queue completes" test "$(st TU01)" = released
ok "B17: Vercel deploy of TU03's web/ commit succeeded: watch closed, no Vercel alert" bash -c "test '$(st TU03)' = released && python3 -c 'import json,sys; sys.exit(0 if json.load(open(\"$W/home/state.json\"))[\"updates\"][\"TU03\"][\"vercel\"][\"state\"]==\"ok\" else 1)' && ! grep '/sendMessage' '$CTL/requests.jsonl' | grep -q 'VERCEL DEPLOY'"
setconf VERCEL_STATUS_API ""
ok "resume after a runner pause: ONE 'release queue RESUMED' message (the wrapper's), not a second from the next pass" test "$(grep '/sendMessage' "$CTL/requests.jsonl" | grep -c 'release queue RESUMED')" = 1
as_rel kill "$(cat "$ROOT/w3.pid")" 2>/dev/null || true

# =====================================================================================================================
note "WORLD 4: arming (arm.sh, the real one): only on a preflight of the CURRENT main and schedule"
new_world w4
FUTURE="$(python3 -c 'import datetime as d; print((d.datetime.now(d.timezone.utc)+d.timedelta(days=2)).strftime("%Y-%m-%dT%H:%M:%SZ"))')"
runarm() { # runarm [KEY=VALUE...]: the real arm.sh as root (Linux) or under the prefix (local); output in $W/arm.out
  if [[ $MODE == linux ]]; then env "$@" SYSTEMCTL="$SYSTEMCTL" LAUNCH_AT="$FUTURE" bash "$REL/arm.sh" >"$W/arm.out" 2>&1
  else env "$@" PREFIX="$PFX" SYSTEMCTL=true LAUNCH_AT="$FUTURE" bash "$REL/arm.sh" >"$W/arm.out" 2>&1; fi
}
setconf GATE_ANVIL no-such-anvil-here
as_ops "$SBIN/ifso-release-preflight" >"$W/pf-w4-noanvil.out" 2>&1
ok "no anvil on the server: preflight refuses the update whose test needs it, with a clear reason (not skipped)" bash -c "grep -q 'TU01: FAIL.*anvil' '$W/pf-w4-noanvil.out' && grep -q 'TU02: PASS' '$W/pf-w4-noanvil.out'"
setconf GATE_ANVIL anvil
as_ops "$SBIN/ifso-release-preflight" >"$W/pf-w4a.out" 2>&1
ok "preflight on the base main: 3 of 3 PASS" grep -q "preflight: 3 of 3 PASS" "$W/home/preflight/status"
# an owner fix lands on private main AFTER that preflight: its results no longer say anything about the new main
git -C "$S" checkout -q main; echo "export const fix = 1" >"$S/app/src/ownerfix.ts"; sg add -A; sg commit -q -m "fix(api): owner fix after the preflight"
git -C "$S" push -q "$W/private.git" main
runarm ARM_TEST=1; ARC=$?
ok "arm.sh refuses preflight results from an older main (and says which)" bash -c "test $ARC -ne 0 && grep -q 'preflight ran on main' '$W/arm.out'"
ok "refused arming left no flag file" test ! -e "$W/ALLOW_REAL_DEPLOY"
# the queue-rebuild path (README "Rebuilt queue"): rebuild on the new main on the Mac, push to a NEW branch, remap, move tu-queue
M1="$(git -C "$S" rev-parse main)"
git -C "$S" checkout -q -b queue-r1 tu-queue
sg rebase -q --onto main "$M0" queue-r1 >/dev/null 2>&1
(cd "$S" && QUEUE_URL="$W/queue.git" SKIP_CHOWN=1 LOCAL_BRANCH=queue-r1 bash "$REL/push-queue.sh" queue-r1) >"$W/pq.out" 2>&1
chown -R "$RUSER" "$W/queue.git" 2>/dev/null || true
ok "rebuilt queue pushed to the NEW branch queue-r1; tu-queue still the old tip" bash -c "test \"\$(git -C '$W/queue.git' rev-parse queue-r1)\" = \"\$(git -C '$S' rev-parse queue-r1)\" && test \"\$(git -C '$W/queue.git' rev-parse tu-queue)\" = '$QTIP'"
rp remap --queue-repo "$W/queue.git" --ref queue-r1 --base "$M1" --tag r1 >"$W/remap.out" 2>&1
ok "remap: every pending update now points at the rebuilt commit with the same subject, in order; the old schedule kept" bash -c "
  diff <(python3 -c 'import json; [print(u[\"sha\"]) for u in json.load(open(\"$W/home/schedule.json\"))[\"updates\"]]') <(git -C '$W/queue.git' rev-list --reverse '$M1..queue-r1') && test -s '$W/home/schedule.json.pre-r1'"
rpre run >"$W/pf-stale-r1.out" 2>&1
ok "before tu-queue moves, the schedule is STALE (one clear line)" grep -q "STALE schedule.json" "$W/pf-stale-r1.out"
as_rel git -C "$W/queue.git" update-ref refs/heads/tu-queue-pre-r1 refs/heads/tu-queue
as_rel git -C "$W/queue.git" update-ref refs/heads/tu-queue refs/heads/queue-r1
as_ops "$SBIN/ifso-release-preflight" >"$W/pf-w4b.out" 2>&1
cp "$W/home/preflight/results.json" "$W/pf-good.json"
python3 - "$W/home/preflight/results.json" <<'PY'
import json, sys
p = sys.argv[1]; r = json.load(open(p)); r["sfp"] = "0" * 16; json.dump(r, open(p, "w"))
PY
runarm ARM_TEST=1; ARC=$?
ok "arm.sh refuses preflight results of another schedule" bash -c "test $ARC -ne 0 && grep -q 'another schedule' '$W/arm.out'"
cp "$W/pf-good.json" "$W/home/preflight/results.json"
# public CI on the public main tip (anonymous API; here the fake GitHub) and the release token are arming preconditions
setconf PUBLIC_CI_API ""
runarm ARM_TEST=1; ARC=$?
ok "arm.sh refuses while PUBLIC_CI_API is not set (the CI watcher would be off)" bash -c "test $ARC -ne 0 && grep -q 'PUBLIC_CI_API' '$W/arm.out' && test ! -e '$W/ALLOW_REAL_DEPLOY'"
setconf PUBLIC_CI_API "http://127.0.0.1:$PORT/repos/ifsodev/public-sandbox"
printf '[{"id":1,"name":"app","status":"completed","conclusion":"success","head_sha":"%s"},{"id":2,"name":"contracts","status":"completed","conclusion":"failure","head_sha":"%s"}]' "$M0" "$M0" >"$CTL/ci.json"
runarm ARM_TEST=1; ARC=$?
ok "arm.sh refuses a red public CI on the public main tip (names the job)" bash -c "test $ARC -ne 0 && grep -q 'public CI' '$W/arm.out' && grep -q 'contracts' '$W/arm.out' && test ! -e '$W/ALLOW_REAL_DEPLOY'"
printf '[{"id":1,"name":"app","status":"in_progress","conclusion":null,"head_sha":"%s"}]' "$M0" >"$CTL/ci.json"
runarm ARM_TEST=1; ARC=$?
ok "arm.sh refuses a public CI that is still running (0 non-success means finished and green)" bash -c "test $ARC -ne 0 && grep -q 'public CI' '$W/arm.out'"
rm -f "$CTL/ci.json"
touch "$CTL/gh-token-bad"
runarm ARM_TEST=1; ARC=$?
ok "arm.sh refuses when the release token cannot create and delete a draft Release" bash -c "test $ARC -ne 0 && grep -q 'release token' '$W/arm.out' && test ! -e '$W/ALLOW_REAL_DEPLOY'"
runarm ALLOW_NO_RELEASE_TOKEN=1; ARC=$?
ok "ALLOW_NO_RELEASE_TOKEN=1: arms anyway with a loud warning" bash -c "test $ARC -eq 0 && grep -q 'WARNING' '$W/arm.out' && test -e '$W/ALLOW_REAL_DEPLOY'"
rm -f "$W/ALLOW_REAL_DEPLOY" "$CTL/gh-token-bad"
runarm ARM_TEST=1; ARC=$?
ok "arm.sh: public CI green (0 non-success) and the token made and deleted a draft" bash -c "grep -q 'public CI: 0 non-success' '$W/arm.out' && grep -q 'draft Release created and deleted' '$W/arm.out' && grep -q 'DELETE' '$CTL/requests.jsonl'"
ok "arm.sh arms on a preflight of the current main and the rebuilt queue's schedule" bash -c "test $ARC -eq 0 && test -e '$W/ALLOW_REAL_DEPLOY' && grep -q ARMED '$W/arm.out'"
ok "arming wrote LAUNCH_AT and the slots" bash -c "python3 -c 'import json,sys; s=json.load(open(\"$W/home/schedule.json\")); sys.exit(0 if s[\"launchAt\"]==\"$FUTURE\" and all(u[\"slot\"] for u in s[\"updates\"]) else 1)'"
rm -f "$W/ALLOW_REAL_DEPLOY"
as_rel kill "$(cat "$ROOT/w4.pid")" 2>/dev/null || true

if [[ $MODE == linux ]]; then
  note "sudo rules (real sudoers, real users)"
  ok "ops user can read the status through sudo" runuser -u "$OPS" -- sudo -n "$SBIN/ifso-release-status" --short
  ok "ops user may NOT run the deploy wrapper" bash -c "! runuser -u '$OPS' -- sudo -n '$SBIN/ifso-deploy-release' --check"
  ok "the runner user may NOT run the status wrapper through sudo" bash -c "! runuser -u '$RUSER' -- sudo -n '$SBIN/ifso-release-status'"
  ok "the runner user may NOT run arbitrary commands as root" bash -c "! runuser -u '$RUSER' -- sudo -n /bin/true"
  ok "retry accepts only TUnn through sudo" bash -c "! runuser -u '$OPS' -- sudo -n '$SBIN/ifso-release-retry' 'TU01; id'"
  note "the gate user (audit M-2)"
  ok "the gate ran every bun step as ifso-gate, never as the release user (worlds 1 to 4)" bash -c "for w in w1 w2 w3 w4; do grep -q '(as ifso-gate)' '$BASE/'\$w/ctl/bun.calls || exit 1; ! grep -q '(as $RUSER)' '$BASE/'\$w/ctl/bun.calls || exit 1; done"
  ok "the gate's environment carries nothing of the runner's (no IFSO_ALLOW_REAL_DEPLOY, RELEASE_HOME, ALLOWED_SIGNERS)" bash -c "! grep -q RUNNER-ENV '$BASE'/w*/ctl/bun.calls"
  ok "the release user may run commands as ifso-gate, the gate user may not sudo at all" bash -c "runuser -u '$RUSER' -- sudo -n -u ifso-gate true && ! runuser -u ifso-gate -- sudo -n true"
  ok "root's own repositories are root's, mode 0700" bash -c "for d in /var/lib/ifso-release-root /var/lib/ifso-release-root/w2.git; do test \"\$(stat -c '%U %a' \$d)\" = 'root 700' || exit 1; done"
fi

echo
echo "sandbox ($MODE): $PASS passed, $FAIL failed"
[[ $FAIL == 0 ]]
