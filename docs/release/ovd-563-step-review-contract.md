# OVD-563 exact STEP review

This is a source-only continuation after OVD-561. It neither activates native
execution nor installs the staged OVD-558/560/561 migrations in production.
OVD-502's verified candidate STEP export is the geometry source. OVD-563 does
not create a GLB, infer portable entity identity, or change native finalization.

## Association

The trusted writer loads one immutable OVD-561 finalization by task ID, obtains
its exact candidate context text, and loads only the separately admitted OVD-502
preview bundle and export report for that candidate. It calls
`verifyStoredNativePreview` before extracting STEP bytes. The writer supplies
the verified export ID, qualified source commit, report digest, result digest,
STEP digest and bytes to the owner-only association function. The SQL function
rechecks the finalized task, attempt, input and candidate snapshots, candidate
context digest, result digest, current conversation head, byte length and SHA-256
under the conversation lock. No caller-provided success flag is authority.

One task has at most one immutable association. Identical retry returns the
existing association; conflicting retry rejects. A missing export produces no
association. Bad or substituted export evidence is rejected, not silently
replaced with another candidate's geometry. Association is separate from the
atomic native result commit; failure leaves that result intact.

## Authenticated read

The public review RPC is granted only to `authenticated` and uses the current
JWT actor. It requires the same conversation, owner, organization and project,
the active engineering operator/project access gate, and an exact requested
candidate snapshot. A foreign task or revoked access returns no data. A result
whose candidate is no longer the conversation head rejects as stale. A task
without a verified finalization or associated STEP returns an explicit
`unavailable` state. For a ready result, the RPC recomputes SHA-256 over stored
bytes before returning base64 and immutable binding metadata. The browser
checks canonical base64, byte count, SHA-256 and STEP envelope before providing
bytes to the existing STEP renderer. Any read or integrity error clears the
geometry and displays an unavailable state.

The private byte table has RLS enabled, no API-role grants, and immutable row
history. Reverse refuses populated review history, preserving evidence. The
source-only SQL fixture must prove role grants, tenant isolation, stale-result
denial, byte substitution detection, replay behavior and reverse safety in an
exclusively owned disposable database. Browser fixtures do not count as native
proof or production activation.
