#!/usr/bin/env bash
# ARMING: the last step before launch, one command, on the server as root.
#     sudo LAUNCH_AT=2026-11-17T14:00:00Z bash arm.sh
# Refuses unless: LAUNCH_AT is UTC ISO with a Z and in the future; schedule.json is current (base in main, tip == queue
# branch); the forbidden-word scan of every queue tree finds nothing; the last preflight passed on the current main (all
# pending updates). Then it writes the 72 slots (hourly from LAUNCH_AT), creates the flag file ALLOW_REAL_DEPLOY and enables
# the timer. Disarm = delete the flag file (the timer may stay on; a pass without the flag does nothing and alerts nobody).
# Pause = ifso-release-pause. Test knobs: PREFIX, SYSTEMCTL, SKIP_PREFLIGHT_CHECK=1 (sandbox only).
set -euo pipefail
PREFIX="${PREFIX:-}"; SYSTEMCTL="${SYSTEMCTL:-systemctl}"
LIB="${IFSO_RELEASE_LIB:-$PREFIX/usr/local/lib/ifso-release}"
export IFSO_RELEASE_CONF="${IFSO_RELEASE_CONF:-$PREFIX/etc/ifso-release/paths.conf}"
# shellcheck disable=SC1091
. "$LIB/common.sh"
[[ -n "$PREFIX" || "$(id -u)" == 0 ]] || die "run as root"
: "${LAUNCH_AT:?usage: sudo LAUNCH_AT=2026-11-17T14:00:00Z bash arm.sh}"
[[ "$LAUNCH_AT" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ ]] || die "LAUNCH_AT must be UTC like 2026-11-17T14:00:00Z"
[[ "$(date -u -d "$LAUNCH_AT" +%s 2>/dev/null || python3 -c 'import sys,datetime as d; print(int(d.datetime.strptime(sys.argv[1],"%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=d.timezone.utc).timestamp()))' "$LAUNCH_AT")" -gt "$(date -u +%s)" ]] \
  || [[ "${ALLOW_PAST_LAUNCH:-0}" == 1 && -n "$PREFIX" ]] || die "LAUNCH_AT is not in the future"
say "1/5 schedule current and queue clean"
release_py scan-queue || die "forbidden text in the queue: fix it, rebuild, replace schedule.json"
if [[ "${SKIP_PREFLIGHT_CHECK:-0}" != 1 ]]; then
  say "2/5 preflight on the current main"
  release_py status --short >/dev/null
  pf="$RELEASE_HOME/preflight/results.json"
  [[ -r "$pf" ]] || die "no preflight results: run sudo ifso-release-preflight first"
  python3 - "$pf" <<'PY' || die "the last preflight has failures or is stale: run sudo ifso-release-preflight and fix them"
import json, sys
r = json.load(open(sys.argv[1]))
sys.exit(0 if r.get("main") and not r.get("failing") and not r.get("stale") else 1)
PY
fi
say "3/5 slots"
release_py set-times --launch-at "$LAUNCH_AT" --interval-minutes 60 --min-gap 2
say "4/5 flag file"
install -m 0644 /dev/null "$ALLOW_FILE"
say "5/5 timer"
[[ -n "$PREFIX" ]] || "$SYSTEMCTL" enable --now ifso-release.timer
say "ARMED. First slot $LAUNCH_AT. Check: sudo ifso-release-status"
