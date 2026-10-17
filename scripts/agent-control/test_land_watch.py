import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location(
    "land_watch", Path(__file__).resolve().parents[2] / ".codex/skills/land/land_watch.py"
)
land_watch = importlib.util.module_from_spec(spec)
spec.loader.exec_module(land_watch)


class ClassifyChecksTests(unittest.TestCase):
    def test_check_runs(self):
        for status, conclusion, expected in [
            ("QUEUED", "", ([], ["ci"])),
            ("IN_PROGRESS", None, ([], ["ci"])),
            ("IN_PROGRESS", "FAILURE", ([], ["ci"])),
            ("COMPLETED", None, ([], ["ci"])),
            ("COMPLETED", "", ([], ["ci"])),
            ("COMPLETED", "SUCCESS", ([], [])),
            ("COMPLETED", "FAILURE", (["ci: FAILURE"], [])),
        ]:
            with self.subTest(status=status, conclusion=conclusion):
                self.assertEqual(land_watch.classify_checks([
                    dict(name="ci", status=status, conclusion=conclusion)
                ]), expected)

    def test_status_contexts(self):
        self.assertEqual(land_watch.classify_checks([
            dict(context="ok", state="SUCCESS"),
            dict(context="pending", state="PENDING"),
            dict(context="expected", state="EXPECTED"),
            dict(context="bad", state="ERROR"),
        ]), (["bad: ERROR"], ["pending", "expected"]))

    def test_empty_rollup_is_pending(self):
        self.assertEqual(land_watch.classify_checks([]), ([], ["no checks reported yet"]))


class EvaluateTests(unittest.TestCase):
    def test_pr_state_matrix(self):
        good = dict(state="OPEN", isDraft=False, mergeStateStatus="CLEAN",
                    statusCheckRollup=[dict(name="ci", status="COMPLETED", conclusion="SUCCESS")])
        for changes, verdict, message in [
            ({}, "mergeable", "looks mergeable"),
            ({"mergeStateStatus": "BEHIND"}, "stop", "behind main"),
            ({"state": "CLOSED"}, "stop", "PR is closed"),
            ({"isDraft": True}, "wait", "draft"),
            ({"mergeStateStatus": "DIRTY"}, "stop", "merge conflict"),
            ({"mergeStateStatus": "NEW"}, "stop", "unknown"),
            ({"mergeStateStatus": None}, "stop", "unknown"),
            ({"state": None}, "stop", "unknown"),
            ({"state": "MERGED"}, "merged", "already merged"),
            ({"mergeStateStatus": "BLOCKED"}, "wait", "not mergeable"),
            ({"statusCheckRollup": []}, "wait", "Waiting"),
            ({"statusCheckRollup": [dict(context="ci", state="FAILURE")]}, "stop", "failing"),
        ]:
            with self.subTest(changes=changes):
                result = land_watch.evaluate({**good, **changes})
                self.assertEqual(result[0], verdict)
                self.assertIn(message, result[1])
