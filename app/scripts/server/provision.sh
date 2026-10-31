#!/usr/bin/env bash
# Prepares a fresh Ubuntu 24.04 server (Cherry Servers VPS, 2-4 GB RAM) to run the Ifso backend. Run as root ON THE SERVER,
# from this folder (it reads ./systemd, ./Caddyfile, ./env.example, ./backup.sh and ./deploy.sh). Safe to run again: every
# step checks the current state first.
#
#   PROFILE=testnet bash provision.sh        everything below (PROFILE is testnet or mainnet, required the first time)
#   bash provision.sh --units-only           only (re)install the systemd units, Caddyfile-independent scripts, backup and deploy
#   bash provision.sh --fix-key-perms        only re-own /etc/ifso/keys for the service users (after you copy key files in)
#   bash provision.sh --cohost [--check]     testnet on a server that already runs another project's live services: touches
#                                            nothing of theirs (see provision-cohost.sh); --check only reads. Do NOT run the
#                                            plain mode on such a server: it upgrades packages and restarts Postgres-side services.
#
# What it does: apt upgrade; git, build tools, jq; UTC clock with NTP; a swap file when there is none; Postgres 16 (no
# extensions) with an `ifso` role and one database (ifso_testnet or ifso_mainnet); Redis 7 on 127.0.0.1 with a password and
# the noeviction policy BullMQ needs; Bun 1.4.4 and Foundry's cast 1.8.4 (checksum-verified downloads); Caddy; ufw allowing
# only 22, 80 and 443; fail2ban; unattended security upgrades; the `ifso` user (owns the code and the deploy key) and one
# service user per role, `ifso-api`, `ifso-bot` and `ifso-worker` (review R2-L3: an RCE in the public API must not reach the
# keeper or resolver key); /etc/ifso/{common,api,bot,worker,db}.env (0600, root); /etc/ifso/keys (root, 0711, not listable):
# relayer.* owned by ifso-api, keeper.* and resolver.* owned by ifso-worker, all 0600, the bot gets none; the systemd units;
# the daily backup timer; /usr/local/sbin/ifso-deploy and ifso-backup; a deploy key for the private repo.
#
# Env (all optional except PROFILE on the first run; saved to /etc/ifso/provision.conf and reused):
#   PROFILE    testnet | mainnet
#   DOMAIN     e.g. api.<your-domain>. The domain is not bought yet: blank = Caddy serves plain HTTP on port 80.
#   REPO_URL   git URL of the backend repo to clone into /opt/ifso/repo (blank = an empty repo; add the remote yourself)
#   SWAP_SIZE  default 2G when the server has no swap (0 = never add swap)
#
# It never creates, reads or moves your wallet keys: /etc/ifso/keys starts empty and you copy the keystores in.
#
# sudo note: Ubuntu 24.04 ships classic sudo (Ubuntu 25.10 and later ship sudo-rs). Both pass almost no environment
# variables through, which is why deploy.sh reads everything from files in /etc/ifso. If you add a sudoers rule for a helper
# user, list the exact command (/usr/local/sbin/ifso-deploy) and check it with `visudo -cf` and `sudo -l -U <user>`.
set -euo pipefail

BUN_VERSION="1.4.4"
FOUNDRY_VERSION="1.8.4"

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ETC=/etc/ifso
CONF="$ETC/provision.conf"
KEYS_DIR="$ETC/keys"

log() { printf '[provision %s] %s\n' "$(date -u +%H:%M:%S)" "$*"; }
warn() { printf '[provision] WARNING: %s\n' "$*" >&2; }
die() { printf 'provision: %s\n' "$*" >&2; exit 1; }

if [[ "${1:-}" == --cohost ]]; then
  [[ -f "$HERE/provision-cohost.sh" ]] || die "missing $HERE/provision-cohost.sh: run provision.sh from the app/scripts/server folder"
  shift
  exec bash "$HERE/provision-cohost.sh" "$@"
fi

UNITS_ONLY=0
KEYS_ONLY=0
case "${1:-}" in
  "") ;;
  --units-only) UNITS_ONLY=1 ;;
  --fix-key-perms | --service-users) KEYS_ONLY=1 ;;
  -h | --help) sed -n '2,32p' "$0"; exit 0 ;;
  *) die "unknown argument $1 (try --help)" ;;
esac

[[ "$(id -u)" == 0 ]] || die "run as root"
for f in systemd/ifso.target Caddyfile env.example backup.sh deploy.sh; do
  [[ -e "$HERE/$f" ]] || die "missing $HERE/$f: run provision.sh from the app/scripts/server folder"
done
cd /

ensure_service_users() { # one Unix user per role (review R2-L3); state lives in each unit's StateDirectory
  local u
  for u in ifso-api ifso-bot ifso-worker; do
    if ! id "$u" >/dev/null 2>&1; then
      log "creating the $u system user"
      useradd --system --user-group --home-dir "/var/lib/$u" --no-create-home --shell /usr/sbin/nologin "$u"
    fi
  done
}

ensure_keys() { # only the role that uses a key can read it: relayer -> ifso-api; keeper, resolver -> ifso-worker
  local f owner
  id ifso >/dev/null 2>&1 || die "the ifso user is missing: run provision.sh without arguments first"
  ensure_service_users
  install -d -o root -g root -m 0711 "$KEYS_DIR"
  for f in "$KEYS_DIR"/*; do
    [[ -f "$f" ]] || continue
    case "$(basename "$f")" in
      relayer.json | relayer.password) owner=ifso-api ;;
      keeper.json | keeper.password | resolver.json | resolver.password) owner=ifso-worker ;;
      *.json | *.password) owner=root; warn "$f is not a key name this server knows (relayer, keeper, resolver): readable by root only" ;;
      *) warn "$f is not a .json keystore or .password file: left as it is"; continue ;;
    esac
    chown "$owner:$owner" "$f"; chmod 0600 "$f"
  done
}

install_units() {
  local f dest changed=0
  for f in "$HERE"/systemd/*.service "$HERE"/systemd/*.target "$HERE"/systemd/*.timer; do
    dest="/etc/systemd/system/$(basename "$f")"
    if ! cmp -s "$f" "$dest"; then install -m 0644 "$f" "$dest"; changed=1; fi
  done
  cmp -s "$HERE/backup.sh" /usr/local/sbin/ifso-backup || install -m 0755 "$HERE/backup.sh" /usr/local/sbin/ifso-backup
  cmp -s "$HERE/deploy.sh" /usr/local/sbin/ifso-deploy || install -m 0755 "$HERE/deploy.sh" /usr/local/sbin/ifso-deploy
  systemctl daemon-reload
  systemctl enable --quiet ifso.target ifso-api.service ifso-worker.service ifso-bot.service
  systemctl enable --now --quiet ifso-backup.timer || die "could not enable the backup timer"
  if [[ "$changed" == 1 ]]; then log "systemd units installed"; else log "systemd units unchanged"; fi
}

if [[ "$KEYS_ONLY" == 1 ]]; then ensure_keys; log "key files in $KEYS_DIR: relayer owned by ifso-api, keeper and resolver by ifso-worker, mode 0600"; exit 0; fi
if [[ "$UNITS_ONLY" == 1 ]]; then ensure_service_users; install_units; exit 0; fi

# ---------------------------------------------------------------- settings
# shellcheck disable=SC1090
saved() { [[ -r "$CONF" ]] && (set +u; source "$CONF" >/dev/null 2>&1; eval "printf '%s' \"\${$1:-}\""); }
PROFILE="${PROFILE:-$(saved PROFILE || true)}"
DOMAIN="${DOMAIN:-$(saved DOMAIN || true)}"
REPO_URL="${REPO_URL:-$(saved REPO_URL || true)}"
case "$PROFILE" in
  testnet | mainnet) ;;
  *) die "set PROFILE=testnet or PROFILE=mainnet (got '${PROFILE:-nothing}')" ;;
esac
DB_NAME="ifso_${PROFILE}"
SWAP_SIZE="${SWAP_SIZE:-2G}"
domain_re='^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)+$'
[[ -z "$DOMAIN" || "$DOMAIN" =~ $domain_re ]] || die "DOMAIN '$DOMAIN' is not a domain name"
if [[ -r "$ETC/profile" && "$(tr -d '[:space:]' <"$ETC/profile")" != "$PROFILE" ]]; then
  die "this server was provisioned as $(tr -d '[:space:]' <"$ETC/profile"): refusing to turn it into $PROFILE (use a new server)"
fi
if [[ -r /etc/os-release ]]; then
  # shellcheck disable=SC1091
  . /etc/os-release
  [[ "${ID:-}" == ubuntu ]] || warn "written for Ubuntu 24.04, this is ${PRETTY_NAME:-unknown}"
  [[ "${VERSION_ID:-}" == 24.04 ]] || warn "written for Ubuntu 24.04, this is ${VERSION_ID:-unknown}: Postgres 16 / Redis 7 come from its own repositories"
fi

# ---------------------------------------------------------------- packages
export DEBIAN_FRONTEND=noninteractive
export NEEDRESTART_MODE=a
APT_OPTS=(-y -q -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold)
log "apt update + upgrade"
apt-get update -q
apt-get "${APT_OPTS[@]}" upgrade
apt-get "${APT_OPTS[@]}" install --no-install-recommends \
  git build-essential ca-certificates curl gnupg unzip jq openssl openssh-client \
  ufw fail2ban unattended-upgrades \
  postgresql-16 postgresql-client-16 redis-server

# ---------------------------------------------------------------- clock (UTC), swap
timedatectl set-timezone Etc/UTC 2>/dev/null || warn "could not set the time zone to UTC"
# The keeper and the resolver compare chain time with the wall clock: keep it synced.
timedatectl set-ntp true 2>/dev/null || warn "could not turn on NTP sync (timedatectl)"
if [[ "$SWAP_SIZE" != 0 && -z "$(swapon --show --noheadings)" ]]; then
  log "adding a $SWAP_SIZE swap file"
  [[ -f /swapfile ]] || fallocate -l "$SWAP_SIZE" /swapfile
  chmod 600 /swapfile
  mkswap /swapfile >/dev/null
  swapon /swapfile
  grep -qE '^/swapfile[[:space:]]' /etc/fstab || echo '/swapfile none swap sw 0 0' >>/etc/fstab
fi
printf 'vm.swappiness=10\n' >/etc/sysctl.d/60-ifso.conf
sysctl -q -p /etc/sysctl.d/60-ifso.conf

# ---------------------------------------------------------------- the ifso user, the service users and directories
if ! id ifso >/dev/null 2>&1; then
  log "creating the ifso system user"
  useradd --system --user-group --home-dir /var/lib/ifso --create-home --shell /usr/sbin/nologin ifso
fi
install -d -o ifso -g ifso -m 0750 /var/lib/ifso
install -d -o ifso -g ifso -m 0755 /opt/ifso /opt/ifso/releases
install -d -o root -g root -m 0711 "$ETC"
install -d -o root -g root -m 0700 /var/backups/ifso
ensure_keys
# git refuses to work in a repository owned by another user (root runs deploy.sh, the ifso user owns the clone).
git config --system --get-all safe.directory | grep -qxF /opt/ifso/repo || git config --system --add safe.directory /opt/ifso/repo
printf '%s\n' "$PROFILE" >"$ETC/profile"
umask 077
{
  echo "# Written by provision.sh; read by provision.sh and ifso-backup."
  printf 'PROFILE=%q\nDOMAIN=%q\nREPO_URL=%q\nDB_NAME=%q\n' "$PROFILE" "$DOMAIN" "$REPO_URL" "$DB_NAME"
} >"$CONF"
umask 022
chmod 0600 "$CONF"

# ---------------------------------------------------------------- Bun (pinned, checksum-verified)
install_bun() {
  if [[ -x /usr/local/bin/bun && "$(/usr/local/bin/bun --version 2>/dev/null)" == "$BUN_VERSION" ]]; then
    log "bun $BUN_VERSION already installed"; return
  fi
  local asset tmp base
  case "$(uname -m)" in
    x86_64) asset=bun-linux-x64; grep -qw avx2 /proc/cpuinfo || asset=bun-linux-x64-baseline ;;
    aarch64 | arm64) asset=bun-linux-aarch64 ;;
    *) die "no Bun build for $(uname -m)" ;;
  esac
  log "installing bun $BUN_VERSION ($asset)"
  tmp="$(mktemp -d)"
  base="https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}"
  curl -fsSL --retry 3 -o "$tmp/$asset.zip" "$base/$asset.zip"
  curl -fsSL --retry 3 -o "$tmp/SHASUMS256.txt" "$base/SHASUMS256.txt"
  (cd "$tmp" && grep -E " \*?${asset}\.zip\$" SHASUMS256.txt | sha256sum -c --quiet -) || die "bun download does not match SHASUMS256.txt"
  unzip -q "$tmp/$asset.zip" -d "$tmp"
  install -m 0755 "$tmp/$asset/bun" /usr/local/bin/bun
  rm -rf "$tmp"
  [[ "$(/usr/local/bin/bun --version)" == "$BUN_VERSION" ]] || die "bun --version is not $BUN_VERSION after install"
}
install_bun

# ---------------------------------------------------------------- Foundry (cast only; used to inspect keystores)
install_cast() {
  if command -v cast >/dev/null 2>&1 && cast --version 2>/dev/null | grep -qF "$FOUNDRY_VERSION"; then
    log "cast $FOUNDRY_VERSION already installed"; return
  fi
  local arch tmp url
  case "$(uname -m)" in
    x86_64) arch=amd64 ;;
    aarch64 | arm64) arch=arm64 ;;
    *) die "no Foundry build for $(uname -m)" ;;
  esac
  url="https://github.com/foundry-rs/foundry/releases/download/v${FOUNDRY_VERSION}/foundry_v${FOUNDRY_VERSION}_linux_${arch}.tar.gz"
  log "installing cast $FOUNDRY_VERSION"
  tmp="$(mktemp -d)"
  if curl -fsSL --retry 3 -o "$tmp/foundry.tar.gz" "$url" && tar -xzf "$tmp/foundry.tar.gz" -C "$tmp" cast; then
    install -m 0755 "$tmp/cast" /usr/local/bin/cast
  else
    rm -rf "$tmp"; die "could not install cast from $url"
  fi
  rm -rf "$tmp"
}
install_cast

# ---------------------------------------------------------------- Postgres 16: role, database, db.env
systemctl enable --now --quiet postgresql || die "postgresql did not start"
for _ in $(seq 1 30); do runuser -u postgres -- pg_isready -q && break; sleep 1; done
psql_admin() { runuser -u postgres -- psql -X -q -v ON_ERROR_STOP=1 -d postgres "$@"; }
[[ "$(psql_admin -tAc 'SHOW server_version_num' | cut -c1-2)" == 16 ]] || die "Postgres is not version 16"

db_password=""
redis_password=""
if [[ -f "$ETC/db.env" ]]; then
  db_password="$(sed -n 's#^DATABASE_URL=postgres://ifso:\([^@]*\)@.*#\1#p' "$ETC/db.env" | tail -1)"
  redis_password="$(sed -n 's#^REDIS_URL=redis://:\([^@]*\)@.*#\1#p' "$ETC/db.env" | tail -1)"
fi
[[ -n "$db_password" ]] || db_password="$(openssl rand -hex 24)"
[[ -n "$redis_password" ]] || redis_password="$(openssl rand -hex 24)"

[[ "$(psql_admin -tAc "SELECT 1 FROM pg_roles WHERE rolname = 'ifso'")" == 1 ]] || psql_admin -c "CREATE ROLE ifso LOGIN"
# The password goes through stdin, never through a command line.
printf "ALTER ROLE ifso WITH LOGIN PASSWORD '%s';\n" "$db_password" | psql_admin
[[ "$(psql_admin -tAc "SELECT 1 FROM pg_database WHERE datname = '$DB_NAME'")" == 1 ]] || runuser -u postgres -- createdb --owner=ifso "$DB_NAME"

# ---------------------------------------------------------------- Redis 7: localhost only, password, noeviction (BullMQ)
redis_major="$(redis-server --version | sed -n 's/.* v=\([0-9]*\)\..*/\1/p')"
[[ "$redis_major" == 7 ]] || warn "Redis is version ${redis_major:-unknown}, expected 7"
RCONF=/etc/redis/redis.conf
sed -i '/^# BEGIN ifso$/,/^# END ifso$/d' "$RCONF"
{
  echo "# BEGIN ifso"
  echo "# Written by provision.sh. Later lines win over the distro defaults above."
  echo "bind 127.0.0.1 -::1"
  echo "protected-mode yes"
  echo "port 6379"
  echo "requirepass $redis_password"
  echo "maxmemory-policy noeviction"
  echo "appendonly yes"
  echo "# END ifso"
} >>"$RCONF"
systemctl enable --quiet redis-server
systemctl restart redis-server

umask 077
{
  echo "# Written by provision.sh. Read by systemd (as root) for every ifso unit. Do not commit or copy."
  echo "DATABASE_URL=postgres://ifso:${db_password}@127.0.0.1:5432/${DB_NAME}"
  echo "REDIS_URL=redis://:${redis_password}@127.0.0.1:6379"
} >"$ETC/db.env.tmp"
mv "$ETC/db.env.tmp" "$ETC/db.env"
chown root:root "$ETC/db.env"; chmod 0600 "$ETC/db.env"
unset db_password redis_password

# ---------------------------------------------------------------- /etc/ifso/{common,api,worker,bot}.env (first run only)
split_env() { # split_env <section> <file>: the lines of one "[section: x]" block of env.example
  awk -v want="$1" '
    /^# \[section: / { s = $3; sub(/\]$/, "", s); on = (s == want); next }
    on { print }
  ' "$HERE/env.example"
}
for role in common api worker; do
  if [[ ! -e "$ETC/$role.env" ]]; then
    { echo "# Ifso $role settings. Written by provision.sh from env.example. Mode 0600, root only."; split_env "$role"; } >"$ETC/$role.env"
    log "wrote $ETC/$role.env"
  fi
done
[[ -e "$ETC/bot.env" ]] || printf '# Settings for ifso-bot only (optional). Shared ones live in common.env.\n' >"$ETC/bot.env"
if grep -q '^IP_HASH_SALT=CHANGE_ME$' "$ETC/api.env"; then
  sed -i "s/^IP_HASH_SALT=CHANGE_ME\$/IP_HASH_SALT=$(openssl rand -hex 32)/" "$ETC/api.env"
  log "generated IP_HASH_SALT in api.env"
fi
chown root:root "$ETC"/*.env
chmod 0600 "$ETC"/*.env
umask 022

# ---------------------------------------------------------------- deploy key for the private repo
if [[ ! -e /var/lib/ifso/.ssh/id_ed25519 ]]; then
  install -d -o ifso -g ifso -m 0700 /var/lib/ifso/.ssh
  runuser -u ifso -- ssh-keygen -q -t ed25519 -N '' -C "ifso-deploy@$(hostname)" -f /var/lib/ifso/.ssh/id_ed25519
  log "created a deploy key"
fi
cat >/var/lib/ifso/.ssh/config <<'EOF'
# Written by provision.sh: the ifso user pulls the repo with its own deploy key.
Host *
  IdentityFile /var/lib/ifso/.ssh/id_ed25519
  IdentitiesOnly yes
  BatchMode yes
  StrictHostKeyChecking accept-new
EOF
chown ifso:ifso /var/lib/ifso/.ssh/config; chmod 0600 /var/lib/ifso/.ssh/config
if [[ ! -d /opt/ifso/repo/.git ]]; then
  if [[ -n "$REPO_URL" ]]; then
    log "cloning $REPO_URL (needs the deploy key added on the git host first; failure here is not fatal)"
    runuser -u ifso -- git clone --quiet "$REPO_URL" /opt/ifso/repo || warn "clone failed: add the deploy key (printed below), then run: runuser -u ifso -- git clone <url> /opt/ifso/repo"
  else
    runuser -u ifso -- git init --quiet /opt/ifso/repo
    warn "no REPO_URL: created an empty /opt/ifso/repo; add the remote (README step 3)"
  fi
fi

# ---------------------------------------------------------------- firewall: 22, 80, 443 only
log "ufw: allow 22/tcp, 80/tcp, 443 (tcp + udp for HTTP/3); deny everything else inbound (port 8080 stays closed)"
ufw default deny incoming >/dev/null
ufw default allow outgoing >/dev/null
ufw allow 22/tcp >/dev/null
ufw allow 80/tcp >/dev/null
ufw allow 443 >/dev/null
ufw --force enable >/dev/null

# ---------------------------------------------------------------- fail2ban, SSH keys only, unattended upgrades, journald
cat >/etc/fail2ban/jail.d/ifso.local <<'EOF'
# Written by provision.sh.
[sshd]
enabled = true
backend = systemd
maxretry = 5
findtime = 10m
bantime = 1h
EOF
systemctl enable --quiet fail2ban
systemctl restart fail2ban
if [[ -s /root/.ssh/authorized_keys ]]; then
  cat >/etc/ssh/sshd_config.d/10-ifso.conf <<'EOF'
# Written by provision.sh: key-only logins.
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin prohibit-password
EOF
  if sshd -t; then
    systemctl try-reload-or-restart ssh.service || warn "could not reload ssh; the settings apply at the next restart"
  else
    rm -f /etc/ssh/sshd_config.d/10-ifso.conf
    warn "sshd -t rejected the key-only settings: removed them, SSH unchanged"
  fi
else
  warn "/root/.ssh/authorized_keys is empty: SSH password settings left unchanged"
fi
cat >/etc/apt/apt.conf.d/20auto-upgrades <<'EOF'
// Written by provision.sh.
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
APT::Periodic::AutocleanInterval "7";
EOF
systemctl enable --now --quiet unattended-upgrades || warn "could not enable unattended-upgrades"
install -d /etc/systemd/journald.conf.d
printf '# Written by provision.sh.\n[Journal]\nSystemMaxUse=1G\nMaxRetentionSec=30day\n' >/etc/systemd/journald.conf.d/ifso.conf
systemctl restart systemd-journald

# ---------------------------------------------------------------- Caddy (HTTPS reverse proxy)
if ! command -v caddy >/dev/null 2>&1; then
  if apt-cache policy caddy 2>/dev/null | grep -qE 'Candidate: [0-9]'; then
    log "installing caddy (Ubuntu package)"
  else
    log "installing caddy (Caddy's own apt repository)"
    curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/gpg.key | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
    curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt >/etc/apt/sources.list.d/caddy-stable.list
    apt-get update -q
  fi
  apt-get "${APT_OPTS[@]}" install caddy
fi
# DOMAIN reaches Caddy through an environment file loaded by a systemd drop-in; the Caddyfile reads {$DOMAIN}.
printf '# Written by provision.sh. Blank DOMAIN = plain HTTP on port 80.\n' >"$ETC/caddy.env"
[[ -z "$DOMAIN" ]] || printf 'DOMAIN=%s\n' "$DOMAIN" >>"$ETC/caddy.env"
chmod 0644 "$ETC/caddy.env"
install -d /etc/systemd/system/caddy.service.d
printf '[Service]\nEnvironmentFile=%s/caddy.env\n' "$ETC" >/etc/systemd/system/caddy.service.d/ifso.conf
systemctl daemon-reload
install -d -o caddy -g caddy /var/log/caddy
# An empty DOMAIN would count as "set" to Caddy and beat the :80 default, so pass it only when it has a value.
caddy_env=(env)
[[ -z "$DOMAIN" ]] || caddy_env+=("DOMAIN=$DOMAIN")
if ! runuser -u caddy -- "${caddy_env[@]}" caddy validate --adapter caddyfile --config "$HERE/Caddyfile" >/dev/null 2>&1; then
  die "the Caddyfile does not validate (try: DOMAIN=$DOMAIN caddy validate --adapter caddyfile --config $HERE/Caddyfile)"
fi
if ! cmp -s "$HERE/Caddyfile" /etc/caddy/Caddyfile; then
  [[ -f /etc/caddy/Caddyfile ]] && cp /etc/caddy/Caddyfile "/etc/caddy/Caddyfile.bak.$(date -u +%Y%m%dT%H%M%SZ)"
  install -m 0644 "$HERE/Caddyfile" /etc/caddy/Caddyfile
  log "Caddyfile written${DOMAIN:+ for $DOMAIN}"
fi
systemctl enable --quiet caddy
systemctl restart caddy

install_units

cat <<MSG

provision: done ($PROFILE).
  Services   ifso-api, ifso-bot, ifso-worker (user ifso), installed and enabled, not started until the first deploy
  Postgres   database $DB_NAME, role ifso;  Redis on 127.0.0.1 with a password (both in /etc/ifso/db.env, 0600)
  Caddy      ${DOMAIN:+https://$DOMAIN}${DOMAIN:-plain HTTP on port 80 (no DOMAIN yet)} -> API on 127.0.0.1:8080
  Backups    daily to /var/backups/ifso (systemctl list-timers ifso-backup.timer)
  Deploy key add this PUBLIC key as a read-only deploy key on the git host:
$(cat /var/lib/ifso/.ssh/id_ed25519.pub)
Next: README.md in this folder, step 3 onward.
MSG
