#!/usr/bin/env python3

from __future__ import annotations

import csv
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

import run_store as store


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

    def verdict(self, unit: str, verdict: str, verifier: str, *, expect: int = 0):
        evidence = self.run / "proof.txt"
        evidence.write_text("proof\n", encoding="utf-8")
        return self.command(
            "verdict", "--run", str(self.run), "--unit-id", unit,
            "--artifact-key", "proof", "--head-sha", "abc123",
            "--verdict", verdict, "--verifier", verifier,
            "--evidence-path", str(evidence), expect=expect,
        )

    def ledger(self) -> list[dict[str, str]]:
        return json.loads(self.command("export", "--run", str(self.run)).stdout)["ledger"]

    def test_accepted_verdict_rejects_owner_as_verifier(self) -> None:
        self.add("u1")  # owner_thread is thread-1
        self.transition("u1", 1, "ready")
        self.transition("u1", 2, "running")
        self.transition("u1", 3, "verifying")
        for verdict in sorted(store.ACCEPTED_VERDICTS):
            with self.subTest(verdict=verdict):
                result = self.verdict("u1", verdict, "thread-1", expect=1)
                self.assertIn("verifier other than the unit owner", result.stderr)
        self.assertEqual([], self.ledger())
        self.verdict("u1", "unit-test-verified", "thread-2")
        self.assertEqual("thread-2", self.ledger()[0]["verifier"])

    def test_failed_verdict_from_owner_is_still_recorded(self) -> None:
        self.add("u1")
        self.transition("u1", 1, "ready")
        self.transition("u1", 2, "running")
        self.verdict("u1", "failed", "thread-1")
        self.verdict("u1", "blocked", "thread-1")
        self.assertEqual(["failed", "blocked"], [row["verdict"] for row in self.ledger()])

    def running_unit(self, unit: str = "u1") -> None:
        self.add(unit)
        self.transition(unit, 1, "ready")
        self.transition(unit, 2, "running")

    def unit_state(self, unit: str = "u1") -> dict[str, str]:
        exported = json.loads(self.command("export", "--run", str(self.run)).stdout)
        return next(row for row in exported["units"] if row["unit_id"] == unit)

    def test_blocked_transition_requires_classified_blocker(self) -> None:
        self.running_unit()
        before = (self.run / "events.tsv").read_text(encoding="utf-8")
        for blocker in (None, "", "waiting on credentials", "access:", "access:   ", "Access: x"):
            with self.subTest(blocker=blocker):
                extra = [] if blocker is None else ["--blocker", blocker]
                result = self.transition("u1", 3, "blocked", *extra, expect=1)
                self.assertIn("must start with a class", result.stderr)
        self.assertEqual("running", self.unit_state()["state"])
        self.assertEqual(before, (self.run / "events.tsv").read_text(encoding="utf-8"))
        self.transition("u1", 3, "blocked", "--blocker", "access: claude-cli-login; owner=Blaine")
        self.assertEqual("blocked", self.unit_state()["state"])

    def test_each_blocker_class_is_accepted(self) -> None:
        for index, blocker_class in enumerate(store.BLOCKER_CLASSES):
            unit = f"u{index}"
            with self.subTest(blocker_class=blocker_class):
                self.running_unit(unit)
                self.transition(unit, 3, "blocked", "--blocker", f"{blocker_class}: detail; owner=Blaine")
                self.assertEqual("blocked", self.unit_state(unit)["state"])
                self.command("transition", "--run", str(self.run), "--unit-id", unit,
                             "--expected-revision", "4", "--state", "abandoned")

    def test_unknown_blocker_prefix_is_rejected(self) -> None:
        self.running_unit()
        for blocker in ("network: runner lost", "accessory: x", "quota", "quota - exhausted"):
            with self.subTest(blocker=blocker):
                result = self.transition("u1", 3, "blocked", "--blocker", blocker, expect=1)
                self.assertIn("must start with a class", result.stderr)

    def test_quota_handoff_keeps_same_unit_and_attempt(self) -> None:
        self.running_unit()
        self.transition("u1", 3, "blocked", "--blocker", "quota: claude-weekly; resume_after=2026-10-24")
        self.transition("u1", 4, "ready", "--owner-thread", "thread-2", expect=1)
        self.command(
            "decision", "--run", str(self.run), "--decision-id", "quota-handoff",
            "--unit-id", "u1", "--decision", "hand off to thread-2",
            "--evidence", "checkpoint.md", "--consequence", "acceptance unchanged",
        )
        self.transition("u1", 4, "ready", "--owner-thread", "thread-2",
                        "--owner-transfer-decision", "quota-handoff")
        unit = self.unit_state()
        self.assertEqual(("ready", "thread-2", "1"), (unit["state"], unit["owner_thread"], unit["attempt"]))

    def add_blocked(self, unit: str, *extra: str, expect: int = 0):
        return self.command(
            "add", "--run", str(self.run), "--unit-id", unit, "--track", "test",
            "--owner-thread", "thread-1", "--host", "local", "--target", unit,
            "--deliverable", "artifact", "--state", "blocked", *extra, expect=expect,
        )

    def test_add_blocked_requires_classified_blocker(self) -> None:
        for blocker in (None, "", "waiting on vendor reply", "access:", "Access: x"):
            with self.subTest(blocker=blocker):
                extra = [] if blocker is None else ["--blocker", blocker]
                result = self.add_blocked("fresh", *extra, expect=1)
                self.assertIn("must start with a class", result.stderr)
        self.assertEqual([], json.loads(self.command("export", "--run", str(self.run)).stdout)["units"])
        self.add_blocked("fresh", "--blocker", "access: claude-cli-login; owner=Blaine")
        self.assertEqual("blocked", self.unit_state("fresh")["state"])

    def test_blocker_detail_needs_visible_letter_or_digit(self) -> None:
        self.running_unit()
        for blocker in (
            "access:\u200bx", "access::", "access: ;", "access: --", "access: _",
            "access: x\u200b", "access:\ufeffx", "access: \u2060x", "access:\u00adx",
        ):
            with self.subTest(blocker=blocker):
                result = self.transition("u1", 3, "blocked", "--blocker", blocker, expect=1)
                self.assertIn("must start with a class", result.stderr)
        self.transition("u1", 3, "blocked", "--blocker", "access: ;x")
        self.assertEqual("blocked", self.unit_state()["state"])

    def test_dependency_invalidation_writes_a_classified_blocker(self) -> None:
        self.add("foundation", "foundation")
        self.transition("foundation", 1, "ready")
        self.transition("foundation", 2, "running")
        self.transition("foundation", 3, "verifying")
        self.verdict("foundation", "unit-test-verified", "thread-2")
        self.transition("foundation", 4, "passed", "--evidence-path", str(self.run / "proof.txt"))
        self.command(
            "add", "--run", str(self.run), "--unit-id", "dependent", "--track", "test",
            "--owner-thread", "thread-2", "--host", "local", "--target", "dependent",
            "--deliverable", "dependent", "--depends-on", "foundation", "--head-sha", "dep123",
        )
        self.transition("dependent", 1, "ready")
        self.transition("dependent", 2, "running")
        self.verdict("foundation", "failed", "thread-2")
        dependent = self.unit_state("dependent")
        self.assertEqual("stopping", dependent["state"])
        self.assertEqual("dependency: invalidated by foundation", dependent["blocker"])
        store._validate_blocker_class("dependent", dependent["state"], dependent["blocker"])
        self.assertIn("dependency", store.BLOCKER_CLASSES)

    def test_legacy_unclassified_blocker_still_validates(self) -> None:
        self.add_blocked("legacy", "--blocker", "owner: placeholder")
        staged = self.root / "legacy-staged"
        store.stage_store(self.run, staged)
        units, _, _, _ = store.validate(staged, prefer_root=True)
        units[0]["blocker"] = "waiting on vendor reply"
        store.write_tsv(staged / store.UNITS_FILE, store.UNIT_HEADER, units)
        store.commit_staged(self.run, staged, ())
        result = self.command("check", "--run", str(self.run))
        self.assertIn("valid run store (v2)", result.stdout)
        self.assertEqual("waiting on vendor reply", self.unit_state("legacy")["blocker"])
        # Leaving blocked is not gated on the blocker text.
        self.transition("legacy", 1, "ready")
        self.assertEqual("ready", self.unit_state("legacy")["state"])

    def transfer(self, unit: str, revision: int, state: str, to: str, decision: str) -> None:
        self.command(
            "decision", "--run", str(self.run), "--decision-id", decision,
            "--unit-id", unit, "--decision", f"hand off to {to}",
            "--evidence", "handoff.md", "--consequence", "acceptance unchanged",
        )
        self.transition(unit, revision, state, "--owner-thread", to, "--owner-transfer-decision", decision)

    def test_accepted_verdict_rejects_earlier_owner_after_transfer(self) -> None:
        self.add("u1")  # created by thread-1
        self.transition("u1", 1, "ready")
        self.transfer("u1", 2, "running", "thread-2", "handoff-1")
        self.transition("u1", 3, "verifying")
        result = self.verdict("u1", "unit-test-verified", "thread-1", expect=1)
        self.assertIn("earlier owner", result.stderr)
        self.verdict("u1", "unit-test-verified", "thread-2", expect=1)
        self.assertEqual([], self.ledger())
        self.verdict("u1", "unit-test-verified", "thread-3")
        self.assertEqual(["thread-3"], [row["verifier"] for row in self.ledger()])

    def test_earlier_owner_chain_and_negative_verdicts(self) -> None:
        self.add("u1")
        self.transfer("u1", 1, "ready", "thread-2", "handoff-1")
        self.transfer("u1", 2, "running", "thread-3", "handoff-2")
        self.transition("u1", 3, "verifying")
        for verifier in ("thread-1", "thread-2", "thread-3"):
            with self.subTest(verifier=verifier):
                self.verdict("u1", "unit-test-verified", verifier, expect=1)
        self.verdict("u1", "failed", "thread-1")  # negative verdicts are not gated
        self.assertEqual(["failed"], [row["verdict"] for row in self.ledger()])
        self.verdict("u1", "unit-test-verified", "thread-4")

    def test_identity_comparison_trims_and_casefolds(self) -> None:
        self.running_unit()
        self.transition("u1", 3, "verifying")
        for verifier in (" Thread-1 ", "THREAD-1", "thread-1\t"):
            with self.subTest(verifier=verifier):
                self.verdict("u1", "unit-test-verified", verifier, expect=1)
        self.assertEqual([], self.ledger())
        self.assertEqual("thread-1", self.unit_state()["owner_thread"])  # stored value unchanged

    def test_earlier_owner_comparison_trims_and_casefolds(self) -> None:
        self.add("u1")
        self.transition("u1", 1, "ready")
        self.transfer("u1", 2, "running", " Thread-2 ", "handoff-1")
        self.transition("u1", 3, "verifying")
        self.verdict("u1", "unit-test-verified", "THREAD-1", expect=1)
        self.verdict("u1", "unit-test-verified", "thread-9")
        self.assertEqual(" Thread-2 ", self.unit_state()["owner_thread"])

    def stage_next_revision(self) -> Path:
        staged = self.root / "staged"
        store.stage_store(self.run, staged)
        units, _, _, _ = store.validate(staged, prefer_root=True)
        units[0]["state"] = "ready"
        units[0]["revision"] = "2"
        store.write_tsv(staged / store.UNITS_FILE, store.UNIT_HEADER, units)
        store.append_event(staged, units[0], "transition:ready", "", "")
        store.bump_manifest(staged)
        return staged

    def descriptor_path(self, descriptor: int) -> Path:
        identity = os.fstat(descriptor)
        for path in [self.run, *self.run.rglob("*")]:
            candidate = path.stat()
            if (candidate.st_dev, candidate.st_ino) == (identity.st_dev, identity.st_ino):
                return path
        self.fail("synced descriptor is outside the publication tree")

    def test_snapshot_is_durable_before_manifest_publication(self) -> None:
        self.add("u1")
        staged = self.stage_next_revision()
        events = []
        original_fsync = os.fsync
        original_replace = Path.replace

        def sync(descriptor):
            events.append(("sync", self.descriptor_path(descriptor)))
            original_fsync(descriptor)

        def replace(source, destination):
            result = original_replace(source, destination)
            events.append(("replace", source, destination))
            return result

        with patch.object(os, "fsync", side_effect=sync), patch.object(Path, "replace", replace):
            store.commit_staged(self.run, staged, store.SNAPSHOT_FILES)

        snapshot_rename = next(event for event in events if event[0] == "replace" and event[1].name.startswith(".staging-"))
        manifest_rename = next(event for event in events if event[0] == "replace" and event[2] == self.run / store.MANIFEST_FILE)
        snapshot_index = events.index(snapshot_rename)
        manifest_index = events.index(manifest_rename)
        for name in store.SNAPSHOT_FILES:
            self.assertIn(("sync", snapshot_rename[1] / name), events[:snapshot_index])
        self.assertIn(("sync", snapshot_rename[1]), events[:snapshot_index])
        self.assertIn(("sync", self.run / ".snapshots"), events[snapshot_index + 1:manifest_index])
        self.assertIn(("sync", manifest_rename[1]), events[snapshot_index + 1:manifest_index])
        self.assertIn(("sync", self.run), events[:snapshot_index])
        self.assertIn(("sync", self.run), events[manifest_index + 1:])
        self.assertEqual("ready", store.validate(self.run)[0][0]["state"])

    def test_failed_durability_barrier_preserves_previous_manifest(self) -> None:
        self.add("u1")
        staged = self.stage_next_revision()
        before = (self.run / store.MANIFEST_FILE).read_bytes()
        original_fsync = os.fsync
        for surface in ("snapshot", "manifest"):
            with self.subTest(surface=surface):
                def fail_sync(descriptor):
                    path = self.descriptor_path(descriptor)
                    snapshot_barrier = path == self.run / ".snapshots"
                    manifest_barrier = path.parent == self.run and path.is_file()
                    if (surface == "snapshot" and snapshot_barrier) or (surface == "manifest" and manifest_barrier):
                        raise OSError("simulated durability failure")
                    original_fsync(descriptor)

                with patch.object(os, "fsync", side_effect=fail_sync):
                    with self.assertRaisesRegex(OSError, "simulated durability failure"):
                        store.commit_staged(self.run, staged, store.SNAPSHOT_FILES)
                self.assertEqual(before, (self.run / store.MANIFEST_FILE).read_bytes())
                self.assertEqual("planned", store.validate(self.run)[0][0]["state"])


if __name__ == "__main__":
    unittest.main()
