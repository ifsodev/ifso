#!/usr/bin/env bash
# The Linux proof: the SAME sandbox as run-sandbox.sh, inside Ubuntu 24.04 as root, with the REAL install.sh (real users, real
# sudoers checked by visudo, runuser, the runner reaching every wrapper through `sudo -n`). Needs Docker (or a compatible
# `docker` command) on the machine that runs it. Nothing leaves the container; the repo is mounted read-only.
#   bash app/scripts/release/sandbox/docker-sandbox.sh
# Needs docs/tools/sync-public.py (private tooling); set SYNC_PUBLIC_PY to its path when it is not found next to the repo.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REL="$(cd "$HERE/.." && pwd)"
SYNC_PY="${SYNC_PUBLIC_PY:-$REL/../../../../docs/tools/sync-public.py}"
command -v docker >/dev/null || { echo "docker not found: run the VPS rehearsal from README.md ('Linux proof') instead" >&2; exit 2; }
[[ -f "$SYNC_PY" ]] || { echo "sync-public.py not found (set SYNC_PUBLIC_PY)" >&2; exit 2; }
docker run --rm \
  -v "$REL:/release:ro" -v "$SYNC_PY:/tools/sync-public.py:ro" -e SYNC_PUBLIC_PY=/tools/sync-public.py \
  ubuntu:24.04 bash -c '
    set -euo pipefail
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -qq >/dev/null
    apt-get install -y -qq git python3 openssh-client sudo curl ca-certificates util-linux >/dev/null
    git config --global --add safe.directory "*"
    cp -r /release /tmp/release-copy      # install.sh and the sandbox write next to themselves
    bash /tmp/release-copy/sandbox/run-sandbox.sh --linux
  '
