#!/usr/bin/env python3
"""Guard an actual child launch using the existing revisioned development run store.

This is an orchestration boundary, not an OS sandbox or an interceptor for the
Codex desktop's own task tools. All records are controller-authored; semantic
relevance remains an independently reviewed claim bound to concrete artifacts.
"""
from __future__ import annotations

import argparse
from datetime import datetime
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import uuid

import run_store as store

ACTIONS = {"source", "test", "review", "tracker", "routine-build"}
ACTIVE = {"running", "verifying", "stopping"}
PLAN_PREFIX = "launch-plan:"
RESULT_PREFIX = "launch-result:"


class Rejected(ValueError):
    """A causal admission rejection that can be counted without saving prompts."""

    def __init__(self, code: str, detail: str):
        super().__init__(f"{code}: {detail}")
        self.code = code


def require(condition, code, detail):
    if not condition:
        raise Rejected(code, detail)


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def read_json(path):
    value = json.loads(Path(path).read_text(encoding="utf-8"))
    require(isinstance(value, dict), "invalid-contract", "expected a JSON object")
    return value


def artifact(ref):
    """Check an exact existing artifact, returning its portable identity pair."""
    require(isinstance(ref, dict), "invalid-artifact", "expected an artifact reference")
    file = Path(ref.get("path", ""))
    require(file.is_absolute() and file.is_file(), "missing-artifact", str(file))
    expected = ref.get("sha256")
    require(isinstance(expected, str) and len(expected) == 64, "invalid-artifact", str(file))
    require(store.file_sha256(file) == expected, "stale-artifact", str(file))
    return {"path": str(file.resolve()), "sha256": expected}


def artifacts(refs, *, nonempty=False):
    require(isinstance(refs, list) and (refs or not nonempty), "invalid-artifact", "artifact list missing")
    return sorted((artifact(ref) for ref in refs), key=lambda ref: ref["path"])


def record(decisions, name):
    values = [row for row in decisions if row["decision"] == name]
    return json.loads(values[-1]["consequence"]) if values else None


def commit(run, units, ledger, decisions, events):
    """Publish metadata and evidence pointers as one existing atomic snapshot."""
    with tempfile.TemporaryDirectory(dir=run.parent) as temp:
        staged = Path(temp) / run.name
        store.stage_store(run, staged)
        store.write_tsv(staged / "units.tsv", store.UNIT_HEADER, units)
        store.write_tsv(staged / "ledger.tsv", store.LEDGER_HEADER, ledger)
        store.write_tsv(staged / "decisions.tsv", store.DECISION_HEADER, decisions)
        for unit, event, notes in events:
            store.append_event(staged, unit, event, "", json.dumps(notes, sort_keys=True))
            store.bump_manifest(staged)
        store.validate(staged, prefer_root=True)
        store.commit_staged(run, staged, store.SNAPSHOT_FILES)


def decision(unit, name, value):
    return {"decision_id": str(uuid.uuid4()), "unit_id": unit["unit_id"] if unit else "",
            "decided_at": store.utc_now(), "decision": name, "evidence": "",
            "consequence": json.dumps(value, sort_keys=True)}


def set_policy(args):
    policy = read_json(args.file)
    require(bool(policy.get("revision")) and bool(policy.get("user_decision_revision")),
            "invalid-policy", "policy and direct-user-decision revisions are required")
    artifacts(policy.get("instructions"), nonempty=True)
    artifacts(policy.get("user_decisions"), nonempty=True)
    run = Path(args.run).resolve()
    with store.lock_store(run):
        units, ledger, decisions, v2 = store.validate(run)
        require(v2, "legacy-store", "explicit legacy migration is required")
        for row in decisions:
            if row["decision"] != "launch-policy":
                continue
            previous = json.loads(row["consequence"])
            require(previous["revision"] != policy["revision"] or previous == policy,
                    "policy-revision-reused", "new policy content needs a new revision")
        decisions.append(decision(None, "launch-policy", policy))
        commit(run, units, ledger, decisions, [({"unit_id": "", "revision": "0"}, "launch:policy", {"revision": policy["revision"]})])
    print(json.dumps({"policy_revision": policy["revision"]}))


def validated_worktree(value):
    """Canonicalize a controller-owned checkout, preserving symlink collision checks.

    This local CLI runs with the controller's existing filesystem permissions;
    manifest paths and validation results are not exposed to a remote caller.
    """
    require(isinstance(value, str) and bool(value), "source-mismatch", "worktree required")
    path = Path(value)
    require(path.is_absolute() and path.is_dir(), "source-mismatch", "existing absolute worktree required")
    return path.resolve()


def source_head(worktree):
    return subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=validated_worktree(worktree),
                                   text=True, stderr=subprocess.DEVNULL).strip()


def identity(assignment):
    """Ignore labels/attempt names while retaining material acceptance inputs."""
    keys = ("kind", "source_revision", "review_scope", "check_identity")
    value = {key: assignment.get(key) for key in keys}
    if assignment.get("kind") != "review":
        value["assignment_key"] = assignment.get("assignment_key")
    for key in ("inputs", "requirements"):
        value[key] = sorted(({"path": str(Path(ref["path"]).resolve()), "sha256": ref["sha256"]}
                             for ref in assignment.get(key, [])), key=lambda ref: ref["path"])
    return digest(value)


def targets_overlap(left, right):
    for a in store.split_ids(left):
        for b in store.split_ids(right):
            if a == b:
                return True
            pa, pb = Path(a), Path(b)
            if pa.is_absolute() and pb.is_absolute():
                pa, pb = pa.resolve(), pb.resolve()
                if pa == pb or pa in pb.parents or pb in pa.parents:
                    return True
    return False


def verify_dependencies(assignment, unit, units, decisions, *, ready=True, only=None):
    """Require independent semantic relevance with current concrete evidence.

    Existence/hash checks establish provenance, not causality. The independent
    review is explicitly responsible for proving the link to the named outcome.
    """
    dependencies = assignment.get("dependencies")
    require(isinstance(dependencies, list), "unsupported-dependency", "dependency manifest required")
    require(sorted(dep.get("unit_id", "") for dep in dependencies) == sorted(store.split_ids(unit["depends_on"])),
            "unsupported-dependency", "manifest must cover exactly the recorded dependencies")
    requirements = {ref["id"]: ref for ref in assignment["requirements"]}
    by_id = {value["unit_id"]: value for value in units}
    for dependency in dependencies:
        if only is not None and dependency["unit_id"] != only:
            continue
        verify_dependency(assignment, dependency, requirements, by_id, units, decisions, ready=ready)


def verify_dependency(assignment, dependency, requirements, by_id, units, decisions, *, ready):
    """Validate one independently reviewed edge, then its result when required."""
    required = requirements.get(dependency.get("requirement_id"))
    review_ref = dependency.get("review", {})
    require(isinstance(review_ref, dict) and all(review_ref.get(key) for key in ("unit_id", "path", "sha256")),
            "unsupported-dependency", "independent completed relevance review receipt required")
    artifact(review_ref)
    review_unit = by_id.get(review_ref["unit_id"])
    review_bindings = [json.loads(row["consequence"]) for row in decisions
                       if row["decision"] == "launch-binding" and row["unit_id"] == review_ref["unit_id"]]
    require(review_unit is not None and review_unit["state"] in {"passed", "complete"} and bool(review_bindings),
            "unsupported-dependency", "relevance reviewer was not separately dispatched and completed")
    review_assignment = review_bindings[-1]["assignment"]
    review_result = accepted_result(review_unit["unit_id"], units, decisions)
    require(artifact(review_ref) in artifacts(review_result["artifacts"]),
            "unsupported-dependency", "receipt is not an accepted review artifact")
    require(review_assignment["kind"] == "review"
            and review_assignment["review_scope"] == "dependency:" + assignment["assignment_key"] + ":" + dependency["unit_id"],
            "unsupported-dependency", "review did not cover this parent and dependency")
    review = read_json(review_ref["path"])
    dependency_unit = by_id.get(dependency["unit_id"])
    require(dependency_unit is not None, "unsupported-dependency", "unknown dependency")
    dependency_bindings = [json.loads(row["consequence"]) for row in decisions
                           if row["decision"] == "launch-binding" and row["unit_id"] == dependency["unit_id"]]
    input_head = dependency_bindings[0]["assignment"]["source_revision"] if dependency_bindings else dependency_unit["head_sha"]
    expected_dependency = {"unit_id": dependency_unit["unit_id"], "deliverable": dependency_unit["deliverable"], "head_sha": input_head}
    require(review.get("parent_assignment_key") == assignment["assignment_key"]
            and all(review.get("dependency", {}).get(key) == value for key, value in expected_dependency.items())
            and review.get("reviewer") == review_result.get("origin_owner_thread", review_unit["owner_thread"]),
            "unsupported-dependency", "receipt is not bound to this dependency scope and reviewer")
    evidence = dependency.get("evidence", [])
    require(required is not None and bool(evidence), "unsupported-dependency", "named acceptance requirement and evidence required")
    artifacts(evidence, nonempty=True)
    require(any(ref.get("kind") in {"source", "runtime"} for ref in evidence),
            "unsupported-dependency", "source or runtime evidence is required")
    require(any(ref.get("kind") == "acceptance" and ref["sha256"] == required["sha256"]
                and Path(ref["path"]).resolve() == Path(required["path"]).resolve() for ref in evidence),
            "unsupported-dependency", "acceptance evidence must match the requirement")
    require(review.get("verdict") == "required" and bool(review.get("reviewer"))
            and review["reviewer"] != assignment["owner_thread"] and bool(review.get("rationale")),
            "unsupported-dependency", "independent relevance review did not accept this dependency")
    require(review.get("source_revision") == assignment["source_revision"]
            and review.get("requirement_id") == required["id"]
            and sorted(review.get("evidence_sha256", [])) == sorted(ref["sha256"] for ref in evidence),
            "unsupported-dependency", "relevance review is not bound to this source and evidence")
    if ready:
        require(dependency_unit["state"] in store.DEPENDENCY_SUCCESS_STATES,
                "dependency-not-ready", dependency["unit_id"])
        require(bool(dependency_bindings), "unverified-terminal", "qualify legacy dependency evidence before dispatch")
        accepted_result(dependency_unit["unit_id"], units, decisions)

def verify_resolved_instructions(assignment):
    """Resolve default Codex instruction files for the actual selected checkout.

    This checks files the CLI discovers, not private desktop-injected messages.
    Invoked skills/extra harness instructions must also be in the policy manifest.
    """
    worktree = validated_worktree(assignment["worktree"])
    root = Path(subprocess.check_output(["git", "rev-parse", "--show-toplevel"], cwd=worktree,
                                        text=True, stderr=subprocess.DEVNULL).strip()).resolve()
    home = Path(os.environ.get("CODEX_HOME", str(Path.home() / ".codex"))).resolve()
    directories = [home, root]
    current = root
    for segment in worktree.relative_to(root).parts:
        current = current / segment
        directories.append(current)
    declared = {ref["path"]: ref["sha256"] for ref in artifacts(assignment.get("loaded_instructions"), nonempty=True)}
    total_bytes = 0
    for directory in directories:
        selected = next((directory / name for name in ("AGENTS.override.md", "AGENTS.md")
                         if (directory / name).is_file() and (directory / name).read_text(encoding="utf-8").strip()), None)
        if selected is not None:
            total_bytes += selected.stat().st_size + 2
            require(total_bytes <= 32768, "truncated-instructions", "instruction chain exceeds the controlled 32 KiB limit")
            require(declared.get(str(selected.resolve())) == store.file_sha256(selected),
                    "conflicting-instructions", "selected instruction file is absent or stale: " + str(selected))


def verify_policy(assignment, policy):
    require(policy is not None, "missing-policy", "configure the canonical controller policy first")
    require(assignment.get("policy_revision") == policy["revision"]
            and assignment.get("user_decision_revision") == policy["user_decision_revision"],
            "stale-policy", "policy or direct-user-decision revision changed")
    expected = artifacts(policy["instructions"], nonempty=True)
    artifacts(policy["user_decisions"], nonempty=True)
    require(artifacts(assignment.get("loaded_instructions"), nonempty=True) == expected,
            "conflicting-instructions", "launch instruction manifest differs from current policy")
    verify_resolved_instructions(assignment)


def verify_assignment(assignment, policy, unit, units, decisions, output_head=None, *, check_dependencies=True):
    verify_policy(assignment, policy)
    require(assignment.get("kind") in {"implementation", "review", "release"}, "invalid-contract", "unknown kind")
    require(bool(assignment.get("assignment_key")) and bool(assignment.get("check_identity")), "invalid-contract", "stable assignment and check identities required")
    require(bool(assignment.get("actions")) and set(assignment["actions"]) <= ACTIONS,
            "protected-action", "this launcher permits routine development only")
    for key in ("owner_thread", "host"):
        require(bool(assignment.get(key)) and assignment[key] == unit[key], "owner-mismatch", key)
    require(Path(assignment.get("worktree", "")).is_absolute(), "source-mismatch", "absolute worktree required")
    expected_head = output_head or assignment.get("source_revision")
    require(unit["head_sha"] in {assignment.get("source_revision"), output_head}
            and expected_head == source_head(assignment["worktree"]),
            "source-mismatch", "assignment, unit and checkout source chain must match")
    require(subprocess.call(["git", "diff", "--quiet", "HEAD"], cwd=validated_worktree(assignment["worktree"]),
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL) == 0,
            "source-mismatch", "commit tracked source changes before dispatch or verification")
    artifacts(assignment.get("inputs"))
    requirements = assignment.get("requirements")
    artifacts(requirements, nonempty=True)
    ids = [ref.get("id") for ref in requirements]
    require(all(ids) and len(ids) == len(set(ids)), "invalid-contract", "unique acceptance requirement IDs required")
    if assignment["kind"] == "review":
        require(bool(assignment.get("review_scope")), "invalid-contract", "review scope required")
    if check_dependencies:
        verify_dependencies(assignment, unit, units, decisions)


def plan(args):
    """Record proposed parent scope; this does not admit its dependency edges."""
    run = Path(args.run).resolve()
    assignment = read_json(args.assignment)
    with store.lock_store(run):
        units, ledger, decisions, _ = store.validate(run)
        unit = next((value for value in units if value["unit_id"] == assignment.get("unit_id")), None)
        require(unit is not None and unit["state"] in {"planned", "blocked", "ready"}, "ineligible-state", "only unstarted units may be planned")
        verify_assignment(assignment, record(decisions, "launch-policy"), unit, units, decisions, check_dependencies=False)
        require(sorted(dep.get("unit_id", "") for dep in assignment.get("dependencies", [])) == sorted(store.split_ids(unit["depends_on"])),
                "unsupported-dependency", "proposal must cover exactly the recorded dependencies")
        prior = record(decisions, PLAN_PREFIX + unit["unit_id"])
        require(prior is None or identity(prior) == identity(assignment), "changed-plan", "material scope changes require a new unit")
        decisions.append(decision(unit, PLAN_PREFIX + unit["unit_id"], assignment))
        commit(run, units, ledger, decisions, [(unit, "launch:planned", {"identity": identity(assignment)})])
    print(json.dumps({"status": "planned", "unit_id": unit["unit_id"]}))


def verified_result(result, assignment):
    require(result is not None, "unverified-terminal", "terminal state lacks a guarded result receipt")
    require(result.get("input_source_revision", result.get("source_revision")) == assignment["source_revision"]
            and result.get("check_identity") == assignment["check_identity"],
            "stale-result", "result source or check identity changed")
    require(bool(result.get("verifier")) and result["verifier"] != result.get("origin_owner_thread", assignment["owner_thread"]),
            "unverified-terminal", "independent verifier required")
    artifacts(result.get("artifacts"), nonempty=True)
    return result


def accepted_result(unit_id, units, decisions, seen=None):
    """Recheck live acceptance throughout reused-result provenance, not only bytes."""
    seen = set() if seen is None else seen
    require(unit_id not in seen, "invalid-provenance", "cyclic reused-result provenance")
    seen.add(unit_id)
    unit = next((row for row in units if row["unit_id"] == unit_id), None)
    require(unit is not None and unit["state"] in {"passed", "complete"},
            "revoked-result", "result origin is no longer accepted: " + unit_id)
    bindings = [json.loads(row["consequence"]) for row in decisions
                if row["decision"] == "launch-binding" and row["unit_id"] == unit_id]
    require(bool(bindings), "unverified-terminal", "missing result binding")
    result = verified_result(record(decisions, RESULT_PREFIX + unit_id), bindings[-1]["assignment"])
    require(result["source_revision"] == unit["head_sha"], "stale-result", "accepted source changed")
    if result.get("reused_from"):
        origin = accepted_result(result["reused_from"], units, decisions, seen)
        for key in ("artifacts", "source_revision", "input_source_revision", "check_identity", "verifier", "origin_owner_thread"):
            require(result.get(key) == origin.get(key), "invalid-provenance", "reused result differs from accepted origin")
    return result


def verify_parent_prerequisites(assignment, unit, units, decisions):
    """Require relevance before a proposed prerequisite starts implementation."""
    # A prerequisite must earn relevance before its implementation starts.
    for parent in units:
        if unit["unit_id"] in store.split_ids(parent["depends_on"]) and parent["state"] not in {"failed", "abandoned"}:
            proposed = record(decisions, PLAN_PREFIX + parent["unit_id"])
            require(proposed is not None, "unsupported-dependency", "record parent acceptance scope before dispatching a prerequisite")
            verify_assignment(proposed, record(decisions, "launch-policy"), parent, units, decisions, check_dependencies=False)
            verify_dependencies(proposed, parent, units, decisions, ready=False, only=unit["unit_id"])


def consume_equivalent(run, assignment, unit, units, ledger, decisions, bindings, by_id, key):
    """Reuse accepted provenance and close aliases without dispatching a child."""
    bindings.sort(key=lambda bound: bound["assignment"]["unit_id"] != unit["unit_id"])
    for bound in bindings:
        if bound["identity"] != key:
            continue
        prior = by_id[bound["assignment"]["unit_id"]]
        if prior["state"] in {"passed", "complete"}:
            result = accepted_result(prior["unit_id"], units, decisions)
            if unit["unit_id"] != prior["unit_id"]:
                require(unit["state"] in {"planned", "ready", "blocked"}, "duplicate-dispatch", unit["unit_id"])
                require(assignment.get("expected_revision") == int(unit["revision"]), "stale-revision", unit["unit_id"])
                result = dict(result, reused_from=prior["unit_id"])
                decisions.append(decision(unit, "launch-binding", {"identity": key, "assignment": assignment}))
                decisions.append(decision(unit, RESULT_PREFIX + unit["unit_id"], result))
                unit["state"] = "complete"
                unit["blocker"] = ""
                unit["revision"] = str(int(unit["revision"]) + 1)
                unit["head_sha"] = result["source_revision"]
                unit["evidence_path"] = result["artifacts"][0]["path"]
                unit["updated_at"] = store.utc_now()
                ledger.append({"unit_id": unit["unit_id"], "artifact_key": "guarded-launch-result", "head_sha": unit["head_sha"],
                               "verdict": "real-artifact-verified", "verifier": result["verifier"],
                               "evidence_path": unit["evidence_path"], "checked_at": store.utc_now(), "notes": "reused:" + prior["unit_id"]})
            commit(run, units, ledger, decisions, [(unit, "launch:consumed", {"from_unit": prior["unit_id"], "identity": key})])
            return {"status": "consumed", "unit_id": prior["unit_id"], "result": result}
        require(prior["state"] not in ACTIVE, "duplicate-dispatch", prior["unit_id"])
    return None


def verify_owner_claim(assignment, unit, units, bindings, by_id):
    """Reject overlapping logical targets and canonical checkout aliases."""
    for other in units:
        if other["unit_id"] != unit["unit_id"] and other["state"] in ACTIVE:
            require(not targets_overlap(unit["mutable_targets"], other["mutable_targets"]), "owner-collision", other["unit_id"])
    # Also claim the concrete checkout even when callers name different logical targets.
    for bound in bindings:
        other = by_id[bound["assignment"]["unit_id"]]
        if other["state"] in ACTIVE:
            require(Path(bound["assignment"]["worktree"]).resolve() != validated_worktree(assignment["worktree"]),
                    "owner-collision", other["unit_id"])


def admit(run, assignment):
    """Claim once under the store lock, or consume an accepted result; never replay."""
    with store.lock_store(run):
        units, ledger, decisions, v2 = store.validate(run)
        require(v2, "legacy-store", "explicit legacy migration is required")
        unit = next((value for value in units if value["unit_id"] == assignment.get("unit_id")), None)
        require(unit is not None, "unknown-unit", "register the bounded unit first")
        try:
            key = identity(assignment)
            bindings = [json.loads(row["consequence"]) for row in decisions if row["decision"] == "launch-binding"]
            by_id = {value["unit_id"]: value for value in units}
            accepted = next((bound for bound in bindings if bound["identity"] == key
                             and by_id[bound["assignment"]["unit_id"]]["state"] in {"passed", "complete"}), None)
            terminal = record(decisions, RESULT_PREFIX + accepted["assignment"]["unit_id"]) if accepted else None
            verify_assignment(assignment, record(decisions, "launch-policy"), unit, units, decisions,
                              output_head=terminal.get("source_revision") if terminal else None)
            verify_parent_prerequisites(assignment, unit, units, decisions)
            require(not any(value["supersedes"] == unit["unit_id"] for value in units), "superseded", unit["unit_id"])
            require(unit["state"] not in {"failed", "abandoned", "stopping"}, "ineligible-state", unit["state"])
            consumed = consume_equivalent(run, assignment, unit, units, ledger, decisions, bindings, by_id, key)
            if consumed is not None:
                return consumed
            require(unit["state"] not in {"passed", "complete"}, "completed-reopen", "terminal assignment cannot be changed in place")
            require(unit["state"] == "ready", "ineligible-state", unit["state"])
            require(assignment.get("expected_revision") == int(unit["revision"]), "stale-revision", unit["unit_id"])
            verify_owner_claim(assignment, unit, units, bindings, by_id)
            unit["state"] = "running"
            unit["revision"] = str(int(unit["revision"]) + 1)
            unit["updated_at"] = store.utc_now()
            decisions.append(decision(unit, "launch-binding", {"identity": key, "assignment": assignment}))
            commit(run, units, ledger, decisions, [(unit, "launch:started", {"identity": key})])
            return {"status": "started", "unit_id": unit["unit_id"]}
        except Rejected as error:
            commit(run, units, ledger, decisions, [(unit, "launch:rejected", {"code": error.code})])
            raise


def launch(args):
    require(bool(args.child), "missing-command", "child command required")
    command = args.child[1:] if args.child[0] == "--" else args.child
    require(bool(command), "missing-command", "child command required")
    assignment = read_json(args.assignment)
    if args.workspace:
        require(Path(args.workspace).resolve() == Path(assignment.get("worktree", "")).resolve(),
                "workspace-mismatch", "controller manifest belongs to another checkout")
    if args.issue_id:
        require(assignment.get("issue_id") == args.issue_id, "issue-mismatch", "controller manifest belongs to another issue")
    result = admit(Path(args.run).resolve(), assignment)
    # Never corrupt the app-server's stdout protocol with controller diagnostics.
    print(json.dumps(result), file=sys.stderr)
    if result["status"] == "consumed":
        return 0
    try:
        return subprocess.call(command, cwd=assignment["worktree"])
    except OSError as error:
        # Retain the claim as unknown; a failed observation never authorizes replay.
        raise Rejected("launch-unknown", str(error)) from error


def reconcile(args):
    """Adopt current policy without replaying work or changing its admitted scope."""
    run = Path(args.run).resolve()
    assignment = read_json(args.assignment)
    with store.lock_store(run):
        units, ledger, decisions, _ = store.validate(run)
        unit = next((value for value in units if value["unit_id"] == assignment.get("unit_id")), None)
        require(unit is not None and unit["state"] in {"running", "verifying"}, "ineligible-state", "only an active claim can reconcile")
        require(assignment.get("expected_revision") == int(unit["revision"]), "stale-revision", unit["unit_id"])
        bindings = [json.loads(row["consequence"]) for row in decisions
                    if row["decision"] == "launch-binding" and row["unit_id"] == unit["unit_id"]]
        require(bool(bindings), "unknown-binding", unit["unit_id"])
        prior = bindings[-1]["assignment"]
        mutable = {"expected_revision", "policy_revision", "user_decision_revision", "loaded_instructions"}
        require({key: value for key, value in prior.items() if key not in mutable}
                == {key: value for key, value in assignment.items() if key not in mutable},
                "changed-scope", "reconciliation cannot change scope, owner, actions or source identity")
        verify_policy(assignment, record(decisions, "launch-policy"))
        decisions.append(decision(unit, "launch-binding", {"identity": bindings[-1]["identity"], "assignment": assignment}))
        unit["revision"] = str(int(unit["revision"]) + 1)
        unit["updated_at"] = store.utc_now()
        commit(run, units, ledger, decisions, [(unit, "launch:reconciled", {"policy_revision": assignment["policy_revision"]})])
    print(json.dumps({"status": unit["state"], "unit_id": unit["unit_id"], "revision": int(unit["revision"])}))


def finish(args):
    run = Path(args.run).resolve()
    result = read_json(args.result)
    with store.lock_store(run):
        units, ledger, decisions, _ = store.validate(run)
        unit = next((row for row in units if row["unit_id"] == args.unit), None)
        require(unit is not None and unit["state"] in {"running", "verifying"}, "ineligible-state", "unit is not awaiting verification")
        bindings = [json.loads(row["consequence"]) for row in decisions
                    if row["decision"] == "launch-binding" and row["unit_id"] == args.unit]
        require(bool(bindings), "unverified-terminal", "unit was not admitted by this launcher")
        assignment = bindings[-1]["assignment"]
        result.pop("reused_from", None)
        result["origin_owner_thread"] = assignment["owner_thread"]
        verified_result(result, assignment)
        verify_assignment(assignment, record(decisions, "launch-policy"), unit, units, decisions,
                          output_head=result.get("source_revision"))
        unit["head_sha"] = result["source_revision"]
        decisions.append(decision(unit, RESULT_PREFIX + args.unit, result))
        ledger.append({"unit_id": args.unit, "artifact_key": "guarded-launch-result", "head_sha": unit["head_sha"],
                       "verdict": "real-artifact-verified", "verifier": result["verifier"],
                       "evidence_path": result["artifacts"][0]["path"], "checked_at": store.utc_now(), "notes": digest(result)})
        unit["state"] = "complete"
        unit["revision"] = str(int(unit["revision"]) + 1)
        unit["updated_at"] = store.utc_now()
        unit["evidence_path"] = result["artifacts"][0]["path"]
        commit(run, units, ledger, decisions, [(unit, "launch:verified", {"identity": bindings[-1]["identity"]})])
    print(json.dumps({"status": "complete", "unit_id": args.unit}))


def metrics(args):
    run = Path(args.run).resolve()
    with store.lock_store(run, exclusive=False):
        store.validate(run)
        _, events = store.read_tsv(store.semantic_root(run) / "events.tsv", [store.EVENT_HEADER])
    result = {"coverage": "guarded-launch events only; earlier or direct desktop dispatch is unknown",
              "launches": 0, "unsupported_blocker_admissions_rejected": 0, "duplicate_dispatches_rejected": 0,
              "completed_results_consumed": 0, "completed_reopen_attempts_rejected": 0, "verified_milestones": []}
    starts = {}
    for event in events:
        kind = event["event"]
        if kind == "launch:started":
            result["launches"] += 1
            starts[event["unit_id"]] = datetime.fromisoformat(event["recorded_at"])
        elif kind == "launch:consumed":
            result["completed_results_consumed"] += 1
        elif kind == "launch:rejected":
            code = json.loads(event["notes"])["code"]
            metric = {"unsupported-dependency": "unsupported_blocker_admissions_rejected", "duplicate-dispatch": "duplicate_dispatches_rejected",
                      "owner-collision": "duplicate_dispatches_rejected", "completed-reopen": "completed_reopen_attempts_rejected"}.get(code)
            if metric:
                result[metric] += 1
        elif kind == "launch:verified" and event["unit_id"] in starts:
            elapsed = (datetime.fromisoformat(event["recorded_at"]) - starts[event["unit_id"]]).total_seconds()
            result["verified_milestones"].append({"unit_id": event["unit_id"], "elapsed_seconds": elapsed})
    print(json.dumps(result, indent=2))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    policy = sub.add_parser("policy")
    policy.add_argument("--run", required=True)
    policy.add_argument("--file", required=True)
    policy.set_defaults(func=set_policy)
    proposal = sub.add_parser("plan")
    proposal.add_argument("--run", required=True)
    proposal.add_argument("--assignment", required=True)
    proposal.set_defaults(func=plan)
    start = sub.add_parser("launch")
    start.add_argument("--run", required=True)
    start.add_argument("--assignment", required=True)
    start.add_argument("--workspace")
    start.add_argument("--issue-id")
    start.add_argument("child", nargs=argparse.REMAINDER)
    start.set_defaults(func=launch)
    refresh = sub.add_parser("reconcile")
    refresh.add_argument("--run", required=True)
    refresh.add_argument("--assignment", required=True)
    refresh.set_defaults(func=reconcile)
    done = sub.add_parser("finish")
    done.add_argument("--run", required=True)
    done.add_argument("--unit", required=True)
    done.add_argument("--result", required=True)
    done.set_defaults(func=finish)
    measure = sub.add_parser("metrics")
    measure.add_argument("--run", required=True)
    measure.set_defaults(func=metrics)
    try:
        args = parser.parse_args()
        return args.func(args) or 0
    except (ValueError, OSError, KeyError, TypeError, subprocess.SubprocessError) as error:
        print(f"agent-launch: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
