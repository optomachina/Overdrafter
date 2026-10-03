# Concrete first-loop source composition

`createNativeFirstLoopRuntime` builds the private SQL transaction executor,
version-specific Storage transport, fixed Node artifact route, preclaim input
mapping writer, independent result-binding writer and result finalization/replay
service. Every operation remains default-off. Constructing it opens no connection,
listener or worker and reads no environment or paired store.

The trusted caller supplies an existing dedicated owner pool, HTTPS public and
Storage origins, Storage authorization, a fixed private output bucket and, for
finalization, signing-key bytes. These are configuration inputs, not new credentials
or grants created by the module. Storage I/O additionally requires an explicit
`storageVersionIdQualified` flag after the actual pinned provider passes its
capability tests. The only HTTP member is `artifactRoute`, mounted at the existing
`/functions/v1/engineering-worker-artifact` path. Never expose the other methods as
worker/public RPCs. No server is mounted or activated by this source packet.

## Required order

| Phase | Concrete call and required input | Expected result / boundary |
| --- | --- | --- |
| Before claim | Owner `prepareInputs({inputAdmissionId, actorId, seedManifestText, signal})` against an existing independently qualified admission; candidate input uses null seed text | Three immutable opaque IDs in ordinal order. No attempt is required. Preserve exact manifest text for replay; no admission or qualification is created. |
| Authorized native attempt | Existing separately authorized `run-task.ps1`, using those three IDs and exact runtime/input admissions | Existing claim, fresh enablement, pinned runtime and zero-existing-SolidWorks-process guards still apply. This runtime does not invoke it. |
| Independent stop | Existing observer workflow, independent qualification and checked stop transaction | Stop evidence alone is not result eligibility. No worker-supplied qualification is accepted. |
| Seven retained outputs | Existing explicit `replay-output.ps1` sends the same immutable set to `artifactRoute` | Paired token, exact scope and stopped eligibility are checked first. The route prepares seven targets using only the configured bucket, then creates/reads/measures/registers bytes. Mapping SQL repeats authority checks under locks. |
| Independent read binding | Owner `admitResult({taskId, attemptId, evidenceId, filesystem, qualificationSha256}, signal)` | Filesystem handle identities must come from separately retained independent measurement. Process identities come from the qualified journal. Worker reports are not admission inputs. |
| Verification and completion | Owner `finalize(taskId, attemptId, options)` | Read seven registered generations, verify reports, recheck current admission, retain exact signed envelope, then execute existing atomic OVD561 finalization. |
| Uncertain completion | Owner `replay(taskId, attemptId, options)` | Load and resend only the original envelope/key. No new verification, signature, object bytes or native run. |

Output target preparation occurs at most once per request after successful
commit acknowledgement. A lost mapping commit response stops that request before
upload; explicit replay invokes the same idempotent mapping operation. Later
artifact authorization checks still recheck current authority. No request header
can select the output bucket or supply a seed manifest.

## Failure and qualification boundaries

Disabled owner methods fail before pool/provider access; the HTTP route returns
503 `transfer_disabled`. Missing signing bytes fail before finalization SQL.
Invalid/foreign tokens, scope or pre-stop uploads cannot prepare output targets.
A mapping SQL refusal or unknown outcome returns an unavailable transfer, retaining
immutable state. A deadline closes the HTTP response; SQL callback handles become
unusable before COMMIT, and unacknowledged connections are destroyed.

The Storage implementation uses Supabase's version-specific authenticated GET,
not a database-version-as-HTTP-ETag assumption. See the pinned upstream source and
actual-provider acceptance matrix in [runtime drivers](native-private-runtime-drivers.md).
A source test or manually set capability flag is not provider qualification.

Apply no staged SQL from this document. The [mapping contract](native-artifact-mapping.md),
[result reader contract](native-result-reader-contract.md),
[pending finalization contract](ovd561-pending-contract.md) and complete generated
first-loop SQL fixture state the separate database prerequisites and assertions.
No PostgreSQL, real Storage, proxy deployment, Windows/native or live Jev pass is
claimed. The hosted interpretation Edge adapter remains disabled; the earlier
trusted Node Jev composition still needs its separately provisioned helper.
