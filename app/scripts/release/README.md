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
| `install.sh` | Makes the users (`ifso-release`, the gate user `ifso-gate`), folders (root's own repository in `/var/lib/ifso-release-root`, 0700), wrappers, units, sudoers and three ssh keys (private deploy, public deploy, signing) on the server. Safe to run again. |
| `arm.sh` | The last step: `sudo LAUNCH_AT=2026-11-17T14:00:00Z bash arm.sh`. |
| `push-queue.sh` | Mac side: ships the local `tu-queue` branch to the server's bare `queue.git` (the queue never goes to GitHub); a rebuilt queue goes to a NEW branch, `tu-queue` is never overwritten (see "Rebuilt queue"). |
| `sandbox/`, `test-local.sh` | The proof (below). |

## Rules the code keeps

- **Two locks to arm:** `LAUNCH_AT` in `schedule.json` plus the root-owned file `ALLOW_REAL_DEPLOY` plus the service's `IFSO_ALLOW_REAL_DEPLOY=1`. Missing any one: a pass releases nothing, and alerts go to a log file, not to the chat. Disarm: delete the file. Pause: `ifso-release-pause`.
- **Failure before the switch is retried, not reverted.** A fetch, install or deploy blip (deploy exit 75) leaves the update waiting; it is held only after the retry cap.
- **Failure after the push** reverts the commit (signed), redeploys the reverted tree and holds the update. A rollback that cannot finish writes `PAUSE` and alerts once.
- **Root never follows a release-user symlink (audit L-11).** The root wrappers read the release user's files (`PAUSE`, `logs/alerts.log`, `schedule.json`) only through `common.sh rel_read`: as the release user, every path component opened with `O_NOFOLLOW`, regular files only, size-capped. A planted symlink shows nothing.
- **"On private main" is root's own answer (audit L-12).** `ifso-deploy-release` fetches main itself from `PRIVATE_URL` (root-owned `paths.conf`) into its own repository with its own read-only deploy key; the release user's clone, its `remote.origin.fetch`, its `refs/remotes/origin/main` and its config never count. A commit that is not reachable from that main is refused.
- **Owner signatures only (audit M-2).** `/etc/ifso-release/allowed_signers` holds OWNER keys only; the server's signing key is never in it. The runner applies a queued commit only when the commit itself is owner-signed, and fast-forwards it when its parent is main. Everything the runner makes itself (a cherry-pick of a queued commit that is not a fast-forward, the revert on a rollback, the re-apply after a retry) is signed with the server key for display, but root's deploy wrapper accepts it only by its trailer: `(cherry picked from commit X)` with X owner-signed and the same `git patch-id --verbatim`, or `This reverts commit X.` with X an ancestor, accepted itself, and the exact inverse patch (`common.sh commit_ok`; the runner checks the same rule, `runner_commit_problem`, before it pushes, and the preflight before the slot). A cherry-pick whose patch changed on the new main (the context moved) is held before the push: rebuild the queue. Why a revert commit and not a switch of `/opt/ifso/current` back to the previous release directory: private main must stay equal to what is live, or the next update would ship the bad one again; the revert is needed on main either way, so it is also what gets deployed.
- **The gate runs as `ifso-gate` (audit M-2)**, a user with no access to the release user's home (its deploy and signing keys), through `sudo -n -u ifso-gate` with a clean environment (`PATH`, `HOME`, `TMPDIR`, `LANG`). The tree is a `git archive` export into `/var/lib/ifso-gate/release` (preflight: `.../preflight`), so the gate never sees a `.git`. `bun install --frozen-lockfile --ignore-scripts` in the gate and in `ifso-deploy`: no dependency install script runs anywhere. None is needed (checked 2026-11-05: the packages with scripts are esbuild, msgpackr-extract, unrs-resolver, @reown/appkit; each has its binary as an optional dependency or only prints a check; with `--ignore-scripts` the app typecheck and all 670 app tests, the web production build and the 69 web tests pass). A dependency that ever needs its script is allow-listed here by name, never by switching the flag off.
- **A held update never blocks the others.** Updates that depend on it, or later migrations, wait and go once it is released. Nothing cascades into a hold.
- **Side channels never block the line.** A broken public copy is journalled (`publicPending`) and caught up later; a crash between push and state write is adopted by the next pass.
- **Alerts are keyed by cause:** one alert, an hourly reminder, one all-clear. A dead-man ping goes out after each pass when `HEALTHCHECK_PING_URL` is set. Public CI on the public main tip is read once per pass when `PUBLIC_CI_API` is set.
- **Vercel is watched after a web/ release:** with `VERCEL_STATUS_API=https://api.github.com/repos/<owner>/<private repo>` in `paths.conf` (and, for a private repo, `VERCEL_STATUS_TOKEN_FILE`: a file the release user can read holding a fine-grained READ-ONLY token, Commit statuses + Checks read, on that repo only), every pass reads the GitHub commit statuses and check-runs of each released update that changed `web/` and alerts once with `VERCEL DEPLOY FAILED (TUnn)` or, when nothing finished within `VERCEL_WAIT_MINUTES` (default 20), `VERCEL DEPLOY MISSING (TUnn)`. It never blocks a release; empty = off (the sandbox default).
- **Catch-up after an outage:** a pass releases at most `MAX_PER_PASS` (default 3) overdue updates, `minGapMinutes` apart; the timer starts the next pass 5 minutes later, so a long outage never becomes a flood that outlives the unit's 3 h timeout.
- **Slots:** `release.py set-times --launch-at <ISO UTC with Z>` writes 72 hourly slots. Local time zones are refused.
- **Migration order:** `make-schedule` (and `remap`) read `app/drizzle/meta/_journal.json` in every queue tree and refuse when a queued migration's `when` is not above main's and every earlier queued one (Drizzle would skip it silently). Every update that adds a journal entry is marked `migration`, so a held migration keeps the later ones waiting.
- **Stale git locks (incident 43).** Every pass and every preflight first removes lock files under the git dirs of the runner's clone, the queue repo and the preflight checkout (`index.lock`, `packed-refs.lock`, `refs/**/*.lock`, ...) that are older than 10 minutes, only when no git process of the release user works in them, and names each one in its log and in one `STALE GIT LOCK REMOVED` alert.
- **A stale `schedule.json`** (tip not equal to the queue branch tip) stops every pass and the preflight with one clear line.

## Install on the server

0. From the Mac (backend checkout): copy this folder and the private public-copy tool, which is never in this repo:
   `rsync -a app/scripts/release/ root@<server>:/root/ifso-release/` and `scp ../docs/tools/sync-public.py root@<server>:/root/sync-public.py`.
1. On the server: `sudo RELEASE_GIT_NAME="<name>" RELEASE_GIT_EMAIL="<email>" SYNC_PUBLIC_SRC=/root/sync-public.py PUBLIC_GITHUB_REPO=<public-owner>/<repo> PRIVATE_GITHUB_REPO=<owner>/<private-repo> bash /root/ifso-release/install.sh`. `PRIVATE_GITHUB_REPO` writes `PRIVATE_URL` (`git@github.com:<owner>/<private-repo>.git`) into `paths.conf`: root fetches private main from there itself, with its own READ-ONLY deploy key `/etc/ifso-release/root_deploy_key` (root 0600, printed at the end: register it on the private repo as a read-only deploy key) and GitHub's ED25519 host key pinned in `/etc/ifso-release/github_known_hosts`. Without it every deploy is refused (exit 75; audit L-12). `PUBLIC_GITHUB_REPO` writes `PUBLIC_CI_API` (the public CI watcher, read once per pass, and the arming check) and `PUBLIC_COMMIT_URL` into `paths.conf`; without it the line is a `CHANGE_ME` placeholder, the watcher is off and `arm.sh` refuses. It installs the tool as `/usr/local/lib/ifso-release/lib/sync-public.py` (where `paths.conf` points) and refuses without it; a later run keeps the installed copy (pass `SYNC_PUBLIC_SRC` again to update it). The name and email are the identity of the commits the runner makes itself on private main (cherry-picks, reverts, re-applies); use an account that is a member of the Vercel team that builds `web/` (the owner's GitHub noreply address), or Vercel skips the build of a rollback. They are kept in `paths.conf`; install.sh refuses without them. Register the four printed public keys on GitHub (two write deploy keys, one signing key, root's read-only deploy key).
2. `/etc/ifso-release/allowed_signers` holds OWNER keys only: never add the server's signing key (install.sh takes it out if an older install put it in; audit M-2). Append the owner's signing keys (`<email> namespaces="git" <key>`), put the bot token and chat id into `/etc/ifso-release/release.env` (root, 0600), and the words that must never be published into `forbidden.txt`.
3. Clone private main to the release user's `backend/` and add the `public` remote THROUGH THE SSH HOST ALIASES install.sh wrote (`github-ifso-private` and `github-ifso-public` in the release user's `~/.ssh/config`; a plain `git@github.com:` URL uses no key and every fetch and push fails): `sudo -u ifso-release git clone github-ifso-private:<owner>/<private-repo>.git /var/lib/ifso-release/backend`, `sudo -u ifso-release git -C /var/lib/ifso-release/backend remote add public github-ifso-public:<public-owner>/<repo>.git`, then `git push --dry-run` to both, then the one-time `sync-public.py --init` (only when the public repo is empty).
4. From the Mac: `SERVER=root@<ip> bash push-queue.sh`. On the server: `release.py make-schedule --queue-repo ... --base <main sha> --manifest <file>`.
5. `sudo ifso-release-preflight` until every update passes, then a rehearsal deploy of a new signed descendant of the live sha through `ifso-deploy-release`, then `sudo LAUNCH_AT=<...Z> bash arm.sh`. It refuses unless: the queue scan is clean; `schedule.json` is current; the last preflight ran on the CURRENT private main and schedule and passed every pending and held update; public CI on the public main tip finished with 0 non-success (anonymous GitHub API); no `url.*.insteadOf` (or `pushInsteadOf`) in any git config the release user reads, the release clone's `origin` resolves to the same repo as `PRIVATE_URL` and answers `ls-remote` with the clone's `origin/main` (incident 47); the server RUNS that main (`/opt/ifso/current`; incident 48: deploy current main first), and root's own fetch of private main from `PRIVATE_URL` equals both; and `GITHUB_RELEASE_TOKEN` / `PUBLIC_REPO` in `release.env` can create and delete a draft Release. Going without GitHub Releases needs `ALLOW_NO_RELEASE_TOKEN=1` and prints a WARNING.

### Calibrate the post-release check (before arming)

`/readyz` answers 503 when the chain head is older than the app's 60 s. Robinhood Chain makes no block without traffic, so on a
quiet hour every post-release check could fail and roll good updates back. The runner accepts a 503 whose ONLY reasons are head
lag up to `RPC_MAX_LAG_S` (paths.conf, default 60). Sample on the server, then set it with margin:

```bash
for i in $(seq 40); do curl -s http://127.0.0.1:8080/readyz; echo; sleep 15; done
for i in $(seq 40); do echo $(( $(date +%s) - $(cast block latest --field timestamp --rpc-url "$RPC_URL") )); sleep 15; done
```

## Rebuilt queue (owner fix on main while updates are queued)

The runner fast-forwards an update whose parent is main and cherry-picks the others; after an owner fix the queue is rebuilt on
the new main so nothing conflicts at its slot. There is no `queue-rebased` command: the path is `release.py remap` (re-points
PENDING and HELD updates in order; it refuses with a diff unless the new branch holds exactly those updates, same count, same subjects, same order, and their migration journal `when` values still increase) plus moving `tu-queue`, which the runner follows (`schedule.json`'s tip must equal it, or
every pass stops with one STALE line). `push-queue.sh` never overwrites `tu-queue`: a rebuilt queue goes to a NEW branch.
Best: rebuild and preflight the queue on the Mac BEFORE pushing the owner fix, so the pause lasts minutes.

```bash
# 0. Server: stop new releases first, and wait until nothing is in progress
sudo ifso-release-pause "owner fix + queue rebuild"
sudo ifso-release-status --short            # "in progress 0" before going on (else: sudo ifso-release-abort, wait)
# 1. Mac (backend checkout): land the owner fix on private main (signed, owner identity), then rebuild the queue on it
git fetch origin
OLD=<current queue branch>; NEW=queue-r1; OLDBASE=$(git merge-base origin/main "$OLD")   # OLDBASE = the base in schedule.json
git switch -c "$NEW" "$OLD"
git -c commit.gpgsign=true rebase --onto origin/main "$OLDBASE" "$NEW"   # fix each conflict inside the update that hits it
#    after each fix: the touched tests (cd app && bun test <files> && bunx tsc --noEmit), then git rebase --continue
diff <(git log --reverse --format=%s "$OLDBASE..$OLD") <(git log --reverse --format=%s "origin/main..$NEW") && echo "subjects match"
git log --format=%G? "origin/main..$NEW" | sort -u                      # must print only G
bash .githooks/public-guard.sh
# 2. Mac: push to a NEW branch on the server's queue repo (never to GitHub); the script refuses an existing name and chowns
SERVER=root@<ifso-server> LOCAL_BRANCH="$NEW" bash app/scripts/release/push-queue.sh "$NEW"
# 3. Server, as root: keep the old tip, re-point pending AND held updates (keeps schedule.json.pre-<tag>)
Q=/var/lib/ifso-release/queue.git
sudo -u ifso-release git -C "$Q" update-ref refs/heads/tu-queue-pre-r1 refs/heads/tu-queue
sudo -u ifso-release bash -c 'set -a; . /etc/ifso-release/paths.conf; set +a;
  python3 /usr/local/lib/ifso-release/lib/release.py remap --queue-repo '"$Q"' --ref queue-r1 --base <new private main sha> --tag r1'
# 4. Server: the runner follows tu-queue, and the schedule tip must equal it
sudo -u ifso-release git -C "$Q" update-ref refs/heads/tu-queue refs/heads/queue-r1
# 5. Server: prove every pending and held update on the new main, then retry the fixed held ones, then resume
sudo ifso-release-preflight                  # must end "N of N PASS"
sudo ifso-release-retry TUnn                 # only for held updates the fix covers
sudo ifso-release-resume
```

The sandbox runs this path in world 4 (owner fix on main, rebuild, push to `queue-r1`, remap, stale until `tu-queue` moves,
preflight, arm).

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
bash app/scripts/release/test-local.sh      # shellcheck, py_compile, the unit tests (lib/test_release.py), then the hardening cases (`sandbox/hardening-cases.sh`: a planted `gpg.ssh.program` must not decide the signature gate, a server-signed commit with no owner-signed source (or the wrong patch, or naming an unsigned queued commit) is refused while a real cherry-pick, revert and re-apply pass (M-2), the GitHub Release wrapper publishes only the runner's own notes and `posters/<tag>.png`, --linux refuses outside its container, install.sh installs sync-public.py and a checksum-verified anvil, push-queue.sh never overwrites tu-queue, the preflight survives the oneshot unit), then the whole-runner sandbox in local mode
```

`sandbox/run-sandbox.sh` runs the real runner, preflight, wrappers, `install.sh` and `arm.sh` against local bare repos with a fake API, Telegram, GitHub and deploy. A queue of 3 updates goes through: deploy blip, install blip, broken public copy, a crash between push and state write, pause/abort/resume, unarmed and half-armed passes, a stale schedule, a failing test (held), a failing deploy (rollback and held), preflight while the release lock is held, a fix and retry, GitHub Releases with posters, signed commits (runner commits signed by the server key install.sh made, with the identity install.sh set, and deployed by root only through the trailer rule: the server key is not an allowed signer), the gate as `ifso-gate` with `--ignore-scripts` and a clean environment (Linux), one public author, no early code leak, a web/ change gated with the web tests and production build (or flagged when the server has no node), a test that needs anvil run (and failing the preflight when anvil is missing), a rollback that cannot finish (pause), and arming with the real `arm.sh` (stale preflight, other schedule, red or running public CI, a release token that cannot make a draft, the queue rebuild path end to end).

### Linux proof (before arming)

The local run uses a prefix install and no real users or sudo. The Linux run needs a Linux root:

- `bash app/scripts/release/sandbox/docker-sandbox.sh` on a machine with Docker (or `colima start`): Ubuntu 24.04 in a throwaway container; real `install.sh`, real users, real sudoers, `visudo -c`, the runner reaching every wrapper through `sudo -n`.
- `run-sandbox.sh --linux` runs only inside that container, never on a real server: it overwrites `/usr/local/bin/bun` with a fake, rewrites `/etc/ifso-release/paths.conf` and `allowed_signers` and adds users. It refuses unless `docker-sandbox.sh` set `IFSO_SANDBOX_CONTAINER=1` and the container runtime's `/.dockerenv` exists.
- On the server itself the proof is the rehearsal instead: pause the queue, deploy a new signed descendant of the live sha through `ifso-deploy-release` as the release user, check every service is healthy, resume.

The gate never skips a test. Changed tests that start a local chain need `anvil`: install it with install.sh
(`FOUNDRY_VERSION=<ver> FOUNDRY_SHA256=<sha256 of foundry_v<ver>_linux_<arch>.tar.gz from the release's checksums>`, or
`FOUNDRY_TARBALL=<file>` instead of the version); only `anvil` is extracted, to `/usr/local/bin`, after the checksum matches.
Without it such an update FAILS the gate (and the preflight) with a clear reason.

The gate calls plain `bun`, so bun must be on the service's default PATH: `/usr/local/bin/bun`, where `provision.sh` (Ifso's own
server) installs it. The co-host layout (`provision-cohost.sh`) keeps bun in `/opt/ifso/bin`, so the runner does not run there;
`arm.sh` refuses anyway, because the preflight it needs fails with `bun: No such file or directory`. Values with spaces in
`paths.conf` must be double-quoted (the wrappers source the file with bash).

Run the Linux proof again after every change to this folder; do not arm before it passes on the current version.
