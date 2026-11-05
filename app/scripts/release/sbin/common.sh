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
# rel_read <path relative to RELEASE_HOME> <max bytes> [tail lines]: print a release-user file the safe way (audit L-11). Read AS
# the release user, every component opened with O_NOFOLLOW from RELEASE_HOME down (itself not a symlink either), a regular file
# only, at most <max bytes> (or its last <tail lines> lines). Exit 2: it does not exist; 1: refused (symlink, not a regular file).
rel_read() {
  as_rel python3 -I -c '
import os, stat, sys
home, rel, mx, tl = sys.argv[1], sys.argv[2], int(sys.argv[3]), int(sys.argv[4])
parts = [p for p in rel.split("/") if p]
if not parts or any(p in (".", "..") for p in parts):
    sys.exit(1)
try:
    fd = os.open(home, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    for p in parts[:-1]:
        fd = os.open(p, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
    fd = os.open(parts[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)
except FileNotFoundError:
    sys.exit(2)
except OSError:
    sys.exit(1)
st = os.fstat(fd)
if not stat.S_ISREG(st.st_mode):
    sys.exit(1)
if tl:
    os.lseek(fd, max(0, st.st_size - mx), 0)
    data = os.read(fd, mx).decode("utf-8", "replace").splitlines()[-tl:]
    sys.stdout.write("\n".join(data) + ("\n" if data else ""))
else:
    sys.stdout.write(os.read(fd, mx).decode("utf-8", "replace"))
' "$RELEASE_HOME" "$1" "$2" "${3:-0}"
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
  GIT_NO_REPLACE_OBJECTS=1 GIT_GRAFT_FILE=/dev/null GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null git -c "safe.directory=$REPO_DIR" -c core.fsmonitor= -c core.commitGraph=false \
    -c core.hooksPath=/dev/null -c core.sshCommand= -c core.pager=cat "$@"
}
# ---- root's own repository (audit M-2). Every check root makes on a commit (ancestry, signatures, patch-ids) runs in
# $ROOT_REPO: root-owned, mode 0700, config-free (hooks, fsmonitor, pager, commit graph, grafts, replace refs pinned off). Its
# objects come from fetches whose packs root's own git indexes (every object hashed), and the remote side of a fetch from a
# release-user repository runs AS the release user (rel_upload_pack), so nothing the release user planted runs as root.
ROOT_REPO="${ROOT_REPO:-/var/lib/ifso-release-root/private.git}"
QUEUE_REPO="${QUEUE_REPO:-}"
sgit() {
  GIT_NO_REPLACE_OBJECTS=1 GIT_GRAFT_FILE=/dev/null GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null git -C "$ROOT_REPO" \
    -c core.fsmonitor= -c core.commitGraph=false -c core.hooksPath=/dev/null -c core.sshCommand= -c core.pager=cat "$@"
}
rel_upload_pack() { if [[ "$(id -u)" == 0 && "$RELEASE_USER" != "$(id -un)" ]]; then printf 'runuser -u %s -- git upload-pack' "$RELEASE_USER"; else printf 'git upload-pack'; fi; }
root_repo_init() {
  if [[ ! -d "$ROOT_REPO" ]]; then
    (umask 077 && mkdir -p "$ROOT_REPO" && GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null git init -q --bare "$ROOT_REPO") || { echo "cannot create $ROOT_REPO"; return 1; }
  fi
  if [[ "$(id -u)" == 0 && "$(stat -c '%u %a' "$ROOT_REPO" 2>/dev/null)" != "0 700" ]]; then echo "$ROOT_REPO must be root's, mode 0700"; return 1; fi
}
# root_fetch_local <release-user repo path> <refspec...>
root_fetch_local() { local src="$1"; shift; sgit fetch -q --no-tags --no-write-fetch-head --upload-pack "$(rel_upload_pack)" "$src" "$@"; }
# root_fetch_main: root's own copy of private main (audit L-12), fetched by root from PRIVATE_URL (paths.conf, root-owned) into
# $ROOT_REPO refs/heads/main. Over ssh with ROOT_SSH_KEY (a read-only deploy key, root 0600) and GitHub's host key pinned in
# ROOT_KNOWN_HOSTS; a local path (the sandbox's stand-in origin) is read with the release user's upload-pack. The release user's
# clone, its config and its refs never decide what "on private main" means. Prints the main sha.
ROOT_SSH_KEY="${ROOT_SSH_KEY:-$ETC_DIR/root_deploy_key}"
ROOT_KNOWN_HOSTS="${ROOT_KNOWN_HOSTS:-$ETC_DIR/github_known_hosts}"
root_fetch_main() {
  local url="${PRIVATE_URL:-}"
  [[ -n "$url" && "$url" != *CHANGE_ME* ]] || { echo "PRIVATE_URL is not set in paths.conf (install.sh PRIVATE_GITHUB_REPO=<owner>/<repo>)"; return 1; }
  root_repo_init || return 1
  if [[ -d "$url" ]]; then
    sgit fetch -q --no-tags --no-write-fetch-head --upload-pack "$(rel_upload_pack)" "$url" "+refs/heads/main:refs/heads/main" || { echo "fetch of main from $url failed"; return 1; }
  else
    [[ "$url" =~ ^git@github\.com:[A-Za-z0-9._-]+/[A-Za-z0-9._-]+\.git$ ]] || { echo "PRIVATE_URL must be git@github.com:<owner>/<repo>.git"; return 1; }
    [[ -r "$ROOT_SSH_KEY" && -r "$ROOT_KNOWN_HOSTS" ]] || { echo "no $ROOT_SSH_KEY or $ROOT_KNOWN_HOSTS (install.sh makes them)"; return 1; }
    GIT_SSH_COMMAND="ssh -F /dev/null -i $ROOT_SSH_KEY -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=$ROOT_KNOWN_HOSTS" \
      sgit fetch -q --no-tags --no-write-fetch-head "$url" "+refs/heads/main:refs/heads/main" || { echo "fetch of main from $url failed"; return 1; }
  fi
  sgit rev-parse --verify refs/heads/main
}
# ensure_commit <sha>: the commit is in root's repo, fetched from the queue repo when it is a queued commit not on main yet
ensure_commit() {
  sgit cat-file -e "$1^{commit}" 2>/dev/null && return 0
  [[ -n "$QUEUE_REPO" ]] && root_fetch_local "$QUEUE_REPO" "+refs/heads/*:refs/queue/*" >/dev/null 2>&1
  sgit cat-file -e "$1^{commit}" 2>/dev/null
}
# owner_signed <sha>: signed by a key in $ALLOWED_SIGNERS (OWNER keys only), ssh-keygen pinned on the command line. Prints
# git's last line on failure.
owner_signed() {
  local out rc=0 keygen
  keygen="$(command -v ssh-keygen)" || { echo "ssh-keygen not found"; return 1; }
  out="$(sgit -c gpg.format=ssh -c "gpg.ssh.program=$keygen" -c "gpg.ssh.allowedSignersFile=$ALLOWED_SIGNERS" -c gpg.ssh.revocationFile= \
    verify-commit "$1" 2>&1)" || rc=$?
  [[ $rc == 0 ]] || printf '%s' "$out" | tail -1
  return $rc
}
# pid_of <a> <b>: git patch-id --verbatim of the diff a..b (binary content in, renames off): only line numbers do not count
pid_of() { sgit diff --no-ext-diff --no-textconv --no-renames --binary --full-index "$1" "$2" | sgit patch-id --verbatim | cut -d' ' -f1; }
# commit_ok <sha> [depth]: may this first-parent commit reach production? Yes when it is signed by an owner key, or when it is a
# runner commit (one parent; the server key's signature counts for nothing) whose LAST trailer names a source X that is accepted:
#   (cherry picked from commit X)   X signed by an owner key, and the same patch
#   This reverts commit X.          X an ancestor, accepted itself (a revert, a re-apply), and the exact inverse patch
# Prints the reason when refused. lib/release.py runner_commit_problem is the same rule (the runner checks before it pushes).
commit_ok() {
  local c="$1" d="${2:-0}" sig line x n a b
  sig="$(owner_signed "$c")" && return 0
  (( d < 4 )) || { echo "runner commits nested too deep"; return 1; }
  n="$(sgit rev-list --parents -n 1 "$c" | wc -w | tr -d ' ')"
  [[ "$n" == 2 ]] || { echo "not signed by an owner key ($sig) and not a runner commit"; return 1; }
  line="$(sgit log -1 --format=%B "$c" | grep -E '^(\(cherry picked from commit [0-9a-f]{40}\)|This reverts commit [0-9a-f]{40}\.)$' | tail -1 || true)"
  [[ -n "$line" ]] || { echo "not signed by an owner key ($sig) and names no owner-signed source"; return 1; }
  x="$(grep -oE '[0-9a-f]{40}' <<<"$line")"
  ensure_commit "$x" || { echo "names ${x:0:12}, which root cannot find (not on main, not in the queue)"; return 1; }
  if [[ "$line" == "(cherry picked"* ]]; then
    sig="$(owner_signed "$x")" || { echo "cherry-pick of ${x:0:12}, which is not signed by an owner key ($sig)"; return 1; }
    a="$(pid_of "$x^" "$x")"; b="$(pid_of "$c^" "$c")"
    [[ -n "$a" && "$a" == "$b" ]] || { echo "not the same patch as ${x:0:12}, the owner-signed commit it says it picks"; return 1; }
    return 0
  fi
  sgit merge-base --is-ancestor "$x" "$c^" || { echo "reverts ${x:0:12}, which is not an ancestor of it"; return 1; }
  sig="$(commit_ok "$x" $((d + 1)))" || { echo "reverts ${x:0:12}, which is not accepted itself: $sig"; return 1; }
  a="$(pid_of "$x^" "$x")"; b="$(pid_of "$c" "$c^")"
  [[ -n "$a" && "$a" == "$b" ]] || { echo "not the exact inverse patch of ${x:0:12}, the commit it says it reverts"; return 1; }
}
