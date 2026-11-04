#!/usr/bin/env bash
# Installs the Ifso release runner on the server, UNARMED (timer disabled, no flag file). Run ON THE SERVER as root, from a
# checkout of this folder:
#   sudo RELEASE_GIT_NAME="<name>" RELEASE_GIT_EMAIL="<email>" bash install.sh
# RELEASE_GIT_NAME / RELEASE_GIT_EMAIL: the identity of the commits the runner makes itself on private main (cherry-picks,
# reverts, re-applies). Use an account that is a member of the Vercel team that builds web/ (the owner's GitHub noreply
# address), or Vercel skips the build of a rollback. Stored in paths.conf; a later run without them reuses those values.
# Safe to run again. Arming is a separate, single step (arm.sh) on launch day.
#
# What it makes:
#   user ifso-release (home /var/lib/ifso-release), group ifso-ops (the people who may use the ifso-release-* commands)
#   /usr/local/lib/ifso-release   the runner (lib/), common.sh, README
#   /usr/local/sbin/ifso-*        the root-owned wrappers (deploy-release, release-notify, release-ghrelease, status, ...)
#   /etc/ifso-release             paths.conf (no secrets), allowed_signers, forbidden.txt, release.env (0600, root)
#   /etc/sudoers.d/ifso-release   checked with visudo -cf before it is installed and visudo -c after
#   /etc/systemd/system           ifso-release.service + ifso-release.timer (NOT enabled)
#   three ssh keys made HERE (never copied from a Mac): private deploy key, public deploy key, signing key
# Test knobs (sandbox only): PREFIX=<dir> installs under a directory without users or systemctl; SYSTEMCTL=<cmd>.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PREFIX="${PREFIX:-}"
SYSTEMCTL="${SYSTEMCTL:-systemctl}"
[[ -n "$PREFIX" || "$(id -u)" == 0 ]] || { echo "run as root (sudo bash install.sh)" >&2; exit 1; }
say() { printf '[install] %s\n' "$*"; }
P() { printf '%s%s' "$PREFIX" "$1"; }
RUSER=ifso-release
RHOME=/var/lib/ifso-release
die() { printf '[install] %s\n' "$*" >&2; exit 1; }
# conf_get KEY: the value already in paths.conf (quotes stripped), or nothing
conf_get() { [[ -r "$(P /etc/ifso-release/paths.conf)" ]] && sed -n "s/^$1=//p" "$(P /etc/ifso-release/paths.conf)" | tail -1 | tr -d "\"'" || true; }
# conf_set KEY VALUE: replace or add one line (double-quoted: the wrappers source the file with bash)
conf_set() {
  local f; f="$(P /etc/ifso-release/paths.conf)"
  grep -v "^$1=" "$f" >"$f.new" || true
  printf '%s="%s"\n' "$1" "$2" >>"$f.new"; cat "$f.new" >"$f"; rm -f "$f.new"
}
# ---- the runner's git identity: without it git refuses (or guesses) every commit the runner makes, so every rollback pauses
GIT_NAME="${RELEASE_GIT_NAME:-$(conf_get RELEASE_GIT_NAME)}"
GIT_EMAIL="${RELEASE_GIT_EMAIL:-$(conf_get RELEASE_GIT_EMAIL)}"
[[ -n "$GIT_NAME" && -n "$GIT_EMAIL" && "$GIT_NAME$GIT_EMAIL" != *CHANGE_ME* ]] \
  || die "no git identity for the runner's commits: sudo RELEASE_GIT_NAME='<name>' RELEASE_GIT_EMAIL='<email>' bash install.sh (README, 'Install on the server')"
[[ "$GIT_EMAIL" =~ ^[^@[:space:]]+@[^@[:space:]]+$ && "$GIT_NAME" != *[\"\'\$\`]* ]] || die "RELEASE_GIT_EMAIL must look like an email and RELEASE_GIT_NAME must not contain quotes or \$"
if [[ -z "$PREFIX" ]]; then
  getent group ifso-ops >/dev/null || groupadd --system ifso-ops
  id "$RUSER" >/dev/null 2>&1 || useradd --system --user-group --home-dir "$RHOME" --create-home --shell /bin/bash "$RUSER"
  install -d -o "$RUSER" -g "$RUSER" -m 0750 "$RHOME"
fi
OWN=(-m 0750); [[ -z "$PREFIX" ]] && OWN=(-o "$RUSER" -g "$RUSER" -m 0750)
install -d "${OWN[@]}" "$(P $RHOME/home)" "$(P $RHOME/home/logs)" "$(P $RHOME/home/notes)" "$(P $RHOME/home/posters)" "$(P $RHOME/.ssh)"
install -d -m 0755 "$(P /usr/local/lib/ifso-release/lib)" "$(P /usr/local/sbin)" "$(P /etc/ifso-release)" "$(P /etc/systemd/system)"
for f in "$HERE"/lib/*.py; do [[ "$(basename "$f")" == test_* ]] || install -m 0644 "$f" "$(P /usr/local/lib/ifso-release/lib)/"; done
install -m 0644 "$HERE/sbin/common.sh" "$(P /usr/local/lib/ifso-release/common.sh)"
install -m 0644 "$HERE/README.md" "$(P /usr/local/lib/ifso-release/README.md)"
for w in "$HERE"/sbin/ifso-*; do install -m 0755 "$w" "$(P /usr/local/sbin)/$(basename "$w")"; done
# the sync tool is private tooling shipped next to this folder by push-to-server.sh; copy it when present
[[ -f "$HERE/sync-public.py" ]] && install -m 0644 "$HERE/sync-public.py" "$(P /usr/local/lib/ifso-release/lib)/sync-public.py"
CONF="$(P /etc/ifso-release/paths.conf)"
if [[ ! -e "$CONF" ]]; then
  cat >"$CONF" <<CONF
# Settings of the release runner, read by the service and by every wrapper. Plain paths and URLs only. Root-owned.
RELEASE_USER=$RUSER
RELEASE_HOME=$RHOME/home
REPO_DIR=$RHOME/backend
QUEUE_REPO=$RHOME/queue.git
GATE_DIR=$RHOME/gate
DEPLOY_BIN=/usr/local/sbin/ifso-deploy
OPT_DIR=/opt/ifso
ALLOWED_SIGNERS=$(P /etc/ifso-release/allowed_signers)
RUNNER_LIB=$(P /usr/local/lib/ifso-release/lib)
SYNC_PUBLIC_PY=$(P /usr/local/lib/ifso-release/lib/sync-public.py)
NOTIFY_BIN=$(P /usr/local/sbin/ifso-release-notify)
PUBLIC_SYNC_STATE=$RHOME/home/public-sync.json
FORBIDDEN_FILE=$(P /etc/ifso-release/forbidden.txt)
API_URL=http://127.0.0.1:8080
PUBLIC_COMMIT_URL=https://github.com/CHANGE_ME/CHANGE_ME/commit/{sha}
CONF
  chmod 0644 "$CONF"
fi
conf_set RELEASE_GIT_NAME "$GIT_NAME"
conf_set RELEASE_GIT_EMAIL "$GIT_EMAIL"
chmod 0644 "$CONF"
# ---- the release user's global git config, written to its file directly (also under PREFIX, where the sandbox points
# GIT_CONFIG_GLOBAL at it): identity, never a guessed one, and every runner commit signed with the server's signing key
GITCFG="$(P $RHOME/.gitconfig)"
gc() { git config --file "$GITCFG" "$@"; }
gc user.name "$GIT_NAME"
gc user.email "$GIT_EMAIL"
gc user.useConfigOnly true
[[ -z "$PREFIX" ]] && chown "$RUSER:$RUSER" "$GITCFG" && chmod 0644 "$GITCFG"
[[ -e "$(P /etc/ifso-release/allowed_signers)" ]] || install -m 0644 /dev/null "$(P /etc/ifso-release/allowed_signers)"
[[ -e "$(P /etc/ifso-release/forbidden.txt)" ]] || install -m 0644 "$HERE/forbidden.txt.example" "$(P /etc/ifso-release/forbidden.txt)"
[[ -e "$(P /etc/ifso-release/release.env)" ]] || {
  install -m 0600 /dev/null "$(P /etc/ifso-release/release.env)"
  printf '%s\n' '# root, 0600. TELEGRAM_BOT_TOKEN= / TELEGRAM_OPS_CHAT_ID= (owner and developer chat) / HEALTHCHECK_PING_URL=' \
    '# GITHUB_RELEASE_TOKEN= (fine-grained, public repo only, Contents read/write) / PUBLIC_REPO=owner/name' >"$(P /etc/ifso-release/release.env)"
}
if [[ ! -e "$(P $RHOME/queue.git)" && -z "$PREFIX" ]]; then
  as_r() { runuser -u "$RUSER" -- "$@"; }
  as_r git init -q --bare "$RHOME/queue.git"
fi
# ---- units and sudoers (the timer is NOT enabled here)
install -m 0644 "$HERE/systemd/ifso-release.service" "$HERE/systemd/ifso-release.timer" "$(P /etc/systemd/system)/"
TMP="$(mktemp)"; cp "$HERE/sudoers" "$TMP"
if command -v visudo >/dev/null 2>&1; then
  visudo -cf "$TMP" >/dev/null || { echo "the sudoers file is invalid: nothing installed" >&2; rm -f "$TMP"; exit 1; }
fi
install -m 0440 "$TMP" "$(P /etc/sudoers.d/ifso-release)" 2>/dev/null || { mkdir -p "$(P /etc/sudoers.d)"; install -m 0440 "$TMP" "$(P /etc/sudoers.d/ifso-release)"; }
rm -f "$TMP"
if [[ -z "$PREFIX" ]]; then
  command -v visudo >/dev/null 2>&1 && visudo -c >/dev/null
  "$SYSTEMCTL" daemon-reload
  "$SYSTEMCTL" disable --now ifso-release.timer >/dev/null 2>&1 || true
  # ---- three keys, made on the server; GitHub refuses one key as both a deploy key and an account key, hence three
  as_r() { runuser -u "$RUSER" -- "$@"; }
  for k in private public signing; do
    [[ -e "$RHOME/.ssh/id_ed25519_$k" ]] || as_r ssh-keygen -q -t ed25519 -N '' -C "ifso-release-$k" -f "$RHOME/.ssh/id_ed25519_$k"
  done
  if [[ ! -e "$RHOME/.ssh/config" ]]; then
    as_r tee "$RHOME/.ssh/config" >/dev/null <<SSH
Host github-ifso-private
  HostName github.com
  User git
  IdentityFile $RHOME/.ssh/id_ed25519_private
  IdentitiesOnly yes
Host github-ifso-public
  HostName github.com
  User git
  IdentityFile $RHOME/.ssh/id_ed25519_public
  IdentitiesOnly yes
SSH
    as_r chmod 600 "$RHOME/.ssh/config"
  fi
  as_r git config --file "$GITCFG" gpg.format ssh
  as_r git config --file "$GITCFG" user.signingkey "$RHOME/.ssh/id_ed25519_signing.pub"
  as_r git config --file "$GITCFG" commit.gpgsign true
  as_r git config --file "$GITCFG" gpg.ssh.allowedSignersFile /etc/ifso-release/allowed_signers
  as_r git config --file "$GITCFG" safe.directory '*'
  echo
  echo "Installed UNARMED (timer disabled, no flag file). Public keys, to register on GitHub:"
  echo "  private repo, WRITE deploy key : $(cat "$RHOME/.ssh/id_ed25519_private.pub")"
  echo "  public repo,  WRITE deploy key : $(cat "$RHOME/.ssh/id_ed25519_public.pub")"
  echo "  public account, SIGNING key    : $(cat "$RHOME/.ssh/id_ed25519_signing.pub")"
  echo "Next: README.md section 'Install on the server' (allowed_signers, clone, queue, release.env, rehearsal), then arm.sh."
else
  say "installed under $PREFIX (sandbox mode: no users, no systemctl)"
fi
