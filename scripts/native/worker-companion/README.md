# Windows companion session client

OVD-500 supplies protected local session state and outbound HTTPS for the
OVD-499 gateway. `run.ps1` is default-off and requires 64-bit Windows PowerShell
5.1. It registers a fresh process boot, then reports session eligibility. It
cannot enable itself, claim a task, launch CAD, upload a file or publish a design.

## Connection and restart

Use only the worker identity, HTTPS gateway and single-use code from the reviewed
activation flow. No active production endpoint or credential is included here.
Read the code into a SecureString; do not put raw codes/tokens in command lines,
environment variables, transcripts or logs.

```powershell
$code = Read-Host 'Approved pairing code' -AsSecureString
.\scripts\native\worker-companion\run.ps1 -Connect `
  -WorkerId $approvedWorkerId -GatewayUrl $approvedGatewayUrl -PairingCode $code
```

Subsequent starts use the same worker/gateway without `-PairingCode`. An existing
credential cannot be replaced by supplying another code. The owner enables the
new boot through the authenticated application. The companion reports only
filtered status changes, polls every five seconds, and stops on pause, expiry,
boot mismatch or error. Its standalone transport loop has an eight-hour maximum
from process startup; `-MaxPolls` can shorten a qualification run. No native work
is started or terminated by this loop.

A new process first reconciles any pending pairing/boot request, then registers
its own fresh boot. It never inherits the old process's enabled grant. Current
revision is read before creating a new boot request. A definite
`worker_conflict/not_applied` allows one bounded refresh; an unknown outcome
retains the original body, revision, key and token for exact replay.

## Credential storage

State is confined to `%LOCALAPPDATA%\OverDrafter\Worker\<workerId>`. Dedicated
directories and files are created with protected current-user ACLs; unexpected
ownership/ACLs and reparse paths are refused. One retained file handle prevents
concurrent clients for that state directory. Existing missing or corrupt state
requires reconciliation rather than silent token regeneration.

The entire state, including an unresolved pairing code, is encrypted with
CurrentUser DPAPI and worker-bound entropy before the first request. Writes use
an exclusive temporary file, flush, atomic replace/move, then decrypt/readback.
A failed write retains its encrypted files. A pairing code disappears from state
only after the pairing receipt can be saved. The database preserves transition
history; this local file is the current recovery journal.

The Windows ACL-at-creation APIs follow Microsoft's
[DirectoryInfo.Create documentation](https://learn.microsoft.com/en-us/dotnet/api/system.io.directoryinfo.create?view=netframework-4.8.1)
and [FileStream constructor documentation](https://learn.microsoft.com/en-us/dotnet/api/system.io.filestream.-ctor?view=netframework-4.8.1).
Their presence in the API contract does not establish that this implementation
has passed actual Windows qualification. Current-user storage is not a sandbox
against other processes already running as that user or an administrator.

## Transport and failure boundary

HTTPS is pinned to the stored endpoint and exact gateway path. Redirects,
cookies, proxy routing and automatic decompression are disabled. Requests are
limited to 8,192 bytes, responses to 32,768 bytes and UTF-8 JSON, with a five-second
cancellation deadline covering headers and body reads. A stalled read cannot
extend the caller's wait by ignoring cancellation.

Mutation and status receipts must match expected worker, installation, boot,
revision and schema. Raw backend messages and transport exceptions are not
printed. Abort is not proof that a remote mutation rolled back; uncertain
requests remain encrypted for replay. Status eligibility is not task ownership
or permission to modify authoritative files.

## Verification

Portable, inert tests (PowerShell Core on Mac/Linux or Windows PowerShell):

```powershell
pwsh -NoProfile -File scripts/native/worker-companion/test-state.ps1
pwsh -NoProfile -File scripts/native/worker-companion/test-boundaries.ps1
```

These use generated in-memory credentials and fake transport/persistence. They
cover persistence before sending, lost replies/receipt saves, fresh boot after
restart, confirmed-conflict limits, malformed/corrupt fields, response byte and
encoding limits, uncooperative stream cancellation and actual default-off
launcher refusal. They perform no network or disk credential operations.
PowerShell Core date conversion is disabled explicitly to preserve the Windows
5.1 wire representation. Run `npm run verify` for normal repository gates.

The separately admitted Windows storage qualification command is:

```powershell
powershell.exe -NoProfile -File scripts/native/worker-companion/qualify-store.ps1 -Qualify
```

It creates a new synthetic worker directory and retains ciphertext. It tests
same-user DPAPI roundtrip, protected ACLs, exclusion of another file handle,
atomic replacement, tampered ciphertext, wrong-worker entropy and reopening.
It uses no endpoint or actual paired credential. It does not test another user
account, actual hosted HTTPS, eight hours of runtime, or native process isolation.

Capture the direct `-File` process exit and structured JSON result together. A
wrapper's zero exit alone is not a passing qualification. Failures report the
completed assertion count and structural exception metadata, never state or raw
exception text. Retain the failed attempt before running corrected source.

The initial Windows run passed the state and boundary suites but exposed an
atomic replacement failure. Replacement now uses PowerShell's
[NullString](https://learn.microsoft.com/en-us/dotnet/api/system.management.automation.language.nullstring)
for the optional .NET backup path; ordinary `$null` is coerced to an empty string.
The corrected storage source still requires the complete Windows qualification.

Windows PowerShell 5.1/DPAPI and hosted HTTPS have **not yet been qualified** for
this source. Run the approved Windows cases and inspect receipts before
activation. No source test or parser result substitutes for that evidence.

## Remaining milestone work

The owner pairing/enablement UI, task claims and leases, native worker integration,
immutable file transport/finalization, cumulative native proof, interpretation
and connected CAD workspace remain required. Activation stays default-off until
those gates and the spending/rate controls pass. Rollback stops new connection
admission and retains encrypted state; it does not establish native process exit.
