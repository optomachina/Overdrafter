- Repository file-admission tooling result: PASS, exactly ONE invocation of the supplied unchanged qualify.ps1 using 64-bit Windows PowerShell 5.1.26100.9278, -NoProfile -NonInteractive -File and fresh -OutputRoot; SourceCommit omitted/null. All three source files written UTF-8 without BOM/LF and matched supplied SHA256 before execution: SharedFilePredicates.cs ddf07e19823672a6fda7ad3a8dbff63755784528166d6b291a8afa144fb0acb7; FileAdmissionCases.cs 5d49f7076adfa7fe29025732de284d6d235436b6f2b76acaf5ac88004aaf02b4; qualify.ps1 15a8079003677f8db34a36f96079a16e1f104ac121518471449640780c6ca277. No source fixes/reformatting. Windows PowerShell5.1 AST parse returned ScriptBlockAst, errorCount0/errors[]. Parent observation UTC2026-09-08T20:05:37.5456413Z, qualifyPID21516, actual parent exit0/knowntrue, elapsed1.0472388s, no timeout under180s owned-process bound, stderr empty. Compiler/test children each exited0 without timeout/termination; all5 cases passed. No policy bypass, installation, COM/CAD calls, native/customer file access, CAD process selection or session change; no retry.
  Exact source directory: C:/Users/blain/Documents/Codex/2026-09-06/create-a-new-assembly-in-solidworks/outputs/ovd-480-repository-tooling/source-d95d46a1da0746849f80bf9dcdc27198. Exact fresh OutputRoot: C:/Users/blain/Documents/Codex/2026-09-06/create-a-new-assembly-in-solidworks/outputs/ovd-480-repository-tooling/attempts/run-d3bfc7cfef2b40cc9c8aad2765e5294a. Exact generated receipt: C:/Users/blain/Documents/Codex/2026-09-06/create-a-new-assembly-in-solidworks/outputs/ovd-480-repository-tooling/attempts/run-d3bfc7cfef2b40cc9c8aad2765e5294a/file-admission-8e4ef49fe4f848ddb9964d42293979f1/result.json; on-disk result.json SHA256 c3219c0b4b4a516c0a2b0676de618705262cd46a6f51a6d5cba2c1e787109495. Source directory retains orchestration.ps1, parent-result.json and qualify stdout/stderr; generated attempt retains copied exact sources, compiler/test logs, binary, fixtures and full receipt. Compiler C:/WINDOWS/Microsoft.NET/Framework64/v4.0.30319/csc.exe FileVersion4.8.9221.0 built by NET481REL1LAST_25H2, SHA25646809206887326d2d24db1eff1f3064de972c3451abe766b49111450a5e08e00; binarySHA2560d935190936ba9bba768a6232f3407e94d9f937811b228d83a482d29371e8308. Complete result.json content follows; no fields omitted (only rendering whitespace normalized):

```json
{
  "outcome": "passed",
  "fileOnly": true,
  "nativeCalls": 0,
  "qualification": "incomplete",
  "sourceCommit": null,
  "startedUtc": "2026-09-08T20:05:38.0185859Z",
  "sourceHashes": [
    {
      "sha256": "ddf07e19823672a6fda7ad3a8dbff63755784528166d6b291a8afa144fb0acb7",
      "name": "SharedFilePredicates.cs"
    },
    {
      "sha256": "5d49f7076adfa7fe29025732de284d6d235436b6f2b76acaf5ac88004aaf02b4",
      "name": "FileAdmissionCases.cs"
    },
    {
      "sha256": "15a8079003677f8db34a36f96079a16e1f104ac121518471449640780c6ca277",
      "name": "qualify.ps1"
    }
  ],
  "finishedUtc": "2026-09-08T20:05:38.7127640Z",
  "binarySha256": "0d935190936ba9bba768a6232f3407e94d9f937811b228d83a482d29371e8308",
  "compiler": {
    "path": "C:\\WINDOWS\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe",
    "sha256": "46809206887326d2d24db1eff1f3064de972c3451abe766b49111450a5e08e00",
    "version": "4.8.9221.0 built by: NET481REL1LAST_25H2"
  },
  "compile": {
    "pid": 21852,
    "exitCode": 0,
    "timedOut": false,
    "terminationRequested": false,
    "terminated": false,
    "elapsedSeconds": 0.2055318,
    "error": null,
    "stdout": "",
    "stderr": ""
  },
  "test": {
    "pid": 20132,
    "exitCode": 0,
    "timedOut": false,
    "terminationRequested": false,
    "terminated": false,
    "elapsedSeconds": 0.16255,
    "error": null,
    "stdout": "{\"outcome\":\"passed\",\"fileOnly\":true,\"nativeCalls\":0,\"sourceOriginalHashesUnchanged\":true,\"cases\":[{\"name\":\"positive_control\",\"observed\":\"eligible\",\"reason\":null,\"expectedPassed\":true,\"admissionContentReads\":1,\"setupHashReads\":1,\"nativeCalls\":0,\"error\":null},{\"name\":\"missing_part\",\"observed\":\"rejected\",\"reason\":\"missing_required_file\",\"expectedPassed\":true,\"admissionContentReads\":0,\"setupHashReads\":0,\"nativeCalls\":0,\"error\":null},{\"name\":\"changed_bytes\",\"observed\":\"rejected\",\"reason\":\"digest_mismatch\",\"expectedPassed\":true,\"admissionContentReads\":1,\"setupHashReads\":1,\"nativeCalls\":0,\"error\":null},{\"name\":\"outside_root\",\"observed\":\"rejected\",\"reason\":\"outside_allowed_root\",\"expectedPassed\":true,\"admissionContentReads\":0,\"setupHashReads\":1,\"nativeCalls\":0,\"error\":null},{\"name\":\"prefix_sibling\",\"observed\":\"rejected\",\"reason\":\"outside_allowed_root\",\"expectedPassed\":true,\"admissionContentReads\":0,\"setupHashReads\":1,\"nativeCalls\":0,\"error\":null}],\"sourceSetupHashReads\":1,\"integrityHashReads\":4,\"initialSetupByteReadbacks\":5,\"sameSizeSingleByteMutation\":true,\"naiveSiblingPrefix\":true,\"limits\":\"Synthetic lexical file predicates only; reparse points, races, native integration and isolation remain unproven.\"}\r\n",
    "stderr": ""
  },
  "cases": {
    "outcome": "passed",
    "fileOnly": true,
    "nativeCalls": 0,
    "sourceOriginalHashesUnchanged": true,
    "cases": [
      {
        "name": "positive_control",
        "observed": "eligible",
        "reason": null,
        "expectedPassed": true,
        "admissionContentReads": 1,
        "setupHashReads": 1,
        "nativeCalls": 0,
        "error": null
      },
      {
        "name": "missing_part",
        "observed": "rejected",
        "reason": "missing_required_file",
        "expectedPassed": true,
        "admissionContentReads": 0,
        "setupHashReads": 0,
        "nativeCalls": 0,
        "error": null
      },
      {
        "name": "changed_bytes",
        "observed": "rejected",
        "reason": "digest_mismatch",
        "expectedPassed": true,
        "admissionContentReads": 1,
        "setupHashReads": 1,
        "nativeCalls": 0,
        "error": null
      },
      {
        "name": "outside_root",
        "observed": "rejected",
        "reason": "outside_allowed_root",
        "expectedPassed": true,
        "admissionContentReads": 0,
        "setupHashReads": 1,
        "nativeCalls": 0,
        "error": null
      },
      {
        "name": "prefix_sibling",
        "observed": "rejected",
        "reason": "outside_allowed_root",
        "expectedPassed": true,
        "admissionContentReads": 0,
        "setupHashReads": 1,
        "nativeCalls": 0,
        "error": null
      }
    ],
    "sourceSetupHashReads": 1,
    "integrityHashReads": 4,
    "initialSetupByteReadbacks": 5,
    "sameSizeSingleByteMutation": true,
    "naiveSiblingPrefix": true,
    "limits": "Synthetic lexical file predicates only; reparse points, races, native integration and isolation remain unproven."
  },
  "error": null
}
```

  Synthetic file-predicate tooling evidence only; native integration/isolation, reparse points and races remain unproven. All prior receipts and root plan/status preserved.
