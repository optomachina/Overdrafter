#!/usr/bin/env python3
"""Create and maintain a revisioned, semantically checked run store."""

from __future__ import annotations

import argparse
import csv
from datetime import datetime, timezone
import fcntl
import hashlib
import json
from pathlib import Path
import re
import shutil
import sys
import tempfile
from typing import Iterable
import uuid


V1_UNIT_HEADER = [
    "unit_id", "track", "owner_thread", "host", "target", "state",
    "deliverable", "evidence_path", "head_sha", "updated_at", "blocker",
]
UNIT_HEADER = V1_UNIT_HEADER + [
    "revision", "depends_on", "mutable_targets", "failure_family", "attempt",
    "max_attempts", "supersedes",
]
LEDGER_HEADER = [
    "unit_id", "artifact_key", "head_sha", "verdict", "verifier",
    "evidence_path", "checked_at", "notes",
]
DECISION_HEADER = [
    "decision_id", "unit_id", "decided_at", "decision", "evidence", "consequence",
]
EVENT_HEADER = [
    "event_id", "unit_id", "unit_revision", "recorded_at", "event", "evidence", "notes",
]
UNITS_FILE = "units.tsv"
LEDGER_FILE = "ledger.tsv"
DECISIONS_FILE = "decisions.tsv"
EVENTS_FILE = "events.tsv"
MANIFEST_FILE = "manifest.json"
STATUS_FILE = "status.md"
SNAPSHOT_FILES = (UNITS_FILE, LEDGER_FILE, DECISIONS_FILE, EVENTS_FILE)
UNIT_STATES = {
    "planned", "ready", "running", "stopping", "blocked", "verifying", "passed",
    "failed", "abandoned", "complete",
}
TERMINAL_STATES = {"passed", "failed", "abandoned", "complete"}
DEPENDENCY_SUCCESS_STATES = {"passed", "complete"}
MUTATING_STATES = {"running", "verifying", "stopping"}
VERDICTS = {
    "real-artifact-verified", "unit-test-verified", "typecheck-only", "blocked", "failed",
}
ACCEPTED_VERDICTS = {"real-artifact-verified", "unit-test-verified", "typecheck-only"}
RUN_ID = re.compile(r"^[a-z0-9][a-z0-9._-]*$")
TRANSITIONS = {
    "planned": {"ready", "blocked", "abandoned"},
    "ready": {"running", "blocked", "abandoned"},
    "running": {"verifying", "blocked", "failed", "abandoned"},
    "verifying": {"passed", "blocked", "failed", "abandoned"},
    "stopping": {"blocked", "failed", "abandoned"},
    "passed": {"complete"},
    "blocked": {"ready", "abandoned", "failed"},
    "failed": {"ready", "abandoned"},
    "abandoned": set(),
    "complete": set(),
}


def utc_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def split_ids(value: str) -> list[str]:
    return [part.strip() for part in value.split(",") if part.strip()]


def write_tsv(path: Path, header: list[str], rows: Iterable[dict[str, str]] = ()) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile("w", newline="", encoding="utf-8", dir=path.parent, delete=False) as handle:
        writer = csv.DictWriter(handle, fieldnames=header, delimiter="\t", lineterminator="\n")
        writer.writeheader()
        writer.writerows(rows)
        temporary = Path(handle.name)
    temporary.replace(path)


def append_tsv(path: Path, header: list[str], row: dict[str, str]) -> None:
    if not path.is_file():
        write_tsv(path, header)
    with path.open("a", newline="", encoding="utf-8") as handle:
        csv.DictWriter(handle, fieldnames=header, delimiter="\t", lineterminator="\n").writerow(row)


def read_tsv(path: Path, accepted_headers: list[list[str]]) -> tuple[list[str], list[dict[str, str]]]:
    if not path.is_file():
        raise ValueError(f"missing {path.name}")
    with path.open(newline="", encoding="utf-8") as handle:
        reader = csv.DictReader(handle, delimiter="\t")
        fields = reader.fieldnames or []
        if fields not in accepted_headers:
            raise ValueError(f"{path.name} header mismatch")
        return fields, list(reader)


def read_manifest(run: Path) -> dict[str, object] | None:
    path = run / MANIFEST_FILE
    if not path.is_file():
        return None
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise ValueError("manifest.json must contain an object")
    return data


def write_manifest(run: Path, manifest: dict[str, object]) -> None:
    path = run / MANIFEST_FILE
    with tempfile.NamedTemporaryFile("w", encoding="utf-8", dir=run, delete=False) as handle:
        json.dump(manifest, handle, indent=2, sort_keys=True)
        handle.write("\n")
        temporary = Path(handle.name)
    temporary.replace(path)


def lock_store(run: Path, *, exclusive: bool = True):
    run.mkdir(parents=True, exist_ok=True)
    handle = (run / ".lock").open("a+", encoding="utf-8")
    fcntl.flock(handle.fileno(), fcntl.LOCK_EX if exclusive else fcntl.LOCK_SH)
    return handle


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def copy_atomic(source: Path, destination: Path) -> None:
    with tempfile.NamedTemporaryFile("wb", dir=destination.parent, delete=False) as handle:
        with source.open("rb") as source_handle:
            shutil.copyfileobj(source_handle, handle)
        handle.flush()
        temporary = Path(handle.name)
    temporary.replace(destination)


def semantic_root(run: Path) -> Path:
    manifest = read_manifest(run)
    if manifest and manifest.get("snapshot_dir"):
        return run / str(manifest["snapshot_dir"])
    return run


def stage_store(run: Path, staged: Path) -> None:
    """Create a writable staging view from the canonical snapshot, never stale projections."""
    shutil.copytree(
        run,
        staged,
        ignore=shutil.ignore_patterns(".snapshots", ".lock"),
    )
    source = semantic_root(run)
    for name in SNAPSHOT_FILES:
        shutil.copy2(source / name, staged / name)


def commit_staged(run: Path, staged: Path, names: tuple[str, ...]) -> None:
    """Publish one immutable snapshot, then atomically switch the canonical manifest pointer."""
    del names  # Every transaction publishes a complete semantic snapshot.
    manifest = read_manifest(staged)
    if not manifest:
        raise ValueError("staged transaction lacks manifest.json")
    revision = int(manifest.get("revision", -1))
    snapshots = run / ".snapshots"
    snapshots.mkdir(exist_ok=True)
    temporary = snapshots / f".staging-{uuid.uuid4().hex}"
    final = snapshots / f"revision-{revision:06d}-{uuid.uuid4().hex}"
    temporary.mkdir()
    try:
        for name in SNAPSHOT_FILES:
            shutil.copy2(staged / name, temporary / name)
        temporary.replace(final)
    except BaseException:
        shutil.rmtree(temporary, ignore_errors=True)
        raise
    pointer = dict(manifest)
    pointer["snapshot_dir"] = str(final.relative_to(run))
    pointer["snapshot_hashes"] = {
        name: file_sha256(final / name) for name in SNAPSHOT_FILES
    }
    write_manifest(run, pointer)
    # Root files are compatibility projections only. CLI readers use the manifest snapshot.
    for name in SNAPSHOT_FILES:
        copy_atomic(final / name, run / name)


def init_store(args: argparse.Namespace) -> None:
    if not RUN_ID.fullmatch(args.run_id):
        raise ValueError("run-id must use lowercase letters, numbers, dot, underscore, or hyphen")
    run = Path(args.root).expanduser().resolve() / args.run_id
    run.mkdir(parents=True, exist_ok=False)
    now = utc_now()
    write_manifest(run, {
        "schema_version": 2, "run_id": args.run_id, "title": args.title,
        "revision": 0, "created_at": now, "updated_at": now,
    })
    (run / "preferences.md").write_text(
        "# Standing constraints\n\n"
        "1. One writer per mutable target.\n"
        "2. A durable artifact or materially new evidence is required at every checkpoint.\n"
        "3. Consequential external actions require their applicable current authorization.\n"
        "4. After two checkpoints without durable progress or three similar failures, stop and preserve evidence.\n",
        encoding="utf-8",
    )
    write_tsv(run / UNITS_FILE, UNIT_HEADER)
    write_tsv(run / LEDGER_FILE, LEDGER_HEADER)
    write_tsv(run / DECISIONS_FILE, DECISION_HEADER)
    write_tsv(run / EVENTS_FILE, EVENT_HEADER)
    (run / "gates.md").write_text("# Open gates\n\nNone.\n", encoding="utf-8")
    (run / STATUS_FILE).write_text(
        f"# {args.title}\n\nGenerated from run-store revision 0 at {now}.\n\nNo units recorded.\n",
        encoding="utf-8",
    )
    print(run)


def find_cycle(graph: dict[str, list[str]]) -> list[str] | None:
    visiting: set[str] = set()
    visited: set[str] = set()

    def walk(node: str, trail: list[str]) -> list[str] | None:
        if node in visiting:
            index = trail.index(node)
            return trail[index:] + [node]
        if node in visited:
            return None
        visiting.add(node)
        for dependency in graph[node]:
            cycle = walk(dependency, trail + [dependency])
            if cycle:
                return cycle
        visiting.remove(node)
        visited.add(node)
        return None

    for node in graph:
        cycle = walk(node, [node])
        if cycle:
            return cycle
    return None


def _validate_required_files(run: Path) -> None:
    for name in ("preferences.md", "gates.md", STATUS_FILE):
        if not (run / name).is_file():
            raise ValueError(f"missing {name}")


def _validation_data_root(run: Path, manifest: dict[str, object] | None, prefer_root: bool) -> Path:
    """Check the selected snapshot before any semantic rows are consumed."""
    data_root = run
    if not prefer_root and manifest and manifest.get("snapshot_dir"):
        data_root = run / str(manifest["snapshot_dir"])
        if not data_root.is_dir():
            raise ValueError("manifest snapshot_dir is missing")
        hashes = manifest.get("snapshot_hashes")
        if not isinstance(hashes, dict):
            raise ValueError("manifest snapshot_hashes is missing")
        for name in SNAPSHOT_FILES:
            if hashes.get(name) != file_sha256(data_root / name):
                raise ValueError(f"snapshot hash mismatch: {name}")
    return data_root


def _validate_manifest_revision(manifest: dict[str, object] | None, data_root: Path) -> None:
    if not manifest or manifest.get("schema_version") != 2:
        raise ValueError("schema-v2 units require manifest.json with schema_version 2")
    _, events = read_tsv(data_root / EVENTS_FILE, [EVENT_HEADER])
    if int(manifest.get("revision", -1)) != len(events):
        raise ValueError("manifest revision does not match event count")


def _validate_identifiers(rows: list[dict[str, str]], field: str) -> list[str]:
    values = [row[field] for row in rows]
    if any(not value for value in values) or len(values) != len(set(values)):
        raise ValueError(f"{field} values must be non-empty and unique")
    return values


def _validate_unit_state(row: dict[str, str]) -> None:
    unit_id = row["unit_id"]
    if row["state"] not in UNIT_STATES:
        raise ValueError(f"unknown unit state for {unit_id}: {row['state']}")
    if row["state"] in {"passed", "complete"} and not row["evidence_path"]:
        raise ValueError(f"accepted unit lacks evidence_path: {unit_id}")
    if row["state"] in {"blocked", "stopping"} and not row["blocker"]:
        raise ValueError(f"blocked unit lacks blocker: {unit_id}")


def _validate_attempt_bounds(row: dict[str, str]) -> None:
    unit_id = row["unit_id"]
    try:
        revision = int(row["revision"])
        attempt = int(row["attempt"])
        max_attempts = int(row["max_attempts"])
    except ValueError as error:
        raise ValueError(f"non-integer revision or attempt for {unit_id}") from error
    if revision < 1 or attempt < 1 or max_attempts < 1 or attempt > max_attempts:
        raise ValueError(f"invalid revision or attempt bounds for {unit_id}")


def _validate_unit_dependencies(row: dict[str, str], unit_map: dict[str, dict[str, str]]) -> None:
    unit_id = row["unit_id"]
    for dependency in split_ids(row["depends_on"]):
        if dependency not in unit_map:
            raise ValueError(f"unknown dependency for {unit_id}: {dependency}")
    if row["state"] in {"ready", "running", "verifying", "passed", "complete"}:
        incomplete = [dep for dep in split_ids(row["depends_on"]) if unit_map[dep]["state"] not in DEPENDENCY_SUCCESS_STATES]
        if incomplete:
            raise ValueError(f"unsatisfied dependencies for {unit_id}: {','.join(incomplete)}")


def _validate_superseded_unit(row: dict[str, str], unit_map: dict[str, dict[str, str]]) -> None:
    unit_id = row["unit_id"]
    supersedes = row["supersedes"]
    if supersedes:
        if supersedes not in unit_map:
            raise ValueError(f"unknown superseded unit for {unit_id}: {supersedes}")
        if unit_map[supersedes]["state"] not in TERMINAL_STATES:
            raise ValueError(f"superseded unit is not terminal for {unit_id}: {supersedes}")


def _validate_target_owners(units: list[dict[str, str]]) -> None:
    owners: dict[str, str] = {}
    for row in units:
        if row["state"] not in MUTATING_STATES:
            continue
        for target in split_ids(row["mutable_targets"]):
            if target in owners:
                raise ValueError(f"active mutable-target collision: {target} ({owners[target]}, {row['unit_id']})")
            owners[target] = row["unit_id"]


def _validate_retry_family(family: str, members: list[dict[str, str]]) -> None:
    attempts = sorted(int(row["attempt"]) for row in members)
    if len(attempts) != len(set(attempts)):
        raise ValueError(f"duplicate attempt in failure family: {family}")
    if attempts != list(range(1, max(attempts) + 1)):
        raise ValueError(f"non-contiguous attempts in failure family: {family}")
    if any(int(row["max_attempts"]) > 3 for row in members):
        raise ValueError(f"failure family exceeds three-attempt ceiling: {family}")
    by_attempt = {int(row["attempt"]): row for row in members}
    for attempt in attempts[1:]:
        current = by_attempt[attempt]
        previous = by_attempt[attempt - 1]
        if current["supersedes"] != previous["unit_id"]:
            raise ValueError(f"retry does not supersede prior attempt in family: {family}")
        if previous["state"] not in {"failed", "abandoned"}:
            raise ValueError(f"retry began before prior attempt terminated: {family}")


def _validate_unit_relationships(units: list[dict[str, str]]) -> None:
    """Validate global relationships after every individual unit has passed."""
    graph = {row["unit_id"]: split_ids(row["depends_on"]) for row in units}
    cycle = find_cycle(graph)
    if cycle:
        raise ValueError(f"dependency cycle: {' -> '.join(cycle)}")
    _validate_target_owners(units)
    families: dict[str, list[dict[str, str]]] = {}
    for row in units:
        families.setdefault(row["failure_family"], []).append(row)
    for family, members in families.items():
        _validate_retry_family(family, members)


def _validate_ledger_rows(ledger: list[dict[str, str]], unit_set: set[str]) -> None:
    for row in ledger:
        if row["unit_id"] not in unit_set:
            raise ValueError(f"ledger references unknown unit: {row['unit_id']}")
        if row["verdict"] not in VERDICTS:
            raise ValueError(f"unknown ledger verdict for {row['unit_id']}: {row['verdict']}")
        if row["verdict"] in ACCEPTED_VERDICTS and not row["evidence_path"]:
            raise ValueError(f"accepted verdict lacks evidence_path: {row['unit_id']}")


def _verdict_history(ledger: list[dict[str, str]]) -> tuple[dict[tuple[str, str, str], dict[str, str]], set[tuple[str, str, str]]]:
    """Retain the latest verdict and whether its exact identity was ever accepted."""
    latest_verdicts: dict[tuple[str, str, str], dict[str, str]] = {}
    accepted_verdict_keys: set[tuple[str, str, str]] = set()
    for row in ledger:
        key = (row["unit_id"], row["artifact_key"], row["head_sha"])
        latest_verdicts[key] = row
        if row["verdict"] in ACCEPTED_VERDICTS:
            accepted_verdict_keys.add(key)
    return latest_verdicts, accepted_verdict_keys


def _validate_accepted_verdict(unit: dict[str, str], latest_verdicts: dict[tuple[str, str, str], dict[str, str]], accepted_verdict_keys: set[tuple[str, str, str]]) -> None:
    current = [
        row for row in latest_verdicts.values()
        if row["unit_id"] == unit["unit_id"]
        and (not unit["head_sha"] or row["head_sha"] == unit["head_sha"])
    ]
    matching = [row for row in current if row["verdict"] in ACCEPTED_VERDICTS]
    if not matching:
        raise ValueError(f"accepted unit lacks matching accepted verdict: {unit['unit_id']}")
    negative = [
        row for row in current
        if row["verdict"] not in ACCEPTED_VERDICTS
        and (row["unit_id"], row["artifact_key"], row["head_sha"])
        in accepted_verdict_keys
    ]
    if negative:
        raise ValueError(f"accepted unit has a current negative verdict: {unit['unit_id']}")


def _validate_accepted_units(units: list[dict[str, str]], ledger: list[dict[str, str]]) -> None:
    latest_verdicts, accepted_verdict_keys = _verdict_history(ledger)
    for unit in units:
        if unit["state"] not in {"passed", "complete"}:
            continue
        _validate_accepted_verdict(unit, latest_verdicts, accepted_verdict_keys)


def _validate_decisions(decisions: list[dict[str, str]], unit_set: set[str]) -> None:
    _validate_identifiers(decisions, "decision_id")
    for row in decisions:
        if row["unit_id"] and row["unit_id"] not in unit_set:
            raise ValueError(f"decision references unknown unit: {row['unit_id']}")


def validate(run: Path, *, prefer_root: bool = False) -> tuple[list[dict[str, str]], list[dict[str, str]], list[dict[str, str]], bool]:
    """Check snapshot integrity and semantics in their original fail-fast order."""
    _validate_required_files(run)
    manifest = read_manifest(run)
    data_root = _validation_data_root(run, manifest, prefer_root)
    unit_header, units = read_tsv(data_root / UNITS_FILE, [UNIT_HEADER, V1_UNIT_HEADER])
    _, ledger = read_tsv(data_root / LEDGER_FILE, [LEDGER_HEADER])
    _, decisions = read_tsv(data_root / DECISIONS_FILE, [DECISION_HEADER])
    is_v2 = unit_header == UNIT_HEADER
    if is_v2:
        _validate_manifest_revision(manifest, data_root)

    unit_ids = _validate_identifiers(units, "unit_id")
    unit_map = {row["unit_id"]: row for row in units}
    for row in units:
        _validate_unit_state(row)
        if is_v2:
            _validate_attempt_bounds(row)
            _validate_unit_dependencies(row, unit_map)
            _validate_superseded_unit(row, unit_map)
    if is_v2:
        _validate_unit_relationships(units)

    unit_set = set(unit_ids)
    _validate_ledger_rows(ledger, unit_set)
    _validate_accepted_units(units, ledger)
    _validate_decisions(decisions, unit_set)
    return units, ledger, decisions, is_v2


def migrate_store(args: argparse.Namespace) -> None:
    run = Path(args.run).expanduser().resolve()
    with lock_store(run):
        header, rows = read_tsv(run / UNITS_FILE, [UNIT_HEADER, V1_UNIT_HEADER])
        if header == UNIT_HEADER:
            print(f"already schema v2: {run}")
            return
        with tempfile.TemporaryDirectory(dir=run.parent) as temp:
            staged = Path(temp) / run.name
            stage_store(run, staged)
            migrated = []
            now = utc_now()
            for row in rows:
                migrated.append({
                    **row, "revision": "1", "depends_on": "",
                    "mutable_targets": row["target"], "failure_family": row["unit_id"],
                    "attempt": "1", "max_attempts": "3", "supersedes": "",
                })
            write_tsv(staged / UNITS_FILE, UNIT_HEADER, migrated)
            write_tsv(staged / EVENTS_FILE, EVENT_HEADER, ({
                "event_id": f"migration-{index:04d}", "unit_id": row["unit_id"],
                "unit_revision": "1", "recorded_at": now, "event": "migrated-v1",
                "evidence": row["evidence_path"], "notes": "Imported without changing historical verdicts",
            } for index, row in enumerate(migrated, start=1)))
            write_manifest(staged, {
                "schema_version": 2, "run_id": run.name, "title": run.name,
                "revision": len(migrated), "created_at": now, "updated_at": now,
            })
            validate(staged, prefer_root=True)
            commit_staged(run, staged, (UNITS_FILE, EVENTS_FILE, MANIFEST_FILE))
    print(f"migrated to schema v2: {run}")


def add_unit(args: argparse.Namespace) -> None:
    run = Path(args.run).expanduser().resolve()
    with lock_store(run):
        units, _, _, is_v2 = validate(run)
        if not is_v2:
            raise ValueError("run store must be migrated before adding revisioned units")
        if any(row["unit_id"] == args.unit_id for row in units):
            raise ValueError(f"unit already exists: {args.unit_id}")
        now = utc_now()
        row = {
            "unit_id": args.unit_id, "track": args.track, "owner_thread": args.owner_thread,
            "host": args.host, "target": args.target, "state": args.state,
            "deliverable": args.deliverable, "evidence_path": args.evidence_path,
            "head_sha": args.head_sha, "updated_at": now, "blocker": args.blocker,
            "revision": "1", "depends_on": args.depends_on,
            "mutable_targets": args.mutable_targets or args.target,
            "failure_family": args.failure_family or args.unit_id,
            "attempt": str(args.attempt), "max_attempts": str(args.max_attempts),
            "supersedes": args.supersedes,
        }
        units.append(row)
        with tempfile.TemporaryDirectory(dir=run.parent) as temp:
            staged = Path(temp) / run.name
            stage_store(run, staged)
            write_tsv(staged / UNITS_FILE, UNIT_HEADER, units)
            append_event(staged, row, "unit-added", args.evidence_path, "")
            bump_manifest(staged)
            validate(staged, prefer_root=True)
            commit_staged(run, staged, (UNITS_FILE, EVENTS_FILE, MANIFEST_FILE))
    print(args.unit_id)


def append_event(run: Path, unit: dict[str, str], event: str, evidence: str, notes: str) -> None:
    manifest = read_manifest(run) or {}
    event_number = int(manifest.get("revision", 0)) + 1
    append_tsv(run / EVENTS_FILE, EVENT_HEADER, {
        "event_id": f"event-{event_number:06d}", "unit_id": unit["unit_id"],
        "unit_revision": unit["revision"], "recorded_at": utc_now(), "event": event,
        "evidence": evidence, "notes": notes,
    })


def bump_manifest(run: Path) -> None:
    manifest = read_manifest(run)
    if not manifest:
        raise ValueError("missing manifest.json")
    manifest["revision"] = int(manifest.get("revision", 0)) + 1
    manifest["updated_at"] = utc_now()
    manifest.pop("snapshot_dir", None)
    manifest.pop("snapshot_hashes", None)
    write_manifest(run, manifest)


def _validate_owner_transfer(args: argparse.Namespace, unit: dict[str, str], decisions: list[dict[str, str]]) -> None:
    """Require the existing per-unit decision before changing its recorded owner."""
    owner_changes = args.owner_thread is not None and args.owner_thread != unit["owner_thread"]
    if owner_changes:
        matching_decision = next((
            row for row in decisions
            if row["decision_id"] == args.owner_transfer_decision
            and row["unit_id"] == args.unit_id
        ), None)
        if not matching_decision:
            raise ValueError("owner transfer requires a recorded decision for this unit")


def transition_unit(args: argparse.Namespace) -> None:
    run = Path(args.run).expanduser().resolve()
    with lock_store(run):
        units, _, decisions, is_v2 = validate(run)
        if not is_v2:
            raise ValueError("run store must be migrated before transitions")
        unit = next((row for row in units if row["unit_id"] == args.unit_id), None)
        if not unit:
            raise ValueError(f"unknown unit: {args.unit_id}")
        current_revision = int(unit["revision"])
        if current_revision != args.expected_revision:
            raise ValueError(f"stale revision for {args.unit_id}: expected {args.expected_revision}, current {current_revision}")
        if args.state not in TRANSITIONS[unit["state"]]:
            raise ValueError(f"invalid transition for {args.unit_id}: {unit['state']} -> {args.state}")
        if unit["state"] == "failed" and args.state == "ready":
            raise ValueError("failed attempts require a new superseding unit")
        _validate_owner_transfer(args, unit, decisions)
        unit["state"] = args.state
        unit["revision"] = str(current_revision + 1)
        unit["updated_at"] = utc_now()
        for field in ("owner_thread", "host", "head_sha", "evidence_path", "blocker"):
            value = getattr(args, field)
            if value is not None:
                unit[field] = value
        if args.increment_attempt:
            raise ValueError("attempts are immutable; add a new superseding unit")
        with tempfile.TemporaryDirectory(dir=run.parent) as temp:
            staged = Path(temp) / run.name
            stage_store(run, staged)
            write_tsv(staged / UNITS_FILE, UNIT_HEADER, units)
            append_event(staged, unit, f"transition:{args.state}", args.evidence_path or unit["evidence_path"], args.notes)
            bump_manifest(staged)
            validate(staged, prefer_root=True)
            commit_staged(run, staged, (UNITS_FILE, EVENTS_FILE, MANIFEST_FILE))
    print(f"{args.unit_id} revision {unit['revision']} state {args.state}")


def _invalidate_dependent(dependent: dict[str, str], unit_id: str) -> None:
    """Retain active ownership until stop acknowledgement; invalidate other work."""
    if dependent["state"] in MUTATING_STATES:
        dependent["state"] = "stopping"
    elif dependent["state"] in {"passed", "complete"}:
        dependent["state"] = "failed"
    else:
        dependent["state"] = "blocked"
    dependent["blocker"] = f"dependency invalidated: {unit_id}"
    dependent["revision"] = str(int(dependent["revision"]) + 1)
    dependent["updated_at"] = utc_now()


def _invalidate_dependents(units: list[dict[str, str]], unit_id: str) -> list[dict[str, str]]:
    """Propagate invalidation in store order, retaining the existing event order."""
    invalidated_dependents: list[dict[str, str]] = []
    invalidated = {unit_id}
    changed = True
    while changed:
        changed = False
        for dependent in units:
            if dependent["unit_id"] in invalidated:
                continue
            if not invalidated.intersection(split_ids(dependent["depends_on"])):
                continue
            if dependent["state"] in {"failed", "abandoned", "blocked"}:
                invalidated.add(dependent["unit_id"])
                continue
            _invalidate_dependent(dependent, unit_id)
            invalidated.add(dependent["unit_id"])
            invalidated_dependents.append(dependent)
            changed = True
    return invalidated_dependents


def _invalidate_accepted_unit(args: argparse.Namespace, unit: dict[str, str], units: list[dict[str, str]]) -> list[dict[str, str]]:
    """Apply only current-head negative verdicts to an already accepted unit."""
    matches_current_head = not unit["head_sha"] or args.head_sha == unit["head_sha"]
    if args.verdict not in ACCEPTED_VERDICTS and matches_current_head and unit["state"] in {"passed", "complete"}:
        unit["state"] = "failed"
        unit["revision"] = str(int(unit["revision"]) + 1)
        unit["updated_at"] = utc_now()
        return _invalidate_dependents(units, unit["unit_id"])
    return []


def record_verdict(args: argparse.Namespace) -> None:
    run = Path(args.run).expanduser().resolve()
    with lock_store(run):
        units, ledger, _, is_v2 = validate(run)
        if not is_v2:
            raise ValueError("run store must be migrated before recording verdicts")
        unit = next((row for row in units if row["unit_id"] == args.unit_id), None)
        if not unit:
            raise ValueError(f"unknown unit: {args.unit_id}")
        if args.verdict in ACCEPTED_VERDICTS and unit["head_sha"] and args.head_sha != unit["head_sha"]:
            raise ValueError(f"accepted verdict head does not match current unit: {args.unit_id}")
        row = {
            "unit_id": args.unit_id, "artifact_key": args.artifact_key,
            "head_sha": args.head_sha, "verdict": args.verdict,
            "verifier": args.verifier, "evidence_path": args.evidence_path,
            "checked_at": utc_now(), "notes": args.notes,
        }
        ledger.append(row)
        invalidated_dependents = _invalidate_accepted_unit(args, unit, units)
        with tempfile.TemporaryDirectory(dir=run.parent) as temp:
            staged = Path(temp) / run.name
            stage_store(run, staged)
            write_tsv(staged / UNITS_FILE, UNIT_HEADER, units)
            write_tsv(staged / LEDGER_FILE, LEDGER_HEADER, ledger)
            append_event(staged, unit, f"verdict:{args.verdict}", args.evidence_path, args.notes)
            bump_manifest(staged)
            for dependent in invalidated_dependents:
                append_event(
                    staged,
                    dependent,
                    "dependency-invalidated",
                    args.evidence_path,
                    f"dependency invalidated by {args.unit_id}",
                )
                bump_manifest(staged)
            validate(staged, prefer_root=True)
            commit_staged(run, staged, (UNITS_FILE, LEDGER_FILE, EVENTS_FILE, MANIFEST_FILE))
    print(f"{args.unit_id} verdict {args.verdict}")


def record_decision(args: argparse.Namespace) -> None:
    run = Path(args.run).expanduser().resolve()
    with lock_store(run):
        units, _, decisions, is_v2 = validate(run)
        if not is_v2:
            raise ValueError("run store must be migrated before recording decisions")
        if any(row["decision_id"] == args.decision_id for row in decisions):
            raise ValueError(f"decision already exists: {args.decision_id}")
        unit = next((row for row in units if row["unit_id"] == args.unit_id), None) if args.unit_id else None
        if args.unit_id and not unit:
            raise ValueError(f"unknown unit: {args.unit_id}")
        row = {
            "decision_id": args.decision_id, "unit_id": args.unit_id,
            "decided_at": utc_now(), "decision": args.decision,
            "evidence": args.evidence, "consequence": args.consequence,
        }
        decisions.append(row)
        event_unit = unit or {"unit_id": "", "revision": "0"}
        with tempfile.TemporaryDirectory(dir=run.parent) as temp:
            staged = Path(temp) / run.name
            stage_store(run, staged)
            write_tsv(staged / DECISIONS_FILE, DECISION_HEADER, decisions)
            append_event(staged, event_unit, "decision", args.evidence, args.decision)
            bump_manifest(staged)
            validate(staged, prefer_root=True)
            commit_staged(run, staged, (DECISIONS_FILE, EVENTS_FILE, MANIFEST_FILE))
    print(args.decision_id)


def check_store(args: argparse.Namespace) -> None:
    run = Path(args.run).expanduser().resolve()
    with lock_store(run, exclusive=False):
        units, ledger, decisions, is_v2 = validate(run)
    version = "v2" if is_v2 else "v1; migrate recommended"
    print(f"valid run store ({version}): {len(units)} units, {len(ledger)} verdicts, {len(decisions)} decisions")


def export_store(args: argparse.Namespace) -> None:
    run = Path(args.run).expanduser().resolve()
    with lock_store(run, exclusive=False):
        units, ledger, decisions, is_v2 = validate(run)
        manifest = read_manifest(run) or {}
        payload = {
            "schemaVersion": 2 if is_v2 else 1,
            "manifest": manifest,
            "units": units,
            "ledger": ledger,
            "decisions": decisions,
        }
    print(json.dumps(payload, indent=2, sort_keys=True))


def render_status(args: argparse.Namespace) -> None:
    run = Path(args.run).expanduser().resolve()
    with lock_store(run):
        units, ledger, decisions, is_v2 = validate(run)
        manifest = read_manifest(run) or {"revision": "legacy"}
    counts = dict.fromkeys(sorted(UNIT_STATES), 0)
    for row in units:
        counts[row["state"]] += 1
    active = [row for row in units if row["state"] not in TERMINAL_STATES]
    blocked = [row for row in units if row["state"] == "blocked"]
    lines = [
        f"# {run.name}", "",
        f"Generated from run-store revision {manifest.get('revision', 'legacy')} at {utc_now()}.", "",
        "## Counts", "", f"- Units: {len(units)}",
        f"- Terminal: {sum(counts[s] for s in TERMINAL_STATES)}",
        f"- Active: {len(active)}", f"- Verification rows: {len(ledger)}",
        f"- Decisions: {len(decisions)}", f"- Schema: {'v2' if is_v2 else 'v1'}", "",
        "## Active units", "",
    ]
    if active:
        lines.extend(
            f"- {row['unit_id']}: {row['state']} — {row['deliverable']} "
            f"(owner {row['owner_thread'] or 'unassigned'}, host {row['host'] or 'unassigned'}, target {row['target']})"
            for row in active
        )
    else:
        lines.append("None.")
    lines.extend(["", "## Blockers", ""])
    if blocked:
        lines.extend(f"- {row['unit_id']}: {row['blocker']}" for row in blocked)
    else:
        lines.append("None.")
    (run / STATUS_FILE).write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(run / STATUS_FILE)


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser()
    sub = result.add_subparsers(dest="command", required=True)
    init = sub.add_parser("init")
    init.add_argument("--root", required=True)
    init.add_argument("--run-id", required=True)
    init.add_argument("--title", required=True)
    init.set_defaults(func=init_store)
    migrate = sub.add_parser("migrate")
    migrate.add_argument("--run", required=True)
    migrate.set_defaults(func=migrate_store)
    add = sub.add_parser("add")
    add.add_argument("--run", required=True)
    add.add_argument("--unit-id", required=True)
    add.add_argument("--track", required=True)
    add.add_argument("--owner-thread", required=True)
    add.add_argument("--host", required=True)
    add.add_argument("--target", required=True)
    add.add_argument("--state", choices=["planned", "blocked"], default="planned")
    add.add_argument("--deliverable", required=True)
    add.add_argument("--evidence-path", default="")
    add.add_argument("--head-sha", default="")
    add.add_argument("--blocker", default="")
    add.add_argument("--depends-on", default="")
    add.add_argument("--mutable-targets", default="")
    add.add_argument("--failure-family", default="")
    add.add_argument("--attempt", type=int, default=1)
    add.add_argument("--max-attempts", type=int, default=3)
    add.add_argument("--supersedes", default="")
    add.set_defaults(func=add_unit)
    transition = sub.add_parser("transition")
    transition.add_argument("--run", required=True)
    transition.add_argument("--unit-id", required=True)
    transition.add_argument("--expected-revision", type=int, required=True)
    transition.add_argument("--state", choices=sorted(UNIT_STATES), required=True)
    transition.add_argument("--owner-thread")
    transition.add_argument("--host")
    transition.add_argument("--head-sha")
    transition.add_argument("--evidence-path")
    transition.add_argument("--blocker")
    transition.add_argument("--notes", default="")
    transition.add_argument("--increment-attempt", action="store_true")
    transition.add_argument("--owner-transfer-decision", default="")
    transition.set_defaults(func=transition_unit)
    verdict = sub.add_parser("verdict")
    verdict.add_argument("--run", required=True)
    verdict.add_argument("--unit-id", required=True)
    verdict.add_argument("--artifact-key", required=True)
    verdict.add_argument("--head-sha", default="")
    verdict.add_argument("--verdict", choices=sorted(VERDICTS), required=True)
    verdict.add_argument("--verifier", required=True)
    verdict.add_argument("--evidence-path", required=True)
    verdict.add_argument("--notes", default="")
    verdict.set_defaults(func=record_verdict)
    decision = sub.add_parser("decision")
    decision.add_argument("--run", required=True)
    decision.add_argument("--decision-id", required=True)
    decision.add_argument("--unit-id", default="")
    decision.add_argument("--decision", required=True)
    decision.add_argument("--evidence", required=True)
    decision.add_argument("--consequence", required=True)
    decision.set_defaults(func=record_decision)
    check = sub.add_parser("check")
    check.add_argument("--run", required=True)
    check.set_defaults(func=check_store)
    export = sub.add_parser("export")
    export.add_argument("--run", required=True)
    export.set_defaults(func=export_store)
    status = sub.add_parser("status")
    status.add_argument("--run", required=True)
    status.set_defaults(func=render_status)
    return result


def main() -> int:
    try:
        args = parser().parse_args()
        args.func(args)
        return 0
    except (OSError, ValueError) as error:
        print(f"run-store error: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
