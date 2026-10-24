# OVD-517 — 1.0 candidate qualification and release approval packet

**2026-09-23 03:48 UTC release hold:** Read-only production review confirmed an anonymously executable, `SECURITY DEFINER` quote-publication helper with no caller authorization check. See [the security finding](SECURITY-FINDING.md). OVD-419 is not ready for release; no deployment, probe, database privilege change or exploit call was performed. The migration deferral decision below remains valid but does not clear this separate security gate.

Prepared 2026-09-22 America/Phoenix (2026-09-23 UTC). Status: **not ready for release approval**. This is a read-only qualification snapshot, not an authorization file or an OVD-419 execution bundle.

Build-only preparation addendum (before approval): [exact frozen approval packet](../ovd517-build-only-20260922/BUILD-ONLY-APPROVAL.md). At that point its offline archive, manifest, inspector, unique tag and build template were ready, but no cloud upload/build or candidate image existed. This did not change the release-preflight disposition below.

2026-09-23 00:48 UTC result addendum: the owner approved and the one build-only attempt succeeded. [Build-only result and immutable digest](../ovd517-build-only-20260922/BUILD-ONLY-RESULT.md) now replace the earlier **absent candidate image** finding for source-to-image qualification. The original matrix below remains a historical 00:20–00:26 UTC snapshot, not a fresh OVD-419 pre-mutation verdict; its unknowns and release stop conditions remain.

2026-09-23 00:49–00:52 UTC [read-only preflight refresh](../ovd517-build-only-20260922/PREFLIGHT-REFRESH.md): the newly qualified digest remains uninstalled; Job and Service retain the rollback baseline. Rollout controls, queues, execution inventory, snapshot metadata and egress matched at capture. Five later source migrations, advisor causality and global sole ownership remain unresolved release gates.

2026-09-23 01:20 UTC [OVD-419 readiness handoff](../ovd517-build-only-20260922/OVD419-READINESS-HANDOFF.md): plan-only validation passed, but the retained OVD-419 branch still has unmerged, incomplete acquisition reader/writer work and explicitly labels production HOLD. Its eventual merged full SHA will require a newly qualified image. Do not treat this OVD-517 digest as an approved final deployment candidate.

After OVD-517 closeout, the exact `build-only-bundle.json` also passed the OVD-419 **plan-only** CLI with verdict `plan-valid`: eight planned promotion phases and two sequential one-task, zero-retry, no-upload probes. This validates bundle shape only. It does not perform or authorize a release, resolve any live preflight unknown, or renew an expired observation.

Static triage of the five pending September 10 migrations: four introduce the default-off engineering inbox, ordered-change, worker-session and native-ownership schema (`OVD-496` through `OVD-501`); the fifth replaces a commercial-admin entitlement-revocation audit function (`OVD-504`). The files contain no direct change to the Xometry quote tables or OVD-418 admission catalogue. This alone was **not** proof that they could be skipped or applied safely in production. No migration was applied.

The subsequent [migration-scope review](MIGRATION-REVIEW.md) recommends deferring all five from OVD-419, with the current OVD-418-compatible production head as its database target. That is a scope recommendation, not permission to deploy or a replacement for fresh catalog/API readback and advisor disposition.

Read-only Supabase refresh at 2026-09-23 01:18 UTC reconfirmed production migration head `20260905233435` and the five pending source migrations. Security advisors still reported WARN categories for mutable function search paths (8), anonymous-executable security-definer functions (71), authenticated-executable security-definer functions (112), and leaked-password protection (1). Performance advisors still reported WARN categories for auth/RLS init plans (10) and multiple permissive policies (27), including `vendor_quote_offers` SELECT. These are counts of current advisory findings, **not** new-issue counts or a causality verdict. No accepted baseline comparison or remediation was performed; the release quality disposition remains unknown.

## Selected source and image — historical pre-build snapshot

- Repository: `optomachina/Overdrafter`.
- Clean isolated branch: `codex/ovd-517-qualification`, based on remote `main` at full SHA `7da20710b25a6a30d0f9ac59e88e00f685defc67`. Git status was clean and `./scripts/symphony-preflight.sh` passed.
- Candidate image: **unknown / absent**. The existing Artifact Registry worker repository has no image updated after 2026-09-09, and the newest regional Cloud Build listed was created 2026-09-09. A search of retained local JSON/Markdown evidence found no record bound to this SHA. Historical qualified images are not evidence for this source.
- Source archive SHA-256, manifest SHA-256, build ID, unique tag resolution, immutable digest, stopped network-disabled image inspection, baked `WORKER_BUILD_VERSION`, and critical-file hashes: **not available for this candidate**. `attestBuildOnly` and the plan-only bundle cannot pass without these actual observations.
- Worker production dependency audit: three reported vulnerable packages, all through the documented `adm-zip` advisory chain (one high and two moderate package-level reports). Retain its existing exposure assessment for the next image qualification; do not describe the image as vulnerability-free.

The prior sentence in `PLAN.md` that fresh image qualification is complete refers to an older source/image checkpoint. It does not qualify the September 22 main SHA.

## Current preflight matrix

| Condition | Observation time (UTC) | Result | Evidence and limit |
| --- | --- | --- | --- |
| OVD-418 production database | 2026-09-23 00:25:16 | Pass for presence; current release compatibility still needs review | Live Supabase project `ozuatdcakezjtevztjlr` includes all four OVD-418 suffix migrations. Current head is `20260905233435`; five later source migrations remain pending in the clean checkout. Admission policy/history and resolver exist, admission policy RLS is forced, and `vendor_quote_offers.geographic_origin` is non-null. The historical OVD-418 final-head verifier cannot be relabeled as a verifier for this later head. |
| Commercial rollout | 2026-09-23 00:25:16 | Pass at capture | All four named controls were disabled. |
| Work and quote queues | 2026-09-23 00:25:16 | Pass at capture | Active `work_queue` rows: 0. Active `quote_requests` rows: 0. |
| Probe execution inventory | 2026-09-23 00:22:32 and 00:26:00 | Pass at capture | Complete CLI list contained 20 historical executions and 0 active. The earlier September 4 receipt listed 13; it is historical. Inventory fingerprint was computed from sorted execution names and retained in the task observation, not inferred from the old receipt. Recollect before any protected operation. |
| Job and Service baseline | 2026-09-23 00:26:00 | Pass at capture | Both reference the same rollback digest `sha256:3dd67a3ce58817417d94da3b580c1eb99cdfdf9aa9d9ed2317c535ad69bf0daf`; Service build version is `25452595367f81d7b46bda960020ecd6aefb153e`. Job resource version: `AAZbIWO5L6M`; Service resource version: `AAZbIWLoUVo`. These opaque concurrency tokens expire on resource change. The candidate digest is absent, so the before-Job mutation predicate cannot yet be evaluated. |
| Snapshot binding | 2026-09-23 00:21:59 | Partial | Job and Service name the same existing snapshot object; generation, metageneration, and etag were present and identical across two metadata reads. Exact private identity was not retained as an OVD-419 authorization input and must be captured again privately immediately before execution. No snapshot content was read. |
| Stable egress | 2026-09-23 00:22–00:23 | Pass at capture | The repository's read-only `ovd410-production-v1` stable-egress verifier passed for the private Service, bounded Job, VPC, routes, and manual-address NAT controls. Recheck at OVD-419 admission. |
| Sole release owner | 2026-09-23 00:23–00:24 | Partial / cross-host unknown | The local host and configured Mac Mini had no default OVD-419 owner lock or matching live-release process; the cloud Job had no active execution. Other hosts and nondefault lock locations were not inventoried. This does not prove global sole ownership. |
| Security/performance advisors | 2026-09-23 00:20:51 | Unknown release disposition | Current advisors contain WARN findings, including functions and a quote-offer policy relevant by name. Their age and release causality were not established by this read-only pass; compare with the OVD-418 accepted baseline before claiming a clean quality gate. |

All pass entries are observations at the stated times. None is a pre-mutation verdict or a renewal of the consumed OVD-419 authorization.

The advisor WARN results relevant by name include executable security-definer functions `public.insert_published_quote_option`, `public.api_admin_invalidate_vendor_quote_offer`, and `public.api_set_job_selected_vendor_quote_offer`, plus multiple permissive SELECT policies on `public.vendor_quote_offers`. Their cause and accepted baseline status need comparison before a release quality verdict. Supabase documents the [anonymous executable-function](https://supabase.com/docs/guides/database/database-linter?lint=0028_anon_security_definer_function_executable), [authenticated executable-function](https://supabase.com/docs/guides/database/database-linter?lint=0029_authenticated_security_definer_function_executable), and [multiple permissive-policy](https://supabase.com/docs/guides/database/database-linter?lint=0006_multiple_permissive_policies) advisories.

## Protected operations and approval sequence

1. **Build-only qualification, if selected.** First freeze and independently review a new minimal source archive, manifest, expected critical hashes, current GeoIP-free image inspector, unique tag, exact Cloud Build configuration and bounded cost for SHA `7da20710b25a6a30d0f9ac59e88e00f685defc67`. Only an exact owner approval for those frozen bytes may admit one non-overwriting source upload, one build/image publication, one digest pull, and one stopped, network-disabled local inspection. No deploy step, automatic retry, credential/IAM repair, or source substitution.
2. **OVD-419 release authority, separately.** After a successful `attestBuildOnly` result and plan-only validation, prepare a short-lived private authorization bound to the observed immutable candidate digest and full source SHA, exact production resource tuple, current rollback digest, snapshot identity, named owner and lock, and the two no-upload probes. No nonce has been created or consumed by OVD-517.
3. **Dormant Job replacement.** Immediately recapture disabled rollout, both empty queues, complete inventory, snapshot identity, stable egress, both images and resource versions, and sole ownership. Replace the Job with the exact candidate using the freshly observed concurrency token, without executing it. Read back the Job; any unknown or mixed state stops and invokes the reviewed rollback path.
4. **Service replacement.** From the verified Job-candidate/Service-baseline transient state, recapture every required predicate and replace the Service using its fresh concurrency token. Verify one-digest parity, full source build version, private/scale/network controls, and final containment.
5. **Two no-upload probes, separately gated.** Each fresh-instance, one-task, zero-retry Job execution needs its own immediate snapshot, Job identity/configuration, inventory and containment checks under the approved single-use authority. A failed or unknown first probe stops the sequence; it does not authorize a retry or the second probe.

Rollback baseline for the protected release is the currently observed Job/Service digest above. OVD-419 must re-read and confirm that baseline before any mutation, then restore every changed resource with fresh resource-version protection and prove parity, disabled rollout, empty queues, zero active executions, and stable egress. A failed or uncertain rollback remains blocked for incident review.

## Verification and disposition

- `./scripts/symphony-preflight.sh`: passed.
- `npm exec -- vitest run scripts/ovd419-digest-contract.test.mjs scripts/run-ovd419-final-digest-release.test.mjs scripts/verify-ovd418-release-state.test.mjs`: 159/159 passed in three files.
- `npm run verify:migration-lineage`: passed.
- `npm --prefix worker audit --omit=dev --json`: three package findings in the documented `adm-zip` chain.
- `scripts/verify-xometry-stable-egress.mjs` with the pinned production contract: passed.
- No current candidate image existed to inspect; no source-to-image attestation or OVD-419 plan-only bundle was fabricated. The full repository gate was not run because image qualification stopped before that step and no tracked source changed.

**Current OVD-517 disposition (2026-09-23):** the later build-only result above qualified the exact candidate image, and Blaine confirmed this evidence-only issue complete. OVD-517 is Done. The pre-build observations in this document remain historical. The refreshed preflight is also time-bound and does not establish OVD-419 release readiness. Keep OVD-419 and OVD-206 blocked; do not submit an executable release approval or infer deployment/probe authority from the consumed build-only approval.
