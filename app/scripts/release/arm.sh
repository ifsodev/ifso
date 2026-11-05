#!/usr/bin/env bash
# ARMING: the last step before launch, one command, on the server as root.
#     sudo LAUNCH_AT=2026-11-17T14:00:00Z bash arm.sh
# Refuses unless: LAUNCH_AT is UTC ISO with a Z and in the future; the forbidden-word scan of every queue tree finds nothing and
# the REAL sync-public.py --dry-run at the queue tip passes (release.py sync-dry-run; incident 39);
# schedule.json is current (base in main, tip == queue branch); the last preflight ran on the CURRENT private main and the
# CURRENT schedule (results.main == origin/main, results.sfp == the schedule's fingerprint), tested every pending and held
# update and passed them all; public CI on the public main tip finished with 0 non-success (release.py arm-check, anonymous
# GitHub API); no url.*.insteadOf in the release user's git config, origin answers the clone's main, and the server RUNS that main
# (root's own fetch of private main agrees; incidents 47, 48); the server's signing key is not in allowed_signers; root pins tu-queue (owner-signed tip, the tip the passing preflight tested: audit I-19) in queue-pin (audit L-13,
# common.sh pin_queue); the release token created and deleted a draft Release (ifso-release-ghrelease --check-token). Going without
# GitHub Releases needs ALLOW_NO_RELEASE_TOKEN=1 and prints a WARNING. Then it writes the 72 slots (hourly from LAUNCH_AT), creates the flag file ALLOW_REAL_DEPLOY and enables
# the timer. Disarm = delete the flag file (the timer may stay on; a pass without the flag does nothing and alerts nobody).
# Pause = ifso-release-pause. Test knobs: PREFIX, SYSTEMCTL (sandbox only). There is no knob that skips a check.
set -euo pipefail
PREFIX="${PREFIX:-}"; SYSTEMCTL="${SYSTEMCTL:-systemctl}"
LIB="${IFSO_RELEASE_LIB:-$PREFIX/usr/local/lib/ifso-release}"
SBIN_DIR="$PREFIX/usr/local/sbin"
export IFSO_RELEASE_CONF="${IFSO_RELEASE_CONF:-$PREFIX/etc/ifso-release/paths.conf}"
# shellcheck disable=SC1091
. "$LIB/common.sh"
[[ -n "$PREFIX" || "$(id -u)" == 0 ]] || die "run as root"
: "${LAUNCH_AT:?usage: sudo LAUNCH_AT=2026-11-17T14:00:00Z bash arm.sh}"
[[ "$LAUNCH_AT" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ ]] || die "LAUNCH_AT must be UTC like 2026-11-17T14:00:00Z"
[[ "$(date -u -d "$LAUNCH_AT" +%s 2>/dev/null || python3 -c 'import sys,datetime as d; print(int(d.datetime.strptime(sys.argv[1],"%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=d.timezone.utc).timestamp()))' "$LAUNCH_AT")" -gt "$(date -u +%s)" ]] \
  || [[ "${ALLOW_PAST_LAUNCH:-0}" == 1 && -n "$PREFIX" ]] || die "LAUNCH_AT is not in the future"
say "1/5 queue clean"
release_py scan-queue || die "forbidden text in the queue: fix it, rebuild, replace schedule.json"
say "1b/5 the real publish step (sync-public.py --dry-run) over every queued tree and message (incident 39)"
release_py sync-dry-run || die "the public copy of a queued update would be refused: fix the queue (or add a scrub rule / forbiddenSkipPaths), rebuild, replace schedule.json"
say "2/5 schedule current, preflight of the CURRENT main and schedule all PASS"
release_py arm-check || die "not armed: fix what is REFUSED above (sudo ifso-release-preflight after any change to main or schedule.json)"
say "2a/5 root's own fetch of private main agrees (incidents 47, 48; audit L-12)"
root_tip="$(root_fetch_main 2>&1)" || true; root_tip="${root_tip##*$'\n'}"
is_sha "$root_tip" || die "root could not fetch private main from PRIVATE_URL: $root_tip"
clone_tip="$(as_rel git -c safe.directory='*' -C "$REPO_DIR" rev-parse --verify refs/remotes/origin/main 2>/dev/null || true)"
[[ "$clone_tip" == "$root_tip" ]] || die "the release clone's origin/main (${clone_tip:0:12}) is not private main as root fetches it (${root_tip:0:12}): a stand-in origin? (incident 47)"
[[ "$(current_rev)" == "$root_tip" ]] || die "the server runs $(current_rev | cut -c1-12), private main is ${root_tip:0:12}: deploy main first (incident 48)"
say "root's own fetch of private main: ${root_tip:0:12} = the release clone's origin/main = the running release"
say "2b0/5 the server's own signing key is NOT an allowed signer (audit M-2)"
if [[ -n "$PREFIX" && -n "${GIT_CONFIG_GLOBAL:-}" ]]; then rcfg="$GIT_CONFIG_GLOBAL"; else rcfg="$(getent passwd "$RELEASE_USER" | cut -d: -f6)/.gitconfig"; fi
srvpub="$(git config --file "$rcfg" --get user.signingkey 2>/dev/null || true)"
[[ -r "$srvpub" ]] || die "cannot read the runner's signing key ($rcfg user.signingkey): install.sh sets it"
srvkey="$(cut -d' ' -f2 "$srvpub")"
{ [[ -n "$srvkey" ]] && ! grep -qF "$srvkey" "$ALLOWED_SIGNERS"; } \
  || die "the server's own signing key is in $ALLOWED_SIGNERS: remove it (owner keys only; audit M-2), or everything the runner signs is deployable"
say "allowed_signers holds no server key"
say "2c/5 root pins the queue (audit L-13): runner cherry-picks and reverts are accepted only for commits of this queue"
pftip="$(preflight_tip)" || die "the queue could not be pinned: $pftip"
pin="$(pin_queue --expect "$pftip")" || die "the queue could not be pinned: $pin"
say "$pin"
say "2b/5 release token (GitHub Releases with posters)"
if ! tok="$("$SBIN_DIR/ifso-release-ghrelease" --check-token 2>&1)"; then
  if [[ "${ALLOW_NO_RELEASE_TOKEN:-0}" == 1 ]]; then
    say "WARNING: arming WITHOUT working GitHub Releases ($tok). Releases go out without GitHub Releases until the token works."
  else
    die "the release token does not work: $tok. Save GITHUB_RELEASE_TOKEN and PUBLIC_REPO in release.env (README), or arm with ALLOW_NO_RELEASE_TOKEN=1 to go without GitHub Releases"
  fi
else
  say "$tok"
fi
say "3/5 slots"
release_py set-times --launch-at "$LAUNCH_AT" --interval-minutes 60 --min-gap 2
say "4/5 flag file"
install -m 0644 /dev/null "$ALLOW_FILE"
say "5/5 timer"
[[ -n "$PREFIX" ]] || "$SYSTEMCTL" enable --now ifso-release.timer
say "ARMED. First slot $LAUNCH_AT. Check: sudo ifso-release-status"
