# Hosting the Ifso backend on one server

These scripts set up one Ubuntu 24.04 server (Cherry Servers VPS, 2 to 4 GB of memory) to run the whole backend: the API, the Telegram bot and the worker (keeper, price watcher, resolver, indexer, notifier), plus Postgres 16, Redis 7 and Caddy for HTTPS. Nothing here runs by itself and nothing has been run yet.

| File | What it is |
|---|---|
| `provision.sh` | One-time setup of a fresh server. Can be run again. |
| `deploy.sh` | Puts one exact commit live, checks it, and goes back by itself if it fails. Installed on the server as `ifso-deploy`. |
| `systemd/` | The services (`ifso-api`, `ifso-bot`, `ifso-worker`), the migration step, and the daily backup timer. |
| `Caddyfile` | The HTTPS front door. The domain is a variable, `DOMAIN`. |
| `provision-cohost.sh`, `cohost/` | `provision.sh --cohost`: testnet on a server that already runs another project's live services (see below). |
| `backup.sh` | Daily database backup, 14 days kept. Installed as `ifso-backup`. |
| `env.example` | Every setting, per service, with no secret values. |
| `deploy-local.test.sh` | Proves the deploy logic on your own computer, no server needed. |

The server holds three kinds of secret: the database and Redis passwords (made for you), the Telegram tokens, and the three hot-wallet key files. Treat all of it as private: never paste any of it into a chat, a ticket or git.

## Words you will see

- **Profile**: `testnet` (chain 46630, play money) or `mainnet` (chain 4663, real money). A server has one profile for life. Use a separate server for the other one.
- **sha**: the 40-character id of one commit. You always deploy a sha, never a branch name, because a sha cannot move.
- **Hot keys**: three wallets the backend signs with: the relayer (pays gas for claims and registers result questions), the keeper (settles and refunds) and the resolver (proposes results with a bond). They are encrypted key files plus a password file each. Keep only small amounts in them.

## Step by step

### 1. Order the server and log in
Order Ubuntu 24.04 (64-bit) at Cherry Servers, add your SSH public key in their panel, then log in as root: `ssh root@<the server's address>`. Do not set a password login.

### 2. Run the setup
Copy this folder to the server (from your computer: `scp -r app/scripts/server root@<address>:/root/ifso-server`), then on the server:

```bash
cd /root/ifso-server
PROFILE=testnet bash provision.sh
```

Use `PROFILE=mainnet` only on the day you go live. If the domain is already bought add `DOMAIN=api.<your-domain>`; if not, leave it out (the API is then served over plain HTTP on port 80, fine for a smoke test only). At the end it prints a **public deploy key**.

### 3. Let the server read the code
In the git host (the repository's Settings, Deploy keys) add the printed public key, read-only. Then on the server:

```bash
runuser -u ifso -- git clone <repository-ssh-url> /opt/ifso/repo
```

(If you gave `REPO_URL` to the setup and the key was not added yet, the clone failed; run the line above now. If `/opt/ifso/repo` already exists as an empty folder, run `runuser -u ifso -- git -C /opt/ifso/repo remote add origin <url>` instead.)

### 4. Fill in the settings
```bash
nano /etc/ifso/common.env     # chain id, contract addresses (incl. the resolver), sports source key, Telegram bot token
nano /etc/ifso/api.env        # nothing to fill in unless you use the Telegram webhook
nano /etc/ifso/worker.env     # hot key paths, other outcome-source settings
```
Replace every `CHANGE_ME`. The deploy refuses to run while one is left. Leave a value empty to switch a feature off. `CHAIN_ID` must be 46630 for testnet and 4663 for mainnet. The database and Redis settings are already written for you in `/etc/ifso/db.env`; do not touch it.

### 5. Put the three key files in place
Create the key files on your own computer (never on a screen share or in a chat), then copy each one up:

```bash
scp relayer.json relayer.password keeper.json keeper.password resolver.json resolver.password root@<address>:/etc/ifso/keys/
```
Then on the server run `bash /root/ifso-server/provision.sh --fix-key-perms`. It hands each file to the one service user that needs it (relayer: `ifso-api`; keeper and resolver: `ifso-worker`; the bot gets none) and makes it readable by no one else. Keep the file names above: `deploy.sh` refuses to start when a key is owned by the wrong user. Send a little gas (and, for the resolver, a little USDG) to the three addresses; the API's `/readyz` stays red until the balances are above the minimums. On mainnet keep `MIN_RESOLVER_USDG=200` (the env.example value: two 100 USDG bonds) and fund the resolver with at least that much USDG.

### 6. First deploy
On your computer: `git rev-parse HEAD` (after you pushed) gives the sha. On the server:

```bash
ifso-deploy <that 40-character sha>
```
It checks the settings, fetches the code, installs it, backs up the database, runs the migrations, starts the services and waits until `/readyz` answers 200. On success it prints `done: <sha> is live and healthy`.

### 7. Point the domain at the server (when you have one)
Add an A record `api` -> the server's address in your DNS. On Cloudflare click the cloud so it is **grey** (DNS only). Put `DOMAIN=api.<your-domain>` in the setup again (`DOMAIN=... PROFILE=testnet bash provision.sh`); Caddy gets the HTTPS certificate by itself within a minute or two. Then try `https://api.<your-domain>/healthz`.

## Day to day

| I want to | Command (on the server, as root) |
|---|---|
| Deploy a new version | `ifso-deploy <sha>` |
| Check everything is healthy | `ifso-deploy --check` |
| Go back to the last good version | `ifso-deploy $(cat /var/lib/ifso/previous.sha)` |
| See the logs | `journalctl -u ifso-api -u ifso-worker -u ifso-bot -n 100 --no-pager` |
| Restart everything | `systemctl restart ifso-api ifso-worker ifso-bot` |
| Stop everything | `systemctl stop ifso.target` |
| Back up now | `systemctl start ifso-backup.service` |

What `ifso-deploy` exit codes mean: `0` live and healthy; `75` it stopped before changing anything (network, bad sha, missing file): fix the cause and run it again; `1` the new version failed and the previous one is back; `2` the new version failed **and** going back failed too: read the logs, this one needs a person.

Migrations only go forward. A rollback puts the old code back but does not undo database changes, which is why every deploy takes a backup first. Write migrations so the previous version still works with them.

## Things to know

- **Run one worker.** Two workers would race to send the same transactions. Do not copy the worker unit.
- **Bot or webhook, not both.** `ifso-bot` listens by long polling. If you instead set `TELEGRAM_WEBHOOK_SECRET` in `api.env` (the API then serves the webhook), run `systemctl disable --now ifso-bot` and clear `TELEGRAM_BOT_TOKEN` handling accordingly. With a token set in `common.env` the deploy restarts `ifso-bot`; with it empty the bot is skipped.
- **The API port.** The API listens on 8080 on all interfaces, but the firewall only opens 22, 80 and 443, so only Caddy reaches it.
- **Backups** are in `/var/backups/ifso` (daily at 03:15 UTC, the newest 14 kept). They live on the same disk as the database, so also copy them somewhere else now and then (`scp root@<address>:/var/backups/ifso/<file> .`). Restore into an empty database: `runuser -u postgres -- pg_restore --clean --if-exists --no-owner --role=ifso -d ifso_<profile> <file>`.
- **Clock**: the server runs in UTC with automatic time sync; the keeper and resolver depend on it.
- **sudo**: Ubuntu 24.04 has the classic `sudo`, later Ubuntu releases use `sudo-rs`. Both strip most environment variables, so these scripts read every setting from `/etc/ifso` files. If you let a helper account run deploys, give it exactly one sudoers rule for `/usr/local/sbin/ifso-deploy`, check it with `visudo -cf <file>` and try it with `sudo -l -U <user>` before relying on it.
- **Security updates** install by themselves; the server may need a reboot now and then (`reboot`; the services come back on their own).
- **Mainnet**: do not run the mainnet profile until the testnet one has been deployed, checked with `ifso-deploy --check`, and a rollback has been rehearsed once (deploy an older sha, then the newer one).

## Sharing a server with another project (`--cohost`, testnet; mainnet only by the conversion below)

`bash provision.sh --cohost --check` only reads: it lists what it would do, confirms ports 3201 (API) and 6380 (Ifso's own Redis) are free and that the other project's units are active, and stops with a `FAIL` line if anything of theirs would change. `DOMAIN=api.<domain> bash provision.sh --cohost` then does the setup without installing, upgrading or restarting their Postgres, Caddy, fail2ban or ssh: a role and a database in their Postgres cluster, a separate Redis on 127.0.0.1:6380, Ifso's own Bun in `/opt/ifso/bin`, one `import` line in their Caddyfile plus `/etc/caddy/sites/ifso.caddy` (graceful reload only), and systemd limits on every Ifso unit. Afterwards `ifso-deploy` runs in co-host mode by itself (the file `/etc/ifso/cohost` switches it on) and exits 3 if one of their units changed during a deploy. The exact order of commands and the way back are in the private runbook for the night.

## Turning a co-host testnet server into the mainnet one (`convert-network.sh`)

Normally a server keeps the network it was set up with: `ifso-deploy` refuses `--profile mainnet` on a testnet server and
`provision.sh` refuses to change the profile. When the owner decides to reuse the testnet server for mainnet,
`convert-network.sh` does it in two owner-run steps, each refused unless `CONVERT_NETWORK=testnet-to-mainnet` is set:

1. `archive` stops the three app services, then keeps the testnet database (`pg_dump`, with a row count per table), a
   snapshot of Ifso's Redis, `/etc/ifso` and the testnet bot keys in `/var/backups/ifso/testnet-archive-<time>/` (root
   only, with a sha256 `MANIFEST`). The keys are moved out of `/etc/ifso/keys` and Ifso's Redis is emptied, so nothing of
   testnet can run on mainnet. No setting changes.
2. The mainnet key files are copied in, then `apply --archive <dir> --values <file> --sha <sha>` checks the archive again
   (including a full restore into a scratch database), the values (public addresses only; `convert-network.sh values`
   makes the file from the deployment record), that the contracts have code on chain 4663 and that the three keystores
   are the expected mainnet wallets. Only then it runs `provision.sh --cohost` with `PROFILE=mainnet` (a new empty
   database `ifso_mainnet`), rewrites the network settings (secrets and every other line are kept), points the release
   runner at the API's port, deploys and checks. `provision.sh --cohost` accepts `PROFILE=mainnet` only with the flag and
   a testnet archive whose `MANIFEST` verifies.

`bash app/scripts/server/convert-network.test.sh` proves it without a server (a temp folder and stand-ins).

## Trying the deploy logic on your computer

```bash
bash app/scripts/server/deploy-local.test.sh        # 136 checks, a few seconds, touches nothing outside a temp folder
bash app/scripts/server/convert-network.test.sh     # 78 checks: the testnet-to-mainnet conversion
shellcheck app/scripts/server/*.sh                  # brew install shellcheck
```
`deploy.sh --dry-run <sha>` does the same kind of rehearsal by hand: no root, systemd calls only printed.
