# Part upload statechart

Typical customer workflow for uploading a part model (CAD + optional drawing) and getting a draft job.
Derived from the current code, not a proposal:

- Client gating and selection: `src/components/chat/PromptComposer.tsx`, `src/features/quotes/file-validation.ts`
- Orchestration: `createJobsFromUploadFiles` / `uploadFilesToJob` in `src/features/quotes/api/uploads-api.ts`
- Export-control gate (OVD-723): `src/features/quotes/export-control.ts`

Notation: `[*]` start/end, `state { ... }` is a compound (nested) state, `--` separates parallel regions,
`<<choice>>` is a guard decision. Event names are on the arrows, `[guard]` is a condition.

```mermaid
stateDiagram-v2
    [*] --> Composer

    state "Composer" as Composer {
        [*] --> Idle
        Idle --> Selecting: pick or drop files
        Selecting --> Validating: FILES_ADDED

        state validate <<choice>>
        Validating --> validate
        validate --> Staged: [ext allowed, size 1B to 200MB]
        validate --> Rejected: [bad type, empty, over 200 MB]
        Rejected --> Staged: some files accepted
        Rejected --> Idle: none accepted

        Staged --> Selecting: add more files
        Staged --> Staged: remove chip / dedupe by SHA-256
        Staged --> Idle: clear
        Staged --> AccessCheck: SUBMIT [prompt or files, not already submitting]
        AccessCheck --> Idle: founding beta access denied
    }

    AccessCheck --> ExportGate

    state "Export-control gate (OVD-723)" as ExportGate {
        [*] --> Asking
        Asking --> Declared: answer = not_controlled
        Asking --> Blocked: controlled / unsure / dismissed
    }

    Blocked --> Staged: nothing uploaded, user can retry
    Declared --> Submitting

    state "Submitting" as Submitting {
        [*] --> Grouping
        Grouping --> Projecting: group files into parts (CAD + drawing stems)
        Projecting --> PartLoop: [more than 1 part] create project
        Grouping --> PartLoop: [1 part]

        state "Per part (sequential)" as PartLoop {
            [*] --> Hashing
            Hashing --> Preflight: SHA-256 per file
            Preflight --> DraftCreated: api_prepare_part_intake (hint only), createClientDraft
            DraftCreated --> FileLoop

            state "Per file" as FileLoop {
                [*] --> Prepare
                Prepare --> Skipped: duplicate in batch / duplicate_in_job
                Prepare --> Reused: status = reused
                Prepare --> Transfer: status = new, signed storage path
                Transfer --> Finalize: storage upload ok / object exists
                Finalize --> Uploaded
                Skipped --> [*]
                Reused --> [*]
                Uploaded --> [*]
            }

            FileLoop --> Reconciling: reconcileJobParts
            Reconciling --> ExtractionRequested: requestExtraction
            ExtractionRequested --> [*]
        }
    }

    Submitting --> Done: all parts finished
    Submitting --> Failed: RPC / storage / export-block error

    Failed --> Staged: toast error, files kept, user can retry
    Done --> Processing: navigate to job(s), composer cleared

    state "Server-side after upload" as Processing {
        [*] --> Extracting
        Extracting --> Ready: CAD preview + part fields extracted
        Extracting --> NeedsReview: low confidence / export markings found
        NeedsReview --> Ready: reviewed
    }

    Ready --> [*]
```

## Notes on design choices

- **Gate before bytes.** The export-control answer is resolved before any hashing or transfer; the server repeats the check in the upload RPCs and storage policy, so the client gate is UX, not the control.
- **Client dedupe is a hint.** Same-`File` duplicates drop immediately; metadata never drops a file; a SHA-256 match removes a chip, and a failed digest keeps the file. The worker verifies bytes before assigning a canonical version.
- **Double-submit guard.** `submitGuardRef` blocks a second submit while the access refetch is pending, before `isSubmitting` renders.
- **Failure leaves a partial job.** A failure mid-loop keeps the already-created drafts and uploaded files; the diagram's `Failed → Staged` edge is the UI recovery, not a rollback. If you want transactional behaviour that is a separate decision.
- **Not modelled:** the signed-out redirect, the manual quote evidence upload path (`uploadManualQuoteEvidence`), and post-extraction quoting states.
