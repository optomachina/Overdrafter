# Capability canary offline preparation (OVD-415)

`worker/src/providerCapabilityCanary.ts` prepares inert plans and sanitized
observation candidates. It does not install a scheduler, execute a probe, acquire
a session, write a ledger row, or enable a provider. There is no runtime entrypoint,
environment-variable switch, database client, browser, network transport, executor
hook, or package command. The source slice is pending integration and does not
complete OVD-415.

## Disabled planning contract

`prepareCapabilityCanaryPlan(config, reviewedEnvelopes)` returns `disabled` for
absent/empty configuration or `{ enabled: false }`. A complete closed configuration
can return `prepared_plan`; its `enabled` value must still be literal `false`.
`true`, unknown fields, malformed bounds, unreviewed scope, or duplicate matching
envelopes return `invalid_configuration`. A prepared plan grants no authority.

The caller must explicitly supply reviewed envelope identities. No runtime
enabled-provider list or manifest is treated as admission. Scope binds provider,
route, surface and revision exactly; envelope extensions and policy evidence use
the existing upload-capability contract. A plan does not verify the review itself.

Policy `capability-canary-offline.v1` fixes:

| Input or output | Bound |
| --- | --- |
| Probe mode | `capability_inspection_no_upload` only |
| Interval | Integer 3,600–86,400 seconds |
| Windows | Integer 1–24; interval × windows at most 86,400 seconds |
| Proposed task timeout | Integer 1–60 seconds |
| Task count / parallelism | 1 / 1 |
| Task / scheduler retries | 0 / 0 |
| Observation candidates per window | Plan limit 1; no distributed claim implied |
| Proposed CPU / memory | 1 CPU / 512 MiB |

Start/end times are exact canonical UTC timestamps, including milliseconds. The
plan has a finite end and at most 1,440 seconds of requested task runtime. These
are conservative preparation limits, not deployed resources or a guarantee that
a future browser fits them. Changing them requires policy review. No cloud
operation occurs here; resource limits alone cannot guarantee a future monetary
ceiling.

Every window has a deterministic `canary:`-prefixed SHA-256 key over the policy
revision, existing capability contract version, exact scope and window start.
Same inputs yield the same key; it is compatible with the existing persistence
key syntax. It is neither a lock nor proof of once-only execution. Repeated
projection intentionally returns candidates without writing or claiming them.

## Supplied observation projection

`prepareCapabilityCanaryObservation(config, reviewedEnvelopes, observation,
admissionResolverResult, now)` revalidates the configuration rather than trusting
a mutable previously returned plan. It accepts only a closed sanitized snapshot
with exact scope, selected window, existing observed-state vocabulary, formats,
accept presence, observation/expiry timestamps and an explicit positive safe
observation revision. No raw HTML, URL, customer identifier, credential, error or
extra field is accepted. Format arrays have at most 32 entries and reuse existing
normalizers and persistence token limits.

The observation must lie inside its selected half-open window, not after the
explicit `now`, and must still be fresh at that time. Expiry is positive and at
most 3,600 seconds after observation. Nonfresh states require empty format arrays
and null accept presence. Revision allocation is left to future integration.

The result contains only a `CapabilityRecordInput` candidate with
`scheduled_canary` actor/source, `issue:OVD-415` evidence reference and stable
window key, plus the result of the existing `decideProviderUploadCapability`
classifier. It preserves `reviewed_missing_accept_xometry` only when the shared
contract permits it; generic missing accept remains `accept_missing` with no
allowed extensions. A blocking classification can still be diagnostic evidence;
neither candidate nor classification permits provider dispatch.

The projection passes its validated explicit clock to the shared classifier's
`nowMs` input, including for expiring admission. It never reads ambient time or
rewrites admission expiry/review evidence. Expiry equal to or before that clock
remains blocking, and future-reviewed or malformed admission remains denied by
the shared classifier. Invalid observation clocks (noninteger, nonfinite or
outside the JavaScript Date range) stop before classification. Null expiry alone
does not establish admission.

This consumer change depends on shared clock repair
`a9a3fd5553aedb9a913eb7faae6ae47576917650`. Verify a composed source revision
containing both changes; the original standalone classifier does not expose the
explicit clock input. The planner remains disabled and performs no execution.

Invalid inputs yield finite preparation outcomes without raw exceptions. No
outcome claims a probe timed out, authenticated, wrote data, or actually ran.

## Existing dependencies and remaining gates

OVD-411's classifier/types, OVD-512's append-only observation ledger, OVD-513's
service-only record/resolver RPCs and `providerUploadCapabilityPersistence.ts`
already exist in source. This module imports persistence types only. Their
presence does not prove deployed schema, current service grants or hosted
qualification. OVD-415's current issue relations also list OVD-413 as a blocker,
beyond the older description's child-1/child-2 dependencies; that mismatch is not
treated as dependency completion.

Future integration still requires:

- durable window claim/concurrency and observation-revision allocation; ledger
  idempotency compares complete observation bytes, so competing snapshots can
  conflict despite sharing a key;
- a reviewed disabled Scheduler/Job helper, finite resource/cost policy and
  explicit auditable operator authorization separate from production rollout;
- profile/session locking and qualified no-upload surface/network controls;
- real bounded cancellation and proof of zero file selection, provider workflow
  mutations, customer writes or commercial commitments;
- qualified service-ledger integration, restricted execution identity, finite
  alerts, deployment smoke tests and operational disable verification.

Disable by discarding preparation/configuration; no history is deleted. Once a
real executor exists, separately reviewed rollback must disable its schedule and
revoke its service permissions while retaining sanitized observations. OVD-419
release work and OVD-410 network proofs remain separate. No source preparation
authorizes live accounts, uploads, quotes, migrations or deployments.

## Source verification

Run the canary tests with the existing classifier and persistence unit suites:

```sh
npm test -- worker/src/providerCapabilityCanary.test.ts worker/src/providerUploadCapability.test.ts worker/src/providerUploadCapabilityPersistence.test.ts
npm --prefix worker run typecheck
```

Coverage includes disabled/hostile configuration, finite limits, exact scope and
window keys, sanitized candidates, classification compatibility, rejected
expired/future-reviewed admission, explicit-clock expiring admission, invalid
clocks, no ambient clock for projection and a static
runtime-import boundary. No live-provider or service-ledger evidence is produced.
