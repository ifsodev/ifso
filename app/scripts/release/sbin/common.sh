# shellcheck shell=bash
# Shared by the root-owned wrappers in /usr/local/sbin (ifso-deploy-release, ifso-release-notify, ifso-release-status, ...).
# Installed to /usr/local/lib/ifso-release/common.sh. Settings come from /etc/ifso-release/paths.conf (root-owned, KEY=VALUE
# lines, no secrets). Test overrides (IFSO_RELEASE_CONF, IFSO_RELEASE_LIB, IFSO_RELEASE_TEST_PATH) are honoured ONLY when the
# script was not started through sudo (SUDO_UID unset): through sudo the environment is reset anyway, and this closes the
# door a second time.
set -euo pipefail
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
umask 027
CONF=/etc/ifso-release/paths.conf
if [[ -z "${SUDO_UID:-}" && -n "${IFSO_RELEASE_CONF:-}" ]]; then CONF="$IFSO_RELEASE_CONF"; fi
if [[ -z "${SUDO_UID:-}" && -n "${IFSO_RELEASE_TEST_PATH:-}" ]]; then PATH="$IFSO_RELEASE_TEST_PATH:$PATH"; fi
[[ -r "$CONF" ]] || { echo "no $CONF" >&2; exit 1; }
# shellcheck disable=SC1090
. "$CONF"
: "${RELEASE_USER:?}" "${RELEASE_HOME:?}" "${REPO_DIR:?}" "${DEPLOY_BIN:?}" "${OPT_DIR:?}" "${ALLOWED_SIGNERS:?}" "${RUNNER_LIB:?}"
ETC_DIR="${ETC_DIR:-/etc/ifso-release}"
ALLOW_FILE="${ALLOW_FILE:-$ETC_DIR/ALLOW_REAL_DEPLOY}"
RELEASE_ENV="${RELEASE_ENV:-$ETC_DIR/release.env}"
DEPLOY_LOCK="${DEPLOY_LOCK:-/run/ifso-deploy.lock}"
die() { printf '%s: %s\n' "$(basename "$0")" "$*" >&2; exit 1; }
say() { printf '[%s %s] %s\n' "$(basename "$0")" "$(date -u +%H:%M:%S)" "$*"; }
# as_rel: run a command as the release user (root only; in tests the caller already is that user)
as_rel() { if [[ "$(id -u)" == 0 && "$RELEASE_USER" != "$(id -un)" ]]; then runuser -u "$RELEASE_USER" -- "$@"; else "$@"; fi; }
caller() { printf '%s' "${SUDO_USER:-$(id -un)}"; }
is_sha() { [[ "$1" =~ ^[0-9a-f]{40}$ ]]; }
# The runner reads its settings from the environment: every KEY=VALUE line of paths.conf is handed to it explicitly.
runner_env() { grep -E '^[A-Z][A-Z0-9_]*=' "$CONF" | tr -d "'\""; echo "RELEASE_HOME=$RELEASE_HOME"; }
# release_py <args...>: run lib/release.py as the release user with the runner's settings
release_py() {
  local envs=()
  while IFS= read -r l; do envs+=("$l"); done < <(runner_env)
  as_rel env "${envs[@]}" python3 "$RUNNER_LIB/release.py" "$@"
}
# Real deploys are armed only by the root-owned file ALLOW_REAL_DEPLOY (arm.sh LAUNCH_AT=... creates it).
real_deploy_guard() { [[ -e "$ALLOW_FILE" ]] || die "real deploys are NOT armed ($ALLOW_FILE does not exist): refusing"; }
# the revision running now: the release directory /opt/ifso/current points at (named by the full sha)
current_rev() { basename "$(readlink "$OPT_DIR/current" 2>/dev/null)" 2>/dev/null || true; }
# rgit: git as root on the release user's clone ($REPO_DIR). The release user owns that clone, so its .git/config is
# attacker-controlled and must never decide what root runs: only that one directory is trusted for ownership (a command-line
# setting; there is NO global safe.directory=*), the global and system configs are ignored, and the config keys that can launch a
# program are overridden. Use it for read-only plumbing (rev-parse, cat-file, rev-list, merge-base), never to verify signatures.
rgit() {
  GIT_NO_REPLACE_OBJECTS=1 GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null git -c "safe.directory=$REPO_DIR" -c core.fsmonitor= \
    -c core.hooksPath=/dev/null -c core.sshCommand= -c core.pager=cat "$@"
}
# verify_signed <40-hex sha>: is that commit of $REPO_DIR signed by a key in $ALLOWED_SIGNERS? The commit object is copied out of
# the release user's clone into a fresh root-owned scratch repository and verified there with ssh-keygen pinned on the command
# line, so nothing the release user planted in its own clone (gpg.ssh.program, includes, hooks, replace refs) takes part.
# Prints git's last line on failure; returns non-zero.
verify_signed() {
  local c="$1" scratch id out rc=0 keygen
  keygen="$(command -v ssh-keygen)" || { echo "ssh-keygen not found"; return 1; }
  scratch="$(mktemp -d "${TMPDIR:-/tmp}/ifso-verify.XXXXXX")" || return 1
  if ! GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null git init -q --bare "$scratch"; then rm -rf "$scratch"; return 1; fi
  id="$(rgit -C "$REPO_DIR" cat-file commit "$c" | GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null git -C "$scratch" hash-object -t commit -w --stdin)" || id=""
  if [[ "$id" != "$c" ]]; then rm -rf "$scratch"; echo "could not copy commit $c"; return 1; fi
  out="$(GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null git -C "$scratch" -c gpg.format=ssh -c "gpg.ssh.program=$keygen" \
    -c "gpg.ssh.allowedSignersFile=$ALLOWED_SIGNERS" -c gpg.ssh.revocationFile= verify-commit "$c" 2>&1)" || rc=$?
  rm -rf "$scratch"
  [[ $rc == 0 ]] || printf '%s' "$out" | tail -1
  return $rc
}
