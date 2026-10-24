#!/usr/bin/env python3
"""Check local receipt consistency, never execute CAD or verify Windows bytes.

Run with Python 3; an optional directory argument selects the evidence packet.
Writes packet-validation.json. Exit 1 means inconsistent/malformed evidence;
exit 0 includes an incomplete packet whose optional adverse receipt is pending.
"""

import json
import math
from pathlib import Path
import re
import sys


def validate(packet):
    checks = []
    inputs = []

    def check(name, predicate, detail=None):
        try:
            passed = bool(predicate())
        except (KeyError, TypeError, ValueError, IndexError, StopIteration) as error:
            passed = False
            detail = f"Missing or malformed evidence: {type(error).__name__}: {error}"
        result = {"name": name, "status": "pass" if passed else "fail"}
        if detail is not None:
            result["detail"] = detail
        checks.append(result)

    def read(path):
        inputs.append(str(path.relative_to(packet.parent)))
        try:
            record = json.loads(path.read_text(encoding="utf-8"),
                                parse_constant=lambda value: (_ for _ in ()).throw(
                                    ValueError(f"Non-finite JSON constant: {value}")))
            if not isinstance(record, dict):
                raise ValueError("Expected an object")
            check(f"parse:{path.name}", lambda: True)
            return record
        except (OSError, ValueError) as error:
            check(f"parse:{path.name}", lambda: False, str(error))
            return {}

    spec = read(packet / "assembly-inspection-case.json")
    preflight = read(packet / "assembly-template-preflight-01.json")
    first = read(packet / "assembly-inspection-01.json")
    initial = read(packet / "assembly-inspection-02.json")
    reopened = read(packet / "assembly-readback-03.json")
    geometry = read(packet.parent / "ovd-480-2026-09-08/native-dimension-case.json")
    records = [spec, preflight, first, initial, reopened, geometry]

    check("qualification_remains_incomplete", lambda: all(
        r.get("qualification") == "incomplete" for r in records[:5]))
    check("no_release_eligibility", lambda: all(
        r.get("releaseEligible") is False for r in [spec, initial, reopened, geometry]))
    check("case_identity_matches", lambda: all(
        r["caseId"] == spec["caseId"] for r in [first, initial, reopened]))
    check("preflight_unevaluated_fields_remain_unknown", lambda:
          preflight["documentCount"] is None and preflight["configuredTemplate"] is None
          and preflight["nativeApiIdentityObserved"] is False
          and preflight["helper"]["comCalls"] == 0
          and preflight["helper"]["mainBodyExecuted"] is False
          and preflight["helper"]["exitCode"] != 0)
    check("first_attempt_preserves_unexecuted_phases", lambda:
          first["observedOccurrences"] is None and first["observedTransforms"] is None
          and first["savedAssemblyExists"] is False
          and first["partialManifest"]["isSuccessfulAssemblyManifest"] is False
          and all(first["native"][key] is False for key in
                  ["partOpenAttempted", "componentInsertAttempted", "saveAttempted", "reopenAttempted"]))
    check("second_attempt_reopen_remains_unevaluated", lambda:
          all(initial["reopen"][key] is None for key in
              ["occurrences", "transforms", "referenceClosure", "readOnlyState"])
          and initial["reopen"]["callerAccepted"] is False)
    check("historical_failed_cleanup_remains_unknown", lambda:
          initial["cleanup"]["failed"] is True
          and initial["cleanup"]["finalDocumentCount"] is None
          and initial["partialManifest"]["fullSuccess"] is False
          and initial["helper"]["exitCode"] != 0)
    check("later_recovery_does_not_rewrite_history", lambda:
          reopened["recovery"]["initialDocumentCount"] == 3
          and reopened["recovery"]["allKnownPrivate"] is True
          and reopened["recovery"]["closedAssemblyFirst"] is True
          and reopened["recovery"]["finalDocumentCount"] == 0
          and reopened["cleanup"]["finalDocumentCount"] == 0
          and reopened["cleanup"]["primaryError"] is None
          and reopened["cleanup"]["cleanupError"] is None
          and reopened["helper"]["exitCode"] == 0)
    check("save_success_precedes_warning_rejection", lambda:
          all(initial["save"][key] is True for key in ["returned", "exactPath", "clean"])
          and initial["save"]["errors"] == 0 and initial["save"]["warnings"] == 0
          and initial["save"]["closedSessionCount"] == 0)
    check("load_warning_32_preserved_in_both_attempts", lambda: all(
        r["reopen"]["returnedDocument"] is True and r["reopen"]["errors"] == 0
        and r["reopen"]["warnings"] == 32
        and r["reopen"]["warningName"] == "swFileLoadWarning_NeedsRegen"
        and r["reopen"]["options"] == 67 for r in [initial, reopened]))
    check("readback_pass_is_after_readonly_full_rebuild", lambda:
          reopened["outcome"] == "verified_after_rebuild_with_load_warning_preserved"
          and reopened["reopen"]["readOnly"] is True
          and reopened["reopen"]["allowedWarningMask"] == 32
          and reopened["reopen"]["fullActiveConfigurationRebuild"] is True
          and reopened["reopen"]["assemblyRebuildCalls"] == 1
          and reopened["nativeFileSaves"] == 0 and reopened["nativeGeometryEdits"] == 0
          and all(o["observationPhase"] == "fresh_readback_after_rebuild"
                  for o in reopened["occurrences"]))

    role_paths = {"5mm_part": "parts/baseline-5mm.SLDPRT",
                  "8mm_part": "parts/candidate-8mm.SLDPRT"}
    expected_paths = set(role_paths.values())
    identity_fields = ["name", "path", "configuration", "underlyingConfiguration",
                       "virtual", "suppressionState", "fixed", "readOnly"]

    def occurrence_set(items):
        return {tuple(item[field] for field in identity_fields) for item in items}

    check("initial_and_readback_occurrence_sets_match", lambda:
          len(initial["initialOccurrences"]) == len(reopened["occurrences"]) == 2
          and len(occurrence_set(initial["initialOccurrences"])) == 2
          and occurrence_set(initial["initialOccurrences"]) == occurrence_set(reopened["occurrences"]))
    check("observed_configurations_match", lambda:
          initial["assemblyConfiguration"] == reopened["reopen"]["configuration"]
          and all(o["configuration"] == o["underlyingConfiguration"]
                  for o in initial["initialOccurrences"] + reopened["occurrences"]))
    check("reference_sets_match_exact_private_inventory", lambda:
          len(initial["initialDependencies"]) == len(reopened["dependencies"]) == 2
          and set(initial["initialDependencies"]) == set(reopened["dependencies"]) == expected_paths
          and all({o["path"] for o in items} == expected_paths for items in
                  [initial["initialOccurrences"], reopened["occurrences"]])
          and set(reopened["partDependencies"]) == expected_paths
          and all(value == [] for value in reopened["partDependencies"].values()))

    def finite_number(value):
        return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)

    def transform_matches(items, expected):
        occurrence = next(o for o in items if o["path"] == role_paths[expected["part"]])
        matrix = occurrence["transform"]
        tolerances = spec["tolerances"]
        return (len(matrix) == 16 and all(finite_number(v) for v in matrix)
                and len(expected["rotation"]) == 9 and len(expected["translationM"]) == 3
                and all(abs(a - b) <= tolerances["rotation"]
                        for a, b in zip(matrix[:9], expected["rotation"]))
                and all(abs(a - b) <= tolerances["translationM"]
                        for a, b in zip(matrix[9:12], expected["translationM"]))
                and abs(matrix[12] - expected["scale"]) <= tolerances["scale"]
                and occurrence["fixed"] is expected["fixed"]
                and occurrence["readOnly"] is True and occurrence["virtual"] is False
                and occurrence["suppressionState"] in [2, 3])

    check("transform_spec_covers_both_parts", lambda:
          len(spec["expectedTransforms"]) == 2
          and {e["part"] for e in spec["expectedTransforms"]} == set(role_paths))
    for phase, key, record in [("initial", "initialOccurrences", initial),
                                ("readback", "occurrences", reopened)]:
        for role in role_paths:
            check(f"transform:{phase}:{role}", lambda role=role, key=key, record=record:
                  transform_matches(record[key], next(e for e in spec["expectedTransforms"]
                                                      if e["part"] == role)))

    analytic_results = []
    check("analytic_recipe_units", lambda:
          all(geometry["geometry"][key]["unit"] == "mm" for key in
              ["diameter", "initialDepth", "candidateDepth"]))
    for path, depth_key in [(role_paths["5mm_part"], "initialDepth"),
                            (role_paths["8mm_part"], "candidateDepth")]:
        def analytic_check(path=path, depth_key=depth_key):
            measurement = next(m for m in reopened["partMeasurements"] if m["path"] == path)
            radius = geometry["geometry"]["diameter"]["value"] / 2000
            depth = geometry["geometry"][depth_key]["value"] / 1000
            expected = {"depthM": depth, "volumeM3": math.pi * radius * radius * depth,
                        "areaM2": 2 * math.pi * radius * (radius + depth)}
            errors = {key: abs(measurement[key] - value) for key, value in expected.items()}
            analytic_results.append({"path": path, "expected": expected, "absoluteErrors": errors})
            return all(finite_number(measurement[key])
                       and errors[key] <= geometry["tolerances"][key] for key in expected)
        check(f"analytic_depth_volume_area:{path}", analytic_check)
    check("center_evidence_remains_executor_reported", lambda:
          len(reopened["partMeasurements"]) == 2
          and all(m["centerEvidence"] == "executor_reported_approximate"
                  and "centerM" not in m for m in reopened["partMeasurements"]))

    def digests(record):
        values = []
        if isinstance(record, dict):
            for key, value in record.items():
                if key == "sha256":
                    values.append(value)
                elif key == "sourceHashes" and isinstance(value, dict):
                    values.extend(value.values())
                else:
                    values.extend(digests(value))
        elif isinstance(record, list):
            for value in record:
                values.extend(digests(value))
        return values

    check("structured_digest_syntax", lambda: all(
        isinstance(value, str) and re.fullmatch(r"[0-9a-f]{64}", value)
        for record in records for value in digests(record)))

    def unchanged_identities():
        by_role = {item["role"]: item for item in spec["inputs"]}
        comparisons = [(preflight["standardTemplate"], by_role["assembly_template"]),
                       (initial["save"], reopened["files"]["assembly"]),
                       (reopened["files"]["template"], by_role["assembly_template"]),
                       (reopened["files"]["baseline"], by_role["5mm_part"]),
                       (reopened["files"]["candidate"], by_role["8mm_part"])]
        return all(a["sha256"] == b["sha256"] and a["bytes"] == b["bytes"]
                   for a, b in comparisons) and initial["packagePath"] == reopened["packagePath"]

    check("reported_file_identities_unchanged_across_records", unchanged_identities)
    check("manifest_stage_finalization_caveat_preserved", lambda:
          "precedes its completion" in reopened["manifest"]["note"]
          and "final result.json reports pass" in reopened["manifest"]["note"])
    check("remote_evidence_not_local_native_proof", lambda:
          reopened["evidence"]["coordinatorIndependentlyRanCad"] is False
          and reopened["evidence"]["coordinatorHasNativeFiles"] is False)

    admission_path = packet / "file-admission-01.json"
    names = ["positive_control", "missing_part", "changed_bytes", "outside_root", "prefix_sibling"]
    if admission_path.exists():
        admission = read(admission_path)
        check("file_admission_scope_and_completion", lambda:
              admission["fileOnly"] is True and admission["nativeCalls"] == 0
              and admission["originalHashesUnchanged"] is True
              and admission["helper"]["exitCode"] == 0
              and admission["qualification"] == "incomplete"
              and isinstance(admission["outcome"], str) and bool(admission["outcome"])
              and isinstance(admission["receipt"], str) and bool(admission["receipt"]))
        check("file_admission_exact_case_set", lambda:
              len(admission["cases"]) == len(names)
              and {case["name"] for case in admission["cases"]} == set(names))
        for name in names:
            def admission_check(name=name):
                case = next(c for c in admission["cases"] if c["name"] == name)
                expected = "eligible" if name == "positive_control" else "rejected"
                reason_valid = case["reason"] is None if name == "positive_control" else (
                    isinstance(case["reason"], str) and bool(case["reason"].strip()))
                return case["observed"] == expected and case["nativeCalls"] == 0 and reason_valid
            check(f"file_admission:{name}", admission_check)
    else:
        for name in names:
            checks.append({"name": f"file_admission:{name}", "status": "pending",
                           "detail": "file-admission-01.json is absent; no result inferred."})

    counts = {status: sum(c["status"] == status for c in checks)
              for status in ["pass", "fail", "pending"]}
    if counts["fail"]:
        status = "failed"
    elif counts["pending"]:
        status = "incomplete"
    else:
        status = "consistent"
    result = {
        "kind": "local_receipt_consistency_validation", "status": status,
        "qualification": "incomplete", "releaseEligible": False,
        "inputs": inputs, "counts": counts, "checks": checks,
        "analyticRecomputation": analytic_results,
        "provenanceLimits": [
            "No CAD calls, native execution, Windows file access, or independent Windows byte/hash verification.",
            "Checks compare local sanitized executor records; matching digest strings establish reported identity consistency only.",
            "Depth, volume and area are recalculated from exact reported values and the declared cylinder recipe; centers remain executor-reported approximate acceptance.",
            "Transforms check rotation, translation and scale against specification; the final three array entries remain diagnostic.",
            "Readback is verified after a full active-configuration rebuild, with load warning 32 preserved and no save; this is not warning-free persisted rebuild state.",
            "Later recovery and final zero document count do not replace the failed earlier cleanup's unknown count or unevaluated reopen fields.",
            "The native manifest's own stage snapshot precedes finalization; final result.json completion is executor-reported, not proven by this local validator.",
            "One synthetic flat assembly and file-only admission fixtures do not qualify worker isolation, arbitrary assemblies, interrupted CAD recovery, or release authority."
        ]
    }
    (packet / "packet-validation.json").write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"status": status, "counts": counts, "qualification": "incomplete"}))
    return 1 if counts["fail"] else 0


if __name__ == "__main__":
    directory = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else Path(__file__).resolve().parent
    raise SystemExit(validate(directory))
