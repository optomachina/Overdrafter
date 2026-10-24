#!/usr/bin/env python3
"""Check immutable local evidence; never open Windows paths or execute CAD."""
import datetime
import hashlib
import json
import math
from pathlib import Path, PureWindowsPath
import re
import subprocess

HERE = Path(__file__).resolve().parent
REPO = HERE.parent.parent
COMMIT = "939a1b9d318ebedb3d10c3949ca03e139df6c3af"
BASELINE = "e4ff1efb9ead3efd44ad24262dee670bee7de82a894ea0a0d998a58a3fd8b8aa"
PACKET = "a73d62181df3e9c85714efa16f28e6f83c41f93a21c37fb3d0ff16d64f771762"


def sha(value):
    return hashlib.sha256(value).hexdigest()


def utc_ticks(value):
    whole, fraction = value.rstrip("Z").split(".")
    dt = datetime.datetime.strptime(whole, "%Y-%m-%dT%H:%M:%S")
    delta = dt - datetime.datetime(1, 1, 1)
    return (delta.days * 86400 + delta.seconds) * 10000000 + int(fraction.ljust(7, "0"))


def main():
    checks = []

    def check(name, predicate, provenance="reported_evidence_consistency"):
        try:
            passed = bool(predicate())
            error = None
        except (KeyError, TypeError, ValueError, IndexError, OSError, subprocess.CalledProcessError) as exc:
            passed, error = False, str(exc)
        row = {"name": name, "passed": passed, "provenance": provenance}
        if error is not None:
            row["error"] = error
        checks.append(row)

    original = (HERE / "live-complete-receipt.json").read_bytes()
    packet = json.loads(original.decode("utf-8-sig"))
    inert = json.loads((HERE / "compile-inert-receipt.json").read_text(encoding="utf-8-sig"))
    supervisor = packet["supervisor"]
    artifacts = {a["path"]: a for a in packet["artifacts"]}
    raw_records = {r["path"]: r for r in packet["rawRecords"]}
    raw_by_name = {str(PureWindowsPath(p).relative_to(PureWindowsPath(supervisor["outer"]["stdout"].strip()).parent)): r
                   for p, r in raw_records.items()}

    def record(name):
        return json.loads(raw_by_name[name]["rawText"])

    lifecycle = record("lifecycle-result.json")
    interrupted, recovery = lifecycle["attempts"]
    checkpoint = record("interrupted\\pre-interrupt.json")
    terminal = [json.loads(o["stdout"]) for o in lifecycle["observations"]]
    code = {s["path"]: subprocess.check_output(["git", "show", COMMIT + ":scripts/native/" + s["path"]], cwd=REPO)
            for s in supervisor["sources"]}

    check("original_packet_size_and_sha256", lambda:
          len(original) == 193397 and sha(original) == PACKET, "independent_local_byte_hash")
    check("artifact_and_raw_record_inventory_sizes", lambda:
          len(packet["artifacts"]) == len(artifacts) == 43
          and len(packet["rawRecords"]) == len(raw_records) == 34
          and set(raw_records).issubset(artifacts))
    for path, row in raw_records.items():
        def raw_check(path=path, row=row):
            data = row["rawText"].encode("utf-8")
            if row["utf8Bom"] == "239,187,191":
                data = b"\xef\xbb\xbf" + data
            return (len(data) == row["bytes"] == artifacts[path]["bytes"]
                    and sha(data) == row["sha256"] == artifacts[path]["sha256"]
                    and ",".join(str(byte) for byte in data[:3]) == row["utf8Bom"])
        check("reconstruct:" + str(PureWindowsPath(path).relative_to(PureWindowsPath(supervisor["outer"]["stdout"].strip()).parent)),
              raw_check, "independent_embedded_record_reconstruction_hash")
    check("all_artifact_digest_claims_well_formed", lambda: all(
        re.fullmatch(r"[0-9a-f]{64}", a["sha256"]) and isinstance(a["bytes"], int) and a["bytes"] >= 0
        for a in artifacts.values()))
    check("live_commit_identity", lambda: supervisor["sourceCommit"] == lifecycle["sourceCommit"] == COMMIT)
    check("six_distinct_source_names", lambda: len(code) == len(supervisor["sources"]) == 6)
    for source in supervisor["sources"]:
        def source_check(source=source):
            path, expected = source["path"], source["sha256"]
            artifact = next(a for a in artifacts.values() if PureWindowsPath(a["path"]).name == Path(path).name)
            return (sha(code[path]) == sha((REPO / "scripts/native" / path).read_bytes()) == expected == artifact["sha256"]
                    and len(code[path]) == source["bytes"] == artifact["bytes"])
        check("source_local_git_and_manifest:" + source["path"], source_check, "independent_local_source_and_git_hash")
    check("lifecycle_checkpoint_source_bindings", lambda:
          {s["name"]: s["sha256"] for s in lifecycle["sourceHashes"]}
          == {Path(s["path"]).name: s["sha256"] for s in supervisor["sources"]}
          and checkpoint["sourceHashes"] == lifecycle["sourceHashes"])
    check("compiler_and_interop_pins", lambda:
          lifecycle["compiler"]["sha256"] == "46809206887326d2d24db1eff1f3064de972c3451abe766b49111450a5e08e00"
          and lifecycle["compiler"]["version"].startswith("4.8.9221.0")
          and any(p["sha256"] == "9284fcfb569b3e7e906e7c8d1f551e6d073f79500ba78e32c6464a53571813f0"
                  and p["version"] == "30.5.0.49" for p in supervisor["pins"]))
    check("binary_digest_link_is_reported_only", lambda:
          lifecycle["binarySha256"] == checkpoint["binarySha256"]
          == next(a["sha256"] for a in artifacts.values() if PureWindowsPath(a["path"]).name == "NativeSessionProbe.exe"))
    check("supervisor_and_compile_success", lambda: all(
        r["exitCode"] == 0 and r["error"] is None and r["timedOut"] is False
        and r["terminationRequested"] is False and r["terminated"] is False
        for r in [supervisor["outer"], lifecycle["compile"]]) and supervisor["error"] is None)
    check("no_preexisting_native_and_unchanged_policy_originals", lambda:
          supervisor["before"] == supervisor["after"]
          and supervisor["before"]["cim"] == supervisor["before"]["dotnet"] == []
          and lifecycle["sourcesBefore"] == lifecycle["sourcesAfter"])
    check("distinct_attempts_processes_and_private_copies", lambda:
          interrupted["role"] == "interrupted" and recovery["role"] == "recovery"
          and interrupted["id"] != recovery["id"] and interrupted["directory"] != recovery["directory"]
          and interrupted["input"]["path"] != recovery["input"]["path"]
          and interrupted["native"]["pid"] != recovery["native"]["pid"]
          and int(interrupted["native"]["ticks"]) < int(recovery["native"]["ticks"])
          and interrupted["native"]["session"] == recovery["native"]["session"] == 1)
    for attempt in [interrupted, recovery]:
        role = attempt["role"]
        def attempt_check(attempt=attempt, role=role):
            manifest = record(role + "\\input.json")
            saved = record(role + "\\attempt-result.json")
            link = raw_by_name[role + "\\attempt-result.json"]
            copied = next(a for a in artifacts.values() if a["path"] == attempt["input"]["path"])
            expected_saved = dict(attempt, resultSha256=None)
            return (attempt["input"] == attempt["inputAfter"] == manifest["input"]
                    and attempt["input"]["sha256"] == manifest["baseline"]["sha256"] == copied["sha256"] == BASELINE
                    and attempt["input"]["bytes"] == manifest["baseline"]["bytes"] == copied["bytes"] == 56144
                    and manifest["baseline"] == lifecycle["sourcesBefore"][0]
                    and attempt["input"]["path"] != manifest["baseline"]["path"]
                    and PureWindowsPath(attempt["input"]["path"]).parent == PureWindowsPath(attempt["directory"])
                    and manifest["id"] == attempt["id"] and manifest["role"] == role
                    and attempt["inputManifestSha256"] == raw_by_name[role + "\\input.json"]["sha256"]
                    and saved == expected_saved and attempt["resultSha256"] == link["sha256"])
        check("attempt_input_and_finalization_links:" + role, attempt_check)
    check("checkpoint_pins_exact_verified_observation", lambda:
          checkpoint["attempt"] == interrupted["id"] and checkpoint["native"] == interrupted["native"]
          and checkpoint["inputManifestSha256"] == interrupted["inputManifestSha256"]
          and checkpoint["observation"] == record("before-interrupt.stdout.txt")
          and interrupted["checkpointSha256"] == raw_by_name["interrupted\\pre-interrupt.json"]["sha256"]
          and checkpoint["interruptedSaveRecovery"] is False
          and checkpoint["action"] == "interrupt_retained_native_process")
    check("checkpoint_chronology_and_observed_terminal_states", lambda:
          utc_ticks(record("interrupted-open.stdout.txt")["utc"]) < utc_ticks(checkpoint["observation"]["utc"])
          < utc_ticks(checkpoint["utc"]) < int(recovery["native"]["ticks"])
          < utc_ticks(record("recovery-open.stdout.txt")["utc"])
          < utc_ticks(record("recovery-close-fixture.stdout.txt")["utc"])
          < utc_ticks(record("recovery-close-native.stdout.txt")["utc"])
          and interrupted["terminationRequested"] is True and interrupted["exitCode"] == -1
          and interrupted["outcome"] == "interrupted"
          and recovery["terminationRequested"] is False and recovery["exitCode"] == 0)
    sequence = code["session-lifecycle/InterruptionCase.ps1"].decode()
    check("executed_source_waits_for_interrupted_exit_before_recovery", lambda:
          sequence.index("$Attempt.checkpointSha256 = Write-ImmutableRecord") < sequence.index("$native.Kill()")
          < sequence.index("$native.WaitForExit(30000)") < sequence.index("Assert-NoNative 'Native process remains after interruption.'")
          < sequence.index("$Attempt.outcome = 'interrupted'")
          and sequence.index("Interrupt-FixtureAttempt $active") < sequence.index("$active = $r.attempts[1]"),
          "source_order_correlated_with_reported_exit_not_independent_kill_timestamp")
    check("helper_observations_are_complete_and_not_killed", lambda:
          len(terminal) == len(lifecycle["observations"]) == 13
          and all(o["pid"] == d["helperPid"] and o["error"] is None
                  and all(o[k] is False for k in ["timedOut", "terminationRequested", "terminated"])
                  and o["exitCode"] == (3 if d["outcome"] == "not_ready" else 0)
                  for o, d in zip(lifecycle["observations"], terminal)))
    check("helper_native_bindings_and_readiness", lambda: all(
        d["expectedPid"] == attempt["native"]["pid"] and d["expectedTicks"] == attempt["native"]["ticks"]
        and d["session"] == 1 and (
            d["outcome"] == "not_ready" and d["mode"] == "inspect" and d["hresult"] == "0x800401E3"
            or d["outcome"] == "passed" and d["apiPid"] == d["expectedPid"]
            and d["revision"] == "30.5.0" and d["startupCompleted"] is True)
        for rows, attempt in [(terminal[:6], interrupted), (terminal[6:], recovery)] for d in rows))

    common = {"sole_document", "same_document_identity", "exact_part_path", "readonly", "only_default_configuration",
              "no_active_sketch", "dependency_array", "no_dependencies", "no_feature_cycle", "feature_bound",
              "unique_extrusion", "extrusion_definition", "body_counts", "finite_mass_properties",
              "extrusion_semantics", "native_rebuild", "geometry", "input_bytes_hash", "verified_bytes_hash"}
    geometry = []
    for name, attempt, before, after in [("interrupted-open.stdout.txt", interrupted, 0, 1),
                                       ("before-interrupt.stdout.txt", interrupted, 1, 1),
                                       ("recovery-open.stdout.txt", recovery, 0, 1),
                                       ("recovery-close-fixture.stdout.txt", recovery, 1, 0)]:
        data = record(name)
        fixture = data["fixture"]
        measurement = fixture["measurements"]
        check("mandatory_fixture_predicates:" + name, lambda f=fixture, a=attempt, b=before, e=after:
              common.issubset(f["checks"]) and all(v is True for v in f["checks"].values())
              and f["outcome"] == "passed" and f["verified"] is True and f["readOnly"] is True
              and f["releaseErrors"] == [] and f["path"] == f["requestedPath"] == a["input"]["path"]
              and f["configurationCount"] == 1 and f["configuration"] == "Default" and f["dependencyEntries"] == 0
              and f["documentCountBefore"] == b and f["documentCountAfter"] == e
              and f["sha256"] == BASELINE and f["bytes"] == 56144)
        def geometry_check(m=measurement, name=name):
            mass = m["massProperties"]
            expected = {"depthM": .005, "volumeM3": math.pi * .010 * .010 * .005,
                        "areaM2": 2 * math.pi * .010 * (.010 + .005)}
            errors = {key: abs(m[key] - value) for key, value in expected.items()}
            center_error = [abs(a - b) for a, b in zip(m["centerM"], [0, 0, .0025])]
            geometry.append({"phase": name, "absoluteErrors": errors, "centerAbsoluteErrorsM": center_error})
            return (len(mass) >= 12 and all(math.isfinite(v) for v in mass)
                    and m["centerM"] == mass[:3] and m["volumeM3"] == mass[3] and m["areaM2"] == mass[4]
                    and len(center_error) == 3 and all(e <= 1e-8 for e in center_error)
                    and errors["depthM"] <= 1e-10 and errors["volumeM3"] <= 1e-10 and errors["areaM2"] <= 1e-9
                    and m["isBase"] is True and m["isThin"] is False and m["bothDirections"] is False
                    and m["endCondition"] == m["fromType"] == m["featureError"] == m["sheetBodies"] == 0
                    and m["reverseDirection"] is False and m["rebuild"] is True and m["featureWarning"] is False
                    and m["solidBodies"] == 1 and m["testDensity"] == 1)
        check("analytic_geometry_and_native_semantics:" + name, geometry_check, "independent_analytic_comparison_of_reported_measurements")
    check("strict_readonly_opens", lambda: all(record(n)["fixture"][k] == value
          for n in ["interrupted-open.stdout.txt", "recovery-open.stdout.txt"]
          for k, value in {"openRequested": True, "closeRequested": False, "openErrors": 0, "openWarnings": 0, "openOptions": 3}.items()))
    check("final_fixture_and_native_close", lambda:
          record("recovery-close-fixture.stdout.txt")["fixture"]["checks"]["closed_empty"] is True
          and record("recovery-close-native.stdout.txt")["documentCount"] == 0
          and record("recovery-close-native.stdout.txt")["exitAppRequested"] is True
          and lifecycle["nativeExit"] == 0 and lifecycle["nativeHasExited"] is True
          and lifecycle["native"] == recovery["native"] and lifecycle["outcome"] == "passed"
          and lifecycle["error"] is None and lifecycle["recovery_required"] is False
          and supervisor["after"]["cim"] == supervisor["after"]["dotnet"] == [])
    reset = code["session-lifecycle/lifecycle.ps1"].decode().split("function Start-NativeProcess", 1)[1]
    check("metadata_reset_sentinel_report_and_source_order", lambda:
          supervisor["resetTest"] is True
          and reset.index("$r.nativeStarted = $false; $r.nativeExit = $null") < reset.index("Assert-NoNative")
          and reset.index("$r.native = $null; $r.nativePid = $null") < reset.index("Assert-NoNative"),
          "executor_reported_sentinel_and_independent_source_order_check")
    check("historical_inert_commit_not_mislabeled_as_live_head", lambda:
          inert["sourceCommit"] != COMMIT and inert["sourceCommit"] == "5bd7bb7630074bd363711d5b064c6197c02b47d5"
          and inert["outcome"] == "passed" and inert["compile"]["exitCode"] == 0
          and inert["beforeAfterEqual"] is True and inert["before"] == inert["after"]
          and [c["child"]["exitCode"] for c in inert["cases"]] == [1, 2, 2, 2]
          and all(c["passed"] is True for c in inert["cases"]))
    check("historical_inert_sources_match_their_git_commit", lambda: all(
        sha(subprocess.check_output(["git", "show", inert["sourceCommit"] + ":scripts/native/" + s["path"]], cwd=REPO)) == s["sha256"]
        for s in inert["sources"]), "independent_historical_git_blob_hash")
    check("full_qualification_stays_incomplete", lambda:
          lifecycle["qualification"] == "incomplete" and lifecycle["interruptionRecovery"] == "passed_single_readonly_fixture")
    failed = [c["name"] for c in checks if not c["passed"]]
    result = {"kind": "local_controlled_native_interruption_evidence_validation",
              "status": "consistent" if not failed else "inconsistent",
              "counts": {"passed": len(checks) - len(failed), "failed": len(failed)},
              "sourceCommit": COMMIT, "packet": {"bytes": len(original), "sha256": sha(original)},
              "checks": checks, "geometryComparisons": geometry,
              "qualification": "incomplete", "releaseEligible": False,
              "limits": [
                  "Original local packet bytes, 34 reconstructed text records and six Git/source artifacts were independently hashed. Native executable and two private SLDPRT contents remain remote digest claims.",
                  "Geometry and exact numeric center comparisons use reported measurements; native/API activity, file persistence and policy were not independently re-executed or observed locally.",
                  "Checkpoint time precedes recovery-process creation. Exact kill/exit timestamps are not separately recorded; kill/wait-before-recovery order is supported by pinned executed source and terminal attempt records.",
                  "Attempt-result self-digests are null inside their own immutable snapshots; the final lifecycle record supplies their verified reconstruction digests.",
                  "The metadata-reset sentinel is reported true with matching reset-before-admission source order; separate sentinel inputs/outputs are not embedded.",
                  "Historical inert checks belong to 5bd7bb76. The live controlled interruption belongs to 939a1b9d; histories are not relabeled.",
                  "One controlled idle read-only synthetic interruption does not establish interrupted-save recovery, arbitrary crash recovery, worker leases, filesystem isolation or release authority."
              ]}
    (HERE / "interruption-validation.json").write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps({"status": result["status"], "counts": result["counts"], "failed": failed}))
    return bool(failed)


if __name__ == "__main__":
    raise SystemExit(main())
