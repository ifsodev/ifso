# Ifso release runner

Releases the 72 tech updates, one per hourly slot (UTC), on the project server. Everything here runs on the server; no laptop is
involved on launch day. It is inert until armed.

| Part | What it is |
|---|---|
| `lib/release.py` | The runner. One pass per timer tick: for every due update, in queue order: apply the signed commit to main, gate, push private main, deploy, post-release checks, signed public copy, GitHub Release with poster, note to the ops chat. State is written after every step, so a killed pass resumes at its first unfinished step. |
| `lib/preflight.py` | Tests every pending and held update against the current main ahead of its slot. Read only, never takes the release lock. |
| `sbin/` | Root-owned wrappers, the only way the runner and the operators reach production: `ifso-deploy-release`, `ifso-release-notify`, `ifso-release-ghrelease` (runner), `ifso-release-status`, `-pause`, `-resume`, `-abort`, `-retry`, `-preflight` (operators). |
| `sudoers` | Names exactly those wrappers. `install.sh` checks it with `visudo -cf` before and `visudo -c` after. |
| `systemd/` | `ifso-release.service` (one pass, `flock`, `nice`, memory limits, 3 h timeout) and the timer (2 min after boot, 5 min after each pass). Installed disabled. |
| `install.sh` | Makes the user, folders, wrappers, units, sudoers and three ssh keys (private deploy, public deploy, signing) on the server. Safe to run again. |
| `arm.sh` | The last step: `sudo LAUNCH_AT=2026-11-17T14:00:00Z bash arm.sh`. |
| `push-queue.sh` | Mac side: ships the local `tu-queue` branch to the server's bare `queue.git` (the queue never goes to GitHub). |
| `sandbox/`, `test-local.sh` | The proof (below). |

## Rules the code keeps

- **Two locks to arm:** `LAUNCH_AT` in `schedule.json` plus the root-owned file `ALLOW_REAL_DEPLOY` plus the service's `IFSO_ALLOW_REAL_DEPLOY=1`. Missing any one: a pass releases nothing, and alerts go to a log file, not to the chat. Disarm: delete the file. Pause: `ifso-release-pause`.
- **Failure before the switch is retried, not reverted.** A fetch, install or deploy blip (deploy exit 75) leaves the update waiting; it is held only after the retry cap.
- **Failure after the push** reverts the commit (signed), redeploys the reverted tree and holds the update. A rollback that cannot finish writes `PAUSE` and alerts once.
- **A held update never blocks the others.** Updates that depend on it, or later migrations, wait and go once it is released. Nothing cascades into a hold.
- **Side channels never block the line.** A broken public copy is journalled (`publicPending`) and caught up later; a crash between push and state write is adopted by the next pass.
- **Alerts are keyed by cause:** one alert, an hourly reminder, one all-clear. A dead-man ping goes out after each pass when `HEALTHCHECK_PING_URL` is set. Public CI on the public main tip is read once per pass when `PUBLIC_CI_API` is set.
- **Slots:** `release.py set-times --launch-at <ISO UTC with Z>` writes 72 hourly slots. Local time zones are refused.
- **A stale `schedule.json`** (tip not equal to the queue branch tip) stops every pass and the preflight with one clear line.

## Install on the server

1. `sudo bash install.sh` (copy this folder over first). Register the three printed public keys on GitHub (two write deploy keys, one signing key).
2. Put the owner's signing keys into `/etc/ifso-release/allowed_signers`, the bot token and chat id into `/etc/ifso-release/release.env` (root, 0600), and the words that must never be published into `forbidden.txt`.
3. Clone private main to the release user's `backend/`, add a `public` remote, run the one-time `sync-public.py --init`.
4. From the Mac: `SERVER=root@<ip> bash push-queue.sh`. On the server: `release.py make-schedule --queue-repo ... --base <main sha> --manifest <file>`.
5. `sudo ifso-release-preflight` until every update passes, then a rehearsal deploy of the live sha through `ifso-deploy-release`, then `arm.sh`.

## Daily commands (group `ifso-ops`)

| Command | What it does |
|---|---|
| `sudo ifso-release-status [--short]` | Timer, armed or not, paused or not, running revision, one line per update, last alerts. |
| `sudo ifso-release-pause "reason"` / `sudo ifso-release-resume` | Planned pause; resume also clears a stale ABORT. Overdue updates then go 2 minutes apart. |
| `sudo ifso-release-abort` | Stops the pass in progress at its next step boundary; nothing is held. |
| `sudo ifso-release-retry TU07` | Put a held update back in the queue. Read `logs/TU07.log`, reproduce, fix, then retry. Never retry blind. |
| `sudo ifso-release-preflight [TU07]` | Test pending and held updates against current main. Run it after every change to main. |

## Tests

```bash
bash app/scripts/release/test-local.sh      # shellcheck, py_compile, 16 unit tests, then the whole-runner sandbox in local mode
```

`sandbox/run-sandbox.sh` runs the real runner, preflight, wrappers, `install.sh` and `arm.sh` against local bare repos with a fake API, Telegram, GitHub and deploy. A queue of 3 updates goes through: deploy blip, install blip, broken public copy, a crash between push and state write, pause/abort/resume, unarmed and half-armed passes, a stale schedule, a failing test (held), a failing deploy (rollback and held), preflight while the release lock is held, a fix and retry, GitHub Releases with posters, signed commits, one public author, no early code leak, and a rollback that cannot finish (pause).

### Linux proof (before arming)

The local run uses a prefix install and no real users or sudo. The Linux run needs a Linux root:

- With Docker: `bash app/scripts/release/sandbox/docker-sandbox.sh` (Ubuntu 24.04; real `install.sh`, real users, real sudoers, `visudo -c`, the runner reaching every wrapper through `sudo -n`).
- Without Docker: the VPS rehearsal. Pause the queue, copy this folder to the server, `sudo bash sandbox/run-sandbox.sh --linux` (it works only under its own scratch folder and a fake deploy), then deploy the already-live sha once through `ifso-deploy-release` as the release user and check every service is healthy, then resume.

The Linux run has not been done for this version; do not arm before it passes.
