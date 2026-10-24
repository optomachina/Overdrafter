#!/usr/bin/env python3
"""Validate retained lifecycle evidence locally; never access Windows or run CAD."""
import hashlib
import json
from pathlib import Path
import re
import subprocess

HERE = Path(__file__).resolve().parent
REPO = HERE.parent.parent
EXPECTED_PACKET_HASH = "c837074fcf02b747c320af8c638cd0d5738177134333b12ff78b840a4d976810"
EXPECTED_COMPILER_HASH = "46809206887326d2d24db1eff1f3064de972c3451abe766b49111450a5e08e00"


def sha(data):
    return hashlib.sha256(data).hexdigest()


def read(name):
    return json.loads((HERE / name).read_text(encoding="utf-8-sig"))


def main():
    checks = []

    def check(name, predicate, provenance="local_receipt_consistency"):
        try:
            passed = bool(predicate())
            error = None
        except (KeyError, TypeError, ValueError, IndexError, OSError, subprocess.CalledProcessError) as exc:
            passed = False
            error = str(exc)
        row = {"name": name, "passed": passed, "provenance": provenance}
        if error is not None:
            row["error"] = error
        checks.append(row)

    raw = (HERE / "complete-receipt.json").read_bytes()
    receipt = json.loads(raw.decode("utf-8-sig"))
    source = read("readiness-source-packet.json")
    held = read("held-run-receipt.json")
    live = json.loads(receipt["rawLifecycleReceipts"]["live"])
    stale = json.loads(receipt["rawLifecycleReceipts"]["stale"])
    observations = live["observations"]
    terminal = [json.loads(o["stdout"]) for o in observations]
    head = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=REPO, text=True).strip()

    check("complete_packet_original_byte_count_and_digest", lambda:
          len(raw) == 28836 and sha(raw) == EXPECTED_PACKET_HASH, "independent_local_byte_hash")
    check("embedded_receipt_hashes_with_utf8_bom", lambda: all(
        sha(b"\xef\xbb\xbf" + text.encode("utf-8")) == receipt["rawLifecycleReceiptSHA256"][name]
        for name, text in receipt["rawLifecycleReceipts"].items()), "independent_reconstruction_hash")
    check("source_names_and_reported_hashes_agree", lambda:
          receipt["sourceHashes"] == source["hashes"]
          and set(source["files"]) == set(source["hashes"]) and len(source["hashes"]) == 3
          and receipt["allSourceHashesUnchanged"] is True)
    for name, digest in source["hashes"].items():
        check("source_packet_bytes:" + name, lambda name=name, digest=digest:
              sha(source["files"][name].encode("utf-8")) == digest, "independent_local_byte_hash")
        check("local_file_and_git_blob:" + name, lambda name=name, digest=digest:
              sha((REPO / "scripts/native" / name).read_bytes()) == digest
              and sha(subprocess.check_output(["git", "show", head + ":scripts/native/" + name], cwd=REPO)) == digest,
              "independent_local_git_blob_hash")
    check("runtime_commit_label_stays_unknown", lambda:
          live["sourceCommit"] is None and stale["sourceCommit"] is None)
    check("copied_execution_sources_match", lambda:
          {s["name"]: s["sha256"] for s in live["sourceHashes"]}
          == {Path(n).name: h for n, h in source["hashes"].items()})
    check("compiler_pin_and_success", lambda:
          live["compiler"]["sha256"] == EXPECTED_COMPILER_HASH
          and live["compiler"]["version"].startswith("4.8.9221.0")
          and live["compile"]["exitCode"] == 0 and live["compile"]["error"] is None
          and live["compile"]["timedOut"] is False)
    check("binary_digest_is_well_formed_claim", lambda:
          re.fullmatch(r"[0-9a-f]{64}", live["binarySha256"]) is not None)
    check("default_off_denies_without_lifecycle_receipt", lambda:
          receipt["wrappers"]["off"]["exitCode"] == 1
          and "Default-off:" in receipt["wrappers"]["off"]["stderr"]
          and receipt["wrappers"]["off"]["stdout"] == ""
          and "off" not in receipt["rawLifecycleReceipts"])
    check("stale_identity_rejects_before_compiler_and_api", lambda:
          receipt["wrappers"]["stale"]["exitCode"] == 2
          and stale["outcome"] == "failed" and stale["stage"] == "preflight"
          and stale["error"] == "old session changed"
          and stale["observations"] == [] and stale["sourceHashes"] == []
          and all(stale[k] is None for k in ["compiler", "compile", "binarySha256", "nativeExit"])
          and stale["nativeStarted"] is False and stale["nativeStartAttempted"] is False
          and int(stale["caller"]["expectedOldTicks"]) == int(stale["old"]["ticks"]) + 1)
    check("held_run_remains_not_started", lambda:
          held["liveStarted"] is False and held["staleReceipt"]["observations"] == []
          and held["nativeAfter"]["dotnet"] == receipt["beforeLive"]["dotnet"]
          and held["nativeAfter"]["cim"] == receipt["beforeLive"]["cim"])
    check("original_identity_matches_fresh_observation", lambda:
          len(receipt["beforeLive"]["dotnet"]) == len(receipt["beforeLive"]["cim"]) == 1
          and all(live["old"][k] == receipt["beforeLive"]["dotnet"][0][k]
                  for k in ["pid", "ticks", "session", "path"])
          and live["caller"]["expectedOldPid"] == live["old"]["pid"]
          and live["caller"]["expectedOldTicks"] == live["old"]["ticks"])
    check("live_wrapper_and_native_exits_are_successful", lambda:
          receipt["wrappers"]["live"]["exitCode"] == 0
          and live["outcome"] == "passed" and live["error"] is None
          and live["nativeStartAttempted"] is True and live["nativeStarted"] is True
          and live["oldExit"] == live["nativeExit"] == 0
          and live["nativeHasExited"] is True and live["recovery_required"] is False)
    check("new_native_identity_is_distinct_and_retained", lambda:
          live["nativePid"] == live["native"]["pid"] != live["old"]["pid"]
          and live["native"]["ticks"] != live["old"]["ticks"]
          and live["native"]["session"] == live["old"]["session"] == 1
          and live["native"]["path"] == live["old"]["path"])
    check("ten_helpers_have_matching_terminal_receipts", lambda:
          len(observations) == len({o["pid"] for o in observations}) == 10
          and all(o["pid"] == d["helperPid"] and o["error"] is None
                  for o, d in zip(observations, terminal)))
    check("exactly_six_not_ready_then_ready_and_close", lambda:
          [d["outcome"] for d in terminal] == ["passed", "passed"] + ["not_ready"] * 6 + ["passed", "passed"]
          and [o["exitCode"] for o in observations] == [0, 0] + [3] * 6 + [0, 0])
    check("not_ready_preserves_unknown_api_and_document_state", lambda: all(
        d["mode"] == "inspect" and d["stage"] == "bind_existing"
        and d["hresult"] == "0x800401E3" and d["exitAppRequested"] is False
        and "apiPid" not in d and "documentCount" not in d
        for d in terminal[2:8]))
    check("successful_api_binding_and_empty_state", lambda: all(
        d["apiPid"] == d["expectedPid"] and d["revision"] == "30.5.0"
        and d["startupCompleted"] is True and d["documentCount"] == 0
        and "error" not in d and "releaseError" not in d
        for d in terminal if d["outcome"] == "passed"))
    check("old_and_new_probe_identity_sequences_match", lambda: all(
        d["expectedPid"] == identity["pid"] and d["expectedTicks"] == identity["ticks"]
        and d["session"] == identity["session"]
        for sequence, identity in [(terminal[:2], live["old"]), (terminal[2:], live["native"])]
        for d in sequence))
    check("only_two_empty_session_graceful_exit_requests", lambda:
          [d["exitAppRequested"] for d in terminal] == [False, True] + [False] * 7 + [True]
          and all(terminal[i]["mode"] == "graceful-close-empty"
                  and terminal[i]["stage"] == "exit_app_returned" for i in [1, 9]))
    check("no_observed_forced_termination_or_timeout", lambda: all(
        r[k] is False for r in list(receipt["wrappers"].values()) + observations + [live["compile"]]
        for k in ["timedOut", "terminationRequested", "terminated"]))
    check("native_sources_have_no_forced_kill_or_file_open_calls", lambda: all(
        re.search(r"\.Kill\s*\(|\bStop-Process\b|\.OpenDoc\w*\s*\(", source["files"][n]) is None
        for n in ["session-lifecycle/lifecycle.ps1", "session-lifecycle/NativeSessionProbe.cs"]),
        "bounded_source_pattern_check_not_general_effect_proof")
    check("final_independent_native_inventories_empty", lambda:
          receipt["nativeAfter"]["dotnet"] == receipt["nativeAfter"]["cim"] == [])
    check("fixture_identities_preserved_across_reported_observations", lambda:
          receipt["fixtures"] == held["fixtures"] and len(receipt["fixtures"]) == 2)
    check("effective_policy_and_scopes_unchanged", lambda:
          receipt["policy"] == receipt["readiness"]["policy"] == held["policy"] == "RemoteSigned"
          and receipt["scopes"] == receipt["readiness"]["scopes"] == held["scopes"])
    check("qualification_remains_incomplete", lambda:
          live["qualification"] == stale["qualification"] == "incomplete")

    failed = [c["name"] for c in checks if not c["passed"]]
    result = {
        "kind": "independent_local_native_lifecycle_evidence_validation",
        "status": "consistent" if not failed else "inconsistent",
        "counts": {"passed": len(checks) - len(failed), "failed": len(failed)},
        "qualification": "incomplete", "releaseEligible": False,
        "localGitSourceCorrelation": head, "runtimeCommitLabel": live["sourceCommit"],
        "completeReceipt": {"bytes": len(raw), "sha256": sha(raw)}, "checks": checks,
        "limits": [
            "The complete local receipt bytes and local source/Git blobs were independently hashed; Windows native binaries, fixtures, process observations and policy were not independently remeasured.",
            "Inner lifecycle digests match reconstruction with the UTF-8 BOM used by the reported Windows files; this is not separate access to their original Windows paths.",
            "Runtime sourceCommit remains null; matching Git blobs provide later local source correlation, not runtime Git attestation.",
            "No-effects denial means no native compiler/API/start/close effects shown by the bounded receipt and source path; wrappers and stale-attempt diagnostic files still exist.",
            "Intermediate stderr journal records retain provisional outcome failed; terminal stdout and actual helper exit classify passed versus not_ready.",
            "Normal ExitApp requests and zero native exit codes establish this reported empty-session lifecycle only; forced-kill recovery, interrupted CAD saves, isolation and production release remain unproven."
        ]
    }
    (HERE / "native-lifecycle-validation.json").write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps({"status": result["status"], "counts": result["counts"], "failed": failed}))
    return bool(failed)


if __name__ == "__main__":
    raise SystemExit(main())
