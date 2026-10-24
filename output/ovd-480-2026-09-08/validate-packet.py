"""Check local qualification receipts; does not execute CAD or hash Windows files."""
import hashlib
import json
import math
import re
from datetime import datetime, timezone
from pathlib import Path

PACKET = Path(__file__).resolve().parent
EXPECTED = {
    "api-probes.json", "cylinder-diagnostic-06.json", "geometry-diagnostics.json",
    "guard-tests.json", "native-dimension-01.json", "native-dimension-02.json",
    "native-dimension-03.json", "native-dimension-04.json", "native-dimension-case.json",
    "primitive-diagnostic-05.json", "save-close-01.json", "save-close-02.json",
    "save-close-preflight.json", "temporary-geometry-01.json", "workstation-inventory.json",
}
DATA = {f.name: json.loads(f.read_text()) for f in PACKET.glob("*.json")
        if f.name != "packet-validation.json"}
CHECKS = []


def check(name, condition):
    if not condition:
        raise AssertionError(name)
    CHECKS.append({"name": name, "outcome": "pass"})


check("all expected evidence JSON files parse", set(DATA) == EXPECTED)
for name, record in DATA.items():
    if "qualification" in record:
        status = record["qualification"]
        if isinstance(status, dict):
            status = status.get("state")
        check(name + " retains incomplete qualification", status == "incomplete")

initial = DATA["api-probes.json"]["attempts"][0]
check("failed identity call remains failed despite exit zero",
      initial["outcome"] == "failed" and initial["helperExitCode"] == 0
      and initial["helperExitDoesNotImplySuccess"])
box = DATA["temporary-geometry-01.json"]["result"]
check("first box failure has no successful measurements",
      box["status"] == "failed" and box["measurements"] == []
      and box["predicates"] == "not_evaluated")
for attempt in DATA["geometry-diagnostics.json"]["attempts"]:
    check(attempt["id"] + " has no successful measurement claim", attempt["measurements"] == [])
    if attempt.get("helperExitCodeKnown") is False:
        check(attempt["id"] + " unknown exit preserved", attempt["helperExitCode"] is None)
primitive = DATA["primitive-diagnostic-05.json"]
check("skipped cylinder and failed box have no measurements",
      not primitive["cylinderAttempted"] and primitive["cylinderMeasurements"] == []
      and primitive["boxMeasurements"] == [])

cylinder = DATA["cylinder-diagnostic-06.json"]
check("temporary cylinder legacy exit remains unknown",
      cylinder["helper"]["exitCode"] is None and not cylinder["helper"]["exitCodeKnown"])
radius = 0.01
height = 0.005
for key, expected in [
    ("volumeM3", math.pi * radius * radius * height),
    ("areaM2", 2 * math.pi * radius * radius + 2 * math.pi * radius * height),
]:
    value = cylinder["result"][key]
    check("temporary cylinder analytic " + key,
          math.isfinite(value) and abs(value - expected) <= cylinder["absoluteTolerance"][key])
check("temporary cylinder exact center components",
      len(cylinder["result"]["centerM"]) == 3 and all(
          math.isfinite(value) and abs(value - expected) <= cylinder["absoluteTolerance"]["centerM"]
          for value, expected in zip(cylinder["result"]["centerM"], [0, 0, height / 2])))

save1 = DATA["save-close-01.json"]
save2 = DATA["save-close-02.json"]
check("first save-close attempt did not mutate",
      not save1["helperLaunched"] and not save1["saveAttempted"] and not save1["closeAttempted"])
check("authorized save and close completed",
      save2["saveOutcome"] == "verified_preserved" and save2["saveErrors"] == save2["saveWarnings"] == 0
      and save2["documentCountBefore"] == 15 and save2["documentCountAfter"] == 0
      and save2["originalFilesUnchanged"] == 14 and save2["originalCadProcessRetained"])
check("save-close legacy exit remains unknown", save2["helper"]["exitCode"] is None)
n1, n2, n3 = (DATA[f"native-dimension-0{i}.json"] for i in [1, 2, 3])
check("native01 blank copy is not a 5mm fixture",
      not n1["nativeGeometryAttempted"] and not n1["partialArtifact"]["isActual5mmFixture"])
check("native02 was not measured or saved",
      not n2["depthAndGeometryVerified"] and not n2["saveAttempted"] and not n2["candidateFileExists"])
check("native03 was not measured or saved",
      n3["geometricMeasurements"] == [] and n3["postConstructionSolidCount"] is None
      and not n3["saveAttempted"] and not n3["candidateFileExists"])

native = DATA["native-dimension-04.json"]
spec = DATA["native-dimension-case.json"]
check("native04 uses exact preserved input",
      native["input"]["sha256"] == save2["recoveredPart"]["sha256"] == spec["input"]["sha256"])
check("native04 successful helper within elapsed limit",
      native["helper"]["exitCodeKnown"] and native["helper"]["exitCode"] == 0
      and native["helper"]["elapsedSeconds"] < native["helper"]["parentDeadlineSeconds"]
      and native["helper"]["automaticRetries"] == 0)
check("all four native04 phases present", [p["name"] for p in native["phases"]] == [
    "baseline_5mm", "candidate_before_edit_5mm", "candidate_8mm", "reopened_candidate_8mm"])
errors = []
for phase, depth in zip(native["phases"], [0.005, 0.005, 0.008, 0.008]):
    expected = {
        "depthM": depth,
        "volumeM3": math.pi * radius * radius * depth,
        "areaM2": 2 * math.pi * radius * radius + 2 * math.pi * radius * depth,
    }
    error = {key: abs(phase[key] - value) for key, value in expected.items()}
    check(phase["name"] + " analytic depth/volume/area",
          all(math.isfinite(phase[key]) and error[key] <= spec["tolerances"][key] for key in expected))
    check(phase["name"] + " executor native checks",
          phase["isBase"] and not phase["isThin"] and not phase["bothDirections"]
          and phase["forwardEndCondition"] == 0 and phase["rebuild"]
          and phase["featureErrorCode"] == 0 and not phase["featureWarning"]
          and phase["solidBodies"] == 1 and phase["sheetBodies"] == 0
          and phase["massPropertyValuesFinite"] == 12)
    check(phase["name"] + " center evidence remains qualified",
          not phase["centerPredicate"]["exactComponentsAvailableLocally"]
          and phase["centerPredicate"]["evidence"] == "remote_executor_report")
    errors.append({"phase": phase["name"], "absoluteErrors": error})
check("baseline and candidate save receipts pass", all(
    saved["returned"] and saved["errors"] == saved["warnings"] == 0
    and saved["exactPath"] and saved["cleanBeforeClose"] for saved in native["save"].values()))
check("candidate edit and read-only reopen receipts pass",
      native["change"]["accessSelections"] and native["change"]["modifyDefinition"]
      and native["change"]["definitionReacquired"] and native["reopen"]["readOnlyStateVerified"]
      and native["reopen"]["savedCandidateHashUnchanged"])
check("native04 cleanup and originals preserved",
      native["cleanup"]["initialDocumentCount"] == native["cleanup"]["finalDocumentCount"] == 0
      and native["cleanup"]["originalApplicationRetained"] and native["input"]["originalUnchanged"])
check("native04 is not release eligible",
      not native["releaseEligible"] and native["qualification"] == "incomplete")
check("reported native file digests well formed", all(
    re.fullmatch("[0-9a-f]{64}", native["files"][key]["sha256"])
    and native["files"][key]["finalHashUnchanged"] for key in ["baseline", "candidate"]))
check("source digests well formed", all(
    re.fullmatch("[0-9a-f]{64}", value) for value in native["sourceHashes"].values()))

report = {
    "validatedUtc": datetime.now(timezone.utc).isoformat(),
    "scope": "Local consistency of reported evidence; no independent native execution or Windows file hashing",
    "result": "pass", "jsonEvidenceFilesParsed": len(DATA), "checks": CHECKS,
    "native04AnalyticErrors": errors,
    "native04CenterCheck": "Executor-reported only; exact components unavailable in sanitized receipt",
    "qualification": "incomplete", "applicationSourceChanges": False, "databaseMigrations": False,
    "fullRepositoryVerificationRun": False,
    "fullRepositoryVerificationReason": "Evidence-only packet; native helper compilation and actual native workflow were separately executed on Workstation.",
}
(PACKET / "packet-validation.json").write_text(json.dumps(report, indent=2) + "\n")
files = sorted(f for f in PACKET.iterdir() if f.is_file() and f.name != "SHA256SUMS.txt")
manifest = "".join(hashlib.sha256(f.read_bytes()).hexdigest() + "  " + f.name + "\n" for f in files)
(PACKET / "SHA256SUMS.txt").write_text(manifest)
for line in manifest.splitlines():
    digest, name = line.split("  ", 1)
    if hashlib.sha256((PACKET / name).read_bytes()).hexdigest() != digest:
        raise AssertionError("Manifest mismatch: " + name)
print(json.dumps({
    "result": "pass", "jsonEvidenceFilesParsed": len(DATA), "consistencyChecks": len(CHECKS),
    "checksummedFiles": len(files), "native04AnalyticErrors": errors, "qualification": "incomplete"
}, indent=2))
