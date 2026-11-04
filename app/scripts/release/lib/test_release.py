#!/usr/bin/env python3
"""Unit tests of the runner's decision logic (no git, no network, no sudo). Run: python3 -m unittest discover -s lib -p 'test_*.py'"""
import datetime as dt, json, os, subprocess, sys, tempfile, unittest

HOME = tempfile.mkdtemp(prefix="ifso-release-unit.")
os.environ.update(RELEASE_HOME=HOME, NOTIFY_CMD="true", ALLOW_FILE=os.path.join(HOME, "ALLOW"), PUBLIC_CI_API="")
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import release as R  # noqa: E402


def sched72():
    return {"launchAt": None, "minGapMinutes": 2, "base": "b", "tip": "t",
            "updates": [{"id": f"TU{i:02d}", "n": i, "name": f"u{i}", "sha": f"{i:040x}", "slot": None, "dependsOn": [], "migration": False}
                        for i in range(1, 73)]}


def state(s, **over):
    st = {"updates": {u["id"]: {"status": "pending", "attempts": 0} for u in s["updates"]}}
    for k, v in over.items():
        st["updates"][k]["status"] = v
    return st


class Slots(unittest.TestCase):
    def test_72_hourly_slots_in_utc(self):
        R.save(R.SCHEDULE, sched72())
        R.cmd_set_times(["--launch-at", "2026-11-17T14:00:00Z"])
        s = R.load(R.SCHEDULE, None)
        self.assertEqual(len(s["updates"]), 72)
        self.assertEqual(s["updates"][0]["slot"], "2026-11-17T14:00:00Z")
        self.assertEqual(s["updates"][1]["slot"], "2026-11-17T15:00:00Z")
        self.assertEqual(s["updates"][23]["slot"], "2026-11-18T13:00:00Z")
        self.assertEqual(s["updates"][71]["slot"], "2026-11-20T13:00:00Z")  # 72 hours: three days
        self.assertEqual(s["cadence"]["perDay"], 24)

    def test_non_utc_launch_refused(self):
        R.save(R.SCHEDULE, sched72())
        with self.assertRaises(Exception):
            R.cmd_set_times(["--launch-at", "2026-11-17T14:00:00+02:00"])


class Ordering(unittest.TestCase):
    def setUp(self):
        self.s = sched72()
        past = dt.datetime.now(dt.timezone.utc) - dt.timedelta(hours=100)
        for i, u in enumerate(self.s["updates"]):
            u["slot"] = R.iso(past + dt.timedelta(hours=i))

    def test_due_updates_go_in_order(self):
        st = state(self.s)
        self.assertEqual(R.next_pending(st, self.s)["id"], "TU01")
        st["updates"]["TU01"]["status"] = "released"
        self.assertEqual(R.next_pending(st, self.s)["id"], "TU02")

    def test_future_slot_is_not_due(self):
        soon = dt.datetime.now(dt.timezone.utc) + dt.timedelta(hours=1)
        for i, u in enumerate(self.s["updates"]):
            u["slot"] = R.iso(soon + dt.timedelta(hours=i))
        self.assertIsNone(R.next_pending(state(self.s), self.s))

    def test_held_update_does_not_block_independent_ones(self):
        st = state(self.s, TU01="held")
        self.assertEqual(R.next_pending(st, self.s)["id"], "TU02")

    def test_dependant_of_a_held_update_waits_and_is_not_held(self):
        self.s["updates"][1]["dependsOn"] = ["TU01"]
        st = state(self.s, TU01="held")
        self.assertEqual(R.next_pending(st, self.s)["id"], "TU03")
        self.assertEqual(st["updates"]["TU02"]["status"], "pending")
        self.assertIn("TU01 is held", st["updates"]["TU02"]["waiting"])
        st["updates"]["TU01"]["status"] = "released"
        self.assertEqual(R.next_pending(st, self.s)["id"], "TU02")

    def test_dependencies_are_transitive(self):
        self.s["updates"][1]["dependsOn"] = ["TU01"]
        self.s["updates"][2]["dependsOn"] = ["TU02"]
        self.assertEqual(R.held_roots(self.s, self.s["updates"][2]), {"TU01", "TU02"})

    def test_migrations_keep_their_order(self):
        self.s["updates"][4]["migration"] = True
        self.s["updates"][9]["migration"] = True
        st = state(self.s, TU05="held")
        for k in ("TU01", "TU02", "TU03", "TU04", "TU06", "TU07", "TU08", "TU09"):
            st["updates"][k]["status"] = "released"
        self.assertEqual(R.next_pending(st, self.s)["id"], "TU11")  # TU10 (migration) waits for the held TU05


class Small(unittest.TestCase):
    def test_tag_is_zero_padded(self):
        self.assertEqual(R.tag_for({"n": 7}), "update-07")
        self.assertEqual(R.tag_for({"n": 72}), "update-72")

    def test_alert_text_has_the_four_plain_lines(self):
        t = R.plain("a", "b", "c", "d")
        self.assertEqual([x.split(":")[0] for x in t.splitlines()], ["What happened", "Users affected", "What was done", "What is next"])

    def test_two_locks_arm_the_runner(self):
        sched = {"launchAt": "2026-11-17T14:00:00Z"}
        os.environ.pop("IFSO_ALLOW_REAL_DEPLOY", None)
        self.assertFalse(R.armed(sched))
        open(R.CFG["allow_file"], "w").close()
        self.assertFalse(R.armed(sched))
        os.environ["IFSO_ALLOW_REAL_DEPLOY"] = "1"
        self.assertTrue(R.armed(sched))
        self.assertFalse(R.armed({"launchAt": None}))
        os.environ.pop("IFSO_ALLOW_REAL_DEPLOY")
        os.remove(R.CFG["allow_file"])

    def test_alerts_are_keyed_by_cause(self):
        calls = []
        old = R.run
        R.run = lambda cmd, **k: (calls.append(cmd) or (0, ""))
        try:
            st = {}
            for _ in range(5):
                R.notify(st, "X", "m", failure=True, key="cause", every=3600)
            self.assertEqual(len(calls), 1)
            R.clear_alert(st, "cause", "all clear", "ok")
            self.assertEqual(len(calls), 2)
            R.clear_alert(st, "cause", "all clear", "ok")  # nothing to clear: silent
            self.assertEqual(len(calls), 2)
        finally:
            R.run = old


class FetchAfterPush(unittest.TestCase):
    """A fetch blip right after a SUCCESSFUL push must not turn into a Fail (that would revert a good update and hold it)."""

    def fake(self, fetch_code, origin="a" * 40):
        def run(cmd, **k):
            if "push" in cmd:
                return 0, "pushed"
            if "fetch" in cmd:
                return fetch_code, "fatal: unable to access 'https://github.com/': Could not resolve host" if fetch_code else ""
            if cmd[-1] == "origin/main":
                return 0, origin
            if cmd[-1] == "main":
                return 0, "a" * 40
            return 0, ""
        return run

    def test_fetch_blip_after_a_good_push_is_not_a_failure(self):
        old = R.run
        R.run = self.fake(128)
        try:
            R.push_main(None)  # push succeeded, origin/main == main (push updates the tracking ref): no exception
        finally:
            R.run = old

    def test_origin_not_main_after_the_push_waits_and_never_fails(self):
        old = R.run
        R.run = self.fake(128, origin="b" * 40)
        try:
            with self.assertRaises(R.Blocked):
                R.push_main(None)
        finally:
            R.run = old


class DeadMan(unittest.TestCase):
    """A held update was already alerted; it must not keep the dead-man check 'down' (a later real silence would be missed)."""

    def test_held_alone_pings_ok_with_a_note(self):
        s = sched72()
        st = state(s, TU01="held")
        calls = []
        old = R.run
        R.run = lambda cmd, **k: (calls.append(cmd) or (0, ""))
        try:
            R.ping(R.health_problems(st, s), R.health_notes(st))
        finally:
            R.run = old
        self.assertEqual(calls[-1][-3:-1], ["--ping", "ok"])
        self.assertIn("held: TU01", calls[-1][-1])

    def test_pause_still_pings_fail(self):
        s = sched72()
        open(R.PAUSE, "w").close()
        try:
            self.assertIn("paused", R.health_problems(state(s, TU01="held"), s))
            self.assertNotIn("held: TU01", R.health_problems(state(s, TU01="held"), s))
        finally:
            os.remove(R.PAUSE)


class ReleaseAlerts(unittest.TestCase):
    """GitHub Release failures are keyed by CAUSE: an outage or a config error is ONE alert, not one per tag per pass."""

    def test_one_alert_per_cause_not_per_tag(self):
        sent, answer = [], {"code": 4, "out": ""}
        old_run, old_cmd = R.run, R.CFG["ghrelease_cmd"]

        def run(cmd, **k):
            if cmd[0] == "ghrel":
                return answer["code"], answer["out"].replace("TAG", cmd[1])
            sent.append(cmd)
            return 0, ""
        R.run, R.CFG["ghrelease_cmd"] = run, "ghrel"
        try:
            st, s = {}, sched72()
            ups = s["updates"][:5]
            for t in range(2):  # two passes over five released updates
                answer["out"] = "create release TAG: HTTP 500"
                for u in ups:
                    R.github_release(st, u, {}, os.path.join(HOME, "gh.log"))
            self.assertEqual(len(sent), 1, [c[1] for c in sent])
            answer["out"] = "ifso-release-ghrelease: PUBLIC_REPO must be owner/name in /etc/ifso-release/release.env"
            for u in ups:
                R.github_release(st, u, {}, os.path.join(HOME, "gh.log"))
            self.assertEqual(len(sent), 2)
            answer.update(code=0, out="release TAG created")
            for u in ups:
                R.github_release(st, u, {}, os.path.join(HOME, "gh.log"))
            self.assertEqual(len(sent), 3)  # one all-clear, once
            self.assertIn("work again", sent[-1][1])
        finally:
            R.run, R.CFG["ghrelease_cmd"] = old_run, old_cmd


class ReadyzLag(unittest.TestCase):
    """The app's /readyz fails on RPC head lag over its own 60 s; an Orbit chain makes no blocks without traffic, so the runner's
    post-release check takes RPC_MAX_LAG_S (calibrated on the server) for a readyz whose ONLY reasons are head lag."""

    def answer(self, code, reasons):
        return lambda url, timeout=15: (code, json.dumps({"ok": not reasons, "reasons": reasons}))

    def test_quiet_chain_lag_within_the_runner_limit_passes(self):
        old, lag = R.http_get, R.CFG.get("rpc_max_lag_s")
        R.http_get, R.CFG["rpc_max_lag_s"] = self.answer(503, ["rpc head lag 90s (max 60s)"]), 300
        try:
            self.assertTrue(R.check_one({"path": "/readyz"})[0])
            R.http_get = self.answer(503, ["rpc head lag 400s (max 60s)"])
            self.assertFalse(R.check_one({"path": "/readyz"})[0])
            R.http_get = self.answer(503, ["rpc head lag 90s (max 60s)", "db down"])
            self.assertFalse(R.check_one({"path": "/readyz"})[0])
        finally:
            R.http_get, R.CFG["rpc_max_lag_s"] = old, lag

    def test_default_limit_is_the_apps_60_s(self):
        self.assertEqual(R.CFG["rpc_max_lag_s"], 60)


class MakeSchedule(unittest.TestCase):
    """TU ids come from the queue POSITION, so a queue with a different number of commits than --count is refused loudly
    (an extra commit would shift every later id, note, poster and tag). Nothing is renumbered."""

    @classmethod
    def setUpClass(cls):
        cls.q = tempfile.mkdtemp(prefix="ifso-queue.")
        g = lambda *a: subprocess.run(["git", "-C", cls.q, "-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", *a],
                                      check=True, capture_output=True, text=True).stdout.strip()  # noqa: E731
        g("init", "-q", "-b", "tu-queue")
        g("commit", "-q", "--allow-empty", "-m", "chore: base")
        cls.base = g("rev-parse", "HEAD")
        for subj in ("feat(tu01): one", "feat(web): the web half of tu01", "feat(tu02): two", "feat(tu03): three"):
            g("commit", "-q", "--allow-empty", "-m", subj)
        cls.extra = g("log", "-1", "--format=%h", "--grep=web half")

    def make(self, count):
        return R.cmd_make_schedule(["--queue-repo", self.q, "--base", self.base, "--count", str(count)])

    def test_wrong_count_is_refused_and_names_the_odd_commit(self):
        with self.assertRaises(SystemExit) as e:
            self.make(3)
        msg = str(e.exception)
        for want in ("4 commits", "--count 3", "do not renumber", self.extra, "feat(web)"):
            self.assertIn(want, msg)

    def test_count_zero_cannot_switch_the_check_off(self):
        with self.assertRaises(SystemExit):
            self.make(0)

    def test_right_count_writes_the_schedule(self):
        self.assertEqual(self.make(4), 0)
        self.assertEqual([u["id"] for u in R.load(R.SCHEDULE, None)["updates"]], ["TU01", "TU02", "TU03", "TU04"])


class Resume(unittest.TestCase):
    def test_resume_leaves_one_note_for_the_next_pass(self):
        open(R.PAUSE, "w").close()
        R.cmd_resume()
        self.assertFalse(os.path.exists(R.PAUSE))
        self.assertTrue(R.take_resume_note())   # the pass after resume stays quiet: the wrapper already posted
        self.assertFalse(R.take_resume_note())  # consumed: a later manual PAUSE removal is announced by the runner

    def test_resume_when_not_paused_leaves_no_note(self):
        R.take_resume_note()
        R.cmd_resume()
        self.assertFalse(R.take_resume_note())


class PublicCI(unittest.TestCase):
    def test_failure_and_timeout_are_red(self):
        runs = [{"id": 1, "name": "app", "conclusion": "failure"}, {"id": 2, "name": "web", "conclusion": "timed_out"},
                {"id": 3, "name": "contracts", "conclusion": "success"}]
        self.assertEqual(R.ci_red_jobs(runs), ["app", "web"])

    def test_cancelled_is_red_only_when_not_replaced(self):
        alone = [{"id": 1, "name": "app", "conclusion": "cancelled"}]
        self.assertEqual(R.ci_red_jobs(alone), ["app"])
        replaced = alone + [{"id": 2, "name": "app", "conclusion": "success"}]
        self.assertEqual(R.ci_red_jobs(replaced), [])

    def test_in_progress_is_never_red(self):
        self.assertEqual(R.ci_red_jobs([{"id": 1, "name": "app", "conclusion": None, "status": "in_progress"}]), [])

    def test_arming_needs_every_job_finished_and_green(self):
        ok = [{"id": 1, "name": "app", "status": "completed", "conclusion": "success"},
              {"id": 2, "name": "docs", "status": "completed", "conclusion": "skipped"}]
        self.assertEqual(R.ci_not_green(ok), [])
        self.assertEqual(R.ci_not_green(ok + [{"id": 3, "name": "web", "status": "in_progress", "conclusion": None}]), ["web (in_progress)"])
        self.assertEqual(R.ci_not_green(ok + [{"id": 4, "name": "slither", "status": "completed", "conclusion": "action_required"}]), ["slither"])

    def test_install_placeholder_keeps_the_watcher_off(self):
        os.environ["PUBLIC_CI_API"] = "https://api.github.com/repos/CHANGE_ME/CHANGE_ME"
        try:
            import importlib
            self.assertEqual(importlib.reload(R).CFG["public_ci_api"], "")
        finally:
            os.environ["PUBLIC_CI_API"] = ""
            importlib.reload(R)

    def test_a_new_red_commit_alerts_at_once(self):
        sent, runs = [], {"v": []}
        old_run, old_get, old_api = R.run, R.public_ci_runs, R.CFG["public_ci_api"]
        R.run = lambda cmd, **k: (sent.append(cmd[1]) or (0, ""))
        R.public_ci_runs = lambda timeout=15: runs["v"]
        R.CFG["public_ci_api"] = "http://ci.invalid"
        try:
            st = {}
            runs["v"] = [{"id": 1, "name": "app", "status": "completed", "conclusion": "failure", "head_sha": "a" * 40}]
            R.public_ci_tick(st)
            R.public_ci_tick(st)  # same red commit within the hour: no second alert
            self.assertEqual(len(sent), 1)
            runs["v"] = [{"id": 2, "name": "web", "status": "completed", "conclusion": "failure", "head_sha": "b" * 40}]
            R.public_ci_tick(st)  # a NEW red commit: alerted at once, not after the hourly reminder
            self.assertEqual(len(sent), 2)
            self.assertIn("bbbbbbbbbb", sent[-1])
        finally:
            R.run, R.public_ci_runs, R.CFG["public_ci_api"] = old_run, old_get, old_api

    def test_off_by_default_and_errors_never_raise(self):
        R.public_ci_tick({})
        R.CFG["public_ci_api"] = "http://127.0.0.1:9"
        try:
            R.public_ci_tick({})
        finally:
            R.CFG["public_ci_api"] = ""


class VercelStatus(unittest.TestCase):
    """B17 (3): after a release that changes web/, Vercel's commit status of that commit is read every pass; a failed deploy or
    none within VERCEL_WAIT_MINUTES is ONE alert per update. Never blocks a release; API errors only wait."""

    def setUp(self):
        self.sent, self.answer = [], {"statuses": [], "check_runs": []}
        self.old = (R.run, R.vercel_api_get, R.CFG["vercel_api"], R.CFG["vercel_wait_min"])
        R.run = lambda cmd, **k: (self.sent.append(cmd[1]) or (0, ""))
        R.vercel_api_get = lambda path, timeout=15: self.answer
        R.CFG["vercel_api"], R.CFG["vercel_wait_min"] = "http://gh.invalid/repos/o/r", 20
        self.s = sched72()

    def tearDown(self):
        R.run, R.vercel_api_get, R.CFG["vercel_api"], R.CFG["vercel_wait_min"] = self.old

    def st(self, minutes_ago=1):
        st = state(self.s, TU03="released")
        st["updates"]["TU03"]["vercel"] = {"sha": "c" * 40, "state": "watching",
                                           "since": R.iso(R.now() - dt.timedelta(minutes=minutes_ago))}
        return st

    def test_failed_vercel_deploy_alerts_once(self):
        st = self.st()
        self.answer = {"statuses": [{"context": "Vercel", "state": "failure"}], "check_runs": []}
        R.vercel_tick(st, self.s)
        R.vercel_tick(st, self.s)
        self.assertEqual(self.sent, ["VERCEL DEPLOY FAILED (TU03)"])
        self.assertEqual(st["updates"]["TU03"]["status"], "released")
        self.assertEqual(st["updates"]["TU03"]["vercel"]["state"], "failed")

    def test_no_deploy_within_the_wait_alerts_missing(self):
        st = self.st(minutes_ago=5)
        R.vercel_tick(st, self.s)
        self.assertEqual(self.sent, [])  # still inside the wait: nothing yet
        st["updates"]["TU03"]["vercel"]["since"] = R.iso(R.now() - dt.timedelta(minutes=30))
        R.vercel_tick(st, self.s)
        R.vercel_tick(st, self.s)
        self.assertEqual(self.sent, ["VERCEL DEPLOY MISSING (TU03)"])

    def test_pending_past_the_wait_alerts_missing(self):
        st = self.st(minutes_ago=30)
        self.answer = {"statuses": [], "check_runs": [{"name": "Vercel - ifso", "status": "in_progress", "conclusion": None}]}
        R.vercel_tick(st, self.s)
        self.assertEqual(self.sent, ["VERCEL DEPLOY MISSING (TU03)"])
        self.assertEqual(st["updates"]["TU03"]["vercel"]["state"], "stuck")

    def test_success_is_quiet_and_other_contexts_are_ignored(self):
        st = self.st(minutes_ago=30)
        self.answer = {"statuses": [{"context": "Vercel", "state": "success"}, {"context": "ci/app", "state": "failure"}], "check_runs": []}
        R.vercel_tick(st, self.s)
        self.assertEqual(self.sent, [])
        self.assertEqual(st["updates"]["TU03"]["vercel"]["state"], "ok")

    def test_superseded_cancelled_build_is_not_a_failure(self):
        self.assertEqual(R.vercel_state([{"context": "Vercel", "state": "cancelled"}], []), "cancelled")
        self.assertEqual(R.vercel_state([], [{"name": "Vercel", "conclusion": "cancelled"}, {"name": "Vercel", "conclusion": "failure"}]), "failed")

    def test_api_errors_wait_and_off_by_default(self):
        st = self.st(minutes_ago=30)

        def boom(path, timeout=15):
            raise OSError("rate limited")
        R.vercel_api_get = boom
        R.vercel_tick(st, self.s)
        self.assertEqual((self.sent, st["updates"]["TU03"]["vercel"]["state"]), ([], "watching"))
        R.CFG["vercel_api"] = ""
        R.vercel_api_get = lambda path, timeout=15: {"statuses": [{"context": "Vercel", "state": "failure"}]}
        R.vercel_tick(st, self.s)
        self.assertEqual(self.sent, [])

    def test_install_placeholder_and_empty_keep_it_off(self):
        import importlib
        for v in ("", "https://api.github.com/repos/CHANGE_ME/CHANGE_ME"):
            os.environ["VERCEL_STATUS_API"] = v
            try:
                self.assertEqual(importlib.reload(R).CFG["vercel_api"], "")
            finally:
                os.environ.pop("VERCEL_STATUS_API", None)
        importlib.reload(R)
        self.old = (R.run, R.vercel_api_get, R.CFG["vercel_api"], R.CFG["vercel_wait_min"])


class LatePoster(unittest.TestCase):
    """B25: a poster staged after its Release exists is attached on a later pass, once."""

    def test_poster_staged_after_the_release_is_attached_once(self):
        calls, have = [], {"poster": False}
        old_run, old_cmd = R.run, R.CFG["ghrelease_cmd"]

        def run(cmd, **k):
            if cmd[0] == "ghrel":
                calls.append(cmd[1])
                return 0, ("release %s already exists: poster attached now" % cmd[1]) if have["poster"] else "release %s created" % cmd[1]
            return 0, ""
        R.run, R.CFG["ghrelease_cmd"] = run, "ghrel"
        try:
            s = sched72()
            st = state(s, TU01="released")
            t = st["updates"]["TU01"]
            R.github_release(st, s["updates"][0], t, os.path.join(HOME, "gh.log"))  # created, no poster staged yet
            R.retry_missing_releases(st, s)
            self.assertEqual(calls, ["update-01"])  # nothing staged: no extra call
            os.makedirs(os.path.join(HOME, "posters"), exist_ok=True)
            with open(os.path.join(HOME, "posters", "update-01.png"), "wb") as f:
                f.write(b"\x89PNG\r\n\x1a\n")
            have["poster"] = True
            R.retry_missing_releases(st, s)  # the later pass: attached
            R.retry_missing_releases(st, s)  # and never again
            self.assertEqual(calls, ["update-01", "update-01"])
            self.assertTrue(t.get("poster"))
        finally:
            R.run, R.CFG["ghrelease_cmd"] = old_run, old_cmd
            try:
                os.remove(os.path.join(HOME, "posters", "update-01.png"))
            except OSError:
                pass


class MigrationOrder(unittest.TestCase):
    """B27: make-schedule refuses a queue whose Drizzle journal `when` values are not increasing in queue order (Drizzle would
    silently skip the later-numbered one with the older `when`), and marks every update that adds a migration."""

    def queue(self, whens):
        q = tempfile.mkdtemp(prefix="ifso-mig.")
        g = lambda *a: subprocess.run(["git", "-C", q, "-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", *a],
                                      check=True, capture_output=True, text=True).stdout.strip()  # noqa: E731
        g("init", "-q", "-b", "tu-queue")
        os.makedirs(os.path.join(q, "app/drizzle/meta"))
        entries = [{"idx": 0, "when": 1000, "tag": "0000_base"}]

        def write():
            with open(os.path.join(q, "app/drizzle/meta/_journal.json"), "w") as f:
                json.dump({"version": "7", "entries": entries}, f)
            g("add", "-A")
        write()
        g("commit", "-q", "-m", "chore: base")
        base = g("rev-parse", "HEAD")
        for i, w in enumerate(whens, 1):
            if w:
                entries.append({"idx": len(entries), "when": w, "tag": f"{len(entries):04d}_tu{i:02d}"})
                write()
            g("commit", "-q", "--allow-empty", "-m", f"feat(tu{i:02d}): update {i}")
        return q, base

    def test_out_of_order_when_is_refused_and_named(self):
        q, base = self.queue([2000, None, 1500])
        with self.assertRaises(SystemExit) as e:
            R.cmd_make_schedule(["--queue-repo", q, "--base", base, "--count", "3"])
        msg = str(e.exception)
        for want in ("not increasing", "TU03", "0002_tu03", "1500", "2000"):
            self.assertIn(want, msg)

    def test_a_when_not_above_main_is_refused(self):
        q, base = self.queue([900])
        with self.assertRaises(SystemExit) as e:
            R.cmd_make_schedule(["--queue-repo", q, "--base", base, "--count", "1"])
        self.assertIn("main (the base)", str(e.exception))

    def test_increasing_queue_is_accepted_and_migrations_marked(self):
        q, base = self.queue([2000, None, 3000])
        self.assertEqual(R.cmd_make_schedule(["--queue-repo", q, "--base", base, "--count", "3"]), 0)
        self.assertEqual([u["migration"] for u in R.load(R.SCHEDULE, None)["updates"]], [True, False, True])


class Remap(unittest.TestCase):
    """E13: remap re-points pending AND held updates only when the rebuilt branch holds exactly them: the same count and the
    same subjects in the same order. Anything else is refused with a diff and schedule.json is untouched."""

    def setUp(self):
        self.q = tempfile.mkdtemp(prefix="ifso-remap.")
        self.g("init", "-q", "-b", "tu-queue")
        self.g("commit", "-q", "--allow-empty", "-m", "chore: base")
        self.base = self.g("rev-parse", "HEAD")
        for i in (1, 2, 3):
            self.g("commit", "-q", "--allow-empty", "-m", f"feat(tu0{i}): update {i}")
        self.old = self.g("rev-list", "--reverse", f"{self.base}..tu-queue").split()
        R.save(R.SCHEDULE, {"launchAt": None, "minGapMinutes": 2, "base": self.base, "tip": self.old[-1],
                            "updates": [{"id": f"TU0{i}", "n": i, "name": f"u{i}", "sha": s, "slot": None, "dependsOn": [], "migration": False}
                                        for i, s in enumerate(self.old, 1)]})
        R.save(R.STATE, {"updates": {"TU01": {"status": "released"}, "TU02": {"status": "held"}, "TU03": {"status": "pending"}}})
        self.oldq, R.CFG["queue_repo"] = R.CFG["queue_repo"], self.q

    def tearDown(self):
        R.CFG["queue_repo"] = self.oldq
        os.remove(R.STATE)

    def g(self, *a):
        return subprocess.run(["git", "-C", self.q, "-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", *a],
                              check=True, capture_output=True, text=True).stdout.strip()

    def branch(self, name, subjects):
        self.g("checkout", "-q", "-b", name, self.base)
        for x in subjects:
            self.g("commit", "-q", "--allow-empty", "-m", x)
        self.g("checkout", "-q", "tu-queue")

    def remap(self, ref):
        return R.cmd_remap(["--queue-repo", self.q, "--ref", ref, "--tag", ref])

    def test_swapped_order_is_refused_with_a_diff(self):
        self.branch("r-swap", ["feat(tu03): update 3", "feat(tu02): update 2"])
        with self.assertRaises(SystemExit) as e:
            self.remap("r-swap")
        self.assertIn("same order", str(e.exception))
        self.assertIn("+TU02  feat(tu03): update 3", str(e.exception))
        self.assertEqual([u["sha"] for u in R.load(R.SCHEDULE, None)["updates"]], self.old)

    def test_extra_or_missing_commit_is_refused(self):
        self.branch("r-extra", ["feat(tu02): update 2", "feat(web): stray half", "feat(tu03): update 3"])
        with self.assertRaises(SystemExit) as e:
            self.remap("r-extra")
        self.assertIn("3 commits", str(e.exception))
        self.branch("r-short", ["feat(tu02): update 2"])
        with self.assertRaises(SystemExit):
            self.remap("r-short")
        self.assertEqual([u["sha"] for u in R.load(R.SCHEDULE, None)["updates"]], self.old)

    def test_exact_branch_remaps_held_and_pending_in_order(self):
        self.branch("r-ok", ["feat(tu02): update 2", "feat(tu03): update 3"])
        self.assertEqual(self.remap("r-ok"), 0)
        new = self.g("rev-list", "--reverse", f"{self.base}..r-ok").split()
        self.assertEqual([u["sha"] for u in R.load(R.SCHEDULE, None)["updates"]], [self.old[0]] + new)


if __name__ == "__main__":
    unittest.main()
