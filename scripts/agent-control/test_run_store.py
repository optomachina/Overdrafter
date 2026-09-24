#!/usr/bin/env python3

from __future__ import annotations

import csv
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


SCRIPT = Path(__file__).with_name("run_store.py")


class RunStoreTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.run = self.root / "case"
        self.command("init", "--root", str(self.root), "--run-id", "case", "--title", "Case")

    def tearDown(self) -> None:
        self.temp.cleanup()

    def command(self, *args: str, expect: int = 0) -> subprocess.CompletedProcess[str]:
        result = subprocess.run(
            [sys.executable, str(SCRIPT), *args], text=True, capture_output=True, check=False
        )
        self.assertEqual(expect, result.returncode, result.stdout + result.stderr)
        return result

    def add(self, unit: str, target: str = "repo") -> None:
        self.command(
            "add", "--run", str(self.run), "--unit-id", unit, "--track", "test",
            "--owner-thread", "thread-1", "--host", "local", "--target", target,
            "--deliverable", "artifact", "--head-sha", "abc123",
        )

    def transition(self, unit: str, revision: int, state: str, *extra: str, expect: int = 0):
        return self.command(
            "transition", "--run", str(self.run), "--unit-id", unit,
            "--expected-revision", str(revision), "--state", state, *extra, expect=expect,
        )

    def test_revision_verdict_and_completion_flow(self) -> None:
        self.add("u1")
        self.transition("u1", 1, "ready")
        self.transition("u1", 2, "running")
        self.transition("u1", 3, "verifying")
        evidence = self.run / "proof.txt"
        evidence.write_text("verified\n", encoding="utf-8")
        self.command(
            "verdict", "--run", str(self.run), "--unit-id", "u1",
            "--artifact-key", "proof", "--head-sha", "abc123",
            "--verdict", "unit-test-verified", "--verifier", "test",
            "--evidence-path", str(evidence),
        )
        self.transition("u1", 4, "passed", "--evidence-path", str(evidence))
        self.transition("u1", 5, "complete")
        result = self.command("check", "--run", str(self.run))
        self.assertIn("valid run store (v2)", result.stdout)

    def test_stale_revision_is_rejected_without_mutation(self) -> None:
        self.add("u1")
        before = (self.run / "units.tsv").read_text(encoding="utf-8")
        result = self.transition("u1", 99, "ready", expect=1)
        self.assertIn("stale revision", result.stderr)
        self.assertEqual(before, (self.run / "units.tsv").read_text(encoding="utf-8"))

    def test_active_target_collision_is_rejected_without_partial_add(self) -> None:
        self.add("u1")
        self.transition("u1", 1, "ready")
        self.transition("u1", 2, "running")
        before_events = (self.run / "events.tsv").read_text(encoding="utf-8")
        result = self.command(
            "add", "--run", str(self.run), "--unit-id", "u2", "--track", "test",
            "--owner-thread", "thread-2", "--host", "local", "--target", "repo",
            "--deliverable", "other", expect=0,
        )
        self.assertIn("u2", result.stdout)
        collision = self.transition("u2", 1, "ready")
        self.assertIn("u2", collision.stdout)
        failed = self.transition("u2", 2, "running", expect=1)
        self.assertIn("active mutable-target collision", failed.stderr)
        self.assertEqual(before_events.count("unit-added") + 1, (self.run / "events.tsv").read_text(encoding="utf-8").count("unit-added"))

    def test_accepted_state_requires_matching_verdict(self) -> None:
        self.add("u1")
        self.transition("u1", 1, "ready")
        self.transition("u1", 2, "running")
        self.transition("u1", 3, "verifying")
        result = self.transition("u1", 4, "passed", "--evidence-path", "proof", expect=1)
        self.assertIn("accepted unit lacks matching accepted verdict", result.stderr)

    def test_unsatisfied_dependency_is_rejected(self) -> None:
        self.add("foundation", "foundation")
        self.command(
            "add", "--run", str(self.run), "--unit-id", "dependent", "--track", "test",
            "--owner-thread", "thread-2", "--host", "local", "--target", "dependent",
            "--deliverable", "dependent artifact", "--depends-on", "foundation",
        )
        result = self.transition("dependent", 1, "ready", expect=1)
        self.assertIn("unsatisfied dependencies", result.stderr)

    def test_retry_family_requires_terminal_predecessor_and_contiguous_attempt(self) -> None:
        self.add("attempt-1", "fixture")
        result = self.command(
            "add", "--run", str(self.run), "--unit-id", "attempt-2", "--track", "test",
            "--owner-thread", "thread-1", "--host", "local", "--target", "fixture-2",
            "--deliverable", "retry", "--failure-family", "attempt-1",
            "--attempt", "2", "--supersedes", "attempt-1", expect=1,
        )
        self.assertIn("superseded unit is not terminal", result.stderr)

    def test_status_renders_empty_blockers(self) -> None:
        self.command("status", "--run", str(self.run))
        status = (self.run / "status.md").read_text(encoding="utf-8")
        self.assertIn("## Blockers\n\nNone.", status)

    def test_partial_root_projection_cannot_change_canonical_snapshot(self) -> None:
        self.add("u1")
        root_units = self.run / "units.tsv"
        root_units.write_text(root_units.read_text(encoding="utf-8").replace("\tplanned\t", "\tready\t"), encoding="utf-8")
        result = self.command("check", "--run", str(self.run))
        self.assertIn("valid run store (v2)", result.stdout)
        manifest = json.loads((self.run / "manifest.json").read_text(encoding="utf-8"))
        snapshot_units = self.run / manifest["snapshot_dir"] / "units.tsv"
        self.assertIn("\tplanned\t", snapshot_units.read_text(encoding="utf-8"))

    def test_next_transaction_recovers_from_stale_root_projection(self) -> None:
        self.add("u1")
        old_projection = {
            name: (self.run / name).read_bytes()
            for name in ("units.tsv", "ledger.tsv", "decisions.tsv", "events.tsv")
        }
        self.transition("u1", 1, "ready")
        for name, content in old_projection.items():
            (self.run / name).write_bytes(content)
        self.transition("u1", 2, "running")
        exported = json.loads(self.command("export", "--run", str(self.run)).stdout)
        self.assertEqual("running", exported["units"][0]["state"])

    def test_snapshot_corruption_is_detected(self) -> None:
        self.add("u1")
        manifest = json.loads((self.run / "manifest.json").read_text(encoding="utf-8"))
        snapshot_units = self.run / manifest["snapshot_dir"] / "units.tsv"
        snapshot_units.write_text(snapshot_units.read_text(encoding="utf-8") + "corrupt\n", encoding="utf-8")
        result = self.command("check", "--run", str(self.run), expect=1)
        self.assertIn("snapshot hash mismatch", result.stderr)

    def test_failed_attempt_requires_new_superseding_unit(self) -> None:
        self.add("u1")
        self.transition("u1", 1, "ready")
        self.transition("u1", 2, "running")
        self.transition("u1", 3, "failed")
        result = self.transition("u1", 4, "ready", expect=1)
        self.assertIn("new superseding unit", result.stderr)

    def test_latest_negative_verdict_prevents_acceptance(self) -> None:
        self.add("u1")
        self.transition("u1", 1, "ready")
        self.transition("u1", 2, "running")
        self.transition("u1", 3, "verifying")
        evidence = self.run / "proof.txt"
        evidence.write_text("proof\n", encoding="utf-8")
        for verdict in ("unit-test-verified", "failed"):
            self.command(
                "verdict", "--run", str(self.run), "--unit-id", "u1",
                "--artifact-key", "proof", "--head-sha", "abc123",
                "--verdict", verdict, "--verifier", "test",
                "--evidence-path", str(evidence),
            )
        result = self.transition("u1", 4, "passed", "--evidence-path", str(evidence), expect=1)
        self.assertIn("lacks matching accepted verdict", result.stderr)

    def test_negative_verdict_invalidates_completed_unit(self) -> None:
        self.add("u1")
        self.transition("u1", 1, "ready")
        self.transition("u1", 2, "running")
        self.transition("u1", 3, "verifying")
        evidence = self.run / "proof.txt"
        evidence.write_text("proof\n", encoding="utf-8")
        self.command(
            "verdict", "--run", str(self.run), "--unit-id", "u1",
            "--artifact-key", "proof", "--head-sha", "abc123",
            "--verdict", "unit-test-verified", "--verifier", "test",
            "--evidence-path", str(evidence),
        )
        self.transition("u1", 4, "passed", "--evidence-path", str(evidence))
        self.transition("u1", 5, "complete")
        self.command(
            "verdict", "--run", str(self.run), "--unit-id", "u1",
            "--artifact-key", "proof", "--head-sha", "abc123",
            "--verdict", "failed", "--verifier", "test",
            "--evidence-path", str(evidence), "--notes", "regression",
        )
        exported = json.loads(self.command("export", "--run", str(self.run)).stdout)
        self.assertEqual("failed", exported["units"][0]["state"])
        self.assertEqual("failed", exported["ledger"][-1]["verdict"])

    def test_stale_head_negative_verdict_does_not_invalidate_current_head(self) -> None:
        self.add("u1")
        self.transition("u1", 1, "ready")
        self.transition("u1", 2, "running")
        self.transition("u1", 3, "verifying")
        evidence = self.run / "proof.txt"
        evidence.write_text("proof\n", encoding="utf-8")
        self.command(
            "verdict", "--run", str(self.run), "--unit-id", "u1",
            "--artifact-key", "proof", "--head-sha", "abc123",
            "--verdict", "unit-test-verified", "--verifier", "test",
            "--evidence-path", str(evidence),
        )
        self.transition("u1", 4, "passed", "--evidence-path", str(evidence))
        self.transition("u1", 5, "complete")
        self.command(
            "verdict", "--run", str(self.run), "--unit-id", "u1",
            "--artifact-key", "proof", "--head-sha", "old-head",
            "--verdict", "failed", "--verifier", "test",
            "--evidence-path", str(evidence),
        )
        exported = json.loads(self.command("export", "--run", str(self.run)).stdout)
        self.assertEqual("complete", exported["units"][0]["state"])

    def test_invalidation_keeps_active_dependent_ownership_until_stop(self) -> None:
        self.add("foundation", "foundation")
        self.transition("foundation", 1, "ready")
        self.transition("foundation", 2, "running")
        self.transition("foundation", 3, "verifying")
        evidence = self.run / "proof.txt"
        evidence.write_text("proof\n", encoding="utf-8")
        self.command(
            "verdict", "--run", str(self.run), "--unit-id", "foundation",
            "--artifact-key", "proof", "--head-sha", "abc123",
            "--verdict", "unit-test-verified", "--verifier", "test",
            "--evidence-path", str(evidence),
        )
        self.transition("foundation", 4, "passed", "--evidence-path", str(evidence))
        self.transition("foundation", 5, "complete")
        self.command(
            "add", "--run", str(self.run), "--unit-id", "dependent", "--track", "test",
            "--owner-thread", "thread-2", "--host", "local", "--target", "shared-target",
            "--deliverable", "dependent", "--depends-on", "foundation", "--head-sha", "dep123",
        )
        self.transition("dependent", 1, "ready")
        self.transition("dependent", 2, "running")
        self.command(
            "verdict", "--run", str(self.run), "--unit-id", "foundation",
            "--artifact-key", "proof", "--head-sha", "abc123",
            "--verdict", "failed", "--verifier", "test",
            "--evidence-path", str(evidence),
        )
        exported = json.loads(self.command("export", "--run", str(self.run)).stdout)
        dependent = next(row for row in exported["units"] if row["unit_id"] == "dependent")
        self.assertEqual("stopping", dependent["state"])
        self.assertEqual("shared-target", dependent["mutable_targets"])

    def test_owner_transfer_requires_recorded_decision(self) -> None:
        self.add("u1")
        result = self.transition("u1", 1, "ready", "--owner-thread", "thread-2", expect=1)
        self.assertIn("owner transfer requires", result.stderr)
        self.command(
            "decision", "--run", str(self.run), "--decision-id", "handoff-1",
            "--unit-id", "u1", "--decision", "transfer owner",
            "--evidence", "handoff.md", "--consequence", "thread-2 becomes sole owner",
        )
        self.transition(
            "u1", 1, "ready", "--owner-thread", "thread-2",
            "--owner-transfer-decision", "handoff-1",
        )


if __name__ == "__main__":
    unittest.main()
