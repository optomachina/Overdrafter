# Next bounded OVD-480 / OVD-479 qualification case

Status: design note only. No further native operation was executed by PR #470.

## Intended evidence

Demonstrate one interrupted, owned SolidWorks process followed by a fresh process that reopens and verifies a private synthetic baseline. This is an interruption/reopen result for one fixture, not interrupted-save recovery or general worker qualification.

## Preconditions

- Capture a fresh Workstation process inventory; the completed lifecycle left no SolidWorks process, but that observation must not be reused as current admission.
- Reconfirm the pinned executable, interop identity and qualified lifecycle source. Preserve the existing native04 source files and all earlier attempts.
- Bind the synthetic 5 mm baseline by exact SHA256 e4ff1efb9ead3efd44ad24262dee670bee7de82a894ea0a0d998a58a3fd8b8aa and 56,144-byte size; create and hash a fresh private copy with file-admission checks.
- Design and review the interruption primitive before use: it must operate only on the actual retained Process handle directly started for the attempt, with fresh PID/creation-time/session/executable checks and matching CAD API PID. PID lookup alone must not authorize termination.
- Stop on unexpected documents, process inventory changes, ambiguous identity, unsupported source, or concurrent operator interaction.

## Single-case sequence

1. Directly start and retain a fresh native process with the proven lifecycle runner's bounded startup/readiness policy.
2. Open only the admitted private synthetic copy read-only; verify exact path, supported configuration and expected synthetic geometry. Preserve the opened-document and native identity observation.
3. Flush a structured checkpoint identifying the owned process and immutable input before the controlled interruption.
4. Terminate only that retained native process using the reviewed interruption primitive. Preserve the actual native exit and any helper outcomes; unknown exit or surviving process requires reconciliation and stops this case.
5. Capture native inventory and fixture hashes. Preserve the interrupted attempt without reusing its mutable session or attempt directory.
6. Start a separate fresh attempt and native process, reopen a new admitted private copy of the same baseline read-only, and repeat the required identity and geometry checks.
7. Close the document normally and observe native normal exit. Capture final independent inventories and original/copy fixture hashes.

## Acceptance conditions

- The interrupted process was actually started and retained by this attempt; the receipt distinguishes process termination from helper termination.
- No unowned native process was targeted. Original baseline/candidate fixture byte identities remain unchanged.
- The original attempt remains interrupted in history; the recovery attempt is separately identified and cannot rewrite its outcome.
- Reopened input identity and supported geometry checks pass in the new process. All mandatory checks and unknowns are shown individually.
- Failure, timeout, modal-dialog or identity ambiguity produces finite evidence and stops the case. No automatic second interruption or broad process cleanup.

## Excluded from the claim

Interrupted native saves, partially written candidate repair, assembly dependency closure, modal-dialog automation, process/profile/network isolation, PDM effects, durable task leases and legitimate capacity qualification remain separate work. Source and environment observations do not establish vendor-supported deployment or licensing entitlement.
