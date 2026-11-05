#!/usr/bin/env bash
# The Linux proof: the SAME sandbox as run-sandbox.sh, inside a throwaway Ubuntu container as root, with the REAL install.sh
# (real users, real sudoers checked by visudo, runuser, the runner reaching every wrapper through `sudo -n`). Needs Docker (or a
# compatible `docker` command) on the machine that runs it. Nothing leaves the container; the repo is mounted read-only.
#   bash app/scripts/release/sandbox/docker-sandbox.sh [26.04|24.04|all]
# Default 26.04: the project server's OS (Ubuntu 26.04 LTS), where `sudo` and `visudo` are sudo-rs (0.2.13 on the server), not
# classic sudo. sudo-rs rejects settings and argument patterns classic sudo accepts, so a proof on 24.04 alone missed two sudoers
# bugs (runbook 2026-11-05). The container asserts `sudo --version` says sudo-rs before it runs anything. 24.04 (classic sudo)
# stays as an extra run: the sudoers file must stay valid for both. `all` runs both, 26.04 first.
# Needs docs/tools/sync-public.py (private tooling); set SYNC_PUBLIC_PY to its path when it is not found next to the repo.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REL="$(cd "$HERE/.." && pwd)"
SYNC_PY="${SYNC_PUBLIC_PY:-$REL/../../../../docs/tools/sync-public.py}"
# pinned by digest (multi-arch index), so the proof runs on the same image every time
IMG_2604="ubuntu:26.04@sha256:6a06111c3b0a8600feadb270aec771dc239bf407b25625f93f44ab00e11f4d3c"
IMG_2404="ubuntu:24.04"
command -v docker >/dev/null || { echo "docker not found: install Docker (or colima) here; the --linux sandbox never runs on a real server" >&2; exit 2; }
[[ -f "$SYNC_PY" ]] || { echo "sync-public.py not found (set SYNC_PUBLIC_PY)" >&2; exit 2; }
case "${1:-26.04}" in
  26.04) runs=(26.04) ;;
  24.04) runs=(24.04) ;;
  all) runs=(26.04 24.04) ;;
  *) echo "usage: docker-sandbox.sh [26.04|24.04|all]" >&2; exit 2 ;;
esac
rc=0
for os in "${runs[@]}"; do
  if [[ $os == 26.04 ]]; then img="$IMG_2604"; want=sudo-rs; else img="$IMG_2404"; want=classic; fi
  echo "== Linux proof on Ubuntu $os ($img), sudo: $want"
  docker run --rm \
    -v "$REL:/release:ro" -v "$SYNC_PY:/tools/sync-public.py:ro" -e SYNC_PUBLIC_PY=/tools/sync-public.py -e IFSO_SANDBOX_CONTAINER=1 \
    -e WANT_SUDO="$want" "$img" bash -c '
      set -euo pipefail
      export DEBIAN_FRONTEND=noninteractive
      apt-get update -qq >/dev/null
      apt-get install -y -qq git python3 openssh-client sudo curl ca-certificates util-linux >/dev/null
      v="$(sudo --version 2>&1 | head -1)"; echo "sudo: $v"
      if [[ $WANT_SUDO == sudo-rs ]]; then
        [[ $v == sudo-rs* ]] || { echo "FAIL: this image does not use sudo-rs as sudo (the server does)"; exit 3; }
        visudo --version 2>&1 | head -1 | grep -q "^visudo-rs" || { echo "FAIL: visudo is not sudo-rs visudo"; exit 3; }
      else
        [[ $v == "Sudo version"* ]] || { echo "FAIL: this image does not use classic sudo"; exit 3; }
      fi
      git config --global --add safe.directory "*"
      cp -r /release /tmp/release-copy      # install.sh and the sandbox write next to themselves
      bash /tmp/release-copy/sandbox/run-sandbox.sh --linux
    ' || rc=1
done
exit $rc
