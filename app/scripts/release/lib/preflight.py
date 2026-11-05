#!/usr/bin/env python3
"""Preflight: test every PENDING and HELD update against the CURRENT private main, ahead of its slot, with the runner's own
light gate (release.gate_at), so a change to main (a fix, a bonus, an owner patch) that breaks a queued update is found hours
before its slot instead of holding it at release time (an earlier project incidents 31, 35, 36).

    preflight.py run [--only TUnn]   on demand (sudo ifso-release-preflight)
    preflight.py auto                only when main changed in a way the runner did not make itself, or the queue/schedule
                                     changed, since the last results; every runner pass starts it detached
    preflight.py status              the one-line status

Rules it keeps (each one cost an earlier project hours):
- It NEVER takes the release lock ($RELEASE_HOME/.run.lock) and never writes state.json or schedule.json (read only). Own
  lock ($PF/.preflight.lock), own clone ($PF/backend), own gate checkout ($PF/gate), own temp dir ($PF/tmp: the app tests'
  throwaway Postgres lives there), own output. nice 19.
- It first asserts the schedule is current (base in main, tip == queue branch tip): a stale schedule.json fails with ONE clear
  line, not dozens of "does not apply" conflicts (an earlier project 2026-10-29).
- The runner's helpers are called exactly as the runner calls them (log PATH strings, never file handles).
- Each update is tested where it will really land: current main plus every earlier unreleased update that applies, in queue
  order, held ones included (the owner retries them).
Output: $PF/results.json, $PF/status (one line), $PF/logs/<TUnn>.log. One alert per (main, failing set), one all-clear.
"""
import fcntl, os, sys

LIB = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, LIB)
import release as R  # noqa: E402  (the runner itself: same CFG, same gate_at, same notify)

PF = os.path.abspath(os.environ.get("PREFLIGHT_DIR", os.path.join(R.RELEASE_HOME, "preflight")))
RESULTS, STATUS, ALERTS = (os.path.join(PF, n) for n in ("results.json", "status", "alerts.json"))
CHECKOUT, LOGS, TMP = (os.path.join(PF, n) for n in ("backend", "logs", "tmp"))
# the gate dir belongs to the gate user (audit M-2): its own preflight folder there, never the release gate's
GATE = os.path.abspath(os.environ.get("PREFLIGHT_GATE_DIR") or (os.path.join(R.CFG["gate_home"], "preflight") if R.gate_user_on() else os.path.join(PF, "gate")))


def sh(cmd, cwd=None, ok=False, log=None, timeout=900):
    code, out = R.run(cmd, cwd=cwd, log=log, timeout=timeout)
    if code and not ok:
        raise R.Fail(f"{' '.join(cmd[:4]) if isinstance(cmd, list) else cmd[:80]} (exit {code}): {out.strip()[-300:]}")
    return out.strip() if code == 0 else None


def g(*a, ok=False, log=None):
    return sh(["git", "-c", "safe.directory=*", "-C", CHECKOUT, *a], ok=ok, log=log)


def pending_set(sched, st):
    return [u for u in sched["updates"] if st["updates"][u["id"]]["status"] in ("pending", "held", "in_progress")]


def prepare(sched):
    """Fresh checkout of private main in the preflight's own folder (clone once, then fetch)."""
    origin = R.git("remote", "get-url", "origin")
    if not os.path.isdir(os.path.join(CHECKOUT, ".git")):
        sh(["git", "clone", "-q", origin, CHECKOUT])
    sh(["git", "-c", "safe.directory=*", "-C", CHECKOUT, "remote", "set-url", "origin", origin])
    g("fetch", "-q", "origin")
    g("checkout", "-q", "-f", "--detach", "origin/main")
    g("clean", "-qfd")
    g("fetch", "-q", R.CFG["queue_repo"], "+refs/heads/*:refs/queue/*")
    return g("rev-parse", "HEAD")


def run_all(only=None, quiet=False):
    os.makedirs(LOGS, exist_ok=True)
    os.makedirs(TMP, exist_ok=True)
    try:
        os.nice(19 - os.nice(0))
    except OSError:
        pass
    env_fix = {"TMPDIR": TMP, "TEST_DATABASE_URL": "", "DATABASE_URL": ""}
    os.environ.update(env_fix)
    os.environ.pop("TEST_DATABASE_URL", None)
    os.environ.pop("DATABASE_URL", None)
    sched = R.schedule()
    st = R.load(R.STATE, {"updates": {}})
    for u in sched["updates"]:
        st["updates"].setdefault(u["id"], {"status": "pending"})
    alerts = R.load(ALERTS, {"updates": {}})
    stale = R.queue_alignment_error(sched)
    if stale:
        result = {"at": R.iso(R.now()), "main": "", "stale": stale, "results": {}}
        R.save(RESULTS, result)
        open(STATUS, "w").write(f"preflight: NOT RUN, {stale[:200]}\n")
        R.notify(alerts, "PREFLIGHT STALE SCHEDULE", R.plain(stale, "no", "preflight did not run; releases are also refused until this is fixed",
                 "replace schedule.json from the matching queue"), failure=True, key="stale", every=3600)
        R.save(ALERTS, alerts)
        print(stale)
        return 3
    alerts.get("alerts", {}).pop("stale", None)
    main = prepare(sched)
    results, head = {}, main
    todo = pending_set(sched, st)
    for u in todo:
        log = os.path.join(LOGS, f"{u['id']}.log")
        open(log, "w").close()
        if only and u["id"] != only:
            # still advance the chain so later updates are tested where they will land
            pass
        parent = g("rev-parse", u["sha"] + "^", ok=True, log=log)
        try:
            if g("rev-parse", "HEAD") == parent:
                g("merge", "--ff-only", u["sha"], log=log)
            else:
                code, out = R.run(["git", "-c", "safe.directory=*", "-c", "commit.gpgsign=false", "-c", "user.name=preflight", "-c",
                                   "user.email=preflight@localhost", "cherry-pick", "-x", u["sha"]], cwd=CHECKOUT, log=log)
                if code:
                    R.run(["git", "-c", "safe.directory=*", "cherry-pick", "--abort"], cwd=CHECKOUT, log=log)
                    raise R.Fail(f"does not apply on current main {main[:10]}: {out.strip()[-160:]}")
            landed = g("rev-parse", "HEAD")
            # the same signature rule as the runner and the root deploy wrapper (audit M-2): an unsigned queued commit, or a
            # cherry-pick whose patch changed on the new main, is found here, hours before its slot
            if not R.signature_ok(u["sha"], CHECKOUT):
                raise R.Fail(f"queued commit {u['sha'][:10]} is not signed by an owner key in {R.CFG['allowed_signers']}")
            why = R.runner_commit_problem(landed, CHECKOUT)
            if why:
                raise R.Fail(f"the deploy wrapper would refuse it on current main {main[:10]}: {why}")
            if only and u["id"] != only:
                results[u["id"]] = {"ok": True, "skipped": True}
                continue
            g("branch", "-f", f"pf-{u['id']}", landed)
            R.gate_at(GATE, CHECKOUT, g("rev-parse", landed + "^"), landed, log)
            results[u["id"]] = {"ok": True}
        except R.Blocked as e:
            results[u["id"]] = {"ok": False, "transient": True, "reason": str(e)[:300]}
        except R.Fail as e:
            results[u["id"]] = {"ok": False, "reason": str(e)[:300]}
        if not quiet:
            print(f"{u['id']}: {'PASS' if results[u['id']]['ok'] else 'FAIL ' + results[u['id']].get('reason', '')[:120]}")
    bad = sorted(k for k, v in results.items() if not v["ok"])
    out = {"at": R.iso(R.now()), "main": main, "sfp": sched_fp(sched), "results": results, "failing": bad}
    R.save(RESULTS, out)
    ok_n = sum(1 for v in results.values() if v["ok"])
    open(STATUS, "w").write(f"preflight: {ok_n} of {len(results)} PASS on main {main[:10]} at {out['at']}" + (f"; FAILING {', '.join(bad)}" if bad else "") + "\n")
    sig = f"{main}:{','.join(bad)}"
    if bad and alerts.get("lastSig") != sig:
        R.notify(alerts, f"PREFLIGHT: {len(bad)} queued update(s) fail on current main", R.plain(
            "; ".join(f"{k}: {results[k]['reason'][:120]}" for k in bad[:5]), "no. Nothing has been released with these problems",
            "nothing; the updates stay queued", "developer: read PF logs, reproduce, fix with the owner-fix path, then run preflight again"), failure=True)
    if not bad and alerts.get("lastSig", "").split(":")[-1]:
        R.notify(alerts, "preflight all clear", f"{ok_n} of {len(results)} queued updates pass on main {main[:10]}")
    alerts["lastSig"] = sig
    R.save(ALERTS, alerts)
    return 1 if bad else 0


sched_fp = R.sched_fp  # one definition: arm-check compares the results against it


def auto():
    """Only when something changed that the runner did not do itself: a new private main it did not make, or a new schedule."""
    sched = R.schedule()
    st = R.load(R.STATE, {"updates": {}})
    prev = R.load(RESULTS, {})
    R.git("fetch", "-q", "origin", ok=True)
    main = R.rev(R.CFG["repo"], "origin/main")
    if prev.get("sfp") == sched_fp(sched):
        if prev.get("main") == main:
            return 0
        if main in set(st.get("runnerMains") or []) and not prev.get("failing"):
            return 0  # main moved only because the runner released an update this preflight already covered
    return run_all(quiet=True)


def main():
    os.makedirs(PF, exist_ok=True)
    lock = open(os.path.join(PF, ".preflight.lock"), "a+")
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        print("another preflight is running")
        return 0
    a = sys.argv[1:] or ["run"]
    if a[0] == "status":
        print(open(STATUS).read().strip() if os.path.exists(STATUS) else "preflight: never run")
        return 0
    if a[0] == "auto":
        return auto()
    return run_all(only=a[a.index("--only") + 1] if "--only" in a else None)


if __name__ == "__main__":
    sys.exit(main() or 0)
