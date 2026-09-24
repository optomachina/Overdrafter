#!/usr/bin/env python3
"""Exercise guarded dispatch through its public CLI and observable child effects."""

from __future__ import annotations

import copy
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


HERE = Path(__file__).resolve().parent
STORE = HERE / "run_store.py"
LAUNCH = HERE / "launch.py"
SYMPHONY = HERE.parent / "symphony-agent.sh"


class LaunchTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.codex_home = self.root / "codex-home"
        self.codex_home.mkdir()
        self.repo = self.root / "OVD-552"
        self.repo.mkdir()
        self.source = self.repo / "worker.py"
        self.source.write_text("# Worker release requires the permission guard.\n", encoding="utf-8")
        self.repo_instructions = self.repo / "AGENTS.md"
        self.repo_instructions.write_text("Synthetic repo policy: preserve the bounded worker release scope.\n", encoding="utf-8")
        self.git("init", "--quiet")
        self.git("add", "worker.py", "AGENTS.md")
        self.git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
                 "commit", "--quiet", "-m", "Synthetic source")
        self.head = self.git("rev-parse", "HEAD").stdout.strip()
        self.run = self.root / "store"
        self.store("init", "--root", str(self.root), "--run-id", "store", "--title", "Dispatch regression")
        self.marker = self.root / "children.txt"
        self.instructions = self.codex_home / "AGENTS.md"
        self.instructions.write_text("Use current policy and one owner per mutable target.\n", encoding="utf-8")
        self.decisions = self.root / "user-decisions.md"
        self.decisions.write_text("Synthetic user decision: routine source development is authorized.\n", encoding="utf-8")
        self.requirement = self.root / "acceptance.md"
        self.requirement.write_text("Worker release must preserve the permission guard.\n", encoding="utf-8")
        self.receipt = self.root / "receipt-schema.json"
        self.receipt.write_text('{"required":["source_revision","artifacts"]}\n', encoding="utf-8")
        self.policy = {
            "revision": "policy-1", "user_decision_revision": "decision-1",
            "instructions": [self.artifact(self.instructions), self.artifact(self.repo_instructions)],
            "user_decisions": [self.artifact(self.decisions)],
        }
        self.install_policy(self.policy)

    def command(self, script: Path, *args: str, ok: bool = True):
        result = subprocess.run([sys.executable, str(script), *args], text=True,
                                env=self.command_environment(), capture_output=True, check=False, timeout=20)
        if ok:
            self.assertEqual(0, result.returncode, result.stdout + result.stderr)
        else:
            self.assertNotEqual(0, result.returncode, result.stdout + result.stderr)
        return result

    def command_environment(self):
        return {**os.environ, "CODEX_HOME": str(self.codex_home)}

    def git(self, *args: str):
        result = subprocess.run(["git", "-C", str(self.repo), *args], text=True,
                                capture_output=True, check=False, timeout=20)
        self.assertEqual(0, result.returncode, result.stdout + result.stderr)
        return result

    def store(self, *args: str, ok: bool = True):
        return self.command(STORE, *args, ok=ok)

    def guard(self, *args: str, ok: bool = True):
        return self.command(LAUNCH, *args, ok=ok)

    def artifact(self, path: Path, **extra):
        return {"path": str(path), "sha256": hashlib.sha256(path.read_bytes()).hexdigest(), **extra}

    def json_file(self, name: str, value) -> Path:
        path = self.root / name
        path.write_text(json.dumps(value), encoding="utf-8")
        return path

    def install_policy(self, policy, ok: bool = True):
        path = self.json_file("policy.json", policy)
        return self.guard("policy", "--run", str(self.run), "--file", str(path), ok=ok)

    def units(self):
        data = json.loads(self.store("export", "--run", str(self.run)).stdout)
        return {unit["unit_id"]: unit for unit in data["units"]}

    def transition(self, unit: str, state: str, *extra: str):
        current = self.units()[unit]
        return self.store("transition", "--run", str(self.run), "--unit-id", unit,
                          "--expected-revision", current["revision"], "--state", state, *extra)

    def add(self, unit: str, *, owner: str = "owner", target: str | None = None,
            dependencies: tuple[str, ...] = (), extra: tuple[str, ...] = (), ready: bool = True):
        target = target or f"resource:{unit}"
        self.store("add", "--run", str(self.run), "--unit-id", unit, "--track", "workflow",
                   "--owner-thread", owner, "--host", "local", "--target", target,
                   "--mutable-targets", target, "--deliverable", "Verified bounded result",
                   "--head-sha", self.head, "--depends-on", ",".join(dependencies), *extra)
        if ready:
            self.transition(unit, "ready")

    def assignment(self, unit: str, **updates):
        stored = self.units()[unit]
        result = {
            "unit_id": unit, "expected_revision": int(stored["revision"]),
            "assignment_key": unit, "kind": "implementation", "owner_thread": stored["owner_thread"],
            "host": "local", "worktree": str(self.repo), "source_revision": self.head,
            "policy_revision": self.policy["revision"],
            "user_decision_revision": self.policy["user_decision_revision"],
            "loaded_instructions": copy.deepcopy(self.policy["instructions"]),
            "inputs": [self.artifact(self.receipt, role="receipt-schema")],
            "requirements": [self.artifact(self.requirement, id="worker-release")],
            "dependencies": [], "review_scope": "", "check_identity": "bounded-check",
            "actions": ["source", "test"],
        }
        result.update(updates)
        return result

    def launch_args(self, assignment):
        path = self.json_file(f"assignment-{assignment['unit_id']}.json", assignment)
        child = "from pathlib import Path; import sys; p=Path(sys.argv[1]); p.open('a').write('child\\n')"
        return ["launch", "--run", str(self.run), "--assignment", str(path), "--",
                sys.executable, "-c", child, str(self.marker)]

    def launch(self, assignment, ok: bool = True):
        return self.guard(*self.launch_args(assignment), ok=ok)

    def child_count(self) -> int:
        return len(self.marker.read_text(encoding="utf-8").splitlines()) if self.marker.exists() else 0

    def rejected(self, assignment):
        before = self.child_count()
        result = self.launch(assignment, ok=False)
        self.assertEqual(before, self.child_count(), "Rejected dispatch still invoked a child")
        return result

    def finish(self, unit: str, **updates):
        artifact = self.root / f"{unit}-verified.txt"
        artifact.write_text("Independently verified synthetic result.\n", encoding="utf-8")
        result = {"source_revision": self.head, "verifier": "independent-verifier",
                  "artifacts": [self.artifact(artifact)], "check_identity": "bounded-check"}
        result.update(updates)
        path = self.json_file(f"result-{unit}.json", result)
        self.guard("finish", "--run", str(self.run), "--unit", unit, "--result", str(path))
        return artifact

    def complete_dependency(self, unit: str):
        self.add(unit)
        self.launch(self.assignment(unit))
        return self.finish(unit)

    def dependency(self, unit: str, verdict: str = "required", *, parent_key: str = "worker-release",
                   reviewer: str = "independent-reviewer", receipt_updates=None):
        evidence = [self.artifact(self.requirement, kind="acceptance"),
                    self.artifact(self.source, kind="source")]
        current = self.units()[unit]
        receipt = {
            "parent_assignment_key": parent_key,
            "dependency": {"unit_id": unit, "revision": int(current["revision"]),
                           "deliverable": current["deliverable"], "head_sha": current["head_sha"]},
            "source_revision": self.head, "requirement_id": "worker-release",
            "evidence_sha256": sorted(item["sha256"] for item in evidence),
            "reviewer": reviewer, "verdict": verdict,
            "rationale": "The worker release calls the permission guard required by acceptance.",
        }
        receipt.update(receipt_updates or {})
        self.dependency_review_count = getattr(self, "dependency_review_count", 0) + 1
        review_id = f"dependency-review-{self.dependency_review_count}"
        receipt_path = self.json_file(f"{review_id}-receipt.json", receipt)
        scope = f"dependency:{parent_key}:{unit}"
        self.add(review_id, owner=reviewer)
        self.launch(self.assignment(review_id, assignment_key=scope, kind="review", review_scope=scope,
                                    actions=["review"]))
        self.finish(review_id, artifacts=[self.artifact(receipt_path)])
        return {"unit_id": unit, "requirement_id": "worker-release", "evidence": evidence,
                "review": {"unit_id": review_id, **self.artifact(receipt_path)}}

    def wrapper_environment(self, assignment):
        assignments = self.root / "assignments"
        assignments.mkdir(exist_ok=True)
        (assignments / f"{self.repo.name}.json").write_text(json.dumps(assignment), encoding="utf-8")
        binaries = self.root / "bin"
        binaries.mkdir(exist_ok=True)
        fake_codex = binaries / "codex"
        expected_args = ["app-server", "-c", "project_doc_fallback_filenames=[]", "-c", "project_doc_max_bytes=32768",
                         "-c", 'model="gpt-6-astra"', "-c", 'model_reasoning_effort="medium"']
        fake_codex.write_text(
            f"#!{sys.executable}\nfrom pathlib import Path\nimport sys\n"
            f"assert sys.argv[1:] == {expected_args!r}\n"
            f"Path({str(self.marker)!r}).open('a').write('child\\n')\n", encoding="utf-8")
        fake_codex.chmod(0o755)
        return {
            "PATH": f"{binaries}{os.pathsep}{Path(sys.executable).parent}{os.pathsep}{os.defpath}",
            "CODEX_HOME": str(self.codex_home),
            "OVD_AGENT_RUN_STORE": str(self.run),
            "OVD_AGENT_ASSIGNMENT_DIR": str(assignments),
            "OVD_AGENT_LAUNCHER": str(LAUNCH),
        }

    def wrapper(self, environment, *, ok: bool):
        result = subprocess.run(["/bin/sh", str(SYMPHONY)], cwd=self.repo, env=environment,
                                text=True, capture_output=True, check=False, timeout=20)
        if ok:
            self.assertEqual(0, result.returncode, result.stdout + result.stderr)
        else:
            self.assertNotEqual(0, result.returncode, result.stdout + result.stderr)
        return result

    def test_symphony_entrypoint_launches_fake_codex_once_for_valid_controller_manifest(self):
        self.add("wrapper-consumer")
        assignment = self.assignment("wrapper-consumer", issue_id=self.repo.name)
        environment = self.wrapper_environment(assignment)
        self.wrapper(environment, ok=True)
        self.assertEqual(1, self.child_count())
        self.assertEqual("running", self.units()["wrapper-consumer"]["state"])
        self.wrapper(environment, ok=False)
        self.assertEqual(1, self.child_count(), "Wrapper replay launched a second app-server")

    def test_symphony_entrypoint_missing_controller_metadata_never_starts_codex(self):
        self.add("wrapper-consumer")
        environment = self.wrapper_environment(self.assignment("wrapper-consumer", issue_id=self.repo.name))
        for variable in ("OVD_AGENT_RUN_STORE", "OVD_AGENT_ASSIGNMENT_DIR", "OVD_AGENT_LAUNCHER"):
            with self.subTest(variable=variable):
                incomplete = environment.copy()
                del incomplete[variable]
                self.wrapper(incomplete, ok=False)
                self.assertEqual(0, self.child_count())
        missing_manifest = {**environment, "OVD_AGENT_ASSIGNMENT_DIR": str(self.root / "missing")}
        self.wrapper(missing_manifest, ok=False)
        self.assertEqual(0, self.child_count())

    def test_symphony_entrypoint_binds_manifest_to_actual_issue_and_workspace(self):
        self.add("wrapper-consumer")
        for updates in ({"issue_id": "OVD-553"}, {"worktree": str(self.root / "another-checkout")}):
            with self.subTest(updates=updates):
                assignment = self.assignment("wrapper-consumer", issue_id=self.repo.name)
                assignment.update(updates)
                self.wrapper(self.wrapper_environment(assignment), ok=False)
                self.assertEqual(0, self.child_count())
        self.assertEqual("ready", self.units()["wrapper-consumer"]["state"])

    def test_missing_receipt_schema_blocks_before_child_then_ready_input_continues(self):
        self.add("receipt-consumer")
        assignment = self.assignment("receipt-consumer")
        original = self.receipt.read_bytes()
        self.receipt.unlink()
        self.rejected(assignment)
        self.assertEqual("ready", self.units()["receipt-consumer"]["state"])
        self.receipt.write_bytes(original)
        self.launch(assignment)
        self.assertEqual(1, self.child_count())
        self.assertNotEqual("complete", self.units()["receipt-consumer"]["state"])

    def test_selected_checkout_override_must_be_declared_before_dispatch(self):
        self.add("checkout-override-consumer")
        undeclared = self.assignment("checkout-override-consumer")
        override = self.repo / "AGENTS.override.md"
        override.write_text("Synthetic old checkout override: require another approval for each attempt.\n", encoding="utf-8")
        self.rejected(undeclared)
        self.assertEqual("ready", self.units()["checkout-override-consumer"]["state"])
        self.policy = {**self.policy, "revision": "policy-2",
                       "instructions": [self.artifact(self.instructions), self.artifact(override)]}
        self.install_policy(self.policy)
        self.launch(self.assignment("checkout-override-consumer"))
        self.assertEqual(1, self.child_count())

    def test_stale_injected_policy_and_changed_disk_policy_do_not_dispatch(self):
        self.add("policy-consumer")
        assignment = self.assignment("policy-consumer")
        stale = copy.deepcopy(assignment)
        stale["loaded_instructions"][0]["sha256"] = "0" * 64
        self.rejected(stale)
        changed = copy.deepcopy(assignment)
        changed["user_decision_revision"] = "old-decision"
        self.rejected(changed)
        original = self.instructions.read_bytes()
        self.instructions.write_text("Old checkout requires a new approval for every attempt.\n", encoding="utf-8")
        self.rejected(assignment)
        self.instructions.write_bytes(original)
        self.launch(assignment)
        self.assertEqual(1, self.child_count())

    def test_new_policy_revision_requires_current_manifest_without_overwriting_old_identity(self):
        self.add("new-policy-consumer")
        old_assignment = self.assignment("new-policy-consumer")
        self.instructions.write_text("Updated policy with preserved standing user decision.\n", encoding="utf-8")
        replacement = copy.deepcopy(self.policy)
        replacement["instructions"] = [self.artifact(self.instructions), self.artifact(self.repo_instructions)]
        self.install_policy(replacement, ok=False)
        replacement["revision"] = "policy-2"
        self.install_policy(replacement)
        self.rejected(old_assignment)
        self.policy = replacement
        self.launch(self.assignment("new-policy-consumer"))
        self.assertEqual(1, self.child_count())

    def test_active_policy_reconcile_preserves_claim_and_only_updates_policy_fields(self):
        self.add("active-policy")
        self.launch(self.assignment("active-policy"))
        proof = self.root / "active-policy-result.txt"
        proof.write_text("Verified result of the existing claim.\n", encoding="utf-8")
        result = self.json_file("active-policy-result.json", {
            "source_revision": self.head, "verifier": "independent-verifier",
            "artifacts": [self.artifact(proof)], "check_identity": "bounded-check"})
        self.instructions.write_text("Updated policy for the same bounded active work.\n", encoding="utf-8")
        self.decisions.write_text("Synthetic updated decision preserves routine source authorization.\n", encoding="utf-8")
        self.policy = {"revision": "policy-2", "user_decision_revision": "decision-2",
                       "instructions": [self.artifact(self.instructions), self.artifact(self.repo_instructions)],
                       "user_decisions": [self.artifact(self.decisions)]}
        self.install_policy(self.policy)
        self.guard("finish", "--run", str(self.run), "--unit", "active-policy",
                   "--result", str(result), ok=False)
        for updates in ({"requirements": [self.artifact(self.requirement, id="expanded-scope")]},
                        {"owner_thread": "different-owner"}, {"actions": ["source", "test", "tracker"]}):
            with self.subTest(updates=updates):
                changed = self.assignment("active-policy", **updates)
                path = self.json_file("changed-active-assignment.json", changed)
                self.guard("reconcile", "--run", str(self.run), "--assignment", str(path), ok=False)
                self.assertEqual("running", self.units()["active-policy"]["state"])
                self.assertEqual(1, self.child_count())
        current = self.json_file("current-active-policy.json", self.assignment("active-policy"))
        self.guard("reconcile", "--run", str(self.run), "--assignment", str(current))
        self.assertEqual("running", self.units()["active-policy"]["state"])
        self.assertEqual(1, self.child_count())
        self.guard("finish", "--run", str(self.run), "--unit", "active-policy", "--result", str(result))
        self.assertEqual("complete", self.units()["active-policy"]["state"])
        self.assertEqual(1, self.child_count())

    def test_unsupported_archive_prerequisite_is_stopped_before_its_own_child_launch(self):
        self.add("archive-redesign")
        self.add("worker-release", dependencies=("archive-redesign",), ready=False)
        dependency = {"unit_id": "archive-redesign", "requirement_id": "worker-release",
                      "evidence": [], "review": {"rationale": "Archive redesign would be beneficial."}}
        parent = self.assignment("worker-release", kind="release", dependencies=[dependency])
        plan = self.json_file("unsupported-parent-plan.json", parent)
        self.guard("plan", "--run", str(self.run), "--assignment", str(plan))
        self.rejected(self.assignment("archive-redesign"))
        self.assertEqual(0, self.child_count())
        self.assertEqual("ready", self.units()["archive-redesign"]["state"])

    def test_genuine_receipt_cannot_be_relabelled_to_start_unrelated_prerequisite(self):
        self.add("permission-guard")
        self.add("archive-redesign")
        self.add("worker-release", dependencies=("archive-redesign",), ready=False)
        copied = self.dependency("permission-guard")
        copied["unit_id"] = "archive-redesign"
        parent = self.assignment("worker-release", kind="release", dependencies=[copied])
        plan = self.json_file("copied-receipt-parent-plan.json", parent)
        self.guard("plan", "--run", str(self.run), "--assignment", str(plan))
        self.rejected(self.assignment("archive-redesign"))
        self.assertEqual("ready", self.units()["archive-redesign"]["state"])

    def test_accepted_real_prerequisite_can_launch_before_parent_is_ready(self):
        self.add("permission-guard")
        self.add("worker-release", dependencies=("permission-guard",), ready=False)
        dependency = self.dependency("permission-guard")
        parent = self.assignment("worker-release", kind="release", dependencies=[dependency])
        plan = self.json_file("accepted-parent-plan.json", parent)
        self.guard("plan", "--run", str(self.run), "--assignment", str(plan))
        before_prerequisite = self.child_count()
        self.launch(self.assignment("permission-guard"))
        self.assertEqual(before_prerequisite + 1, self.child_count())
        self.assertEqual("planned", self.units()["worker-release"]["state"])

    def test_unrelated_archive_redesign_cannot_become_worker_release_dependency(self):
        self.complete_dependency("archive-redesign")
        self.add("worker-release", dependencies=("archive-redesign",))
        dependency = self.dependency("archive-redesign", verdict="unrelated", receipt_updates={
            "rationale": "Archive redesign does not participate in worker-only release."})
        self.rejected(self.assignment("worker-release", kind="release", dependencies=[dependency]))
        dependency["evidence"] = []
        dependency["review"] = {"reviewer": "independent-reviewer", "verdict": "required",
                                "rationale": "It would be beneficial to fix archive deletion first."}
        self.rejected(self.assignment("worker-release", kind="release", dependencies=[dependency]))
        self.complete_dependency("permission-guard")
        copied = self.dependency("permission-guard")
        copied["unit_id"] = "archive-redesign"
        self.rejected(self.assignment("worker-release", kind="release", dependencies=[copied]))
        self.assertEqual("ready", self.units()["worker-release"]["state"])

    def test_evidence_bound_release_dependency_allows_real_blocker(self):
        self.complete_dependency("permission-guard")
        self.add("worker-release", dependencies=("permission-guard",))
        assignment = self.assignment("worker-release", kind="release",
                                     dependencies=[self.dependency("permission-guard")])
        before_parent = self.child_count()
        self.launch(assignment)
        self.assertEqual(before_parent + 1, self.child_count())

    def test_tampered_prerequisite_result_cannot_admit_parent_until_evidence_is_restored(self):
        proof = self.complete_dependency("permission-guard")
        self.add("worker-release", dependencies=("permission-guard",))
        assignment = self.assignment("worker-release", kind="release",
                                     dependencies=[self.dependency("permission-guard")])
        original = proof.read_bytes()
        proof.write_text("Unverified replacement prerequisite output.\n", encoding="utf-8")
        self.rejected(assignment)
        self.assertEqual("ready", self.units()["worker-release"]["state"])
        proof.write_bytes(original)
        before_parent = self.child_count()
        self.launch(assignment)
        self.assertEqual(before_parent + 1, self.child_count())

    def test_legacy_complete_dependency_without_hashed_result_cannot_admit_parent(self):
        self.add("legacy-prerequisite")
        self.transition("legacy-prerequisite", "running")
        self.transition("legacy-prerequisite", "verifying")
        proof = self.root / "legacy-proof.txt"
        proof.write_text("Legacy unbound evidence.\n", encoding="utf-8")
        self.store("verdict", "--run", str(self.run), "--unit-id", "legacy-prerequisite",
                   "--artifact-key", "proof", "--head-sha", self.head,
                   "--verdict", "unit-test-verified", "--verifier", "independent-verifier",
                   "--evidence-path", str(proof))
        self.transition("legacy-prerequisite", "passed", "--evidence-path", str(proof))
        self.transition("legacy-prerequisite", "complete")
        self.add("worker-release", dependencies=("legacy-prerequisite",))
        assignment = self.assignment("worker-release", kind="release",
                                     dependencies=[self.dependency("legacy-prerequisite")])
        self.rejected(assignment)
        self.assertEqual("ready", self.units()["worker-release"]["state"])

    def test_dependency_review_must_be_independent_and_bound_to_actual_requirement(self):
        self.complete_dependency("permission-guard")
        self.add("worker-release", dependencies=("permission-guard",))
        for mutation in ("self-review", "other-head", "wrong-evidence", "omitted-dependency"):
            with self.subTest(mutation=mutation):
                key = f"release-{mutation}"
                updates = {}
                reviewer = "owner" if mutation == "self-review" else "independent-reviewer"
                if mutation == "other-head":
                    updates["source_revision"] = "0" * 40
                elif mutation == "wrong-evidence":
                    updates["evidence_sha256"] = ["0" * 64]
                dependencies = []
                if mutation != "omitted-dependency":
                    dependencies = [self.dependency("permission-guard", parent_key=key,
                                                    reviewer=reviewer, receipt_updates=updates)]
                self.rejected(self.assignment("worker-release", assignment_key=key,
                                               kind="release", dependencies=dependencies))

    def test_superseded_recovery_cannot_restart_but_replacement_can_continue(self):
        self.add("old-recovery")
        old_assignment = self.assignment("old-recovery")
        self.transition("old-recovery", "abandoned")
        self.add("current-recovery", extra=("--failure-family", "old-recovery", "--attempt", "2",
                                            "--supersedes", "old-recovery"))
        old_assignment["expected_revision"] = int(self.units()["old-recovery"]["revision"])
        self.rejected(old_assignment)
        self.launch(self.assignment("current-recovery", assignment_key="old-recovery"))
        self.assertEqual(1, self.child_count())

    def test_completed_jarvis_assignment_consumes_verified_result_without_relaunch(self):
        self.add("jarvis-loop")
        self.launch(self.assignment("jarvis-loop"))
        self.rejected(self.assignment("jarvis-loop"))
        self.finish("jarvis-loop")
        self.assertEqual("complete", self.units()["jarvis-loop"]["state"])
        self.launch(self.assignment("jarvis-loop"))
        self.add("renamed-jarvis-loop")
        self.launch(self.assignment("renamed-jarvis-loop", assignment_key="jarvis-loop"))
        alias = self.units()["renamed-jarvis-loop"]
        self.assertEqual("complete", alias["state"])
        self.assertEqual(self.head, alias["head_sha"])
        self.assertTrue(Path(alias["evidence_path"]).is_file(), "Alias lacks durable result provenance")
        self.launch(self.assignment("renamed-jarvis-loop", assignment_key="jarvis-loop"))
        self.assertEqual("complete", self.units()["renamed-jarvis-loop"]["state"])
        self.add("jarvis-dependent", dependencies=("renamed-jarvis-loop",))
        self.assertEqual("ready", self.units()["jarvis-dependent"]["state"])
        self.assertEqual(1, self.child_count(), "Completed result caused repeated JARVIS work")
        metrics = json.loads(self.guard("metrics", "--run", str(self.run)).stdout)
        self.assertEqual(1, metrics["launches"])
        self.assertEqual(1, metrics["duplicate_dispatches_rejected"])
        self.assertEqual(3, metrics["completed_results_consumed"])
        self.assertEqual(1, len(metrics["verified_milestones"]))
        self.assertEqual("jarvis-loop", metrics["verified_milestones"][0]["unit_id"])
        self.assertGreaterEqual(metrics["verified_milestones"][0]["elapsed_seconds"], 0)
        self.store("verdict", "--run", str(self.run), "--unit-id", "jarvis-loop",
                   "--artifact-key", "guarded-launch-result", "--head-sha", self.head,
                   "--verdict", "failed", "--verifier", "independent-verifier",
                   "--evidence-path", self.units()["jarvis-loop"]["evidence_path"])
        self.assertEqual("failed", self.units()["jarvis-loop"]["state"])
        self.rejected(self.assignment("renamed-jarvis-loop", assignment_key="jarvis-loop"))
        self.assertEqual(1, self.child_count(), "Revoked origin evidence reopened its alias")

    def test_equivalent_recursive_review_is_rejected_but_new_concrete_input_is_allowed(self):
        self.add("first-review")
        review = self.assignment("first-review", assignment_key="release-review", kind="review",
                                 review_scope="worker permission change", actions=["review"])
        self.launch(review)
        self.add("renamed-review")
        duplicate = self.assignment("renamed-review", assignment_key="renamed-review-key", kind="review",
                                    review_scope="worker permission change", actions=["review"])
        self.rejected(duplicate)
        self.finish("first-review")
        self.launch(duplicate)
        self.assertEqual(1, self.child_count())
        self.receipt.write_text('{"required":["source_revision","artifacts","schema_version"]}\n', encoding="utf-8")
        self.add("review-new-evidence")
        changed = self.assignment("review-new-evidence", assignment_key="release-review", kind="review",
                                  review_scope="worker permission change", actions=["review"])
        self.launch(changed)
        self.assertEqual(2, self.child_count())

    def test_concurrent_duplicate_dispatch_invokes_exactly_one_child(self):
        self.add("racing-launch")
        args = self.launch_args(self.assignment("racing-launch"))
        processes = [subprocess.Popen([sys.executable, str(LAUNCH), *args], text=True,
                                      env=self.command_environment(), stdout=subprocess.PIPE,
                                      stderr=subprocess.PIPE) for _ in range(2)]
        results = [process.communicate(timeout=20) for process in processes]
        self.assertEqual(1, sum(process.returncode == 0 for process in processes), results)
        self.assertEqual(1, self.child_count())
        self.assertEqual("running", self.units()["racing-launch"]["state"])

    def test_parent_child_mutable_paths_have_one_active_owner(self):
        self.add("directory-writer", target=str(self.repo / "src"))
        self.add("file-writer", owner="other-owner", target=str(self.repo / "src" / "component.py"))
        self.launch(self.assignment("directory-writer"))
        self.rejected(self.assignment("file-writer"))
        self.assertEqual(1, self.child_count())

    def test_source_revision_and_owner_mismatch_are_rejected_before_child(self):
        self.add("source-owner-check")
        for updates in ({"source_revision": "0" * 40}, {"owner_thread": "other-owner"}, {"host": "other-host"}):
            with self.subTest(updates=updates):
                self.rejected(self.assignment("source-owner-check", **updates))
        self.source.write_text("# New source revision.\n", encoding="utf-8")
        self.git("add", "worker.py")
        self.git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
                 "commit", "--quiet", "-m", "New synthetic source")
        self.rejected(self.assignment("source-owner-check"))
        self.head = self.git("rev-parse", "HEAD").stdout.strip()
        self.add("new-source-continuation")
        self.launch(self.assignment("new-source-continuation", assignment_key="source-owner-check"))
        self.assertEqual(1, self.child_count())

    def test_committed_output_head_finishes_and_original_assignment_consumes_result(self):
        self.add("committed-output")
        assignment = self.assignment("committed-output")
        self.launch(assignment)
        self.source.write_text("# Implemented permission guard.\n", encoding="utf-8")
        self.git("add", "worker.py")
        self.git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
                 "commit", "--quiet", "-m", "Verified implementation output")
        output_head = self.git("rev-parse", "HEAD").stdout.strip()
        self.assertNotEqual(self.head, output_head)
        self.finish("committed-output", source_revision=output_head, input_source_revision=self.head)
        self.assertEqual(output_head, self.units()["committed-output"]["head_sha"])
        assignment["expected_revision"] = int(self.units()["committed-output"]["revision"])
        self.launch(assignment)
        self.assertEqual(1, self.child_count(), "Valid committed output reopened its original assignment")

    def test_missing_or_changed_terminal_artifact_is_not_silently_consumed_or_relaunched(self):
        self.add("verified-result")
        self.launch(self.assignment("verified-result"))
        artifact = self.finish("verified-result")
        artifact.write_text("Unverified replacement.\n", encoding="utf-8")
        self.rejected(self.assignment("verified-result"))
        artifact.unlink()
        self.rejected(self.assignment("verified-result"))
        self.assertEqual(1, self.child_count())

    def test_finish_requires_independent_head_bound_evidence(self):
        self.add("finish-check")
        self.launch(self.assignment("finish-check"))
        proof = self.root / "finish-proof.txt"
        proof.write_text("Actual proof\n", encoding="utf-8")
        valid = {"source_revision": self.head, "verifier": "independent-verifier",
                 "artifacts": [self.artifact(proof)], "check_identity": "bounded-check"}
        for updates in ({"verifier": "owner"}, {"source_revision": "0" * 40},
                        {"artifacts": []}, {"check_identity": "different-check"}):
            with self.subTest(updates=updates):
                path = self.json_file("invalid-result.json", {**valid, **updates})
                self.guard("finish", "--run", str(self.run), "--unit", "finish-check",
                           "--result", str(path), ok=False)
                self.assertNotEqual("complete", self.units()["finish-check"]["state"])
        self.assertEqual(1, self.child_count())


if __name__ == "__main__":
    unittest.main()
