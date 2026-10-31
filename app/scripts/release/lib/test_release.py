#!/usr/bin/env python3
"""Unit tests of the runner's decision logic (no git, no network, no sudo). Run: python3 -m unittest discover -s lib -p 'test_*.py'"""
import datetime as dt, json, os, sys, tempfile, unittest

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

    def test_off_by_default_and_errors_never_raise(self):
        R.public_ci_tick({})
        R.CFG["public_ci_api"] = "http://127.0.0.1:9"
        try:
            R.public_ci_tick({})
        finally:
            R.CFG["public_ci_api"] = ""


if __name__ == "__main__":
    unittest.main()
