#!/usr/bin/env python3
"""Ifso release runner: releases the tech updates one per slot (72, hourly, UTC) on the project server.

    release.py pass                   one pass (what the systemd timer runs): releases every due update, one after the other
    release.py status [--short]       released / pending / held counts, the next slot, one line per update
    release.py retry TUnn             put a held update back in the queue (developer: sudo ifso-release-retry TUnn)
    release.py set-times --launch-at <ISO UTC> [--interval-minutes N] [--min-gap N]   write the slot times
    release.py make-schedule --queue-repo P --base SHA [--ref tu-queue] [--manifest F] [--count 72]
    release.py remap --queue-repo P --ref NEWBRANCH [--tag T]   re-point pending AND held updates at a rebuilt queue
    release.py scan-queue             forbidden-word scan of every queue tree (arming precondition)
    release.py arm-check              arming preconditions: schedule current, preflight of the current main and schedule all
                                      PASS, public CI on the public main tip finished with 0 non-success (anonymous API)
    release.py notify-test            one test alert through the notify wrapper

Everything is driven by $RELEASE_HOME/state.json, written atomically after every step, so a pass that dies anywhere
(reboot, kill, network) is resumed by the next pass from its first unfinished step.

Pipeline per update: apply (signed commit onto main) -> gate (typecheck + targeted tests, bannedWords always) ->
push private main -> deploy (ifso-deploy-release: validated sha, ifso-deploy with automatic return) -> post-release checks
-> signed public copy (sync-public.py) -> GitHub Release (+poster) -> ops note. A failure before the push resets main and
HOLDS the update; a failure after it reverts the commit, redeploys the reverted tree and holds it; a rollback that fails
writes PAUSE and alerts. A held update never blocks the others unless one of them needs it (dependsOn / migration order).
Infrastructure blips before the switch (fetch, install, deploy exit 75) are retried and never held until the cap.

Unarmed = log only: with no launchAt, or without the root-owned ALLOW_REAL_DEPLOY file, a pass releases nothing and
every alert goes to logs/notify-log-only.log (never Telegram). Everything is configured by environment variables so the
sandbox proof can run the real code against local bare repos.
"""
import datetime as dt, fcntl, hashlib, json, os, pwd, re, shlex, shutil, subprocess, sys, time, urllib.request

LIB = os.path.dirname(os.path.abspath(__file__))
E = os.environ.get
HOME = os.path.expanduser("~")
RELEASE_HOME = os.path.abspath(E("RELEASE_HOME", f"{HOME}/home"))
CFG = {
    "repo": E("REPO_DIR", f"{HOME}/backend"),                      # the runner's clone of PRIVATE main (origin = private)
    "queue_repo": E("QUEUE_REPO", f"{HOME}/queue.git"),            # bare repo on the server; the queue never touches GitHub
    "queue_ref": E("QUEUE_REF", "refs/heads/tu-queue"),
    "deploy_cmd": E("DEPLOY_CMD", "sudo -n /usr/local/sbin/ifso-deploy-release"),
    "notify_cmd": E("NOTIFY_CMD", "sudo -n /usr/local/sbin/ifso-release-notify"),
    "ghrelease_cmd": E("GHRELEASE_CMD", "sudo -n /usr/local/sbin/ifso-release-ghrelease"),
    "sync_py": E("SYNC_PUBLIC_PY", f"{HOME}/runner/sync-public.py"),
    "sync_state": E("PUBLIC_SYNC_STATE", f"{RELEASE_HOME}/public-sync.json"),
    "api": E("API_URL", "http://127.0.0.1:8080").rstrip("/"),      # the server's own API, for post-release checks
    "public_url": E("PUBLIC_COMMIT_URL", "{sha}"),
    "allow_file": E("ALLOW_FILE", "/etc/ifso-release/ALLOW_REAL_DEPLOY"),
    "opt_dir": E("OPT_DIR", "/opt/ifso"),                          # /opt/ifso/current -> releases/<sha>: the running revision
    "gate_dir": E("GATE_DIR", f"{HOME}/gate"),
    # The gate runs the queued trees' tests and their dependencies' code. It runs as GATE_USER (install.sh: ifso-gate), a user
    # with no access to the release user's ~/.ssh (deploy and signing keys), through `sudo -n -u ifso-gate`, with a clean
    # environment (nothing of paths.conf or the service's env). The tree is exported with `git archive` into GATE_DIR (owned
    # by the gate user), so the gate never sees a .git of the runner. Empty = run as the runner itself (local sandbox only;
    # arm-check refuses it on a server). Audit M-2.
    "gate_user": E("GATE_USER", ""),
    "gate_home": E("GATE_HOME", "/var/lib/ifso-gate"),
    # no dependency's install script runs in the gate (none is needed: proven with the full app suite, the web tests and the
    # web production build, README "Install scripts"). Audit M-2.
    "gate_install": E("GATE_INSTALL", "bun install --frozen-lockfile --ignore-scripts"),
    "gate_typecheck": E("GATE_TYPECHECK", "bun run typecheck"),
    "gate_test": E("GATE_TEST", "bun test --timeout 90000"),
    # web/: an update that changes it also gets the web tests and the PRODUCTION build (a page dropped only by the production
    # build was an earlier project's incident 20). Needs a node runtime for `next build`; without one the update is FLAGGED
    # (alert, gate result webUngated), not held. GATE_WEB=off turns the web steps off on purpose (also flagged).
    "gate_web": E("GATE_WEB", "auto"),
    "gate_web_runtime": E("GATE_WEB_RUNTIME", "node"),
    "gate_web_install": E("GATE_WEB_INSTALL", "bun install --frozen-lockfile --ignore-scripts"),
    "gate_web_test": E("GATE_WEB_TEST", "bun run test"),
    "gate_web_build": E("GATE_WEB_BUILD", "bun run build"),
    "gate_anvil": E("GATE_ANVIL", "anvil"),                       # tests that start a local chain need it (install.sh installs it)
    "gate_always": [x for x in E("GATE_ALWAYS_TESTS", "test/bannedWords.test.ts").split(",") if x],
    # OWNER keys only (audit M-2): the server's own signing key is never in it, so a commit signed on this server is accepted
    # only as a runner commit whose trailer names an owner-signed commit with the same (or the inverse) patch.
    "allowed_signers": E("ALLOWED_SIGNERS", "/etc/ifso-release/allowed_signers"),
    "forbidden_file": E("FORBIDDEN_FILE", "/etc/ifso-release/forbidden.txt"),
    "infra_backoff": [int(x) for x in E("INFRA_RETRY_S", "10,30,60").split(",") if x.strip()],
    "transient_max": int(E("TRANSIENT_MAX_PASSES", "6")),
    "verify_tries": int(E("VERIFY_TRIES", "4")),
    "verify_wait": int(E("VERIFY_RETRY_S", "20")),
    "gap_sleep": E("GAP_SLEEP", "1") == "1",
    "disk_min_gb": float(E("DISK_MIN_GB", "3")),
    "disk_paths": [x for x in E("DISK_PATHS", "/opt,/var/lib").split(",") if x.strip()],
    "preflight_auto": E("PREFLIGHT_AUTO", "1") == "1",
    "sandbox": E("IFSO_SANDBOX", "0") == "1",
    "public_ci_api": "" if "CHANGE_ME" in E("PUBLIC_CI_API", "") else E("PUBLIC_CI_API", "").rstrip("/"),  # https://api.github.com/repos/<owner>/<repo>; empty or the install placeholder = off
    # at most this many updates per pass: after a long outage the overdue ones go a few per pass (minGapMinutes apart, the timer
    # starts the next pass 5 minutes later), never a flood that outlives the unit's 3 h timeout. 0 = no limit (tests only).
    "max_per_pass": int(E("MAX_PER_PASS", "3")),
    # Vercel builds web/ from PRIVATE main. After a release that changes web/, the runner reads the GitHub commit statuses and
    # check-runs of that commit (Vercel posts them) and alerts when the Vercel deploy failed or never finished within
    # VERCEL_WAIT_MINUTES. Never blocks a release. VERCEL_STATUS_API=https://api.github.com/repos/<owner>/<private repo>
    # (empty or CHANGE_ME = off); a private repo needs VERCEL_STATUS_TOKEN_FILE: a file readable by the release user holding a
    # fine-grained READ-ONLY token (Commit statuses + Checks: read) on that repo only. Anonymous when no file is set.
    "vercel_api": "" if "CHANGE_ME" in E("VERCEL_STATUS_API", "") else E("VERCEL_STATUS_API", "").rstrip("/"),
    "vercel_token_file": E("VERCEL_STATUS_TOKEN_FILE", ""),
    "vercel_wait_min": float(E("VERCEL_WAIT_MINUTES", "20")),
    # /readyz answers 503 when the chain head is over the APP's 60 s (app/src/ops/health.ts RPC_MAX_LAG_S). Robinhood Chain (an
    # Orbit chain) makes no block without traffic, so a quiet hour would fail every post-release check and roll good updates
    # back. The runner accepts a 503 whose ONLY reasons are head lag up to this many seconds. CALIBRATE on the server before
    # arming (sample the head-block age 40+ times; README) and set it in paths.conf with margin.
    "rpc_max_lag_s": int(E("RPC_MAX_LAG_S", "60")),                   # 0 = no limit; the sandbox uses 1 to stage a crash on a chosen update
}
SCHEDULE = os.path.join(RELEASE_HOME, "schedule.json")
STATE = os.path.join(RELEASE_HOME, "state.json")
LOGS = os.path.join(RELEASE_HOME, "logs")
PAUSE = os.path.join(RELEASE_HOME, "PAUSE")
ABORT = os.path.join(RELEASE_HOME, "ABORT")
RESUME_NOTED = os.path.join(RELEASE_HOME, "RESUME_ANNOUNCED")  # written by `resume`: the wrapper already told the chat
RUN_LOCK = os.path.join(RELEASE_HOME, ".run.lock")
DEPLOY_TRANSIENT = 75
STEPS = ["apply", "gate", "push", "deploy", "verify", "sync", "ghrelease", "publish"]


# ------------------------------------------------------------------ basics
def now():
    return dt.datetime.now(dt.timezone.utc)


def iso(t):
    return t.strftime("%Y-%m-%dT%H:%M:%SZ")


def parse(s):
    return dt.datetime.strptime(s, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=dt.timezone.utc)


def say(msg):
    print(f"[{iso(now())}] {msg}", flush=True)


class Fail(Exception):
    """The update itself is bad (tests, deploy, checks): hold it."""


class Blocked(Exception):
    """Infrastructure not ready: nothing is held, the next pass retries."""


class Transient(Blocked):
    """A blip that survived the in-pass retries; counted, held only after TRANSIENT_MAX_PASSES passes."""


class Aborted(Exception):
    """ifso-release-abort was asked for: stop at this step, hold nothing."""


def run(cmd, cwd=None, log=None, env=None, timeout=None, inp=None):
    shell = isinstance(cmd, str)
    try:
        p = subprocess.run(cmd, shell=shell, cwd=cwd, env=dict(os.environ, **(env or {})), input=inp, text=True,
                           stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=timeout,
                           executable="/bin/bash" if shell else None)
        code, out = p.returncode, p.stdout or ""
    except subprocess.TimeoutExpired as e:
        code, out = 124, (e.stdout or "") + f"\nTIMEOUT after {timeout}s"
    if log:
        with open(log, "a") as f:
            shown = cmd if shell else " ".join(shlex.quote(c) for c in cmd)
            f.write(f"\n[{iso(now())}] $ {shown}   (in {cwd or os.getcwd()}) -> exit {code}\n{out}")
    return code, out


def git(*a, repo=None, log=None, timeout=600, ok=False):
    code, out = run(["git", "-c", "safe.directory=*", *a], cwd=repo or CFG["repo"], log=log, timeout=timeout)
    if code != 0 and not ok:
        raise Fail(f"git {' '.join(a[:3])} failed: {out.strip()[-300:]}")
    return out.strip() if code == 0 else None


def load(path, default):
    try:
        with open(path) as f:
            return json.load(f)
    except FileNotFoundError:
        return default


def save(path, obj):
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(obj, f, indent=1)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)


def retrying(fn, what, log=None):
    """fn() -> (ok, detail); 1 + len(INFRA_RETRY_S) tries with those waits."""
    waits = list(CFG["infra_backoff"])
    while True:
        ok, detail = fn()
        if ok or not waits:
            return ok, detail
        w = waits.pop(0)
        say(f"{what} failed ({str(detail).strip()[-80:]}); retrying in {w} s")
        time.sleep(w)


def schedule():
    s = load(SCHEDULE, None)
    if s is None:
        raise Blocked(f"no schedule.json in {RELEASE_HOME}")
    return s


def init_state(sched):
    st = load(STATE, {"updates": {}})
    for u in sched["updates"]:
        st["updates"].setdefault(u["id"], {"status": "pending", "attempts": 0})
    return st


def tu_log(u):
    os.makedirs(LOGS, exist_ok=True)
    return os.path.join(LOGS, f"{u['id']}.log")


# ------------------------------------------------------------------ arming and alerts
def armed(sched=None, strict=True):
    """Armed = LAUNCH_AT written in schedule.json AND the root-owned flag file AND (strict, i.e. in a pass) the service's env var."""
    sched = sched or load(SCHEDULE, {}) or {}
    return bool(sched.get("launchAt")) and os.path.exists(CFG["allow_file"]) and (not strict or E("IFSO_ALLOW_REAL_DEPLOY") == "1")


def plain(what, users, done, nxt):
    """Every alert says four things in plain words (crypto-telegram-ops)."""
    return f"What happened: {what}\nUsers affected: {users}\nWhat was done: {done}\nWhat is next: {nxt}"


def notify(st, title, msg, failure=False, key=None, every=0, channel="ops"):
    """Alert through the notify wrapper. Keyed by CAUSE: one alert, a reminder at most every `every` seconds. Unarmed =
    log only (the wrapper decides too; this keeps the state clean). Never raises."""
    try:
        if key:
            seen = st.setdefault("alerts", {})
            last = seen.get(key)
            if last and (every == 0 or (now() - parse(last)).total_seconds() < every):
                return
            seen[key] = iso(now())
        os.makedirs(LOGS, exist_ok=True)
        with open(os.path.join(LOGS, "alerts.log"), "a") as f:
            f.write(f"{iso(now())} {'FAILED ' if failure else ''}{title} | {len(msg)} chars\n")
        cmd = shlex.split(CFG["notify_cmd"]) + [title[:200], msg[:3000], "1" if failure else "0", channel]
        c, out = run(cmd, timeout=60)
        if c:
            say(f"notify wrapper exit {c}: {out.strip()[-120:]}")
    except Exception as e:  # noqa: BLE001
        say(f"notify failed: {type(e).__name__}")


def clear_alert(st, key, title, msg):
    if (st.get("alerts") or {}).pop(key, None):
        notify(st, title, msg)


# ------------------------------------------------------------------ queue alignment (stale schedule assert)
def rev(repo, ref):
    c, o = run(["git", "-c", "safe.directory=*", "-C", repo, "rev-parse", "-q", "--verify", ref + "^{commit}"])
    return o.strip() if c == 0 else ""


def queue_alignment_error(sched, repo=None, queue_repo=None, queue_ref=None):
    """None when schedule.json describes the queue that is really on this server: its tip is the queue branch's tip and
    its base is in private main. Otherwise ONE plain line that names the shas, instead of dozens of per-update conflicts."""
    repo, queue_repo, queue_ref = repo or CFG["repo"], queue_repo or CFG["queue_repo"], queue_ref or CFG["queue_ref"]
    ups = sched.get("updates") or []
    tip = ups[-1]["sha"] if ups else sched.get("tip", "")
    base = sched.get("base", "")
    qtip = rev(queue_repo, queue_ref) if os.path.isdir(queue_repo) else ""
    if not qtip:
        return f"the queue repo has no {queue_ref.rsplit('/', 1)[-1]} ({queue_repo}); schedule.json tip is {tip[:12]}. Push the queue first."
    if qtip != tip:
        return (f"STALE schedule.json: its tip {tip[:12]} is not the queue branch tip {qtip[:12]}. The schedule and the queue are from "
                f"different builds. Replace {SCHEDULE} (keep a .pre-<tag> copy) or push the matching queue, then run again.")
    git("fetch", "-q", "origin", "main", ok=True)
    main = rev(repo, "origin/main") or rev(repo, "main")
    if not main:
        return f"private main is not readable in {repo}; the queue's base is {base[:12]}"
    c, _ = run(["git", "-c", "safe.directory=*", "-C", repo, "merge-base", "--is-ancestor", base, main])
    if c != 0:
        return (f"STALE schedule.json: the queue's base {base[:12]} is not in private main {main[:12]}: the queue was built on a "
                f"different main. Rebuild the queue on {main[:12]} and replace schedule.json, then run again.")
    return None


# ------------------------------------------------------------------ queue ordering and waiting
def by_id(sched):
    return {u["id"]: u for u in sched["updates"]}


def held_roots(sched, u, seen=None):
    seen = seen if seen is not None else set()
    idx = by_id(sched)
    deps = list(u.get("dependsOn") or [])
    if u.get("migration"):
        deps += [x["id"] for x in sched["updates"] if x.get("migration") and x["n"] < u["n"]]
    for d in deps:
        if d in idx and d not in seen:
            seen.add(d)
            held_roots(sched, idx[d], seen)
    return seen


def waiting_on(st, sched, u):
    """Why `u` cannot go yet (a dependency or an earlier migration is not released), or None. Held ones are waited for."""
    for d in sorted(held_roots(sched, u)):
        s = st["updates"][d]["status"]
        if s != "released":
            return f"{d} is {s}" + (" (held; it goes on its own once that one is retried and released)" if s == "held" else "")
    return None


def next_pending(st, sched, any_time=False):
    for u in sched["updates"]:
        t = st["updates"][u["id"]]
        if t["status"] == "pending" and (any_time or (u.get("slot") and parse(u["slot"]) <= now())):
            why = waiting_on(st, sched, u)
            if why:
                if t.get("waiting") != why:
                    t["waiting"] = why
                    notify(st, f"{u['id']} waiting", plain(f"{u['id']} cannot go yet: {why}", "no", "nothing; it is not held",
                           f"the queue goes on and {u['id']} follows once that is live"), key=f"waiting-{u['id']}", every=6 * 3600)
                continue
            t.pop("waiting", None)
            return u
    return None


# ------------------------------------------------------------------ git steps
def signature_ok(sha, repo=None):
    """Signed by an OWNER key (allowed_signers holds owner keys only)."""
    c, out = run(["git", "-c", "safe.directory=*", "-c", "gpg.format=ssh", "-c", f"gpg.ssh.allowedSignersFile={CFG['allowed_signers']}",
                  "-C", repo or CFG["repo"], "log", "-1", "--format=%G?", sha])
    return c == 0 and out.strip() == "G"


# the LAST of these lines in a runner commit's message names its source (git cherry-pick -x and git revert write them last)
TRAILER = re.compile(r"^(?:\(cherry picked from commit ([0-9a-f]{40})\)|This reverts commit ([0-9a-f]{40})\.)$", re.M)


def patch_id(a, b, repo=None):
    """git patch-id --verbatim of the diff a..b (binary content included, no renames, no external diff): line numbers do not
    count, every other byte does. The root wrapper computes the same (common.sh pid_of)."""
    d = subprocess.run(["git", "-c", "safe.directory=*", "-C", repo or CFG["repo"], "diff", "--no-ext-diff", "--no-textconv", "--no-renames",
                        "--binary", "--full-index", a, b], capture_output=True)
    if d.returncode:
        return ""
    p = subprocess.run(["git", "patch-id", "--verbatim"], input=d.stdout, capture_output=True)
    return p.stdout.split()[0].decode() if p.returncode == 0 and p.stdout.strip() else ""


def runner_commit_problem(c, repo=None, depth=0):
    """None when the root deploy wrapper will accept commit c: signed by an owner key, OR a runner commit (one parent) whose
    last trailer names a source X that is accepted: `(cherry picked from commit X)` with X owner-signed and the same patch,
    or `This reverts commit X.` with X an ancestor of c, itself accepted, and the inverse patch. Else the reason. Mirrors
    common.sh commit_ok, so the runner holds an update BEFORE the push instead of the root wrapper refusing it after."""
    repo = repo or CFG["repo"]
    if signature_ok(c, repo):
        return None
    if depth >= 4:
        return f"{c[:10]}: runner commits nested too deep"
    parents = (git("rev-list", "--parents", "-n", "1", c, repo=repo, ok=True) or "").split()[1:]
    if len(parents) != 1:
        return f"{c[:10]} is not signed by an owner key and is not a runner commit (it has {len(parents)} parents)"
    found = TRAILER.findall(git("log", "-1", "--format=%B", c, repo=repo) or "")
    if not found:
        return f"{c[:10]} is not signed by an owner key and names no owner-signed source (no cherry-pick or revert trailer)"
    pick, rev_of = found[-1]
    x = pick or rev_of
    if git("cat-file", "-e", x + "^{commit}", repo=repo, ok=True) is None:
        return f"{c[:10]} names {x[:10]}, which is not in this repository"
    if pick:
        if not signature_ok(x, repo):
            return f"{c[:10]} is a cherry-pick of {x[:10]}, which is not signed by an owner key"
        a, b = patch_id(x + "^", x, repo), patch_id(c + "^", c, repo)
        if not a or a != b:
            return f"{c[:10]} is not the same patch as {x[:10]}, the owner-signed commit it says it picks (patch-id differs)"
        return None
    if git("merge-base", "--is-ancestor", x, c + "^", repo=repo, ok=True) is None:
        return f"{c[:10]} reverts {x[:10]}, which is not an ancestor of it"
    why = runner_commit_problem(x, repo, depth + 1)
    if why:
        return f"{c[:10]} reverts {x[:10]}, which is not accepted itself: {why}"
    a, b = patch_id(x + "^", x, repo), patch_id(c, c + "^", repo)
    if not a or a != b:
        return f"{c[:10]} is not the exact inverse patch of {x[:10]}, the commit it says it reverts (patch-id differs)"
    return None


def find_landed(u, st):
    """The commit on main that carries update u: u.sha itself (fast-forwarded), its signed cherry-pick, or (after a
    rollback and a retry) the signed re-apply that reverts the revert."""
    main = git("rev-parse", "main")
    rv = (st.get("reverted") or {}).get(u["sha"])
    if rv:
        out = git("log", "-n", "50", "--format=%H", f"--grep=This reverts commit {rv[-1]}", main, ok=True)
        return out.splitlines()[0] if out else None
    if git("merge-base", "--is-ancestor", u["sha"], main, ok=True) is not None:
        return u["sha"]
    out = git("log", "-n", "200", "--format=%H", f"--grep=cherry picked from commit {u['sha']}", main, ok=True)
    return out.splitlines()[0] if out else None


def fetch_all(log=None):
    code, out = run(["git", "-c", "safe.directory=*", "fetch", "-q", "origin"], cwd=CFG["repo"], log=log, timeout=300)
    if code:
        raise Transient(f"git fetch origin failed: {out.strip()[-160:]}")
    c, o = run(["git", "-c", "safe.directory=*", "fetch", "-q", CFG["queue_repo"], "+refs/heads/*:refs/queue/*"],
               cwd=CFG["repo"], log=log, timeout=300)
    if c:
        raise Blocked(f"cannot read the queue repo: {o.strip()[-160:]}")


def sync_main(log):
    """Local main must equal private main (the runner's clone is a pure mirror between releases)."""
    git("checkout", "-q", "main", log=log)
    git("reset", "-q", "--hard", "origin/main", log=log)
    git("clean", "-qfd", log=log)


def apply_commit(st, t, u, log):
    # the queued commit itself must carry an OWNER signature (audit M-2): the server key re-signs only what the owner signed
    if not signature_ok(u["sha"]):
        raise Fail(f"queued commit {u['sha'][:10]} is not signed by an owner key in {CFG['allowed_signers']}: refusing to apply it")
    landed = find_landed(u, st)
    if landed:
        t["landedSha"] = landed
        why = runner_commit_problem(landed)
        if why:
            raise Fail(f"landed commit would be refused by the deploy wrapper: {why}")
        return
    main = git("rev-parse", "main", log=log)
    parent = git("rev-parse", u["sha"] + "^", log=log)
    rv = (st.get("reverted") or {}).get(u["sha"])
    if rv:  # rolled back earlier and retried after a fix: re-apply by reverting the revert (signed)
        subj = git("log", "-1", "--format=%s", u["sha"])
        git("revert", "--no-commit", rv[-1], log=log)
        msg = f'Reapply "{subj}"\n\nThis reverts commit {rv[-1]}.\n'
        code, out = run(["git", "-c", "safe.directory=*", "-c", "commit.gpgsign=true", "commit", "-q", "-S", "-F", "-"], cwd=CFG["repo"], log=log, inp=msg)
        if code:
            raise Fail(f"re-apply commit failed: {out.strip()[-200:]}")
    elif main == parent:
        git("merge", "--ff-only", u["sha"], log=log)
    else:
        code, out = run(["git", "-c", "safe.directory=*", "-c", "commit.gpgsign=true", "cherry-pick", "-x", u["sha"]],
                        cwd=CFG["repo"], log=log, timeout=300)
        if code:
            run(["git", "-c", "safe.directory=*", "cherry-pick", "--abort"], cwd=CFG["repo"], log=log)
            raise Fail(f"does not apply on current main: {out.strip()[-200:]}")
    t["landedSha"] = git("rev-parse", "main", log=log)
    why = runner_commit_problem(t["landedSha"])
    if why:  # before the push: the update is held, nothing reaches main (a context change can alter a cherry-pick's patch)
        raise Fail(f"landed commit would be refused by the deploy wrapper: {why}")


def push_main(log):
    code, out = run(["git", "-c", "safe.directory=*", "push", "origin", "main"], cwd=CFG["repo"], log=log, timeout=300)
    if code:
        raise Blocked(f"git push origin main failed: {out.strip()[-200:]}")
    # the push itself moved origin/main; a fetch blip here is NOT a failure of the update (a Fail would revert a good update
    # and hold it). Compare what we have; if they differ, wait (Blocked): the next pass pushes again (a no-op) and goes on.
    git("fetch", "-q", "origin", log=log, ok=True)
    if git("rev-parse", "origin/main", ok=True) != git("rev-parse", "main"):
        raise Blocked("origin/main is not main after the push (fetch blip?): retried next pass, nothing reverted")


# ------------------------------------------------------------------ gate
def changed_tests(g, parent, landed, log, source_repo=None):
    files = git("diff", "--name-only", parent, landed, repo=source_repo or g, log=log).splitlines()
    tests = []
    for f in files:
        if f.startswith("app/") and f.endswith(".ts"):
            rel = f[4:]
            for c in ([rel] if rel.endswith(".test.ts") else [rel[:-3] + ".test.ts", rel[:-3] + ".unit.test.ts"]):
                if os.path.exists(os.path.join(g, "app", c)) and c not in tests:
                    tests.append(c)
    for a in CFG["gate_always"]:
        if os.path.exists(os.path.join(g, "app", a)) and a not in tests:
            tests.append(a)
    return files, sorted(tests)


def anvil_tests(g, tests):
    """The targeted tests that start a local anvil chain (they need anvil on this server; they are never skipped)."""
    return [t for t in tests if "anvil" in open(os.path.join(g, "app", t), errors="ignore").read().lower()]


def gate_user_on():
    u = CFG["gate_user"]
    return bool(u) and u != pwd.getpwuid(os.getuid()).pw_name


def gate_shell(cmd, cwd, env=None):
    """argv that runs the shell command `cmd` in `cwd` as the gate user with a CLEAN environment (PATH, HOME, TMPDIR and the
    given extras only); without GATE_USER (local sandbox) as the runner itself with its environment plus the extras."""
    line = f"cd {shlex.quote(cwd)} && {cmd}"
    if not gate_user_on():
        return ["env", *[f"{k}={v}" for k, v in (env or {}).items()], "bash", "-c", line]
    e = {"PATH": os.environ.get("PATH", "/usr/local/bin:/usr/bin:/bin"), "HOME": CFG["gate_home"], "LANG": "C.UTF-8", **(env or {})}
    return ["sudo", "-n", "-u", CFG["gate_user"], "--", "env", "-i", *[f"{k}={v}" for k, v in e.items()], "bash", "-c", line]


def gate_tree(g, source_repo, landed, log):
    """Put the tree of `landed` (from the runner's repo, read by the runner) into the gate dir `g`, owned and written by the gate
    user: everything but app/node_modules and web/node_modules (the install cache) is removed first."""
    wipe = (f"mkdir -p {shlex.quote(g)} {shlex.quote(g + '.tmp')} && cd {shlex.quote(g)} && "
            "find . -mindepth 1 -maxdepth 1 ! -name app ! -name web -exec rm -rf {} + && "
            "for d in app web; do if [ -d \"$d\" ]; then find \"$d\" -mindepth 1 -maxdepth 1 ! -name node_modules -exec rm -rf {} +; fi; done")
    must(gate_shell(wipe, "/"), "gate clean", log=log)
    arc = subprocess.Popen(["git", "-c", "safe.directory=*", "-C", source_repo, "archive", "--format=tar", landed],
                           stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    untar = subprocess.run(gate_shell(f"tar -x -f - -C {shlex.quote(g)}", "/"), stdin=arc.stdout, capture_output=True)
    arc.stdout.close()
    if arc.wait() or untar.returncode:
        raise Fail(f"gate checkout of {landed[:10]} failed (archive exit {arc.returncode}, extract exit {untar.returncode}): "
                   f"{untar.stderr.decode(errors='replace').strip()[-160:]}")


def gate_at(g, source_repo, parent, landed, log, label=""):
    """Light server gate on the tree of `landed` exported into the gate dir `g` (the runner's clone is never touched, and the gate
    user never sees a .git). Called with a log PATH string, exactly as the runner calls it (an earlier project incident 35)."""
    assert isinstance(log, str), "gate_at wants a log path, not a file handle"
    gate_tree(g, source_repo, landed, log)
    files, tests = changed_tests(g, parent, landed, log, source_repo)
    app = os.path.join(g, "app")
    genv = {"TMPDIR": g + ".tmp", "GATE_COMMIT_SUBJECT": git("log", "-1", "--format=%s", landed, repo=source_repo, ok=True) or ""}
    if not gate_user_on() and os.environ.get("TMPDIR"):
        genv["TMPDIR"] = os.environ["TMPDIR"]  # the preflight's own temp dir (its throwaway Postgres) when the gate is the runner
    res = {"gateKind": "light", "tests": tests, "changed": len(files), "seconds": {},
           "gateUser": CFG["gate_user"] if gate_user_on() else pwd.getpwuid(os.getuid()).pw_name}
    need = anvil_tests(g, tests)
    if need and not shutil.which(CFG["gate_anvil"]):
        raise Fail(f"gate: {len(need)} changed test(s) start anvil ({', '.join(need[:3])}) and there is no {CFG['gate_anvil']} on this "
                   f"server: install it (install.sh FOUNDRY_TARBALL=... FOUNDRY_SHA256=...), never skip the tests")
    t0 = time.time()

    def once():
        c, o = run(gate_shell(f"nice -n 10 {CFG['gate_install']}", app, genv), log=log, timeout=2400)
        return c == 0, o
    ok, out = retrying(once, "gate install", log)
    if not ok:
        raise Transient(f"gate: install failed after retries (registry or network?): {out.strip()[-160:]}")
    res["seconds"]["install"] = round(time.time() - t0, 1)
    steps = [("typecheck", CFG["gate_typecheck"], app)]
    if tests:
        steps.append(("targeted tests", f"{CFG['gate_test']} " + " ".join("./" + t for t in tests), app))
    web = os.path.join(g, "web")
    if any(f.startswith("web/") for f in files) and os.path.isfile(os.path.join(web, "package.json")):
        if CFG["gate_web"] == "off":
            res["web"], res["webUngated"] = "NOT GATED: GATE_WEB=off", True
        elif not shutil.which(CFG["gate_web_runtime"]):
            res["web"], res["webUngated"] = f"NOT GATED: no {CFG['gate_web_runtime']} on this server for the web production build", True
        else:
            def web_once():
                c, o = run(gate_shell(f"nice -n 10 {CFG['gate_web_install']}", web, genv), log=log, timeout=2400)
                return c == 0, o
            ok, out = retrying(web_once, "gate web install", log)
            if not ok:
                raise Transient(f"gate: web install failed after retries (registry or network?): {out.strip()[-160:]}")
            steps += [("web tests", CFG["gate_web_test"], web), ("web production build", CFG["gate_web_build"], web)]
            res["web"] = "tests + production build"
    for name, cmd, cwd in steps:
        t1 = time.time()
        code, out = run(gate_shell(f"nice -n 10 {cmd}", cwd, genv), log=log, timeout=2400)
        if code:  # one re-run: a flaky first run is recorded, a failing second one holds the update
            code, out = run(gate_shell(f"nice -n 10 {cmd}", cwd, genv), log=log, timeout=2400)
            if code == 0:
                res.setdefault("flakyPassedOnRerun", []).append(name)
        res["seconds"][name] = round(time.time() - t1, 1)
        if code:
            tail = [x for x in out.strip().splitlines() if x.strip()][-3:]
            raise Fail(f"gate: {name} failed twice: {' | '.join(tail)[:300]}")
    return res


def must(cmd, what, **kw):
    code, out = run(cmd, **kw)
    if code:
        raise Fail(f"{what} (exit {code}): {out.strip().splitlines()[-1][:200] if out.strip() else ''}")
    return out.strip()


# ------------------------------------------------------------------ deploy and checks
def deploy(sha, log):
    """ifso-deploy-release <sha>. Exit 75 = nothing switched (retried with backoff). Returns (code, last line)."""
    res = {}

    def once():
        res["r"] = run(shlex.split(CFG["deploy_cmd"]) + [sha], cwd=CFG["repo"], log=log, timeout=3600)
        return res["r"][0] != DEPLOY_TRANSIENT, res["r"][1]
    retrying(once, f"deploy of {sha[:10]} (exit 75: nothing switched)", log)
    code, out = res["r"]
    return code, (out.strip().splitlines() or [""])[-1][:200]


def http_get(url, timeout=15):
    try:
        with urllib.request.urlopen(url, timeout=timeout) as r:
            return r.status, r.read(200000).decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return e.code, e.read(200000).decode("utf-8", "replace")
    except Exception as e:  # noqa: BLE001
        return 0, f"{type(e).__name__}: {e}"


def json_get(obj, dotted):
    for part in dotted.split("."):
        obj = obj[int(part)] if isinstance(obj, list) else obj[part]
    return obj


def readyz_only_lag(body):
    """The head lag in seconds when EVERY readyz reason is 'rpc head lag Ns ...', else None."""
    try:
        reasons = json.loads(body).get("reasons") or []
        lags = [re.fullmatch(r"rpc head lag (\d+)s.*", r) for r in reasons]
        return max(int(m.group(1)) for m in lags) if lags and all(lags) else None
    except Exception:  # noqa: BLE001
        return None


def check_one(chk):
    """One content check. perk_gated: the feature is ON but answers 'hold N to unlock' until the token exists, so the
    LOCKED answer is the expected one (a 200 with the open body would be the failure only if locked_contains is missing)."""
    code, body = http_get(CFG["api"] + chk["path"])
    if chk["path"] == "/readyz" and code == 503:
        lag = readyz_only_lag(body)
        if lag is not None and lag <= CFG["rpc_max_lag_s"]:
            return True, f"/readyz: only rpc head lag {lag}s, within RPC_MAX_LAG_S={CFG['rpc_max_lag_s']} (a quiet chain)"
    if chk.get("perk_gated"):
        want = chk.get("locked_contains", "")
        if code in (200, 401, 402, 403) and want and want in body:
            return True, f"perk-gated {chk['path']} answers locked ({code})"
        return False, f"perk-gated {chk['path']}: wanted the locked answer containing '{want}', got {code}: {body[:100]}"
    if code != chk.get("status", 200):
        return False, f"{chk['path']}: status {code}, wanted {chk.get('status', 200)}: {body[:100]}"
    if chk.get("contains") and chk["contains"] not in body:
        return False, f"{chk['path']}: text '{chk['contains']}' not in the answer"
    for k, v in (chk.get("json") or {}).items():
        try:
            got = json_get(json.loads(body), k)
        except Exception:  # noqa: BLE001
            return False, f"{chk['path']}: field {k} missing"
        if got != v:
            return False, f"{chk['path']}: {k} is {got!r}, wanted {v!r}"
    return True, f"{chk['path']} ok"


def verify(u, log):
    """Health first (readyz), then the update's own content checks. Retried a few times: services need a moment."""
    checks = [{"path": "/readyz"}] + ([u["check"]] if u.get("check") else [])
    out = {}
    for chk in checks:
        for i in range(CFG["verify_tries"]):
            ok, why = check_one(chk)
            if ok:
                break
            if i + 1 < CFG["verify_tries"]:
                time.sleep(CFG["verify_wait"])
        out[chk["path"]] = {"ok": ok, "out": why}
        with open(log, "a") as f:
            f.write(f"\n[{iso(now())}] check {chk['path']}: {'ok' if ok else 'FAIL'} {why}\n")
    return out


# ------------------------------------------------------------------ failure paths
def hold(st, u, t, reason):
    t["status"], t["reason"], t["heldAt"] = "held", reason, iso(now())
    t.pop("step", None)
    nxt = next_pending(st, schedule(), any_time=True)
    notify(st, f"HELD {u['id']} {u['name']}", plain(f"{u['id']} was not released: {reason}",
           "no. It never went live (or was taken back); the live app is unchanged",
           "held; nothing else is blocked unless it needs this one",
           (f"{nxt['id']} at {nxt['slot']}. " if nxt else "no other update can go now. ") +
           f"Developer: read logs/{u['id']}.log, reproduce, fix, then sudo ifso-release-retry {u['id']}; never retry without a fix"),
           failure=True)


def pause_and_alert(st, u, why):
    st["rollbackIncomplete"] = {"id": u["id"], "at": iso(now()), "why": why[:300]}
    try:
        with open(PAUSE, "w") as f:
            f.write(f"{iso(now())} paused by the runner: rollback of {u['id']} incomplete: {why}\n")
    except OSError as e:
        why += f" (and the PAUSE file could not be written: {e})"
    st["pausedSeen"] = iso(now())
    notify(st, f"{u['id']} ROLLBACK INCOMPLETE, releases PAUSED", plain(
        f"{u['id']} failed and putting the previous version back did not finish: {why}",
        "maybe: production may still run the bad release", "every release is PAUSED; the update is held",
        f"the owner checks production now (sudo ifso-release-status), fixes it, then sudo ifso-release-resume and "
        f"sudo ifso-release-retry {u['id']}"), failure=True)


def rollback(st, u, t, reason, log):
    """The update is on private main (and maybe live) and is not right: signed revert, push, redeploy the reverted tree."""
    say(f"{u['id']}: rolling back ({reason})")
    problems = []
    landed = t["landedSha"]
    try:
        if t.get("revertSha") and git("merge-base", "--is-ancestor", t["revertSha"], "main", ok=True) is not None:
            pass
        elif git("merge-base", "--is-ancestor", landed, "main", ok=True) is not None:
            subj = git("log", "-1", "--format=%s", landed)
            git("revert", "--no-commit", landed, log=log)
            msg = f'Revert "{subj}"\n\nThis reverts commit {landed}.\nThe update was held by the release checks; it will be released again after a fix.\n'
            code, out = run(["git", "-c", "safe.directory=*", "-c", "commit.gpgsign=true", "commit", "-q", "-S", "-F", "-"],
                            cwd=CFG["repo"], log=log, inp=msg)
            if code:
                problems.append(f"revert commit failed: {out.strip()[-160:]}")
            elif runner_commit_problem(git("rev-parse", "main")):
                problems.append(f"the revert would be refused by the deploy wrapper: {runner_commit_problem(git('rev-parse', 'main'))}")
                git("reset", "-q", "--hard", landed, log=log, ok=True)
            else:
                t["revertSha"] = git("rev-parse", "main")
                st.setdefault("reverted", {}).setdefault(u["sha"], []).append(t["revertSha"])
                save(STATE, st)
    except Fail as e:
        problems.append(f"revert failed: {str(e)[-200:]}")
        git("revert", "--abort", log=log, ok=True)
    if not problems:
        code, out = run(["git", "-c", "safe.directory=*", "push", "origin", "main"], cwd=CFG["repo"], log=log, timeout=300)
        if code:
            problems.append(f"push of the revert failed: {out.strip()[-160:]}")
    if "deploy" in t.get("started", []) and not problems:
        code, last = deploy(t["revertSha"], log)
        t["rollbackDeploy"] = "ok" if code == 0 else f"exit {code}"
        if code:
            problems.append(f"redeploy of the reverted tree failed (exit {code}): {last}")
    if not problems:
        notify(st, f"{u['id']} ROLLED BACK", plain(f"{u['id']} failed after it reached main: {reason[:200]}",
               "possibly, for a few minutes while it was live; the previous version is back now",
               "reverted on main, the previous release redeployed, the update held",
               f"the queue goes on. A failing check alone is a check bug until proven otherwise: run it by hand, fix, "
               f"then sudo ifso-release-retry {u['id']}"), failure=True)
    else:
        pause_and_alert(st, u, "; ".join(problems))
    return problems


def check_abort(where):
    if os.path.exists(ABORT):
        try:
            os.remove(ABORT)
        except OSError:
            pass
        raise Aborted(where)


def crash_point(u, step, phase="after"):
    """Sandbox only: die hard at a named point (IFSO_CRASH_AT=TU03:push:before-save)."""
    if CFG["sandbox"] and E("IFSO_CRASH_AT") == f"{u['id']}:{step}:{phase}":
        os._exit(9)


# ------------------------------------------------------------------ public copy, GitHub Release
def sync_public(st, u, t, log):
    """Signed public copy via sync-public.py, only after the release is healthy. A failure here never rolls anything back:
    it is journalled (publicPending) and retried at every pass."""
    before = (load(CFG["sync_state"], {}) or {}).get("publicSha")
    code, out = run([sys.executable, CFG["sync_py"], CFG["sync_state"]], cwd=CFG["repo"], log=log, timeout=600)
    after = (load(CFG["sync_state"], {}) or {}).get("publicSha")
    if code or (after == before and "nothing to sync" not in out):
        t["publicPending"], t["publicError"] = True, out.strip()[-200:]
        notify(st, f"PUBLIC COPY FAILED {u['id']}", plain(f"the signed copy to the public repo failed: {out.strip()[-200:]}",
               f"no. {u['id']} is live", "releases continue", "the next successful sync copies every waiting commit in order"),
               failure=True, key="public-sync", every=3600)
        return
    t["publicSha"] = after
    t.pop("publicPending", None)
    t.pop("publicError", None)
    for k, x in st["updates"].items():  # earlier updates whose copy failed are covered by this one
        if x.get("publicPending") and x is not t:
            x.pop("publicPending")
            x["publicSha"] = after
    clear_alert(st, "public-sync", "public copy caught up", f"the public repo is current again (public {str(after)[:10]})")


def tag_for(u):
    return f"update-{u['n']:02d}"


def github_release(st, u, t, log):
    """One GitHub Release per update with its poster on top. Best effort and idempotent: never blocks a release."""
    if not CFG["ghrelease_cmd"]:
        return
    notes = os.path.join(RELEASE_HOME, "notes", f"{u['id']}.md")
    body = open(notes).read() if os.path.exists(notes) else u["name"]
    sha = t.get("publicSha") or t.get("landedSha", "")
    nf = os.path.join(RELEASE_HOME, f".relnotes-{u['id']}.md")
    with open(nf, "w") as f:
        f.write(body)
    code, out = run(shlex.split(CFG["ghrelease_cmd"]) + [tag_for(u), f"Update {u['n']}: {u['name']}", nf, sha], log=log, timeout=120)
    os.remove(nf)
    if code:
        t["releaseError"] = out.strip()[-160:]
        auth = any(x in out for x in ("401", "403", "no token"))
        cause = release_cause(out)
        notify(st, "GITHUB RELEASES BLOCKED (token permission)" if auth else f"GITHUB RELEASES FAILING ({cause})", plain(
            f"GitHub Releases are not being created ({u['id']} is the latest one): {out.strip()[-160:]}",
            "no. The updates themselves are live", "nothing; releases continue",
            "the owner checks the release token (draft create and delete) or GitHub's status; every missing Release is created on a "
            "later pass. One alert per cause, a reminder an hour at most"),
            failure=True, key="ghrelease-auth" if auth else f"ghrelease-{cause}", every=6 * 3600 if auth else 3600)
        return
    t["releaseTag"] = tag_for(u)
    t.pop("releaseError", None)
    if "poster attached" in out:
        t["poster"] = True
    gone = [k for k in list((st.get("alerts") or {})) if k.startswith("ghrelease-")]
    for k in gone:
        st["alerts"].pop(k, None)
    if gone:
        notify(st, "GitHub releases work again", "the Release wrapper works again; missing Releases are created now")


def release_cause(out):
    """The CAUSE of a failed GitHub Release, without the tag or sha in it, so one outage or one config error is one alert key:
    'http-500', or the first words of the error with tags and shas removed."""
    m = re.search(r"HTTP (\d{3})", out)
    if m:
        return f"http-{m.group(1)}"
    text = re.sub(r"\b(update|bonus)-\d{2}\b|\bfix-[a-z0-9-]+|\b[0-9a-f]{7,40}\b|/\S+", "", out.strip().splitlines()[-1] if out.strip() else "")
    words = re.findall(r"[a-z_]+", text.lower().split(":", 1)[-1])[:4]
    return "-".join(words) or "unknown"


def poster_waiting(u, t):
    """A released update whose Release has no poster yet while posters/<tag>.png is staged now (staged after the Release)."""
    return t.get("releaseTag") and not t.get("poster") and os.path.isfile(os.path.join(RELEASE_HOME, "posters", f"{tag_for(u)}.png"))


def retry_missing_releases(st, sched):
    """Missing Releases are created, and a poster staged after its Release existed is attached (the wrapper is idempotent)."""
    for u in sched["updates"]:
        t = st["updates"][u["id"]]
        if t["status"] == "released" and (t.get("releaseError") or poster_waiting(u, t)) and CFG["ghrelease_cmd"]:
            github_release(st, u, t, tu_log(u))


# ------------------------------------------------------------------ one update
def release_one(st, sched, u):
    t = st["updates"][u["id"]]
    log = tu_log(u)
    resuming = t["status"] == "in_progress"
    if not resuming:
        t.update({"status": "in_progress", "startedAt": iso(now()), "done": [], "started": [], "attempts": t.get("attempts", 0) + 1})
        for k in ("reason", "heldAt", "landedSha", "revertSha", "prevMain", "verify", "gate", "rollbackDeploy"):
            t.pop(k, None)
    save(STATE, st)
    say(f"{'resuming' if resuming else 'releasing'} {u['id']} {u['name']} (done: {', '.join(t['done']) or 'nothing'})")
    with open(log, "a") as f:
        f.write(f"\n===== [{iso(now())}] {'RESUME' if resuming else 'START'} {u['id']} attempt {t['attempts']} =====\n")
    try:
        try:
            return release_steps(st, sched, u, t, log, resuming)
        except Transient as e:
            n = t["transientPasses"] = t.get("transientPasses", 0) + 1
            if n < CFG["transient_max"]:
                raise
            raise Fail(f"{e} (still failing after {n} passes)")
    except Aborted as e:
        say(f"{u['id']}: stopped by ifso-release-abort at {e}; state kept, nothing held")
        with open(PAUSE, "w") as f:
            f.write(f"{iso(now())} aborted at {e}\n")
        save(STATE, st)
        return "aborted"
    except Blocked as e:
        t["blockedReason"] = str(e)
        if not resuming and not t["done"]:
            t["status"], t["attempts"] = "pending", max(0, t.get("attempts", 1) - 1)
        tr = isinstance(e, Transient)
        notify(st, f"{u['id']} waiting", plain(f"{'infrastructure blip' if tr else 'blocked'}: {e}", "no. Nothing was switched",
               (f"pass {t.get('transientPasses')} of {CFG['transient_max']}, nothing reverted" if tr else "nothing; it is retried every pass"),
               f"{u['id']} goes as soon as this clears (one reminder an hour at most)"), failure=True, key=f"blocked-{u['id']}", every=3600)
        save(STATE, st)
        return "blocked"
    except (Fail, subprocess.CalledProcessError) as e:
        reason = str(e)
        if "push" in t["done"] or t.get("pushed"):
            try:
                rollback(st, u, t, reason, log)
            except Exception as e2:  # noqa: BLE001  a rollback that crashes must not loop or go silent
                pause_and_alert(st, u, f"the rollback itself crashed: {type(e2).__name__}: {str(e2)[:200]}")
        else:
            git("reset", "-q", "--hard", "origin/main", log=log, ok=True)
        t["done"] = []
        hold(st, u, t, reason)
        save(STATE, st)
        return "held"


def release_steps(st, sched, u, t, log, resuming):
    def step(name, fn):
        if name in t["done"]:
            return
        check_abort(f"step {name}")
        t["step"] = name
        if name not in t["started"]:
            t["started"].append(name)
        save(STATE, st)
        fn()
        crash_point(u, name, "before-save")
        t["done"].append(name)
        t.setdefault("times", {})[name] = iso(now())
        save(STATE, st)
        crash_point(u, name, "after")

    if "apply" not in t["done"]:
        fetch_all(log)
        sync_main(log)
    if "prevMain" not in t:
        t["prevMain"] = git("rev-parse", "main")
        save(STATE, st)

    def s_gate():
        t["gate"] = gate_at(CFG["gate_dir"], CFG["repo"], git("rev-parse", t["landedSha"] + "^"), t["landedSha"], log)
        if t["gate"].get("webUngated"):
            notify(st, f"WEB CHANGE NOT GATED {u['id']}", plain(
                f"{u['id']} changes web/ but the server gate could not run the web tests and production build ({t['gate']['web']})",
                "not yet: the update goes on (app gate passed); the website part is checked only by Vercel's own build",
                "flagged, not held", f"check the Vercel build of {u['id']}'s commit and the live page right after the release"),
                failure=True, key=f"web-ungated-{u['id']}")

    def s_push():
        t["pushed"] = True
        save(STATE, st)
        push_main(log)
        st.setdefault("runnerMains", []).append(t["landedSha"])

    def s_deploy():
        code, last = deploy(t["landedSha"], log)
        if code == DEPLOY_TRANSIENT:
            raise Transient(f"deploy did not start (infrastructure, nothing switched): {last}")
        if code:
            raise Fail(f"deploy failed (exit {code}): {last}")

    def s_verify():
        res = verify(u, log)
        t["verify"] = res
        bad = [c for c, r in res.items() if not r["ok"]]
        if bad:
            raise Fail(f"post-release check failed: {res[bad[0]]['out'][-180:]}")

    def s_publish():
        t["status"], t["releasedAt"] = "released", iso(now())
        t.pop("step", None)
        t.pop("pushed", None)
        t.pop("blockedReason", None)
        st["lastReleaseAt"] = t["releasedAt"]
        if CFG["vercel_api"] and web_changed(t["landedSha"]):  # read by vercel_tick at the end of this and later passes
            t["vercel"] = {"sha": t["landedSha"], "since": t["releasedAt"], "state": "watching"}
        st.pop("allDone", None)
        nxt = next_pending(st, sched, any_time=True)
        pub = t.get("publicSha")
        notify(st, f"{u['id']} released: {u['name']}", f"main {t['landedSha'][:10]}, public {str(pub)[:10] if pub else 'pending'}, "
               f"release {t.get('releaseTag', 'pending')}. " + (f"Next: {nxt['id']} at {nxt['slot']}" if nxt else "That was the last one."))

    step("apply", lambda: apply_commit(st, t, u, log))
    step("gate", s_gate)
    step("push", s_push)
    step("deploy", s_deploy)
    step("verify", s_verify)
    step("sync", lambda: sync_public(st, u, t, log))
    step("ghrelease", lambda: github_release(st, u, t, log))
    step("publish", s_publish)
    save(STATE, st)
    return "released"


# ------------------------------------------------------------------ pass
def disk_low():
    for p in CFG["disk_paths"]:
        if os.path.isdir(p):
            s = os.statvfs(p)
            if s.f_bavail * s.f_frsize / 1e9 < CFG["disk_min_gb"]:
                return f"{p} has under {CFG['disk_min_gb']:g} GB free"
    return None


LOCK_STALE_S = 600


def git_processes_in(dirs):
    """Pids of this user's running git processes whose working directory is inside one of `dirs` (git -C chdirs there).
    Linux: /proc. Elsewhere (the Mac sandbox): pgrep + lsof. If that cannot be answered, a pid of -1 (assume one runs)."""
    me, roots = os.getuid(), [os.path.realpath(d) for d in dirs]
    inside = lambda cwd: any(cwd == d or cwd.startswith(d + os.sep) for d in roots)  # noqa: E731
    found = []
    if os.path.isdir("/proc/self/fd"):
        for p in os.listdir("/proc"):
            if not p.isdigit():
                continue
            try:
                if os.stat(f"/proc/{p}").st_uid != me or open(f"/proc/{p}/comm").read().strip() != "git":
                    continue
                if inside(os.path.realpath(os.readlink(f"/proc/{p}/cwd"))):
                    found.append(int(p))
            except OSError:
                continue
        return found
    c, out = run(["pgrep", "-u", str(me), "-x", "git"])
    if c not in (0, 1):
        return [-1]
    for pid in out.split():
        c2, o2 = run(["lsof", "-a", "-p", pid, "-d", "cwd", "-Fn"])
        cwd = next((x[1:] for x in o2.splitlines() if x.startswith("n")), "")
        if c2 == 0 and cwd and inside(os.path.realpath(cwd)):
            found.append(int(pid))
    return found


def clear_stale_git_locks(repos, st=None, where="pass"):
    """Incident 43: every *.lock under the git dir of each repo (index.lock, packed-refs.lock, HEAD.lock, refs/**/*.lock, ...)
    older than 10 minutes is removed, but only when no git process of this user works in any of them. Each removed lock is
    named in the log and in ONE alert. Returns the removed paths. The pass and the preflight both call it before any git work."""
    gitdirs = []
    for r in repos:
        if os.path.isdir(os.path.join(r, ".git")):
            gitdirs.append(os.path.join(r, ".git"))
        elif os.path.isfile(os.path.join(r, "HEAD")) and os.path.isdir(os.path.join(r, "objects")):
            gitdirs.append(r)  # a bare repository (the queue)
    if not gitdirs:
        return []
    busy = git_processes_in(repos)
    if busy:
        say(f"stale-lock check skipped: git is running in {', '.join(repos)} (pid {', '.join(map(str, busy))})")
        return []
    removed, t0 = [], time.time()
    for gd in gitdirs:
        for dp, dn, fn in os.walk(gd):
            if os.path.basename(dp) == "objects" and os.path.dirname(dp) == gd:
                dn[:] = [d for d in dn if d in ("info", "pack")]  # not the loose-object fan-out
            for f in fn:
                path = os.path.join(dp, f)
                try:
                    if f.endswith(".lock") and t0 - os.lstat(path).st_mtime > LOCK_STALE_S:
                        os.remove(path)
                        removed.append(path)
                except OSError:
                    continue
    if removed:
        say(f"removed stale git lock(s) (over 10 min old, no git process running): {', '.join(removed)}")
        if st is not None:
            notify(st, f"STALE GIT LOCK REMOVED ({where})", plain(
                f"lock file(s) older than 10 minutes with no git process holding them: {', '.join(removed)[:600]}",
                "no", f"removed before the {where}'s git work, which goes on", "nothing; if it repeats, look for a git process that "
                "died (disk full, out of memory, a killed pass) in the journal"))
    return removed


def ping(problems, notes=()):
    """Dead-man's switch through the notify wrapper (the URL is a secret and never sits in this process). `fail` only for
    problems that need a human now (paused, stuck, late); held updates were alerted already and ride along as a note."""
    try:
        text = "; ".join(list(problems) + list(notes))[:200]
        run(shlex.split(CFG["notify_cmd"]) + ["--ping", "fail" if problems else "ok", text], timeout=30)
    except Exception:  # noqa: BLE001
        pass


def health_notes(st):
    held = [k for k, v in st["updates"].items() if v["status"] == "held"]
    return [f"held: {','.join(held)}"] if held else []


def health_problems(st, sched):
    """What turns the dead-man check red: paused, an update in progress over 90 min, the next due one over 60 min late. A held
    update is NOT one (health_notes): it was alerted once, and a check that stays down forever hides the next real silence."""
    out = []
    if os.path.exists(PAUSE):
        out.append("paused")
    for k, v in st["updates"].items():
        if v["status"] == "in_progress" and v.get("startedAt") and (now() - parse(v["startedAt"])).total_seconds() > 90 * 60:
            out.append(f"{k} in progress over 90 min")
    due = next_pending(st, sched)
    if due and due.get("slot") and (now() - parse(due["slot"])).total_seconds() > 60 * 60:
        out.append(f"{due['id']} over 60 min late")
    return out


def ci_red_jobs(check_runs):
    """Names of the failing jobs in a commit's check-runs. failure / timed_out / action_required are red. A CANCELLED job is red
    only when no other run of the same job on this commit replaced it (a push run cancelled by the scheduled run on the same sha is
    not a failure). In-progress jobs and a missing conclusion are never red."""
    red = []
    for c in check_runs:
        con, name = c.get("conclusion"), c.get("name", "?")
        if con in ("failure", "timed_out", "action_required"):
            red.append(name)
        elif con == "cancelled":
            later = [x for x in check_runs if x is not c and x.get("name") == name and x.get("conclusion") != "cancelled"
                     and (x.get("id") or 0) > (c.get("id") or 0)]
            if not later:
                red.append(name)
    return sorted(set(red))


def public_ci_runs(timeout=15):
    """The check-runs of the public main tip, anonymous (one call). Raises on any error."""
    req = urllib.request.Request(f"{CFG['public_ci_api']}/commits/main/check-runs?per_page=100",
                                 headers={"Accept": "application/vnd.github+json", "User-Agent": "ifso-release"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.load(r).get("check_runs", [])


def ci_not_green(runs):
    """Arming is stricter than the watcher: every job finished, and nothing but success / skipped / neutral (a cancelled job
    that a later run of the same job replaced is ignored, as in ci_red_jobs)."""
    red = set(ci_red_jobs(runs))
    for c in runs:
        if c.get("status") != "completed":
            red.add(f"{c.get('name', '?')} ({c.get('status')})")
        elif c.get("conclusion") not in ("success", "skipped", "neutral", "cancelled"):
            red.add(c.get("name", "?"))
    return sorted(red)


def public_ci_tick(st):
    """One anonymous GitHub call per pass: red check-runs on the public main tip raise ONE alert naming the jobs and the commit
    (a reminder every hour while red), one all-clear when green. API errors, rate limits and in-progress runs never alert and
    never block a release."""
    api = CFG["public_ci_api"]
    if not api:
        return
    try:
        runs = public_ci_runs()
        if not runs:
            return
        sha = runs[0].get("head_sha", "")[:10]
        red = ci_red_jobs(runs)
        if red:
            if st.get("publicCiRedSha") != sha:  # a NEW red commit is alerted at once, not after the hourly reminder of the old one
                (st.get("alerts") or {}).pop("public-ci", None)
                st["publicCiRedSha"] = sha
            notify(st, f"PUBLIC CI RED ({sha})", plain(f"failing jobs on the public main commit {sha}: {', '.join(red)}", "no. The live app is not affected",
                   "nothing is blocked; releases continue", "open the failing run on the public repo and fix it before the next slot (never re-run until green)"),
                   failure=True, key="public-ci", every=3600)
        elif not any(c.get("status") != "completed" for c in runs):
            st.pop("publicCiRedSha", None)
            clear_alert(st, "public-ci", "public CI green again", f"every check on the public main commit {sha} passes")
    except Exception as e:  # noqa: BLE001
        say(f"public CI check skipped: {type(e).__name__}")


def web_changed(sha):
    code, out = run(["git", "-c", "safe.directory=*", "-C", CFG["repo"], "diff-tree", "--no-commit-id", "--name-only", "-r", sha])
    return code == 0 and any(x.startswith("web/") for x in out.splitlines())


def vercel_api_get(path, timeout=15):
    """One GitHub API GET for the Vercel watcher (anonymous, or the read-only token file). Raises on any error."""
    hdr = {"Accept": "application/vnd.github+json", "User-Agent": "ifso-release"}
    tf = CFG["vercel_token_file"]
    if tf:
        tok = open(tf).read().strip()
        if tok:
            hdr["Authorization"] = f"Bearer {tok}"
    with urllib.request.urlopen(urllib.request.Request(f"{CFG['vercel_api']}{path}", headers=hdr), timeout=timeout) as r:
        return json.load(r)


def vercel_state(statuses, check_runs):
    """'failed', 'ok', 'cancelled', 'pending' or 'none' from a commit's statuses and check-runs (only entries whose name says Vercel)."""
    v = [s.get("state") for s in statuses if "vercel" in str(s.get("context", "")).lower()]
    v += [c.get("conclusion") or c.get("status") for c in check_runs if "vercel" in str(c.get("name", "")).lower()]
    if not v:
        return "none"
    if any(x in ("failure", "error", "timed_out", "action_required") for x in v):
        return "failed"
    if all(x == "cancelled" for x in v):  # Vercel cancels a build that a newer push replaced: not a failure
        return "cancelled"
    if any(x in ("pending", "queued", "in_progress", "requested", "waiting", None) for x in v):
        return "pending"
    return "ok"


def vercel_tick(st, sched):
    """For each released update that changed web/: read Vercel's commit status of its private main commit. A failed deploy, or
    none finished within VERCEL_WAIT_MINUTES, raises ONE alert per update. API errors only wait. Never blocks a release."""
    if not CFG["vercel_api"]:
        return
    for u in sched["updates"]:
        t = st["updates"].get(u["id"]) or {}
        w = t.get("vercel")
        if not w or w.get("state") != "watching":
            continue
        try:
            sha = w["sha"]
            statuses = vercel_api_get(f"/commits/{sha}/status").get("statuses", [])
            runs = vercel_api_get(f"/commits/{sha}/check-runs?per_page=100").get("check_runs", [])
        except Exception as e:  # noqa: BLE001
            say(f"Vercel status of {u['id']} skipped: {type(e).__name__}")
            continue
        state = vercel_state(statuses, runs)
        late = (now() - parse(w["since"])).total_seconds() > CFG["vercel_wait_min"] * 60
        if state in ("ok", "cancelled"):
            w["state"] = state
        elif state == "failed":
            w["state"] = "failed"
            notify(st, f"VERCEL DEPLOY FAILED ({u['id']})", plain(
                f"{u['id']} changed web/ and Vercel reported a FAILED deploy for its commit {sha[:10]}",
                "the API and the bot run the new code; the website still shows the previous version", "nothing is blocked; releases continue",
                "open the Vercel deployment of that commit (blocked author? build error?) and fix it through the owner-fix path"),
                failure=True, key=f"vercel-{u['id']}")
        elif late:
            w["state"] = "missing" if state == "none" else "stuck"
            notify(st, f"VERCEL DEPLOY MISSING ({u['id']})", plain(
                f"{u['id']} changed web/, but Vercel {'never reported a deploy' if state == 'none' else 'did not finish its deploy'} for its "
                f"commit {sha[:10]} within {CFG['vercel_wait_min']:g} minutes", "the website may still show the previous version",
                "nothing is blocked; releases continue", "check the Vercel project (a commit author outside the Vercel team is skipped) and the live page"),
                failure=True, key=f"vercel-{u['id']}")


def preflight_kick():
    if not CFG["preflight_auto"]:
        return
    try:  # detached, nice 19, its own lock; it never takes the run lock (an earlier project incident 36)
        subprocess.Popen([sys.executable, os.path.join(LIB, "preflight.py"), "auto"], stdout=subprocess.DEVNULL,
                         stderr=subprocess.DEVNULL, start_new_session=True)
    except Exception:  # noqa: BLE001
        pass


def cmd_pass():
    os.makedirs(LOGS, exist_ok=True)
    lock = open(RUN_LOCK, "a+")
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        say("another pass holds the run lock: exiting")
        return 0
    try:
        return _pass()
    finally:
        fcntl.flock(lock, fcntl.LOCK_UN)


def _pass():
    try:
        sched = schedule()
    except Blocked as e:
        say(str(e))
        return 0
    st = init_state(sched)
    clear_stale_git_locks([CFG["repo"], CFG["queue_repo"]], st, "release pass")
    save(STATE, st)
    if not sched.get("launchAt"):
        say("no LAUNCH_AT set: unarmed, nothing runs")
        return 0
    if not armed(sched):
        say("unarmed (the ALLOW_REAL_DEPLOY file or the service's IFSO_ALLOW_REAL_DEPLOY=1 is missing): nothing runs")
        return 0
    if now() < parse(sched["launchAt"]):
        say(f"before launch ({sched['launchAt']}): nothing runs")
        return 0
    stale = queue_alignment_error(sched)
    if stale:
        st["staleSchedule"] = stale
        notify(st, "STALE SCHEDULE", plain(stale, "no", "no release starts", "replace schedule.json from the matching queue (README, after a queue rebase)"),
               failure=True, key="stale-schedule", every=3600)
        save(STATE, st)
        say(stale)
        return 2
    st.pop("staleSchedule", None)
    clear_alert(st, "stale-schedule", "schedule is current again", "schedule.json matches the queue; releases continue")
    if os.path.exists(PAUSE):
        if not st.get("pausedSeen"):
            st["pausedSeen"] = iso(now())
            why = open(PAUSE).read().strip()[:160]
            notify(st, "release queue PAUSED", plain(f"the queue is paused ({why or 'PAUSE file'})", "no. The live app keeps running",
                   "no new release starts; one in progress finishes", f"a planned pause ends with sudo ifso-release-resume; overdue updates then go {sched.get('minGapMinutes', 2)} minutes apart"))
        save(STATE, st)
        say("paused")
        ping(health_problems(st, sched), health_notes(st))
        return 0
    if st.pop("pausedSeen", None):
        st.pop("rollbackIncomplete", None)
        if not take_resume_note():  # ifso-release-resume already posted RESUMED (naming who); only a manual PAUSE removal reaches here
            notify(st, "release queue RESUMED", plain("the pause is over", "no", "releases continue",
                   f"overdue updates go one at a time, {sched.get('minGapMinutes', 2)} minutes apart; then the normal slots"))
    low = disk_low()
    if low:
        notify(st, "DISK LOW", plain(low, "no", "no update starts until space is freed", "free disk space on the server"), failure=True, key="disk", every=3600)
        save(STATE, st)
        return 2
    by = by_id(sched)
    done_now = 0
    while True:
        cur = next((by[k] for k, v in st["updates"].items() if v["status"] == "in_progress"), None)
        if cur:
            u = cur
        else:
            retry_public_pending(st, sched)
            u = next_pending(st, sched)
            save(STATE, st)
            if not u:
                if queue_settled(st, sched) and not st.get("allDone"):
                    st["allDone"] = iso(now())
                    r = sum(v["status"] == "released" for v in st["updates"].values())
                    notify(st, "queue finished", f"{r}/{len(st['updates'])} released, {len(st['updates']) - r} held")
                retry_missing_releases(st, sched)
                save(STATE, st)
                say("nothing due")
                break
            gap = sched.get("minGapMinutes", 2) * 60
            if st.get("lastReleaseAt") and CFG["gap_sleep"]:
                wait = gap - (now() - parse(st["lastReleaseAt"])).total_seconds()
                if wait > 0:
                    time.sleep(min(wait, gap))
        res = release_one(st, sched, u)
        save(STATE, st)
        if res in ("blocked", "aborted") or os.path.exists(PAUSE):
            break  # a hold does NOT stop the queue: the next due update goes on
        done_now += 1
        if CFG["max_per_pass"] and done_now >= CFG["max_per_pass"]:
            break
    public_ci_tick(st)
    vercel_tick(st, sched)
    save(STATE, st)
    ping(health_problems(st, sched), health_notes(st))
    preflight_kick()
    return 0


def retry_public_pending(st, sched):
    pend = next((u for u in sched["updates"] if st["updates"][u["id"]].get("publicPending")), None)
    if pend:
        try:
            fetch_all(tu_log(pend))
            sync_public(st, pend, st["updates"][pend["id"]], tu_log(pend))
        except (Blocked, Fail) as e:
            say(f"public sync retry blocked: {e}")


def queue_settled(st, sched):
    for u in sched["updates"]:
        t = st["updates"][u["id"]]
        if t["status"] in ("released", "held"):
            continue
        if t["status"] == "pending" and any(st["updates"][d]["status"] == "held" for d in held_roots(sched, u)):
            continue
        return False
    return True


# ------------------------------------------------------------------ commands
def sched_fp(sched):
    """Fingerprint of the schedule's updates (id=sha): preflight results carry it, arming compares it."""
    return hashlib.sha256("".join(f"{u['id']}={u['sha']}" for u in sched["updates"]).encode()).hexdigest()[:16]


def arm_problems(results_path):
    """Why arming must be refused (empty = arm). The schedule must be current, and the last preflight must have run on the
    CURRENT private main and the CURRENT schedule, covering every pending and held update, with no failure."""
    out = []
    sched = schedule()
    st = init_state(sched)
    stale = queue_alignment_error(sched)
    if stale:
        out.append(stale)
    r = load(results_path, None)
    if not r:
        return out + [f"no preflight results ({results_path}): run sudo ifso-release-preflight first"]
    git("fetch", "-q", "origin", ok=True)
    main = rev(CFG["repo"], "origin/main")
    if r.get("stale"):
        out.append(f"the last preflight did not run: {r['stale'][:160]}")
    elif r.get("main") != main:
        out.append(f"preflight ran on main {str(r.get('main'))[:12]} but private main is now {main[:12]}: run sudo ifso-release-preflight again")
    out += remote_problems(main)
    if r.get("sfp") != sched_fp(sched):
        out.append("preflight results belong to another schedule (schedule.json changed since): run sudo ifso-release-preflight again")
    want = [u["id"] for u in sched["updates"] if st["updates"][u["id"]]["status"] in ("pending", "held", "in_progress")]
    res = r.get("results") or {}
    missing = [k for k in want if k not in res or res[k].get("skipped")]
    if missing:
        out.append(f"preflight did not test {', '.join(missing[:8])}{' ...' if len(missing) > 8 else ''} (a --only run does not count)")
    bad = sorted(k for k in want if k in res and not res[k].get("ok"))
    if bad or r.get("failing"):
        out.append(f"preflight failures: {', '.join(bad or r.get('failing'))}")
    if not CFG["public_ci_api"]:
        out.append("PUBLIC_CI_API is not set in paths.conf (https://api.github.com/repos/<public-owner>/<repo>): public CI cannot be "
                   "checked now or watched during the launch")
    else:
        try:
            runs = public_ci_runs()
            nz = ci_not_green(runs) if runs else ["no check-runs at all on the public main tip"]
            if nz:
                out.append(f"public CI on the public main tip {(runs[0].get('head_sha') or '')[:10] if runs else ''}: "
                           f"{len(nz)} non-success ({', '.join(nz[:6])}): fix it (never re-run until green)")
            else:
                print(f"public CI: 0 non-success of {len(runs)} check-runs on the public main tip {(runs[0].get('head_sha') or '')[:10]}")
        except Exception as e:  # noqa: BLE001
            out.append(f"public CI could not be read ({type(e).__name__}): arming needs a green answer")
    return out


def repo_id(url):
    """owner/repo of a git URL (ssh alias, scp form or ssh://), or the real path of a local one: two spellings of one repo match."""
    u = url.strip().rstrip("/")
    u = u[:-4] if u.endswith(".git") else u
    if u.startswith(("/", "file://")):
        return os.path.realpath(u.replace("file://", "", 1))
    m = re.match(r"^(?:[a-z+]+://)?(?:[^@/]+@)?[^:/]+[:/]/?(.+)$", u)
    return (m.group(1) if m else u).lower()


def remote_problems(main):
    """Incidents 47 and 48. No url.*.insteadOf / pushInsteadOf in any git config the release user's git reads (a stand-in origin
    left there means no release reaches GitHub or Vercel); origin really answers the main the clone has; and the server runs
    exactly that main, so Update 1 ships only Update 1."""
    out = []
    for scope, cmd in (("global (~/.gitconfig)", ["git", "config", "--global", "--get-regexp", r"^url\."]),
                       ("system", ["git", "config", "--system", "--get-regexp", r"^url\."]),
                       ("the release clone", ["git", "-c", "safe.directory=*", "-C", CFG["repo"], "config", "--local", "--get-regexp", r"^url\."]),
                       ("the queue repo", ["git", "-c", "safe.directory=*", "-C", CFG["queue_repo"], "config", "--local", "--get-regexp", r"^url\."])):
        c, o = run(cmd)
        if c == 0 and o.strip():
            out.append(f"the release user's git config ({scope}) rewrites remote URLs: {'; '.join(o.strip().splitlines()[:3])[:240]}. "
                       f"Remove every url.*.insteadOf before arming (incident 47)")
    want = E("PRIVATE_URL", "")
    got = (run(["git", "-c", "safe.directory=*", "-C", CFG["repo"], "ls-remote", "--get-url", "origin"])[1] or "").strip()
    if want and "CHANGE_ME" not in want and repo_id(got) != repo_id(want):
        out.append(f"the release clone's origin resolves to {got[:120]} (after any insteadOf), not the private repo {want} that root deploys "
                   f"from: releases would never reach it (incident 47)")
    c, o = run(["git", "-c", "safe.directory=*", "-C", CFG["repo"], "ls-remote", "origin", "refs/heads/main"], timeout=120)
    lr = o.split()[0] if c == 0 and o.strip() else ""
    if not lr:
        out.append(f"`git ls-remote origin refs/heads/main` in the release clone gave no answer (exit {c}): the real remote must answer (incident 47)")
    elif lr != main:
        out.append(f"origin answers main = {lr[:12]} but the clone's origin/main is {main[:12]}: a stand-in or stale remote (incident 47)")
    try:
        running = os.path.basename(os.readlink(os.path.join(CFG["opt_dir"], "current")))
    except OSError:
        running = ""
    if running != main:
        out.append(f"the server runs {running[:12] or 'nothing readable'} but private main is {main[:12]}: deploy current main first "
                   f"(sudo ifso-deploy {main}), then run the preflight again (incident 48)")
    else:
        print(f"running release = private main = origin's main ({main[:12]})")
    return out


def cmd_arm_check(args):
    probs = arm_problems(arg(args, "--preflight", os.path.join(RELEASE_HOME, "preflight", "results.json")))
    for p in probs:
        print(f"REFUSED: {p}")
    if not probs:
        print("arming checks: schedule current, preflight current and all PASS, public CI green")
    return 1 if probs else 0


def cmd_status(short=False):
    sched = load(SCHEDULE, None)
    if sched is None:
        print("no schedule.json yet")
        return 0
    st = init_state(sched)
    cnt = {"released": 0, "pending": 0, "held": 0, "in_progress": 0}
    for v in st["updates"].values():
        cnt[v["status"]] = cnt.get(v["status"], 0) + 1
    nxt = next_pending(st, sched, any_time=True)
    paused = os.path.exists(PAUSE)
    print(f"armed: {'yes' if armed(sched, strict=False) else 'NO'}   launchAt {sched.get('launchAt') or 'not set'}   now {iso(now())}   "
          f"{'PAUSED (' + open(PAUSE).read().strip()[:100] + ')' if paused else 'running' if sched.get('launchAt') else 'idle'}")
    print(f"released {cnt['released']}   pending {cnt['pending']}   held {cnt['held']}   in progress {cnt['in_progress']}   (of {len(sched['updates'])})")
    print(f"next slot: {nxt['id'] + ' at ' + str(nxt['slot']) if nxt else 'none'}")
    held = [k for k, v in st["updates"].items() if v["status"] == "held"]
    print(f"held: {', '.join(held) or 'none'}" + (f"   (after fixing: sudo ifso-release-retry {held[0]})" if held else ""))
    if st.get("staleSchedule"):
        print(f"STALE SCHEDULE: {st['staleSchedule'][:200]}")
    pf = preflight_line()
    if pf:
        print(pf)
    if short:
        return 0
    print(f"\n{'TU':5} {'slot (UTC)':20} {'status':12} {'main':10} {'public':10} note")
    for u in sched["updates"]:
        t = st["updates"][u["id"]]
        note = t.get("reason") or t.get("waiting") or t.get("blockedReason") or ""
        if t["status"] == "released":
            note = "public copy pending" if t.get("publicPending") else u["name"]
        if t["status"] == "in_progress":
            note = f"at step {t.get('step')} ({', '.join(t.get('done', []))} done)"
        print(f"{u['id']:5} {str(u.get('slot') or '-'):20} {t['status']:12} {str(t.get('landedSha') or '')[:10]:10} "
              f"{str(t.get('publicSha') or '')[:10]:10} {note[:100]}")
    return 0


def preflight_line():
    try:
        return open(os.path.join(RELEASE_HOME, "preflight", "status")).read().strip()
    except OSError:
        return ""


def cmd_retry(tid):
    sched = schedule()
    st = init_state(sched)
    if tid not in st["updates"]:
        sys.exit(f"no update {tid} in the schedule")
    t = st["updates"][tid]
    if t["status"] != "held":
        sys.exit(f"{tid} is {t['status']}, not held")
    st["updates"][tid] = {"status": "pending", "attempts": 0,
                          "history": t.get("history", []) + [{k: t.get(k) for k in ("reason", "heldAt", "landedSha", "revertSha")}]}
    st.pop("allDone", None)
    (st.get("alerts") or {}).pop(f"blocked-{tid}", None)
    save(STATE, st)
    print(f"{tid} is pending again; the next pass releases it (its slot has passed)")
    return 0


def cmd_set_times(args):
    la = arg(args, "--launch-at")
    iv = int(arg(args, "--interval-minutes", "60"))
    gap = int(arg(args, "--min-gap", "2"))
    t0 = parse(la)  # must be UTC with a Z; anything else is refused
    sched = schedule()
    for i, u in enumerate(sched["updates"]):
        u["slot"] = iso(t0 + dt.timedelta(minutes=iv * i))
    sched.update({"launchAt": la, "minGapMinutes": gap, "cadence": {"perDay": round(1440 / iv, 2), "intervalMinutes": iv}})
    save(SCHEDULE, sched)
    print(f"launchAt {la}; {len(sched['updates'])} slots, one every {iv} min; last at {sched['updates'][-1]['slot']}")
    return 0


def arg(args, name, default=None):
    if name in args:
        return args[args.index(name) + 1]
    if default is None:
        sys.exit(f"missing {name}")
    return default


JOURNAL = "app/drizzle/meta/_journal.json"


def journal_at(repo, sha):
    """The Drizzle migration journal entries in the tree of `sha` ([] when the tree has no journal)."""
    p = subprocess.run(["git", "-c", "safe.directory=*", "-C", repo, "show", f"{sha}:{JOURNAL}"], capture_output=True, text=True)
    if p.returncode:
        return []
    try:
        return json.loads(p.stdout).get("entries") or []
    except ValueError as e:
        raise SystemExit(f"REFUSED: {JOURNAL} in {sha[:10]} is not valid JSON ({e})")


def journal_order(repo, base, shas, ids=None):
    """(problems, migrating ids) for the queue `shas` on `base`. Drizzle applies a migration only when its journal `when` is
    newer than the last APPLIED one, so a queued migration whose `when` is not above every earlier one (main's and the earlier
    queue entries') would be skipped silently on the server (an earlier project's incident 27)."""
    seen = {e.get("tag") for e in journal_at(repo, base)}
    top = max([int(e.get("when") or 0) for e in journal_at(repo, base)] or [0])
    top_from = "main (the base)"
    problems, migrating = [], set()
    for i, sha in enumerate(shas, 1):
        tid = ids[i - 1] if ids else f"TU{i:02d}"
        new = sorted((e for e in journal_at(repo, sha) if e.get("tag") not in seen), key=lambda e: e.get("idx", 0))
        for e in new:
            w = int(e.get("when") or 0)
            if w <= top:
                problems.append(f"  {tid} {sha[:10]}: migration {e.get('tag')} has when {w}, not above {top} ({top_from})")
            else:
                top, top_from = w, f"{tid} {e.get('tag')}"
            seen.add(e.get("tag"))
            migrating.add(tid)
    return problems, migrating


def journal_refusal(problems):
    return ("REFUSED: the Drizzle migration journal `when` values are not increasing in queue order. Drizzle skips a migration "
            "whose `when` is not newer than the last applied one, so these would never run on the server:\n" + "\n".join(problems[:10]) +
            f"\nFix the QUEUE: give each listed migration a `when` (in {JOURNAL}) between the previous migration's and the next one's, "
            "rebuild the queue and run this again.")


def cmd_make_schedule(args):
    qrepo, ref, base = arg(args, "--queue-repo"), arg(args, "--ref", "tu-queue"), arg(args, "--base")
    count = int(arg(args, "--count", "72"))
    if count < 1:
        sys.exit("--count must be the number of updates (72); the count check cannot be switched off")
    manifest = load(arg(args, "--manifest", "/nonexistent"), {})
    shas = subprocess.run(["git", "-C", qrepo, "rev-list", "--first-parent", "--reverse", f"{base}..{ref}"], capture_output=True, text=True, check=True).stdout.split()
    if len(shas) != count:
        # ids are given by POSITION: one extra or missing commit shifts every later TU id, note, poster, tag and manifest key
        odd = []
        for i, sha in enumerate(shas, 1):
            subj = subprocess.run(["git", "-C", qrepo, "log", "-1", "--format=%h %s", sha], capture_output=True, text=True, check=True).stdout.strip()
            if not re.search(r"\btu0*%d\b" % i, subj, re.I):
                odd.append(f"  position {i}: {subj}")
        sys.exit(f"REFUSED: the queue {ref} has {len(shas)} commits after the base {base[:10]}, but --count {count}. TU ids come from the "
                 f"position, so this would shift every later id, note, poster and tag. Fix the QUEUE (squash an extra commit into "
                 f"its update, e.g. a web half into the update it belongs to), do not renumber and do not change --count.\n"
                 + ("Commits whose subject does not name the TU of their position (the first one is where it goes wrong):\n" + "\n".join(odd[:5]) if odd else ""))
    problems, migrating = journal_order(qrepo, base, shas)
    if problems:
        sys.exit(journal_refusal(problems))
    ups = []
    for i, sha in enumerate(shas, 1):
        tid = f"TU{i:02d}"
        subj = subprocess.run(["git", "-C", qrepo, "log", "-1", "--format=%s", sha], capture_output=True, text=True, check=True).stdout.strip()
        m = manifest.get(tid, {})
        ups.append({"id": tid, "n": i, "name": m.get("name") or re.sub(r"^\w+(\([^)]*\))?!?:\s*", "", subj), "sha": sha, "slot": None,
                    "dependsOn": m.get("dependsOn", []), "migration": bool(m.get("migration")) or tid in migrating, "perk_gated": bool(m.get("perk_gated")),
                    "check": m.get("check")})
    for u in ups:  # a perk-gated update's check must say what the locked answer looks like
        if u["perk_gated"] and u["check"] and not u["check"].get("perk_gated"):
            u["check"]["perk_gated"] = True
        if u["perk_gated"] and u["check"] and not u["check"].get("locked_contains"):
            sys.exit(f"{u['id']} is perk_gated but its check has no locked_contains")
    sched = {"project": "ifso", "launchAt": None, "minGapMinutes": 2, "base": base, "tip": shas[-1] if shas else base, "updates": ups}
    save(SCHEDULE, sched)
    print(f"wrote {SCHEDULE}: {len(ups)} updates, base {base[:10]}, tip {sched['tip'][:10]}")
    return 0


def cmd_remap(args):
    """Re-point PENDING and HELD updates at a rebuilt queue branch. The branch (base..ref) must hold exactly those updates: the
    same count and the same subjects in the same order, else it refuses with a diff and changes nothing. Run `retry` for held
    ones first; refuses while an update is in progress. The old schedule is kept as schedule.json.pre-<tag>."""
    import difflib
    qrepo, ref = arg(args, "--queue-repo"), arg(args, "--ref")
    tag = arg(args, "--tag", now().strftime("%Y%m%dT%H%M%S"))
    sched = schedule()
    st = init_state(sched)
    if any(v["status"] == "in_progress" for v in st["updates"].values()):
        sys.exit("an update is in progress: wait for the pass to finish (or ifso-release-abort first)")
    base = arg(args, "--base", sched["base"])
    new = subprocess.run(["git", "-C", qrepo, "rev-list", "--first-parent", "--reverse", f"{base}..{ref}"], capture_output=True, text=True, check=True).stdout.split()
    subj = lambda s: subprocess.run(["git", "-C", qrepo, "log", "-1", "--format=%s", s], capture_output=True, text=True, check=True).stdout.strip()  # noqa: E731
    waiting = [u for u in sched["updates"] if st["updates"][u["id"]]["status"] in ("pending", "held")]
    want = []
    for u in waiting:
        old = subprocess.run(["git", "-C", CFG["queue_repo"], "log", "-1", "--format=%s", u["sha"]], capture_output=True, text=True).stdout.strip() \
              or subprocess.run(["git", "-C", qrepo, "log", "-1", "--format=%s", u["sha"]], capture_output=True, text=True).stdout.strip()
        if not old:
            sys.exit(f"{u['id']}: its scheduled commit {u['sha'][:10]} is in neither queue repo; schedule.json untouched")
        want.append(f"{u['id']}  {old}")
    got = [f"{waiting[i]['id'] if i < len(waiting) else '(extra)'}  {subj(s)}" for i, s in enumerate(new)]
    if len(new) != len(waiting) or [w.split("  ", 1)[1] for w in want] != [g.split("  ", 1)[1] for g in got]:
        diff = "\n".join(difflib.unified_diff(want, got, "schedule.json (pending + held, in order)", f"{ref} ({base[:10]}..)", lineterm="", n=2))
        sys.exit(f"REFUSED: {ref} has {len(new)} commits after {base[:10]}; the schedule has {len(waiting)} pending/held updates. The "
                 f"rebuilt branch must hold exactly those, with the same subjects in the same order (pass --base <the main it was "
                 f"rebuilt on>). schedule.json untouched.\n{diff}")
    problems, _ = journal_order(qrepo, base, new, ids=[u["id"] for u in waiting])
    if problems:
        sys.exit(journal_refusal(problems))
    save(SCHEDULE + f".pre-{tag}", sched)
    for u, s in zip(waiting, new):
        u["sha"] = s
    sched["tip"] = new[-1] if new else sched["tip"]
    sched["base"] = base
    save(SCHEDULE, sched)
    print(f"remapped {len(waiting)} pending/held updates onto {ref} (same count, same subjects, same order); tip {sched['tip'][:10]}; "
          f"old schedule kept as schedule.json.pre-{tag}.\n"
          f"Next: push the same branch to the server queue repo as {CFG['queue_ref'].rsplit('/', 1)[-1]}, then run a preflight.")
    return 0


# The files that hold the forbidden patterns themselves (install.sh seeds forbidden.txt from the example), never "hits".
PATTERN_FILES = [":(exclude)app/scripts/release/forbidden.txt.example", ":(exclude).githooks/public-guard.denylist"]


def cmd_scan_queue():
    """Forbidden-word scan of EVERY queue tree (the added and changed text), not only the diff of one commit: a word in an
    early update would be copied to the public repo at its slot. Patterns: FORBIDDEN_FILE, one regex per line."""
    pats = [l.strip() for l in open(CFG["forbidden_file"]).read().splitlines() if l.strip() and not l.startswith("#")] \
        if os.path.exists(CFG["forbidden_file"]) else []
    if not pats:
        sys.exit(f"no patterns in {CFG['forbidden_file']}: refusing to call the queue clean")
    sched = schedule()
    bad = 0
    for u in sched["updates"]:
        c, out = run(["git", "-c", "safe.directory=*", "-C", CFG["queue_repo"], "grep", "-I", "-i", "-l", "-E", "|".join(f"({p})" for p in pats), u["sha"], "--", *PATTERN_FILES])
        msg = subprocess.run(["git", "-C", CFG["queue_repo"], "log", "-1", "--format=%B", u["sha"]], capture_output=True, text=True).stdout
        mhit = [p for p in pats if re.search(p, msg, re.I)]
        if c == 0 or mhit:
            bad += 1
            print(f"{u['id']}: forbidden text in {out.strip().replace(chr(10), ', ')[:200] or 'the commit message'}")
    print(f"scanned {len(sched['updates'])} queue trees: {bad} with hits")
    return 1 if bad else 0


def cmd_pause(reason):
    with open(PAUSE, "w") as f:
        f.write(f"{iso(now())} paused by {os.environ.get('SUDO_USER') or 'an operator'}: {reason[:200]}\n")
    print("paused: no new release starts; one in progress finishes")
    return 0


def cmd_abort():
    open(ABORT, "w").write(iso(now()) + "\n")
    cmd_pause("abort requested: a running pass stops at its next step")
    print("abort requested")
    return 0


def take_resume_note():
    """True once after `resume` removed PAUSE (its wrapper announced it); the marker is consumed."""
    try:
        os.remove(RESUME_NOTED)
        return True
    except FileNotFoundError:
        return False


def cmd_resume():
    """Removes PAUSE. A stale ABORT (asked for while no pass was running) would fail the NEXT update at its first step
    (an earlier project incident 4): if no pass holds the run lock, nothing is left to abort, so it is removed."""
    if os.path.exists(ABORT):
        lk = open(RUN_LOCK, "a+")
        try:
            fcntl.flock(lk, fcntl.LOCK_EX | fcntl.LOCK_NB)
            os.remove(ABORT)
            print("removed a stale ABORT request (no release pass was running)")
            fcntl.flock(lk, fcntl.LOCK_UN)
        except OSError:
            print("note: a release pass is running; it still stops at its next step (ABORT kept)")
    if os.path.exists(PAUSE):
        os.remove(PAUSE)
        with open(RESUME_NOTED, "w") as f:
            f.write(iso(now()) + "\n")
        print("resumed: the next pass (within 5 minutes) continues")
    else:
        print("was not paused")
    return 0


def cmd_notify_test():
    st = load(STATE, {"updates": {}})
    notify(st, "Alert test", plain("this is a test of the release alerts", "no", "nothing", "nothing is wrong"), channel="test")
    print("sent through the notify wrapper (see logs/alerts.log; Telegram only when armed or channel test)")
    return 0


def main():
    a = sys.argv[1:]
    if not a:
        sys.exit(__doc__)
    os.makedirs(RELEASE_HOME, exist_ok=True)
    cmd = a[0]
    try:
        if cmd == "pass":
            return cmd_pass()
        if cmd == "status":
            return cmd_status("--short" in a)
        if cmd == "retry":
            return cmd_retry(a[1])
        if cmd == "set-times":
            return cmd_set_times(a)
        if cmd == "make-schedule":
            return cmd_make_schedule(a)
        if cmd == "remap":
            return cmd_remap(a)
        if cmd == "arm-check":
            return cmd_arm_check(a)
        if cmd == "scan-queue":
            return cmd_scan_queue()
        if cmd == "pause":
            return cmd_pause(" ".join(a[1:]) or "planned pause")
        if cmd == "abort":
            return cmd_abort()
        if cmd == "resume":
            return cmd_resume()
        if cmd == "notify-test":
            return cmd_notify_test()
    except Blocked as e:
        sys.exit(str(e))
    sys.exit(__doc__)


if __name__ == "__main__":
    sys.exit(main() or 0)
