#!/usr/bin/env bash
# Installs the Ifso release runner on the server, UNARMED (timer disabled, no flag file). Run ON THE SERVER as root, from a
# checkout of this folder:   sudo bash install.sh
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
  as_r git config --global gpg.format ssh
  as_r git config --global user.signingkey "$RHOME/.ssh/id_ed25519_signing.pub"
  as_r git config --global commit.gpgsign true
  as_r git config --global gpg.ssh.allowedSignersFile /etc/ifso-release/allowed_signers
  as_r git config --global safe.directory '*'
  echo
  echo "Installed UNARMED (timer disabled, no flag file). Public keys, to register on GitHub:"
  echo "  private repo, WRITE deploy key : $(cat "$RHOME/.ssh/id_ed25519_private.pub")"
  echo "  public repo,  WRITE deploy key : $(cat "$RHOME/.ssh/id_ed25519_public.pub")"
  echo "  public account, SIGNING key    : $(cat "$RHOME/.ssh/id_ed25519_signing.pub")"
  echo "Next: README.md section 'Install on the server' (allowed_signers, clone, queue, release.env, rehearsal), then arm.sh."
else
  say "installed under $PREFIX (sandbox mode: no users, no systemctl)"
fi
