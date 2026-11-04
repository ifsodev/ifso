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

    def test_off_by_default_and_errors_never_raise(self):
        R.public_ci_tick({})
        R.CFG["public_ci_api"] = "http://127.0.0.1:9"
        try:
            R.public_ci_tick({})
        finally:
            R.CFG["public_ci_api"] = ""


if __name__ == "__main__":
    unittest.main()
