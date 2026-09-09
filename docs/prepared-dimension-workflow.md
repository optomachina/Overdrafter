# Internal prepared-dimension workflow

This is the first connected engineering-workflow increment from the approved
control-plane plan. It uses the existing synthetic two-part assembly on
Workstation and SolidWorks 2022. It is internal development tooling; it does
not promote the customer CAD pilot or change the Part-to-Quote release.

The workflow is split across OVD-489 (captured context and request/result
records), OVD-490 (native operation), and OVD-491 (local review workspace).
These are separately reviewed implementation pieces of one user outcome:
import context, record a dimension request, execute a private candidate, and
inspect its measured result.

OVD-492 adds bounded dimension interpretation, OVD-493 adds the separate STEP
preview-export experiment, and OVD-494 connects conversation and CAD comparison.
The internal page now places requests, clarification questions and explicit
decision cards beside the assembly view. The interpreter recognizes a closed
set of prepared-dimension phrases; it does not call an inference provider or
claim general engineering reasoning.

## First transport

The browser and Workstation exchange explicitly selected JSON files. The
browser does not dispatch or monitor CAD. Downloading a request leaves it
waiting for a result; it does not create a running task or prove execution.
The operator runs the exact request on Workstation and imports its result.
Automatic Windows connectivity remains a separate integration.

Start the local internal page from a development checkout:

```sh
VITE_ENABLE_ENGINEERING_WORKBENCH=1 \
VITE_SUPABASE_URL=http://127.0.0.1:9 \
VITE_SUPABASE_PUBLISHABLE_KEY=internal-synthetic-demo \
npm run dev -- --host 127.0.0.1 --port 4186
```

Open `http://127.0.0.1:4186/dev/engineering`. The inert backend values above
keep this local demonstration separate from a configured backend. The page
requires a development build, explicit opt-in and a loopback hostname; it is
absent from production bundles and customer navigation.

1. Capture context on Workstation using the [native adapter](../scripts/native/prepared-dimension/README.md).
2. Open **Workbench tools** and import that exact context JSON. A matching
   baseline STEP preview can be imported separately through **Import CAD preview**.
3. Send a request such as “Make it thicker.” The assistant asks for the target
   depth; “8” requires a units answer. “8 mm” or “Set the depth to 8 mm” produces
   a proposal. Select **Evaluate this change** to save the request, or cancel or
   revise the proposal. Sending a message does not accept a decision or run CAD.
4. Download the selected request JSON and run the explicit native command from
   the adapter README with that request and the original context.
5. Import the returned `result.json` to inspect measurements and all required
   checks. Import its separately exported, matching candidate STEP preview to
   use **Before** and **After**. A requested depth alone never changes displayed
   geometry. Refresh revalidates saved requests, evidence and preview bytes.

Reset removes the local browser workbench after explicit confirmation; native
files and retained Workstation attempt directories are separate.

Native files stay on Workstation. The context file records their exact byte
identities, the one supported configuration and the prepared depth binding.
The browser verifies the internal record format and its relationship to the
known prepared package. That validation does not measure the native files or
authenticate the operator. The runner must recheck the actual source bytes
and native preconditions when it executes.

## Prepared envelope

- One `synthetic-assembly.SLDASM` with two fixed, resolved components, one
  `Default` configuration, no mates, subassemblies or drawings.
- The named `OVD_QualificationExtrusion` in `baseline-5mm-1` starts at 5 mm.
  The internal operation accepts a requested depth from 6 through 10 mm.
- The companion 8 mm cylinder stays unchanged at its 40 mm offset.
- Every request evaluates an independent private copy of the same baseline;
  requests are not cumulative edits or an integrated alternative.
- The first native demonstration must use 8 mm. One passing case does not
  establish a completion rate for the entire envelope.

Exact source identities and prior observed geometry are recorded in
[the native feasibility record](solidworks-2022-feasibility.md).

## Context, requests and evidence

The internal wire formats are `overdrafter.prepared-assembly.v1`,
`overdrafter.prepared-dimension-job.v1` and
`overdrafter.prepared-dimension-result.v1`.

Context identity is the SHA-256 of its exact UTF-8 JSON bytes. The request
contains the context digest, exact input files, scope, configuration, declared
operation, independent request/attempt identities and mandatory check set.
Its exported bytes have their own digest. A returned result must match those
identities; matching a requested depth alone is insufficient.

The workbench composes the existing engineering snapshot and accepted-decision
contracts. Its operator handoff records are separate from the durable worker
task/lease model. No lease, fence, dispatch permission or worker-start
observation is invented to make an imported result fit that model.

Up to five accepted requests can be recorded without waiting for CAD. Local
browser persistence stores exact context, request and receipt texts. Restore
revalidates their hashes and relationships and reconstructs state; persisted
status flags cannot make a result pass. A failed storage write must not appear
as a successfully queued decision. Identical receipt import is idempotent;
a contradictory second receipt is rejected.
The escaped saved representation has a 2 MB aggregate budget. A request or
receipt that would exceed it is rejected before replacing the prior state, so
every accepted workbench remains within the restore limit. Browser storage may
apply a smaller available quota, which the page must report without losing prior data.

Unconfirmed conversation messages and clarification/proposal state remain in
the current tab; they are not durable engineering decisions. Proposals bind to
the current context and baseline and are rechecked when confirmed. The bounded
interpreter requires one explicit supported target and millimeter units; it
rejects ambiguous values, additional operations, negation and conditional
instructions rather than dropping those parts of the request. There is no
simulated thinking or native progress stream.

Successful imported evidence requires every unique mandatory check to pass:
input identity, native integrity, requested dimension, assembly references,
component positions, save/reopen, and original-file preservation. It also
requires the complete candidate file manifest and consistent finite cylinder
measurements. The unchanged companion retains its exact bytes; changed
geometry does not have a predetermined output file hash.

A request-bound failure can preserve partial or changed input observations,
missing checks and unknown measurements. It remains failed. A malformed,
foreign or mismatched receipt is rejected without changing the saved request.
The workspace labels passing results as imported native evidence and retains
`Not adopted`. It supplies no release approval or authoritative CAD update.

## CAD preview evidence

The `overdrafter.prepared-step-preview.v1` bundle contains actual STEP exchange
bytes and their digest, the exact native source closure, configuration, export
provenance and translation limitations. A baseline preview binds to the context;
a candidate preview also binds to the exact successful request and result.
Import and refresh verify those relationships before passing the bytes to the
existing interactive STEP renderer. A completed request's geometry cannot stand
in for a different pending request. Missing or invalid geometry remains visible
as an unavailable preview.

Preview storage is separate from accepted requests: at most six exports within
a 4 MB saved representation, with a 3 MB bundle limit and 2 MB STEP limit. Failed
imports or writes keep previous evidence. A STEP view is a translation of native
CAD, not its editable feature history or an engineering release approval.
Consistency and hash checks do not authenticate imported provenance or prove
geometric equivalence independently of native export verification.

The [preview exporter experiment](../scripts/native/prepared-preview/README.md)
is a separate, opt-in Workstation operation. Its native qualification remains
pending until source compilation, real export, source preservation and normal
teardown evidence are captured. Unit fixtures or a working browser renderer do
not establish that qualification.

## Native operation and qualification

The runner must preserve the existing pinned process ownership and admission
rules. It opens only the private package, verifies resolved references before
editing, edits the private part while the assembly is closed, then saves,
reopens and checks the affected assembly. The original package is immutable.
Native ambiguity or unconfirmed effects stop the attempt and preserve its
evidence; there is no automatic broad process cleanup or blind retry.

Captured context, source compilation, native execution, browser presentation
and production qualification are distinct evidence. The native README gives
the exact invocation. The [observed browser-requested case](native-prepared-dimension-evidence.md)
changed the private baseline from 5 to 8 mm, passed all seven checks and was
imported into the workbench. That one real case does not qualify a customer pilot
or replace the broader operation and recovery corpus.

## Rollback and limits

There is no database migration or deployed service change. Removing the local
page and its opt-in withdraws the interface; removing the internal runner
withdraws the operation. Preserve local requests and native attempt directories
as evidence. No PDM revision, production worker or authoritative file is
changed by this workflow.

Customer-file admission, automatic transport, durable server-side task leases,
multi-user synchronization, broader CAD operations, native save interruption,
full worker isolation and legitimate licensed capacity remain incomplete.
