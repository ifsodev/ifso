#!/usr/bin/env python3
"""Unit tests of the runner's decision logic (no git, no network, no sudo). Run: python3 -m unittest discover -s lib -p 'test_*.py'"""
import datetime as dt, json, os, shutil, subprocess, sys, tempfile, unittest

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


class ReleaseBody(unittest.TestCase):
    """The GitHub Release body is the PUBLIC part of notes/TUnn.md only (What changes, How to see it, Activation): never the
    integrator notes (## Integration, file names), never the Post copy, never a banned word (CLAUDE.md copy rules)."""

    NOTE = ("# TU05: Plain receipts\n\n**What changes.** Every payment gets a receipt link.\n\n"
            "**How to see it.** Open a claim link and press Receipt.\n\n"
            "**Under the hood.** `app/src/api/routes/receipt.ts` renders it with `lib/pdf.ts`.\n\n"
            "**Activation.** On by default.\n\n**Post (Telegram / X):** Receipts are here.\n\n"
            "## Integration (for the integrator)\nFiles: `app/src/receipt.ts`. Test: `test/receipt.test.ts`; safe to re-run.\n")

    def run_release(self, note):
        os.makedirs(os.path.join(R.RELEASE_HOME, "notes"), exist_ok=True)
        open(os.path.join(R.RELEASE_HOME, "notes", "TU05.md"), "w").write(note)
        sent, bodies = [], []
        old_run, old_cmd = R.run, R.CFG["ghrelease_cmd"]

        def run(cmd, **k):
            if cmd[0] == "ghrel":
                bodies.append(open(cmd[3]).read())
                return 0, "release created"
            sent.append(cmd)
            return 0, ""
        R.run, R.CFG["ghrelease_cmd"] = run, "ghrel"
        try:
            st, t = {}, {}
            R.github_release(st, {"id": "TU05", "n": 5, "name": "Plain receipts"}, t, os.path.join(HOME, "gh.log"))
        finally:
            R.run, R.CFG["ghrelease_cmd"] = old_run, old_cmd
            os.remove(os.path.join(R.RELEASE_HOME, "notes", "TU05.md"))
        return sent, bodies, t

    def test_integration_post_and_file_naming_under_the_hood_are_not_published(self):
        sent, bodies, t = self.run_release(self.NOTE)
        self.assertEqual(len(bodies), 1)
        b = bodies[0]
        for keep in ("# TU05: Plain receipts", "**What changes.**", "**How to see it.**", "**Activation.**"):
            self.assertIn(keep, b)
        for gone in ("Integration", "receipt.ts", "Under the hood", "Post (", "safe"):
            self.assertNotIn(gone, b)
        self.assertEqual(sent, [], "a clean note raises no alert")
        self.assertEqual(t.get("releaseTag"), "update-05")

    def test_a_banned_word_in_the_public_part_skips_the_body_and_alerts_but_keeps_the_release(self):
        sent, bodies, t = self.run_release(self.NOTE.replace("Every payment gets", "A safe way: every payment gets"))
        self.assertEqual(len(bodies), 1, "the GitHub Release is still made")
        self.assertNotIn("safe", bodies[0].lower())
        self.assertNotIn("What changes", bodies[0], "the body is skipped (title line only)")
        self.assertEqual(len(sent), 1)
        self.assertIn("RELEASE NOTES REFUSED", sent[0][1])
        self.assertIn("safe", " ".join(sent[0]))
        self.assertEqual(t.get("releaseTag"), "update-05")


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


class CatchUp(unittest.TestCase):
    """E15: after a long outage a pass releases at most MAX_PER_PASS (default 3) overdue updates, minGapMinutes apart; the
    next pass goes on with the rest."""

    def test_a_long_outage_releases_three_per_pass_with_the_gap(self):
        s = sched72()
        s["launchAt"], s["minGapMinutes"] = R.iso(R.now() - dt.timedelta(hours=10)), 2
        for i, u in enumerate(s["updates"]):
            u["slot"] = R.iso(R.now() - dt.timedelta(hours=10) + dt.timedelta(hours=i))  # 10 overdue
        released, sleeps = [], []
        names = ("schedule", "armed", "queue_alignment_error", "disk_low", "release_one", "public_ci_tick", "ping", "preflight_kick",
                 "retry_public_pending", "retry_missing_releases", "take_resume_note")
        saved = {n: getattr(R, n) for n in names}
        old_sleep, old_gap = R.time.sleep, R.CFG["gap_sleep"]

        def release_one(st, sched, u):
            st["updates"][u["id"]]["status"] = "released"
            st["lastReleaseAt"] = R.iso(R.now())
            released.append(u["id"])
            return "released"
        R.schedule, R.armed, R.queue_alignment_error, R.disk_low = (lambda: s), (lambda *a, **k: True), (lambda *a, **k: None), (lambda: None)
        R.release_one, R.public_ci_tick, R.ping, R.preflight_kick = release_one, (lambda st: None), (lambda *a: None), (lambda: None)
        R.retry_public_pending = R.retry_missing_releases = lambda st, sched: None
        R.take_resume_note = lambda: True
        R.time.sleep, R.CFG["gap_sleep"] = sleeps.append, True
        try:
            if os.path.exists(R.STATE):
                os.remove(R.STATE)
            if os.path.exists(R.PAUSE):
                os.remove(R.PAUSE)
            R._pass()
            self.assertEqual(released, ["TU01", "TU02", "TU03"])
            self.assertEqual(len(sleeps), 2)  # the gap between them, each close to minGapMinutes
            self.assertTrue(all(110 <= x <= 120 for x in sleeps), sleeps)
            R._pass()
            self.assertEqual(released[3:], ["TU04", "TU05", "TU06"])
        finally:
            for n, f in saved.items():
                setattr(R, n, f)
            R.time.sleep, R.CFG["gap_sleep"] = old_sleep, old_gap
            if os.path.exists(R.STATE):
                os.remove(R.STATE)

    def test_default_is_three(self):
        self.assertEqual(R.CFG["max_per_pass"], 3)


class OwnerOnlySigners(unittest.TestCase):
    """Audit M-2 (PoC poc_audit_m2_server_key.py): install.sh's allowed_signers must hold OWNER keys only, so a commit signed
    by the server key is never accepted for what it is. A runner-made commit (cherry-pick of a queued commit, revert, re-apply)
    is accepted only when its trailer names an owner-signed commit with the same patch (or the inverse one). Driven through the
    real install.sh (PREFIX mode), apply_commit and the root wrapper ifso-deploy-release --validate."""

    @classmethod
    def setUpClass(cls):
        rel = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        cls.T = T = tempfile.mkdtemp(prefix="ifso-m2.")
        env = {k: v for k, v in os.environ.items() if not k.startswith("GIT_")}
        cls.env0 = dict(env, GIT_CONFIG_NOSYSTEM="1", GIT_CONFIG_SYSTEM="/dev/null")

        def sh(*a, cwd=None, env=None, inp=None, ok=False):
            p = subprocess.run(a, cwd=cwd, env=dict(cls.env0, **(env or {})), input=inp, text=True, capture_output=True)
            if p.returncode and not ok:
                raise RuntimeError(f"{a}: {p.stdout}{p.stderr}")
            return p.stdout.strip() if not ok else (p.returncode, (p.stdout + p.stderr).strip())
        cls.sh = staticmethod(sh)
        open(os.path.join(T, "sync-public.py"), "w").write("# stand-in\n")
        pfx = os.path.join(T, "pfx")
        sh("bash", os.path.join(rel, "install.sh"), env={"PREFIX": pfx, "RELEASE_GIT_NAME": "Ifso Release", "RELEASE_GIT_EMAIL": "release@example.invalid",
                                                         "SYNC_PUBLIC_SRC": os.path.join(T, "sync-public.py")})
        cls.signers = os.path.join(pfx, "etc/ifso-release/allowed_signers")
        cls.server_gitcfg = os.path.join(pfx, "var/lib/ifso-release/.gitconfig")
        cls.env0["GIT_CONFIG_GLOBAL"] = cls.server_gitcfg  # every command here is the release user's unless it says otherwise
        sh("ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-C", "owner", "-f", os.path.join(T, "owner"))
        with open(cls.signers, "a") as f:  # the owner's key, appended as the README says
            f.write(f'owner@example.invalid namespaces="git" {" ".join(open(os.path.join(T, "owner.pub")).read().split()[:2])}\n')
        cls.ocfg = os.path.join(T, "owner.gitconfig")
        open(cls.ocfg, "w").write(f"[user]\n name = Owner\n email = owner@example.invalid\n signingkey = {T}/owner.pub\n[gpg]\n format = ssh\n[commit]\n gpgsign = true\n")
        cls.origin = os.path.join(T, "origin.git")
        sh("git", "init", "-q", "--bare", "-b", "main", cls.origin)
        cls.work = w = os.path.join(T, "owner-work")
        sh("git", "clone", "-q", cls.origin, w)
        O = {"GIT_CONFIG_GLOBAL": cls.ocfg}

        def commit(msg, f, sign=True, base=None):
            if base:
                sh("git", "checkout", "-q", "--detach", base, cwd=w, env=O)
            open(os.path.join(w, f), "w").write(msg + "\n")
            sh("git", "add", f, cwd=w, env=O)
            sh("git", "-c", f"commit.gpgsign={'true' if sign else 'false'}", "commit", "-q", "-m", msg, cwd=w, env=O)
            return sh("git", "rev-parse", "HEAD", cwd=w)
        cls.B = commit("base", "a")
        cls.M = commit("owner fix on main", "b")
        sh("git", "push", "-q", "origin", "HEAD:refs/heads/main", cwd=w, env=O)
        cls.Q_unsigned = commit("POISON: unsigned queued update", "evil", sign=False, base=cls.B)  # parent B != main M
        cls.Q_owner = commit("feat(api): TU02 owner-signed queued update", "tu02", base=cls.B)
        cls.queue = os.path.join(T, "queue.git")
        sh("git", "init", "-q", "--bare", "-b", "main", cls.queue)
        sh("git", "push", "-q", cls.queue, f"{cls.Q_owner}:refs/heads/tu-queue", f"{cls.Q_unsigned}:refs/heads/poison", cwd=w, env=O)
        cls.clone = os.path.join(T, "backend")
        sh("git", "clone", "-q", cls.origin, cls.clone)
        sh("git", "fetch", "-q", cls.queue, "+refs/heads/*:refs/queue/*", cwd=cls.clone)
        os.makedirs(os.path.join(T, "opt/releases", cls.M))
        os.symlink(os.path.join(T, "opt/releases", cls.M), os.path.join(T, "opt/current"))
        # the queue root pinned at arming (audit L-13): base B (its merge-base with main) .. the owner-signed tip Q_owner
        cls.pin = os.path.join(T, "queue-pin")
        open(cls.pin, "w").write(f"{cls.B} {cls.Q_owner}\n")
        cls.saved = (R.CFG["repo"], R.CFG["allowed_signers"], os.environ.get("GIT_CONFIG_GLOBAL"), R.CFG.get("queue_pin"), R.CFG["opt_dir"])
        R.CFG["repo"], R.CFG["allowed_signers"] = cls.clone, cls.signers
        R.CFG["queue_pin"], R.CFG["opt_dir"] = cls.pin, os.path.join(T, "opt")
        os.environ["GIT_CONFIG_GLOBAL"] = cls.server_gitcfg  # the release user's ~/.gitconfig from install.sh: signs with the server key

    @classmethod
    def tearDownClass(cls):
        R.CFG["repo"], R.CFG["allowed_signers"], g, R.CFG["queue_pin"], R.CFG["opt_dir"] = cls.saved
        if g is None:
            os.environ.pop("GIT_CONFIG_GLOBAL", None)
        else:
            os.environ["GIT_CONFIG_GLOBAL"] = g

    def setUp(self):
        self.sh("git", "checkout", "-q", "main", cwd=self.clone)
        self.sh("git", "reset", "-q", "--hard", self.M, cwd=self.clone)

    def root_validate(self, sha, pin=None):
        """The root wrapper's own gate on `sha` (pushed to origin main first, as the runner does before the deploy)."""
        self.sh("git", "push", "-q", "-f", self.origin, f"{sha}:refs/heads/main", cwd=self.clone)
        conf = os.path.join(self.T, "paths.conf")
        open(conf, "w").write(f"RELEASE_USER={self.sh('id', '-un')}\nRELEASE_HOME={self.T}/home\nREPO_DIR={self.clone}\nQUEUE_REPO={self.queue}\n"
                              f"ROOT_REPO={self.T}/root.git\nPRIVATE_URL={self.origin}\nDEPLOY_BIN=/bin/false\nOPT_DIR={self.T}/opt\n"
                              f"ALLOWED_SIGNERS={self.signers}\nRUNNER_LIB={os.path.dirname(os.path.abspath(__file__))}\nFETCH_WAIT=0\n"
                              f"QUEUE_PIN={pin or self.pin}\n")
        sbin = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "sbin")
        return self.sh("bash", os.path.join(sbin, "ifso-deploy-release"), "--validate", sha, ok=True,
                       env={"IFSO_RELEASE_CONF": conf, "IFSO_RELEASE_LIB": sbin, "GIT_CONFIG_GLOBAL": self.server_gitcfg})

    def test_install_keeps_the_server_key_out_of_allowed_signers(self):
        srv = open(os.path.join(self.T, "pfx/var/lib/ifso-release/.ssh/id_ed25519_signing.pub")).read().split()[1]
        self.assertNotIn(srv, open(self.signers).read())

    def test_poc_unsigned_queued_commit_is_refused(self):
        with self.assertRaises(R.Fail) as e:
            R.apply_commit({}, {}, {"sha": self.Q_unsigned, "id": "TU01"}, os.path.join(self.T, "log"))
        self.assertIn("not signed by an owner key", str(e.exception))
        self.assertEqual(self.sh("git", "rev-parse", "main", cwd=self.clone), self.M)  # nothing landed

    def test_owner_signed_queued_commit_lands_as_a_runner_cherry_pick_root_accepts(self):
        t = {}
        R.apply_commit({}, t, {"sha": self.Q_owner, "id": "TU02"}, os.path.join(self.T, "log"))
        landed = t["landedSha"]
        self.assertNotEqual(landed, self.Q_owner)  # not a fast-forward: a runner-made cherry-pick
        self.assertIn(f"(cherry picked from commit {self.Q_owner})", self.sh("git", "log", "-1", "--format=%B", landed, cwd=self.clone))
        self.assertIsNone(R.runner_commit_problem(landed))
        rc, out = self.root_validate(landed)
        self.assertEqual(rc, 0, out)

    def test_server_signed_commit_whose_trailer_names_another_patch_is_refused(self):
        # what a compromised release user can make: its own change, signed by the server key, claiming to be a pick of Q_owner
        w = self.clone
        open(os.path.join(w, "evil"), "w").write("evil\n")
        self.sh("git", "add", "evil", cwd=w)
        self.sh("git", "commit", "-q", "-S", "-m", f"feat(api): TU02\n\n(cherry picked from commit {self.Q_owner})", cwd=w)
        forged = self.sh("git", "rev-parse", "HEAD", cwd=w)
        self.assertIn("patch", R.runner_commit_problem(forged) or "")
        rc, out = self.root_validate(forged)
        self.assertNotEqual(rc, 0, out)
        self.assertIn("patch", out)

    def test_server_signed_commit_without_a_trailer_is_refused_by_root(self):
        w = self.clone
        open(os.path.join(w, "evil2"), "w").write("evil\n")
        self.sh("git", "add", "evil2", cwd=w)
        self.sh("git", "commit", "-q", "-S", "-m", "chore: looks harmless", cwd=w)
        rc, out = self.root_validate(self.sh("git", "rev-parse", "HEAD", cwd=w))
        self.assertNotEqual(rc, 0, out)

    # ---- audit L-13 (rescore of 2522423): docs/reviews/poc_rescore_l13_revert_reapply.py, both cases now REFUSED
    def test_l13_poc_a_revert_of_an_owner_fix_on_main_is_refused(self):
        w = self.clone
        self.sh("git", "revert", "--no-edit", self.M, cwd=w)          # server-key signed, "This reverts commit M."
        r = self.sh("git", "rev-parse", "HEAD", cwd=w)
        self.assertIn("pinned queue", R.runner_commit_problem(r) or "")
        rc, out = self.root_validate(r)
        self.assertNotEqual(rc, 0, out)                                # M is the running release but no queued update
        self.assertIn("pinned queue", out)

    def test_l13_poc_b_reapply_of_an_abandoned_owner_commit_is_refused(self):
        O = {"GIT_CONFIG_GLOBAL": self.ocfg}
        wo = self.work
        self.sh("git", "checkout", "-q", "--detach", self.B, cwd=wo, env=O)
        open(os.path.join(wo, "debug"), "w").write("ALLOW_ANY=1\n")   # an owner-signed WIP commit never meant for main
        self.sh("git", "add", "debug", cwd=wo, env=O)
        self.sh("git", "commit", "-q", "-m", "wip: debug switch (never merge)", cwd=wo, env=O)
        e = self.sh("git", "rev-parse", "HEAD", cwd=wo)
        self.sh("git", "push", "-q", self.queue, f"{e}:refs/heads/anything", cwd=wo, env=O)  # the release user owns the queue repo
        w = self.clone
        self.sh("git", "fetch", "-q", self.queue, "+refs/heads/*:refs/queue/*", cwd=w)
        self.sh("git", "cherry-pick", "-x", e, cwd=w)                 # server-key signed, "(cherry picked from commit E)"
        c = self.sh("git", "rev-parse", "HEAD", cwd=w)
        self.assertIn("not a commit of the pinned queue", R.runner_commit_problem(c) or "")
        rc, out = self.root_validate(c)
        self.assertNotEqual(rc, 0, out)
        self.assertIn("not a commit of the pinned queue", out)

    def test_l13_without_a_pinned_queue_root_refuses_every_runner_commit(self):
        t = {}
        R.apply_commit({}, t, {"sha": self.Q_owner, "id": "TU02"}, os.path.join(self.T, "log"))
        rc, out = self.root_validate(t["landedSha"], pin=os.path.join(self.T, "no-such-pin"))
        self.assertNotEqual(rc, 0, out)
        self.assertIn("no pinned queue", out)
        self.assertIn("no pinned queue", R.runner_commit_problem(t["landedSha"], pins=[]) or "")

    def test_l13_revert_of_an_older_update_that_is_not_the_running_release_is_refused(self):
        t = {}
        R.apply_commit({}, t, {"sha": self.Q_owner, "id": "TU02"}, os.path.join(self.T, "log"))
        landed, w = t["landedSha"], self.clone
        self.sh("git", "revert", "--no-edit", landed, cwd=w)
        r = self.sh("git", "rev-parse", "HEAD", cwd=w)
        self.assertIsNone(R.runner_commit_problem(r, cur=landed))      # the rollback of the running release: accepted
        self.assertIsNone(R.runner_commit_problem(r, cur=self.M))      # landed is in this same deploy: accepted
        self.assertIn("neither the running release", R.runner_commit_problem(r, cur=r) or "")  # cur past landed: refused

    def test_revert_with_the_inverse_patch_is_accepted_and_an_altered_one_refused(self):
        t = {}
        R.apply_commit({}, t, {"sha": self.Q_owner, "id": "TU02"}, os.path.join(self.T, "log"))
        landed, w = t["landedSha"], self.clone
        self.sh("git", "revert", "--no-edit", landed, cwd=w)  # signed by the server key (commit.gpgsign in install's gitconfig)
        good = self.sh("git", "rev-parse", "HEAD", cwd=w)
        self.assertIsNone(R.runner_commit_problem(good))
        rc, out = self.root_validate(good)
        self.assertEqual(rc, 0, out)
        self.sh("git", "reset", "-q", "--hard", landed, cwd=w)
        self.sh("git", "revert", "--no-commit", landed, cwd=w)
        open(os.path.join(w, "evil3"), "w").write("smuggled\n")
        self.sh("git", "add", "evil3", cwd=w)
        self.sh("git", "commit", "-q", "-S", "-m", f'Revert "x"\n\nThis reverts commit {landed}.', cwd=w)
        bad = self.sh("git", "rev-parse", "HEAD", cwd=w)
        self.assertIn("patch", R.runner_commit_problem(bad) or "")
        rc, out = self.root_validate(bad)
        self.assertNotEqual(rc, 0, out)


class GateUser(unittest.TestCase):
    """Audit M-2: the gate runs as GATE_USER (no access to the release user's keys) with a clean environment, and installs
    without running any dependency's install script."""

    def test_gate_runs_as_the_gate_user_with_a_clean_environment(self):
        old = R.CFG["gate_user"]
        R.CFG["gate_user"] = "ifso-gate-test"
        os.environ["IFSO_ALLOW_REAL_DEPLOY"] = "1"
        try:
            argv = R.gate_shell("nice -n 10 bun test", "/var/lib/ifso-gate/release/app", {"TMPDIR": "/var/lib/ifso-gate/release.tmp"})
        finally:
            R.CFG["gate_user"] = old
            os.environ.pop("IFSO_ALLOW_REAL_DEPLOY")
        self.assertEqual(argv[:7], ["sudo", "-n", "-u", "ifso-gate-test", "--", "env", "-i"])
        self.assertEqual(argv[-3:-1], ["bash", "-c"])
        self.assertTrue(argv[-1].startswith("umask 022 && cd /var/lib/ifso-gate/release/app && "))
        envs = [a for a in argv[7:-3]]
        self.assertEqual(sorted(e.split("=", 1)[0] for e in envs), ["HOME", "LANG", "PATH", "TMPDIR"])
        self.assertIn("HOME=/var/lib/ifso-gate", envs)
        self.assertFalse(any("IFSO_" in a or "RELEASE_HOME" in a or "ALLOWED_SIGNERS" in a for a in argv))

    def test_no_gate_user_runs_as_the_runner(self):
        self.assertEqual(R.gate_shell("true", "/tmp")[:1], ["env"])

    def test_gate_tree_is_readable_by_the_runner_whatever_umask_it_inherits(self):
        """sudo-rs (Ubuntu 26.04, the server) keeps the caller's umask, 027 from common.sh when an operator runs
        ifso-release-preflight; classic sudo's PAM session reset it. With 027 the gate user's tree was unreadable by the
        runner, changed_tests() found no test, and the preflight passed updates whose tests fail (or need anvil)."""
        d = tempfile.mkdtemp(prefix="ifso-umask.")
        old = os.umask(0o077)
        try:
            for gu in ("", "ifso-gate-test"):
                R.CFG["gate_user"], keep = gu, R.CFG["gate_user"]
                try:
                    self.assertTrue(R.gate_shell("true", d)[-1].startswith("umask 022 && cd "), gu)
                finally:
                    R.CFG["gate_user"] = keep
            subprocess.run(R.gate_shell("mkdir t && echo x >t/f.test.ts", d), check=True)
            self.assertEqual(oct(os.stat(os.path.join(d, "t")).st_mode & 0o777), "0o755")
            self.assertEqual(oct(os.stat(os.path.join(d, "t", "f.test.ts")).st_mode & 0o777), "0o644")
        finally:
            os.umask(old)
            shutil.rmtree(d, ignore_errors=True)

    def test_installs_ignore_scripts(self):
        self.assertIn("--ignore-scripts", R.CFG["gate_install"])
        self.assertIn("--ignore-scripts", R.CFG["gate_web_install"])


class StaleLocks(unittest.TestCase):
    """Incident 43: lock files older than 10 minutes (index.lock, packed-refs.lock, refs/**/*.lock) are removed only when no
    git process works in that repository, and every removed lock is named in the log and the alert."""

    def setUp(self):
        self.repo = tempfile.mkdtemp(prefix="ifso-locks.")
        subprocess.run(["git", "init", "-q", self.repo], check=True)
        self.bare = tempfile.mkdtemp(prefix="ifso-locks-bare.")
        subprocess.run(["git", "init", "-q", "--bare", self.bare], check=True)
        old = R.time.time() - 20 * 60
        self.stale = [os.path.join(self.repo, ".git", "packed-refs.lock"), os.path.join(self.repo, ".git", "index.lock"),
                      os.path.join(self.repo, ".git", "refs", "runner", "heads", "release-queue-copy.lock"),
                      os.path.join(self.bare, "refs", "heads", "tu-queue.lock")]
        for f in self.stale:
            os.makedirs(os.path.dirname(f), exist_ok=True)
            open(f, "w").close()
            os.utime(f, (old, old))
        self.fresh = os.path.join(self.repo, ".git", "HEAD.lock")
        open(self.fresh, "w").close()
        self.calls = []
        self.old_run = R.run

    def tearDown(self):
        R.run = self.old_run

    def test_stale_locks_are_removed_and_named(self):
        st = {}
        R.run = lambda cmd, **k: (self.calls.append(cmd) or (0, "")) if "--ping" not in cmd and cmd[:1] != ["pgrep"] else self.old_run(cmd, **k)
        removed = R.clear_stale_git_locks([self.repo, self.bare], st)
        self.assertEqual(sorted(removed), sorted(self.stale))
        self.assertFalse(any(os.path.exists(f) for f in self.stale))
        self.assertTrue(os.path.exists(self.fresh), "a lock younger than 10 minutes is never touched")
        alert = [c for c in self.calls if "STALE GIT LOCK" in " ".join(c)]
        self.assertEqual(len(alert), 1)
        self.assertIn("packed-refs.lock", " ".join(alert[0]))
        self.assertIn("release-queue-copy.lock", " ".join(alert[0]))

    def test_nothing_is_removed_while_a_git_process_works_there(self):
        old = R.git_processes_in
        R.git_processes_in = lambda dirs: [4242]
        try:
            self.assertEqual(R.clear_stale_git_locks([self.repo, self.bare], {}), [])
        finally:
            R.git_processes_in = old
        self.assertTrue(all(os.path.exists(f) for f in self.stale))

    def test_a_lock_replaced_between_the_check_and_the_removal_is_kept(self):
        """Rescore info: check-then-remove race. A git process that starts after the busy check and re-creates the lock (a NEW
        file at the same path) must keep it: the runner moves the old file aside, checks it is still the same inode and age and
        that no git process started, and only then deletes it; otherwise the lock goes back."""
        target = self.stale[0]
        real_rename = R.os.rename
        def racing_rename(a, b):
            if a == target:  # a git process removes the stale lock and takes it anew, just before the runner acts
                os.remove(a); open(a, "w").close()
            real_rename(a, b)
        R.os.rename = racing_rename
        try:
            removed = R.clear_stale_git_locks([self.repo, self.bare], None)
        finally:
            R.os.rename = real_rename
        self.assertNotIn(target, removed)
        self.assertTrue(os.path.exists(target), "the fresh lock of the new git process is back in place")
        self.assertFalse([f for f in os.listdir(os.path.dirname(target)) if ".stale." in f], "no aside file left behind")
        self.assertIn(self.stale[1], removed)

    def test_a_git_process_that_starts_during_the_sweep_keeps_its_locks(self):
        old, calls = R.git_processes_in, []
        R.git_processes_in = lambda dirs: (calls.append(1) or ([] if len(calls) == 1 else [4242]))
        try:
            removed = R.clear_stale_git_locks([self.repo, self.bare], None)
        finally:
            R.git_processes_in = old
        self.assertEqual(removed, [])
        self.assertTrue(all(os.path.exists(f) for f in self.stale))

    def test_a_git_process_in_another_repository_does_not_count(self):
        p = subprocess.Popen(["git", "-C", tempfile.mkdtemp(), "hash-object", "--stdin"], stdin=subprocess.PIPE)
        try:
            self.assertEqual(R.git_processes_in([self.repo]), [])
        finally:
            p.communicate(b"x")
        q = subprocess.Popen(["git", "-C", self.repo, "hash-object", "--stdin"], stdin=subprocess.PIPE)
        try:
            R.time.sleep(0.3)
            self.assertEqual(R.git_processes_in([self.repo]), [q.pid])  # ... and one working in the repository does
        finally:
            q.communicate(b"x")


class SetTimes(unittest.TestCase):
    """Incident 49 (and the time-move rule): set-times re-dates only the updates not yet released, and posts the new times to the
    ops chat in UTC, MSK and US Eastern (DST-aware)."""

    def setUp(self):
        self.calls, self.old_run = [], R.run
        R.run = lambda cmd, **k: (self.calls.append(cmd) or (0, "")) if "--ping" not in cmd else (0, "")

    def tearDown(self):
        R.run = self.old_run
        for f in (R.STATE,):
            if os.path.exists(f):
                os.remove(f)

    def posted(self):
        return [" ".join(c) for c in self.calls if any("slots" in str(x).lower() or "times" in str(x).lower() for x in c[-4:-2])]

    def test_released_updates_keep_their_slots(self):
        s = sched72()
        R.save(R.SCHEDULE, s)
        R.cmd_set_times(["--launch-at", "2026-11-17T14:00:00Z"])
        st = state(R.load(R.SCHEDULE, None), TU01="released", TU02="released", TU03="held")
        R.save(R.STATE, st)
        R.cmd_set_times(["--launch-at", "2026-11-18T20:00:00Z"])
        u = R.load(R.SCHEDULE, None)["updates"]
        self.assertEqual([u[0]["slot"], u[1]["slot"]], ["2026-11-17T14:00:00Z", "2026-11-17T15:00:00Z"])  # released: untouched
        self.assertEqual(u[2]["slot"], "2026-11-18T20:00:00Z")   # the held one goes first when retried
        self.assertEqual(u[3]["slot"], "2026-11-18T21:00:00Z")
        self.assertEqual(u[71]["slot"], "2026-11-21T17:00:00Z")  # 70 left, hourly: 20:00 + 69 h

    def test_the_new_times_are_posted_in_utc_msk_and_us_eastern(self):
        R.save(R.SCHEDULE, sched72())
        R.cmd_set_times(["--launch-at", "2026-11-17T14:00:00Z"])
        msg = " ".join(" ".join(c) for c in self.calls)
        self.assertIn("2026-11-17 14:00 UTC", msg)
        self.assertIn("17:00 MSK", msg)
        self.assertIn("09:00 EST", msg)          # November: UTC-5
        self.calls.clear()
        R.cmd_set_times(["--launch-at", "2026-07-01T14:00:00Z"])
        msg = " ".join(" ".join(c) for c in self.calls)
        self.assertIn("10:00 EDT", msg)          # summer: UTC-4

    def test_us_eastern_switches_on_the_right_days(self):
        f = lambda t: R.us_eastern(R.parse(t))[1]  # noqa: E731
        self.assertEqual(f("2026-03-08T06:59:00Z"), "EST")
        self.assertEqual(f("2026-03-08T07:00:00Z"), "EDT")
        self.assertEqual(f("2026-11-01T05:59:00Z"), "EDT")
        self.assertEqual(f("2026-11-01T06:00:00Z"), "EST")


if __name__ == "__main__":
    unittest.main()
