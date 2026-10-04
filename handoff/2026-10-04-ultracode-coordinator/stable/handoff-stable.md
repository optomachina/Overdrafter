# Handoff: stable sections

Prepared 2026-10-04 for Blaine. The October 4 handoff was treated as source material and checked against the repository (main at 8d8d243 and the open PR stack) and Linear. Anything unknown or undecided is listed as a question for you, not guessed. **Nothing here claims that the phone-to-SolidWorks proof (OVD-520) or any release gate has passed.**

Two run facts shape everything below: the Linear workspace hit its free-plan issue limit, so only OVD-599 to OVD-603 were created and other PRs say "issue pending"; and a spend-limit outage around 16:30-16:50 UTC cut some agent work short.

## At a glance

- 21 handoff claims were contradicted by the repo or Linear; 14 notable claims checked out.
- 54 open questions in 7 groups. The 5 most blocking are listed first under Open questions.
- 23 protected or owner-only actions are waiting on you.
- 39 units have no Linear issue of their own yet: 7 with open PRs, 7 in progress without a PR, 10 queued, 11 deferred, 4 dropped.
- 14 process deviations to disclose.
- One real product defect was found: after an in-tab account switch, the next user briefly sees the previous user's parts list (PR #583). A fix is in progress.

## OVD-520: phone-to-SolidWorks proof

**Status: not passed.** No connected native run or recording exists and all five OVD-520 acceptance boxes are unchecked. A phone cannot reach /engineering, the staged OVD-558/560/561/563 SQL has not been applied to any real backend, there is no interpretation adapter, and the server pieces for steps 6 and 9-11 sit unmerged in #565. Everything this run produced is disposable synthetic SQL or a mocked browser simulation, which by design cannot satisfy AC1-AC5; AC5 has no pre-flight evidence at all. The three steps that can satisfy the criteria (X1, X2, X3) are protected and owner-run.

### What this run proved locally

All of it is disposable synthetic SQL or a mocked browser simulation. None of it is Windows, SolidWorks, hosted-database or production evidence.

- Disposable staged-SQL runner (synthetic data, one throwaway Postgres 17 container): on main 8d8d243 it exits 1 with ovd563_reverse_catalog_drift (and ovd561 drift) while every behaviour check passes (OVD-560 11/11, OVD-561 24/24, races 12/12, OVD-563 21/21). Cause: the race proof leaks the cluster roles ovd575_observer_validator and ovd576_stop_validator.
- PR #575 (OVD-599) at 527f051 fixes the leak: --ovd563 and --ovd561 both exit 0; removing the drop loop brings the drift back (fixture 6b1539ce). Hosted CI green at 527f051, with browser-test passing on rerun after one unrelated flake.
- PR #576 (OVD-600) at 52a6dc0: 9 new pgTAP assertions show a confirmed native_operation_failed stop on a fresh task gets no automatic retry and keeps its successor blocked. Local pgTAP Files=46, Tests=1448 PASS (baseline 1439); a mutation treating native_operation_failed as transient fails 3 assertions; replay compatibility suite 129/129. Hosted 'Test database policies' was pending when the PR body was written.
- PR #582 (A7) at bb39359: a browser fixture with a Node-side mock (simulationOnly) shows failed Change 1 with blocked Change 2, no geometry, no STEP-review request, no write requests, and truthful Canceled states after a simulated cancel. e2e:fixture 22 passed (baseline 21); three mutations fail the spec.
- Reader reproductions in scratch exports: 645 engineering unit tests pass at main 8d8d243; #565's 5 failing tests pass 23/23 under the node test environment (not committed).

### What remains

| Item | Owner | Protected |
|---|---|---|
| C1: path-scoped, non-required CI job for the staged SQL proof chain | agent (in progress, no PR); you decide CI policy and tagging 000d82a3 | no |
| A2: same-project peer and revoked-owner STEP-review denial (OVD-563 21 to 25) | agent (in progress, no PR) | no |
| A3: failed attempt cannot register, finalize or show geometry (staged) | agent (in progress, no PR) | no |
| A1: synthetic same-run identity chain (fixture resolves the 7 mm message as 8 mm; digest-based) | agent (in progress, no PR) | no |
| A5 route-level no-retry pin (deferred; waits on retry policy; Deno tests hosted-only) | Blaine decision, then agent | no |
| A6 attempt/task binding display in STEP review (deferred) | Blaine decision (provenance labels / Lane B) | no |
| Retry policy for native_startup_timeout and the three docs that still describe one retry | Blaine decision | no |
| Phone reachability of /engineering (AC2) | Blaine decision; the hosted option is protected | no |
| Interpretation adapter (none exists; the service refuses even when enabled) | Blaine decision; any model credential and spend are protected | no |
| Server pieces for steps 6 and 9-11 exist only in draft #565 (CI red, Sonar D/D) | Blaine decision on #565 | no |
| Owner pairing/enablement path (no UI calls the DB functions) | Blaine decision | no |
| Provenance labels distinguishing simulation, replay and native (AC5) | Blaine decision | no |
| OVD-558 fail-closed manifest refresh with independent review before any apply | agent plus reviewer | no |
| OVD-511 reconciliation (still formally blocks OVD-520); stale docs (jarvis-bounded-restart.md, completion-checklist.md) | Blaine (tracker); agent (docs) | no |
| X1: Workstation exact-source qualification (Windows PowerShell 5.1, SolidWorks, SolidWorks-session decision) | Blaine | yes |
| X2: backend activation packet (DB apply, principals, credentials, flags, admissions) | Blaine | yes |
| X3: connected phone-to-SolidWorks 7 mm run with a labelled recording | Blaine | yes |
| Owner-side artifacts on no remote (feature/OVD-520-phone-loop, jarvis bundle, handoff zip) | Blaine | no |

## Release gates

No gate is marked passed. "Pending verification" means a PR adds evidence but hosted checks, review or merge are still outstanding. Titles are paraphrased from the readers' mapping, because the U1-U18 and R1-R30 source lists were not found in the repo or Linear.

| Gate | Title | Status | Note |
|---|---|---|---|
| U1 | Signup/sign-in and first upload | covered-by-PR #583 pending verification | No signup or upload browser test on main; #583 adds Mailpit-confirmed signup and enrolled-client intake access; the upload itself is in INTAKE-STEP-E2E (no PR yet). |
| U2 | Workspace restore across logout, login and reload | covered-by-PR #583 pending verification | Restore is covered on main (smoke.spec.ts:42); restore after intake is in INTAKE-STEP-E2E (no PR yet). |
| U3 | No duplicate intake on repeated selection | covered-by-PR #564, #577 pending verification | Concurrent guard only in #564; composer race in #577 (OVD-603); browser case in INTAKE-STEP-E2E (no PR). Re-selection after completion and server idempotency need your decision. |
| U4 | Empty or invalid STEP gets a finite, useful error | covered-by-PR #564 pending verification | Client 0-byte check only in #564; server rejection in OVD-601 (no PR yet); browser case in INTAKE-STEP-E2E; STEP header check needs your decision. |
| U6 | Quote confirmation (client side) | covered-by-PR #564 pending verification | 13 quote-confirmation browser cases on the release base only; hosted green at 084b48c5; unmerged. |
| U7 | Seven named providers customer-routable | blocked-owner-decision | Provider-neutral chain is in drafts #568/#573/#574; the bar (7 vs 8, gate timing) is undecided; live certification is protected. |
| U8 | Quote results preserve original currency | blocked-owner-decision | Customer schema and UI are USD-only; needs the currency decision. |
| U9 | Known vs estimated arrival and cost shown distinctly | not started | OVD-571 (Backlog) is not implemented. |
| U10 | Comparison: variant grouping and table/chart selection sync | covered-by-PR #585 pending verification | Unit-only on main. #585 found an intermittent dropped first click on chart points after row focus (likely QuoteComparisonRow onBlur); not fixed. |
| U11 | Stale, simulated or expired offers not shown as live | covered-by-PR #585 pending verification | Expired but recently quoted offers still count in 'live offers' (owner question). |
| U12 | Refresh preserves prior decision, with invalidity explanation | blocked-owner-decision | Meaning of 'refresh' (reload vs requote, OVD-460) and the copy are undecided; #585 dropped the invalidation assertion. |
| U13 | No order implied; vendor link and sign-in note | covered-by-PR #585 pending verification | Decision panel has no order or payment controls and vendor links carry the sign-in note; the legacy procurement handoff ('Review order') needs your decision. |
| U14 | Phone navigation Escape and focus return | covered-by-PR #569 pending verification | Fix in #569; its own record is 29/50 under load; the repeat-evidence result was not available to this report. |
| U15 | Engineering submission scoped and truthful in a real authenticated run | blocked-protected | Fixture-lane mock coverage exists on main; a real run depends on OVD-520 X1-X3. |
| U16 | Retained previews labelled distinct from new execution | blocked-owner-decision | Surface and label form undecided; the sample-plate unit is queued without a provenance claim. |
| U17 | No dev fixtures, diagnostics or concept galleries in production | covered-by-PR #567 pending verification | The OVD-595 closeout on #567 adds production-build route and bundle checks; ?debug=1 and fixture-bytes policy undecided; what production serves today is unverified. |
| U18 | Authenticated production smoke on the deployed release candidate | blocked-protected | Needs production deploy, a real account, enrollment and provider dispatch. |
| R3 | Signup and upload journey proof | covered-by-PR #583 pending verification | Upload portion in INTAKE-STEP-E2E (no PR yet). |
| R4 | Quote confirmation behaviour (client side) | covered-by-PR #564 pending verification | Mapped by the readers together with U6 and R15; exact item text not located. |
| R7 | Comparison scatter with no invented Pareto | covered-by-PR #585 pending verification | Points-only chart asserted; see the dropped-click finding under U10. |
| R8 | US-only vs all sourcing; unknown origin labelled | covered-by-PR #585 pending verification | US-only lists only explicitly domestic offers; no-origin offers show 'Unknown'. |
| R9 | Prior-scope data removed on logout and account/org switch | covered-by-PR #583 pending verification | Currently failing: #583 found the next account briefly sees the previous account's parts (client-side ref in use-workspace-navigation-model.ts). Case 4 is opt-in; ACCOUNT-SWITCH-NAV-LEAK-FIX is in progress, no PR yet. |
| R10 | Subscription or entitlement never replaces Founding Beta enrollment | covered-by-PR #578 pending verification | Legacy entry points covered (plan 44, mutation recorded); generic-path case queued. |
| R12 | Stale or simulated prices cannot pass as live | covered-by-PR #585 pending verification | Stale offer never listed; expired-offer count question open. |
| R13 | Customer cancel creates no duplicate vendor work | unknown | Unit test only (ClientPart.test.tsx:1841); no browser or DB proof was traced. |
| R14 | Customer-visible errors carry no secrets or stack traces | not started | No gate evidence yet; ERROR-SANITIZATION-SCOPED is in progress with no PR. |
| R15 | Quote confirmation behaviour (client side) | covered-by-PR #564 pending verification | Mapped with U6 and R4; exact item text not located. |
| R16 | Fresh signup lands not-enrolled with uploads and quotes blocked | covered-by-PR #583 pending verification | Case 5 in #583; DB coverage exists on main. |
| R28 | Accessibility, keyboard and 390/768/1440 viewports | blocked-owner-decision | Desktop tests use 1512; #585 adds a 1440 keyboard path for comparison; the axe scan waits on dependency approval and the fix policy. |
| U5, R1, R2, R5, R6, R11, R17-R27, R29, R30 | Not mapped by any reader | unknown | The source checklist was not found in the repo or Linear (open question). |

## Where the handoff was wrong

1. **Claim:** Implied by the handoff: the built system already enforces OVD-520's 'no automatic CAD retry' (AC4).
   - **What the repo or Linear shows:** Only the worker-task route's action whitelist blocks a retry. The database still grants one automatic retry for native_startup_timeout, three docs still specify one retry, and before this run no test pinned that native_operation_failed is never retried automatically.
   - **Evidence:** supabase/migrations/20260910104500_engineering_native_ownership.sql:656-660,679-684; supabase/tests/engineering_native_ownership.sql:244-252; supabase/functions/engineering-worker-task/index.ts:60; docs/engineering-automatic-loop.md:28; docs/engineering-task-coordinator.md:152,263; docs/engineering-control-plane.md:176
   - **Impact:** AC4 cannot be claimed. PR #576 (OVD-600) pins native_operation_failed only; native_startup_timeout waits on your retry-policy decision.
2. **Claim:** The Oct 2 duplicate-intake and empty-STEP fixes are in place (and the U3/U4 checklist items hold).
   - **What the repo or Linear shows:** They exist only in draft PR #564, so main and production still allow overlapping intake and 0-byte uploads. Even on #564, re-selecting a file after intake completes creates a new draft. PromptComposer has its own double-submit race. The server accepts size 0/null and the empty-content hash; there is no STEP header check and no browser test.
   - **Evidence:** origin/main src/features/quotes/use-client-job-file-picker.ts:84-119, file-validation.ts:20-41; uploads-api.ts:146-176; src/components/chat/PromptComposer.tsx:144-175; supabase/migrations/20260815093000_enforce_founding_beta_file_boundaries.sql:44-315; local storage.buckets job-files limits NULL
   - **Impact:** U3/U4 are open in production. Partial coverage is in flight: PR #577 (OVD-603, composer race), SERVER-EMPTY-FILE-REJECTION (OVD-601, no PR yet), INTAKE-STEP-E2E (no PR yet). Re-selection and header checks need your decision.
3. **Claim:** The full customer journey is PARTIAL because fixture context is lost on navigation.
   - **What the repo or Linear shows:** Stale within #564: a later QA doc there reports the blocker fixed (withLocalFixtureContext) and a continuous PASS. That PASS is self-reported and its receipts are uncommitted on Blaine's Mac.
   - **Evidence:** docs/qa/customer-continuous-fixture-2026-10-02.md (in #564); output/playwright absent from repo
   - **Impact:** Neither PARTIAL nor PASS is verifiable; treat the journey as unproven.
4. **Claim:** OVD-596: the phone-nav test 'passes 50/50 locally with parallel workers' (Linear AC ticked; #564 handoff table).
   - **What the repo or Linear shows:** PR #569's own record shows 29/50 under load, and no 50/50 artifact exists.
   - **Evidence:** PR #569 body ('NOT clean: 29/50 passed under load'); Linear OVD-596 comment 2026-10-03T21:55Z
   - **Impact:** OVD-596 AC2 is unmet; the templated Linear checkboxes are unreliable.
5. **Claim:** 'Sonar clean (no new issues)' on OVD-593, 536, 457 and 458; 'one pgTAP false positive' on OVD-459.
   - **What the repo or Linear shows:** Sonar reports new issues on every one: #572 has 3, #571 11, #568 4, #573 104, #574 77 (quality gates passed, but with new issues).
   - **Evidence:** sonarqubecloud bot comments 2026-10-03; check-run annotation counts (c35d054b 4, f5c8c823 11, 2428df2f 3, 9e901502 and ac5026fe capped at 50)
   - **Impact:** The AGENTS.md:56 inspection was not done. GitHub annotations cap at 50, so #573/#574 lists are incomplete from here.
6. **Claim:** PR #564 release base is 'hosted CI green' and main 8d8d243 is a clean merge.
   - **What the repo or Linear shows:** The Actions jobs passed, but the Sonar gate failed on #564 (D Reliability, D Security) and SonarCloud Code Analysis failed at main 8d8d243.
   - **Evidence:** Check runs at 084b48c5 and 8d8d2435 (re-checked by the synthesis pass)
   - **Impact:** #564, the base of the whole stack, cannot merge under current policy without a Sonar disposition.
7. **Claim:** Oct 3 decision: the 1.0 provider bar is 'Xometry plus all seven providers, per OVD-585', as a gate before invitations.
   - **What the repo or Linear shows:** OVD-585's seven already include Xometry, so the literal text means eight. Repo docs require five CNC-certified providers before activation. Unchanged OVD-199/OVD-319 text, the project description and the milestones still say five.
   - **Evidence:** OVD-585 description; OVD-358 decision comment 643fe0d3; docs/founding-beta-program.md:34-37; PLAN.md:31-36; PRD.md:64-68; OVD-319 acceptance item 4
   - **Impact:** The launch gate is undefined; whether RMFG (OVD-580) and OSH Cut (OVD-402) block invitations is unknown.
8. **Claim:** OVD-598: requested_by_date and applicable_vendors edits go undetected because they are outside the scope fingerprint.
   - **What the repo or Linear shows:** Partly wrong. A committed requirement edit bumps updated_at, which is hashed as capturedAt, so it fails closed. The unbound fields are jobs.requested_service_kinds and job_files kind/job/organization. No row locks are taken, so an edit committed during issuance does not wait (a jobs edit waits only at the final jobs UPDATE, still leaving a permit built from the old snapshot).
   - **Evidence:** 20260303101500:344-347; 20260926225000:378-420; 20260812041000:281; 20260812044000:54-66,677; plan-1.0 'dropped' correction; PR #580 red run (33/49 failed on the base)
   - **Impact:** OVD-598 acceptance was rewritten per field; PR #580 adds the row locks (migration #137). Production apply is protected.
9. **Claim:** The Quickparts '#/login' sign-in route was corrected to '#/'.
   - **What the repo or Linear shows:** Main and every pushed ref, including #564, still use '#/login'. The fix exists only as unpushed local commit 72b45234.
   - **Evidence:** worker/src/adapters/quickpartsPortal.ts:91 (main), :96 (#564); OVD-429 comment; 'git cat-file -t 72b45234' is not a valid object
   - **Impact:** The OVD-429 description is false on main; the commit must be pushed or re-created.
10. **Claim:** U17: dev fixtures, diagnostics and concept galleries do not leak to production.
    - **What the repo or Linear shows:** Production builds register /debug/concepts and /debug/state-gallery with no DEV check, and ?debug=1 enables diagnostics for any signed-in user. The fixture module is bundled even on #567, which makes the galleries DEV-only but is unmerged and had no production-build test.
    - **Evidence:** src/App.tsx:172-174; src/concepts/ConceptsGallery.tsx; src/pages/StateGallery.tsx; src/components/debug/DiagnosticsBootstrap.tsx:35-37; 'fixture-pricing-policy' in #567 App chunk
    - **Impact:** U17 is open. Whether production serves these routes today is unverified (the proxy blocks overdrafter.vercel.app).
11. **Claim:** PR #572 body: deploy-cloud-run.sh now defaults PLAYWRIGHT_DISABLE_SANDBOX to false and the contract test expects false.
    - **What the repo or Linear shows:** At head 2428df2f the default is true and the test expects true. The body's verification cites an older head, 20007361.
    - **Evidence:** worker/scripts/deploy-cloud-run.sh:35; commits c01722e and f819f6e; scripts/deploy-cloud-run-contract.test.mjs
    - **Impact:** The body misstates a security boundary. OVD-593 AC1 stays open behind a protected Cloud Run smoke. A fixer push to #572 this session landed only partially (outage); re-check the head.
12. **Claim:** OVD-597 AC1: 'shared setup deduplicated where safe' ([x]).
    - **What the repo or Linear shows:** At the head the readers checked, nothing was deduplicated; only Playwright cache steps were added.
    - **Evidence:** PR #566 body ('A composite action was skipped'); .github/workflows/ci.yml diff
    - **Impact:** The tick was false. A fixer this session drafted a real composite action, but its push landed only partially during the outage; verify #566's head before relying on it.
13. **Claim:** PR bodies give final heads c8b528d9 (#568), 5d8b247c (#573), ef6a7a12 (#574), 20007361 (#572); the #564 checkpoint says 6df4d1bb; OVD-527/419 notes cite main a11a9526 / 1992765b.
    - **What the repo or Linear shows:** Heads at read time were c35d054b, 9e901502, ac5026fe, 2428df2f and 084b48c5; main is 8d8d243 (2026-10-01).
    - **Evidence:** GitHub pulls API head.sha; git rev-parse origin/main
    - **Impact:** Verification sections in those bodies describe older code.
14. **Claim:** Tracker: OVD-457 is blocked by OVD-206; OVD-458/459 are Backlog; OVD-416 waits for OVD-410.
    - **What the repo or Linear shows:** The Oct 3 comment lifted the OVD-206 ordering but the relation and description were not updated. OVD-458/459 have active draft PRs (#573/#574). OVD-410 has been Done since 2026-09-24.
    - **Evidence:** OVD-457 relations.blockedBy and comment 5a64d264; PRs #573, #574; OVD-416 comment 249a2ef7
    - **Impact:** Linear status cannot be used as the source of truth until reconciled.
15. **Claim:** Full strict mode for OVD-594 is 'deferred pending @types/three'.
    - **What the repo or Linear shows:** @types/three fixes only 6 of 14 strict errors; 3 need a quoted-sample .d.ts, 4 are TS7006 and 1 is TS2322.
    - **Evidence:** tsc --strict --noImplicitAny on the merged #567+#569+#570 tree
    - **Impact:** Approving the dependency alone does not unlock full strict.
16. **Claim:** R28: the critical journey is checked at 390, 768 and 1440 px.
    - **What the repo or Linear shows:** The fixture-lane desktop viewport is 1512x751. 1440 is used only by #564's quote-confirmation dialog lane.
    - **Evidence:** e2e/client-shell.spec.ts:186-190; #564 e2e/quote-confirmation/playwright.config.ts (1440x1000)
    - **Impact:** The 1440 claim is false for the journey; PR #585 adds 1440 coverage for comparison only.
17. **Claim:** U8: quote results preserve the original currency.
    - **What the repo or Linear shows:** The customer schema and UI are USD-only. Native currency exists only in local evaluation evidence and is barred from customer results.
    - **Evidence:** src/features/quotes/utils.ts:57-64; worker/src/adapters/providerAdapterContract.ts:234-258 (#564)
    - **Impact:** U8 cannot be tested until you decide currency handling; Weerg (EUR) counts toward the provider bar.
18. **Claim:** Docs: jarvis-bounded-restart.md lists OVD-509/510/511 as Backlog; completion-checklist.md lists finalization as Open and verifier authority in progress.
    - **What the repo or Linear shows:** OVD-509 and OVD-510 are Done. OVD-558/560/561 are Done with staged SQL and disposable proofs merged; only connected and production proof remain.
    - **Evidence:** Linear completedAt 2026-09-24 / 2026-09-28; docs/release/ovd-56*.sql; docs/jarvis-bounded-restart.md:122-124
    - **Impact:** Docs drift misstates OVD-520 readiness.
19. **Claim:** Implied by the tracker and PRs #541/#544: the merged OVD-560/561/563 disposable proofs pass on current main.
    - **What the repo or Linear shows:** On main 8d8d243 the disposable runner exits 1 at the rollback-catalog comparison (ovd563_reverse_catalog_drift; --ovd561 also drifts) although every behaviour check passes. The race proof leaks two cluster-wide roles.
    - **Evidence:** finding-ovd563-drift.md; scripts/ovd561-race-proof.mjs:58-59; supabase/migrations/20260927130000:8-9 and 20260927140000:8-9; runner fixtures 908df196 and 0ef18f32 (exit 1)
    - **Impact:** Per-head proof evidence had been silently red. PR #575 (OVD-599) ports #564's fix; C1 (no PR yet) would keep it checked in CI.
20. **Claim:** DESIGN.md uses orange for selection, recommendation and decision; allows cards only for artifacts; homepage copy includes 'Start with a part package or open an existing project.'; the iOS team ID is set in the project; the DESIGN.md previews exist.
    - **What the repo or Linear shows:** The accent is 'oxidized red' (#C2410C) and recommendation is not a listed use. There is no cards-only rule. That homepage string was removed on 2026-04-02 (9b82022). CNCDUB33GL appears only in ExportOptions-TestFlight.plist and the release doc. The .context/design-preview files are absent.
    - **Evidence:** docs/DESIGN.md:22,97,104-114,142,209,472-473; commit 9b82022; ios/ExportOptions-TestFlight.plist:16; ios/project.yml (no DEVELOPMENT_TEAM)
    - **Impact:** Design inputs need correcting before any Lane B boards are drawn.
21. **Claim:** PR #567 rollback: 'Revert the single commit'.
    - **What the repo or Linear shows:** The PR has two commits of its own, 4590115 and 9355cb4.
    - **Evidence:** git log origin/codex/recovered-release-free-safety-20261003..origin/refactor/OVD-595-production-bundle-cleanup
    - **Impact:** Minor; rollback instructions are wrong.

## What checked out

Only items a reader checked independently.

- OVD-520 is In Progress: PR #561's merge auto-closed it to Done 43 ms before OVD-589 completed, and it was reopened on Oct 1. All five acceptance boxes are unchecked. *Evidence: Linear OVD-520 stateHistory; Blaine comment 2026-10-01T06:02:20Z; description AC list*
- OVD-520 constants match source: gateway actions pair/boot/session, 8192-byte request and 5 s server deadline, 32768-byte client response cap, flags compared with === 'true', 5 s/10 s/60 s/10 min/8 h timings, 10-minute pairing code, seven WireContract checks, 6-10 mm depth, five outstanding changes and one active native job. *Evidence: supabase/functions/engineering-worker/index.ts:4-5,212; scripts/native/worker-companion/CompanionHttp.ps1:11,31,38; scripts/native/prepared-dimension/WireContract.ps1:2-3,86,103*
- /engineering loads only in a DEV build with the flag on a loopback host and is excluded from production builds; the OVD-579 Tailscale route is a read-only sample plate, and no iPhone was verified on it. *Evidence: src/App.tsx:49-50,146-147; src/lib/engineering-workbench-access.ts:2-3; PR #551 body*
- Several regression tests the handoff proposed already exist (stale/substituted/cross-tenant STEP, finalization forgery and replay, lock-wait and revocation races, browser STEP substitution). *Evidence: docs/release/ovd-563-step-review-proof.sql:49-107; ovd-561-finalization-proof.sql:55-84; scripts/ovd561-race-proof.mjs:98-121; e2e/engineering-inbox.spec.ts:238-313*
- Main 8d8d243 CI workflow jobs passed (21 fixture and 9 authenticated browser tests); SonarCloud Code Analysis failed there; the extraction-gate 'success' is vacuous because no corpus exists. *Evidence: CI run 36828979472; playwright --list; check runs at 8d8d2435*
- The Oct 2 intake fix is real but only in #564: a synchronous pending-selection guard and a 0-byte client check, with unit tests passing in hosted CI at 084b48c. *Evidence: PR #564 diff (use-client-job-file-picker.ts uploadPendingRef; file-validation.ts); job 111275745538*
- On main, log_audit_event is an anon-callable SECURITY DEFINER function that can forge audit rows (PR #571 revokes it), and members can insert client_selections directly (closed and tested in #564). *Evidence: local catalog pg_get_functiondef/has_function_privilege; PR #571; #564 20261002041305:216-217; quote_selection_expiry.sql:21-24,99-102*
- Provider manifests match the handoff, except Xometry is entirely unknown rather than mostly unknown; 438 offline provider tests and provider:check (18 providers) pass at main; #562 (Weerg native currency) merged as 8d8d243; Quickparts stops on purpose with quickparts_reviewed_portal_evidence_missing. *Evidence: provider-integrations/*/manifest.v1.json; vitest over 17 provider files; worker/src/adapters/quickpartsPortal.ts:100*
- #572 makes the quote failure take priority over a snapshot-teardown failure and tests it (xometry 83/83, fictiv 19/19 on a scratch export). *Evidence: xometry.ts withSnapshotTeardownDiagnostic; xometry.test.ts quarantine test*
- #567 cuts the App chunk from 1,806 kB to 477 kB; #570 fixes 85 strictNullChecks errors; #567+#569+#570 merge with one modify/delete conflict on QuoteChart.tsx and typecheck once it is deleted. *Evidence: vite build of #564 base and a046191a; tsc -p tsconfig.app.json; git merge-tree*
- Release-path tracker state: OVD-527, 419, 206, 199 and 541 are Blocked; OVD-528/529 Backlog; OVD-541's prepared PATCH has not run; OVD-551, 585 and 359 are Done; iOS issues OVD-221/282/283/339 are Backlog. *Evidence: Linear get_issue per ID (read 2026-10-04)*
- Oct 3 comments from Blaine's account exist: OVD-536 'proceed with the narrow source-only fix' and OVD-457/OVD-380 'provider-neutral chain may proceed before OVD-206; Xometry unchanged'. Authorship is unconfirmed. *Evidence: Linear comments e940fe5c, 5a64d264, 412990b2 (16:43:30-16:43:37Z, onBehalfOf null)*
- The DESIGN.md core rules (bone surfaces, hairlines, 4 px radius cap, mono data, no shadows or gradients) are implemented in tokens, and the launch shell and list pages conform with zero violations. *Evidence: docs/DESIGN.md:22,91,230-233; src/index.css:17-25,60-62; QuoteIntelligenceShell.tsx:54,138,259*
- iOS: bundle id com.optomachina.overdrafter, iOS 17.0, iPhone and iPad (no Catalyst), default origin overdrafter.vercel.app, first-beta Parts | Quotes | Search shell; PR #271 (dark-mode sidebar fix) closed unmerged. *Evidence: ios/project.yml:36-41; ios/Configurations/Base.xcconfig:1-11; ios/OverDrafter/App/AppDestination.swift:4-6; PR #271 head 5171429*

## Open questions

### The 5 most blocking

1. How should the phone reach /engineering for the OVD-520 run? *(OVD-520 proof path)*
2. Which backend should the OVD-520 run use: hosted Supabase production, or a private Supabase on Workstation behind Tailscale? *(OVD-520 proof path)*
3. What should happen to draft PR #565, and may agents edit it? *(OVD-520 proof path)*
4. How should Sonar findings on the stack be dispositioned, and can sonarcloud.io egress or issue exports be provided? *(Release & DB)*
5. What is the 1.0 provider bar: seven providers in total (OVD-585's list) or eight, and must all be production-certified before Founding Beta invitations, or only five CNC providers with all seven needed for 1.0 completion? *(Providers & quoting)*

### OVD-520 proof path

1. **How should the phone reach /engineering for the OVD-520 run?** **[top 5]**
   - Why it matters: Today the route loads only in a DEV build, with the flag, on loopback, and is excluded from production builds, so AC2 cannot be met.
   - Options: (a) Private Tailscale Serve route like OVD-579 with the host gate relaxed to the tailnet host; (b) hosted production deployment behind a flag and allowlist (protected); (c) the iOS app (Lane B).
   - Source: synthesis Q2; reader-ovd520 G1; ovd520-plan open question 2
2. **Which backend should the OVD-520 run use: hosted Supabase production, or a private Supabase on Workstation behind Tailscale?** **[top 5]**
   - Why it matters: It decides which protected migration, credential and principal steps are needed and whether production data is touched at all.
   - Options: Hosted production (after an OVD-558 manifest refresh) or a self-hosted private stack.
   - Source: synthesis Q3; ovd520-plan open question 3
3. **What should happen to draft PR #565, and may agents edit it?** **[top 5]**
   - Why it matters: It holds the only server pieces for OVD-520 steps 6 and 9-11, says it is preservation-only, has red CI and Sonar D/D, and conflicts with #564 in 3 files. A 2-line '@vitest-environment node' fix turns its 5 failing tests into 23/23 passing; windows-desktop-inert is undiagnosed.
   - Options: (a) Fix CI and land it whole; (b) split into bounded per-contract PRs; (c) keep as reference and rebuild the pieces.
   - Source: synthesis Q1; reader-ovd520; ovd520-plan open question 5 and rejected P1/P2
4. **Which interpretation adapter should produce the 7 mm interpretation?**
   - Why it matters: engineering-interpretation has no adapter and refuses even when enabled.
   - Options: Deterministic classifier, no model call ($0); the adapter OVD-578 used, through a server-side credential; or the hosted model the docs name (20-cent reserve per request, capped at $40/month).
   - Source: synthesis Q5; ovd520-plan open question 4
5. **Must a native_startup_timeout failure also get zero automatic retries for OVD-520, or may the database's single classified retry stay as a documented exception?**
   - Why it matters: The database still grants that retry and three docs specify it; PR #576 pinned native_operation_failed only, and the deferred route-level pin (A5) waits on this.
   - Options: (a) Rely on the worker route plus tests; (b) revoke or disable api_request_native_retry for the pilot; (c) document the exception in engineering-automatic-loop.md, engineering-task-coordinator.md and engineering-control-plane.md.
   - Source: synthesis Q9; ovd520-plan open question 1 and rejected A5; PR #576 follow-up
6. **May the SolidWorks session that OVD-578 keeps open (PID 7460) be closed before the OVD-520 run?**
   - Why it matters: The prepared runner aborts if any SLDWORKS process exists (run.ps1:245), while the OVD-578 rules say never to kill that session.
   - Options: Close it manually before the run, or schedule the run when no sample-plate session is active.
   - Source: synthesis Q16; ovd520-plan open question 6
7. **How should the worker be paired and enabled for the run?**
   - Why it matters: The database functions exist but no UI calls them, and enablement must come from the owner, not the worker.
   - Options: A minimal operator screen (needs a Lane B pick) or a one-off authenticated script run in the activation packet.
   - Source: synthesis Q15; ovd520-plan open question 8
8. **Which surfaces must label results as simulation, retained replay or new native output, and should the STEP review also show the task and attempt IDs?**
   - Why it matters: OVD-520 AC5 and U16 need it; retained fixture bytes render exactly like real results, and the attempt-binding display unit (A6) was deferred because it adds new copy.
   - Options: Surfaces: private sample plate, engineering exact-STEP review, or both. Form: text-only provenance line (Lane A) or designed badge (Lane B).
   - Source: synthesis Q14; ovd520-plan open question 7 and rejected A6; reader-gates_e2e U16
9. **Should the staged native SQL proof chain run as a non-required, path-scoped CI job (unit C1), and may the reviewed baseline commit 000d82a3 be pinned with a tag?**
   - Why it matters: The D0 regression went unnoticed because no CI runs these proofs, and no ref contains 000d82a3, so CI depends on GitHub keeping an unreferenced object.
   - Options: Approve C1 and the tag; approve C1 only; or keep proofs manual.
   - Source: ovd520-plan open question 10; C1 unit
10. **Where should the OVD-520 recording and exact-source evidence live?**
    - Why it matters: AC5 needs a recording plus exact-source evidence, and the location decides what reviewers can check.
    - Options: Linear attachment on OVD-520; a private evidence folder with a SHA-256 manifest; or both.
    - Source: synthesis Q40; ovd520-plan open question 9
11. **Should OVD-511 be closed with evidence links or kept open for the protected production finalization activation?**
    - Why it matters: It is Backlog and still formally blocks OVD-520 while its children OVD-560 and 561 are Done.
    - Options: Close with links; or keep for production activation.
    - Source: synthesis Q39; ovd520-plan open question 11

### Release & DB

12. **How should Sonar findings on the stack be dispositioned, and can sonarcloud.io egress or issue exports be provided?** **[top 5]**
    - Why it matters: The #564 gate fails (D Reliability, D Security) and blocks the whole stack; GitHub annotations show at most 50 issues per head, so #573 (104), #574 (77) and #564's bugs and vulnerabilities are not fully visible; AGENTS.md:56 requires inspection at the final head.
    - Options: (a) You mark false positives in SonarCloud; (b) scoped NOSONAR suppressions; (c) fix the code; plus allow egress or provide exports.
    - Source: synthesis Q10; reader-prstack; reader-linear_release
13. **Should new Lane A work stay stacked on the #564 release branch, and should green, reviewed children (#566-#572 and this run's stacked PRs) merge into it before the release window?**
    - Why it matters: This run stacked most PRs on #564/#574 because units built on main conflict with #564's runner, harness, seed and migrations; PRs targeting main (#575, #576, #577, #579, #581, #582) deploy production when merged; folding children in widens the protected release packet.
    - Options: (a) Keep stacking and merge each child into #564 when green and reviewed; (b) hold children until #564 lands, then retarget to main; (c) merge only non-migration children now; and keep or retarget the main-based PRs.
    - Source: synthesis Q4, Q12; plan-1.0 open question 4; reader-intake_db; reader-providers; reader-ui_design_ios
14. **In the release window, should the five September 10 engineering migrations be applied with the stack or excluded again?**
    - Why it matters: The hosted ledger is non-prefix (21 identities absent), so the dry-run selection cannot be finalized without an answer.
    - Options: (a) Exclude, as on 2026-09-24; (b) include.
    - Source: synthesis Q37; reader-linear_release
15. **Should #572 (OVD-593) merge with AC1 partly met (deploy sandbox default stays true, flip tracked separately), or wait for the protected Cloud Run smoke?**
    - Why it matters: AC1 cannot be met in source alone without breaking the pinned OVD-419/410 contracts.
    - Options: Merge now with a follow-up; or hold.
    - Source: synthesis Q20; reader-prstack
16. **Is automatic Xometry quoting (rollout control, or the free-beta allowance after #564) enabled or planned for any production organization?**
    - Why it matters: It sets OVD-598's urgency; the legacy race is reachable only when admission is enabled.
    - Options: Enabled now; planned for the release window; not planned.
    - Source: synthesis Q38; reader-intake_db
17. **How should duplicate intake be handled beyond concurrent selections: what happens when a customer re-selects the same STEP after intake finished, and should the server enforce an idempotency key?**
    - Why it matters: Today re-selection always creates a new part, and the #564 guard does not cover two tabs or a retry after an unknown outcome; a server key is a contract and schema change.
    - Options: Re-selection: (a) open the existing part, (b) warn and let the customer choose, (c) create a new part. Server key: new child issue, or client-only for 1.0.
    - Source: synthesis Q22, Q23; reader-gates_e2e; reader-intake_db
18. **How strict should intake validation be: may the server reject a null p_size_bytes (SERVER-EMPTY-FILE-REJECTION), and should a .step/.stp without the ISO-10303-21 header be rejected?**
    - Why it matters: Null currently defaults through and the only app caller always sends file.size; renamed non-STEP files are accepted today; both are customer-visible contract changes.
    - Options: Null: reject, or allow and reject only zero/negative/empty-hash. Header: browser check only; browser plus worker pre-extraction; leave as is.
    - Source: plan-1.0 open question 3; synthesis Q24; reader-intake_db
19. **#563 (MCP plugin spike) and #564 both add docs/chatgpt-plugin-foundation.md and server/chatgpt/oauth-bridge*.ts: which version is canonical?**
    - Why it matters: After #564 lands, #563 cannot merge without an ownership decision.
    - Options: #564 wins and #563 rebases; #563 supersedes; or close #563 as absorbed.
    - Source: synthesis Q43; reader-prstack

### Providers & quoting

20. **What is the 1.0 provider bar: seven providers in total (OVD-585's list) or eight, and must all be production-certified before Founding Beta invitations, or only five CNC providers with all seven needed for 1.0 completion?** **[top 5]**
    - Why it matters: Linear's Oct 3 text, the docs (founding-beta-program.md:34, PRD.md:64) and the project milestones disagree; the answer decides whether RMFG (OVD-580) and OSH Cut (OVD-402) block launch.
    - Options: Count: (a) seven total, (b) eight, naming the eighth. Gate: (a) five CNC before invitations, seven for completion; (b) all seven before invitations; (c) another split.
    - Source: synthesis Q7, Q8; reader-linear_release; reader-providers
21. **How should the 6061-T6 CNC same-package requirement be met, given Weerg and Geomiq evidence only 6082, Xometry's manifest is all unknown, and no canonical material key or tolerance rule exists?**
    - Why it matters: Only five of the named seven are CNC, so all must qualify with no slack; Fictiv and Quickparts tolerance is unknown; PR #581 records the full eligibility table as evidence.
    - Options: (a) Require 6061 evidence from Weerg and Geomiq; (b) change the validation material or accept 6082; (c) allow substitutes with 6061 evidence (RapidDirect, Protolabs, SendCutSend); (d) lower the CNC count; plus a reviewed canonical material map and whether standard +/-0.005 in counts as explicit.
    - Source: synthesis Q17, Q30; reader-providers; PR #581
22. **For 1.0, should non-USD provider quotes (Weerg in EUR) be excluded, shown in native currency with a label, or converted?**
    - Why it matters: Customer schema and UI are USD-only, so U8 cannot be tested, the OVD-432 adapter stays fail-closed, and Weerg counts toward the bar.
    - Options: (a) Exclude and test the exclusion; (b) native-currency columns and display (migration plus UI); (c) convert at a dated rate.
    - Source: synthesis Q18; reader-gates_e2e U8; reader-linear_release
23. **With a seven-provider set, should the Founding Beta keep its 20-run / 4-week cap by routing a subset per attempt, or will you approve a higher cap?**
    - Why it matters: Seven-way fan-out exhausts 20 runs in fewer than three attempts, while the minimum evidence is five attempts.
    - Options: (a) Keep 20 and route a subset; (b) approve N runs / $X.
    - Source: synthesis Q19; reader-linear_release
24. **Should the legacy procurement handoff (shipping, billing, 'OverDrafter can coordinate manual release', reached from the 'Review order' button) stay reachable for 1.0 customers?**
    - Why it matters: The 1.0 contract is a handoff to the official vendor with no order implied, yet smoke.spec.ts:119-143 asserts the legacy flow and the decision panel shows a 'Review order' button.
    - Options: (a) Keep as non-order follow-up; (b) hide it and rewrite the smoke tests; (c) reword and keep.
    - Source: synthesis Q21; reader-gates_e2e U13; PR #585 finding 6
25. **How should invalid quotes and decisions be presented: should commercially expired offers leave the 'live offers' count (which also ignores sourcing scope), and does U12 'refresh preserves prior decision' mean a page reload or a requote?**
    - Why it matters: PR #585 shows an expired but recently quoted offer counted as live and the count unchanged under US-only; U12 is untestable until 'refresh' is defined and the invalidity copy is set.
    - Options: Count: exclude expired, or keep with label. U12: (a) page reload plus invalidation after a requirement change; (b) the requote flow (OVD-460, Backlog).
    - Source: PR #585 findings 2-3; synthesis Q29; reader-gates_e2e
26. **Does the Oct 3 ordering lift also clear the OVD-380/413/414 blockers on OVD-461-463, and must OVD-567 change only the generic preflight, leaving the Xometry five-argument preflight byte-identical?**
    - Why it matters: OVD-414 changes Xometry file selection and the OVD-413 parent says to replace the Xometry preflight, both against 'Xometry unchanged'; OVD-567/568/462/463 were deferred on this.
    - Options: Start 462/463 standalone now or hold until 567/568 merge; defer OVD-414 until after OVD-206; OVD-567 generic-only now, or include Xometry under a separate certification.
    - Source: synthesis Q31, Q32; reader-providers; plan-1.0 deferred
27. **For OVD-462, should the session lease be DB-backed (atomic across Cloud Run instances) or worker-local with a documented single-instance constraint?**
    - Why it matters: The issue says 'no schema expansion' but requires exactly one holder, which a local lock cannot guarantee across instances.
    - Options: Worker-local with a single-instance constraint; or a reviewed lease-table migration.
    - Source: synthesis Q34; reader-providers
28. **Will you push local commit 72b45234 (Quickparts '#/' route, branch codex/ovd429-provider-recovery on the Mac mini), or should an agent re-create it on #564?**
    - Why it matters: No pushed ref contains the fix, and duplicating it risks divergence; #564 edits the same file.
    - Options: Push it; authorize re-creation based on #564 (quickpartsPortal.ts:96); or wait for the authenticated observation.
    - Source: synthesis Q33; reader-providers; plan-1.0 deferred OVD429

### Security & privacy

29. **For OVD-541, should leaked-password protection be enabled now with the prepared PATCH, or deferred for this release with a recorded rationale?**
    - Why it matters: OVD-541 blocks OVD-527, which blocks OVD-419, OVD-206 and OVD-199.
    - Options: (a) Enable now (protected); (b) defer with rationale.
    - Source: reader-linear_release; synthesis protected_actions
30. **Should the account-switch leak fix (ACCOUNT-SWITCH-NAV-LEAK-FIX) be fast-tracked independently of the #564 stack once its PR is up?**
    - Why it matters: PR #583 showed the next signed-in account briefly seeing the previous account's parts list (client-side; PostgREST returned [] for the outsider), which violates R9; the fix is stacked on #583, which is stacked on #564. Whether main reproduces it was not checked.
    - Options: Fast-track to main after confirming main reproduces; or ride the release packet.
    - Source: PR #583; args-1.0b ACCOUNT-SWITCH-NAV-LEAK-FIX
31. **What is the U17 production-surface policy: ship #567's debug-route gating to main now, may '?debug=1' enable Diagnostics and Extraction for client users, and must fixture bytes be excluded from the bundle?**
    - Why it matters: Main registers /debug/concepts and /debug/state-gallery in production builds; #567 waits on the protected window; the production-surface test needs defined expectations; excluding fixtures is a refactor that collides with #570.
    - Options: Gating: ship separately now, or with #564. ?debug=1: support feature, internal roles only, or dev builds only. Fixtures: runtime inertness is enough, or exclude the bytes.
    - Source: plan-1.0 open question 1; synthesis Q25, Q26; reader-gates_e2e
32. **Should anon and authenticated lose the broad legacy grants (TRUNCATE, TRIGGER, REFERENCES and unused DML) on the 45 public tables?**
    - Why it matters: RLS is the only protection and TRUNCATE bypasses RLS; OVD-536 left broad ACL changes out of scope; PRIV-DEFINER-ALLOWLIST (OVD-602) pins today's posture as known debt.
    - Options: Revoke in a new child issue (migration plus protected apply); or keep, pinned as known debt.
    - Source: synthesis Q35; reader-intake_db
33. **Should customer errors replace PostgREST JSON payloads (code, details, hint) with 'Something went wrong.', and may an email deny-pattern apply given approved enrollment copy includes the support email?**
    - Why it matters: ERROR-SANITIZATION was re-scoped to tokens, service_role, storageState and stack frames because both changes would break approved copy or a pinned test.
    - Options: Replace PostgREST JSON or keep; email pattern never, or only outside approved messages.
    - Source: plan-1.0 open question 2; args-1.0c ERROR-SANITIZATION-SCOPED
34. **Should archive-delete safety (OVD-540-550, draft PR #530) become a 1.0 gate?**
    - Why it matters: It is a real data-loss risk that OVD-551 removed from the worker-release gate, and #530 conflicts with #566.
    - Options: (a) Post-1.0 backlog; (b) 1.0 gate.
    - Source: synthesis Q42; reader-linear_release
35. **Should worker screenshot and trace capture for Xometry and Fictiv be masked or disabled, and should DOM captures move to the metadata-only policy?**
    - Why it matters: Raised as a #572 follow-up that could not be filed in Linear.
    - Options: Mask; disable; or move to metadata-only.
    - Source: PR #572 body follow-up (b)

### UI/design/iOS

36. **Once P1/P2/P3 boards exist, which design direction do you pick, are legacy and internal surfaces in scope, and should the Oct 3 diagram style be used anywhere?**
    - Why it matters: No boards have been produced yet (B1 did not run). Lane B units and iOS polish wait on the pick; legacy and internal surfaces hold most violations but OVD-332 scopes them out; the diagram style conflicts with DESIGN.md's single-accent rule and has no artifact.
    - Options: P1 daylight refinement; P2 engineering-console accents (needs a Decisions row); P3 drawing-sheet title block. Legacy: now or post-1.0. Diagram style: docs only, JARVIS surfaces, or not at all.
    - Source: synthesis Q44, Q51, Q54; reader-ui_design_ios
37. **Which anonymous landing, headline, CTA labels and public positioning are canonical?**
    - Why it matters: '/' and signed-out /parts show different landings with conflicting CTAs ('Sign in'/'Log in', 'Sign up for free'/'Create account'/'Upload a part package'); '/' has no footer; the title still says 'Machined Aluminum Sourcing'.
    - Options: Unify on one landing or align both; keep 'CAD In / Parts Out' and pick one CTA pair, or write new copy; keep or replace the title and og:title.
    - Source: synthesis Q45, Q46; reader-ui_design_ios
38. **Fonts: license the specified faces, self-host the free analogs, or accept the system fallback for now?**
    - Why it matters: Production likely renders system-ui; DESIGN.md says the analogs should not ship; a license purchase is protected.
    - Options: Purchase (protected); self-host OFL analogs (dependency exception); defer.
    - Source: synthesis Q47; reader-ui_design_ios
39. **How should the DESIGN.md contradictions be settled (wordmark colour, 44/32/56 px command strip, circular avatar vs 4 px cap, 2 vs 4 px inputs), and should status labels move to READY/REVIEW/HOLD/FAIL/QUEUE?**
    - Why it matters: Lane A conformance work and the badge-contrast fix cannot pick a side; wording is a product decision.
    - Options: Pick each value as a Decisions row; adopt or keep current status labels.
    - Source: synthesis Q48, Q49; reader-ui_design_ios
40. **OVD-332 says the part workspace keeps context in an inspector, but DESIGN.md:180 and client-shell.spec.ts:162 say there is no persistent inspector: which is current?**
    - Why it matters: It decides the docs-drift unit (deferred) and whether OVD-332's criteria need rewriting.
    - Options: No inspector (rewrite OVD-332); or inspector (change design and tests).
    - Source: synthesis Q50; plan-1.0 deferred UI-DOCS-DRIFT
41. **Should the interim dark palette be kept, redesigned or removed, and should --muted-ink be darkened or kept off --surface-2 rows?**
    - Why it matters: The dark accent measures 3.82:1 with a blue-violet sidebar primary; --muted-ink on --surface-2 is 4.35:1, below AA for small text; both are token decisions.
    - Options: Dark: keep, commission, remove. Muted ink: darken, or restrict usage.
    - Source: synthesis Q52, Q53; reader-ui_design_ios
42. **If the first axe scan finds serious or critical violations, must all be fixed before 1.0, and is the desktop target exactly 1440 px (tests use 1512)?**
    - Why it matters: It decides whether the deferred a11y unit stays test-only or pulls in visual fixes needing your design pick.
    - Options: (a) Fix all; (b) Linear-tracked allowlist with a narrowed claim; (c) mix by severity.
    - Source: synthesis Q28; reader-gates_e2e R28
43. **What should the user-facing name for the JARVIS engineering loop be?**
    - Why it matters: The UI says 'Engineering' and 'Ask OverDrafter', and DESIGN.md anti-references include personified assistants.
    - Options: Keep 'Engineering' or 'Ask OverDrafter'; adopt 'JARVIS'; other.
    - Source: synthesis Q55
44. **Is iOS out of 1.0, and if it resumes, ship TestFlight with the Parts | Quotes | Search shell or build the approved INBOX | PARTS | QUOTES | MORE + ASK shell first?**
    - Why it matters: It needs a paid Apple account (OVD-282), a Mac and a Lane B pick; the iPad dark-mode sidebar fix exists only on closed PR #271.
    - Options: (a) Stay deferred; (b) TestFlight the current shell; (c) build the approved shell first.
    - Source: synthesis Q56; reader-linear_release; reader-ui_design_ios

### Process & tooling

45. **Did you personally write the Oct 3 'Decision' comments on OVD-199, 319, 358, 380, 457 and 536?**
    - Why it matters: All were posted from your account within 4 seconds; the provider-chain go-ahead, the OVD-536 narrow fix and the provider bar rest on them, and this run's OVD-598 (#580) and PRIV-DEFINER-ALLOWLIST stack on #573/#574 because of them.
    - Options: Confirm all; confirm some (name them); or retract.
    - Source: synthesis Q6; reader-linear_release; reader-providers
46. **Who should perform the independent reviews AGENTS.md requires, given every stack PR and every PR from this run is a draft that CodeRabbit skips?**
    - Why it matters: No PR has a review or thread; security and concurrency boundaries (#572, #580) need an independent review recorded before merge.
    - Options: Move PRs to ready-for-review for bot coverage; a separate reviewer session; you review; or a mix by risk.
    - Source: reader-prstack G1/G2/G8; synthesis critic; PR #580 body
47. **Do you ratify running a full local Supabase stack (about 8 containers) in the cloud container for pgTAP and authenticated e2e, beyond the two-container fixture-lane ceiling, or should those units be verified in hosted CI only?**
    - Why it matters: This run did so on synthetic data (treated as resolved by its own environment notes, not by you); without ratification about 12 units can be verified only in hosted CI.
    - Options: (a) Allowed with exclusive ownership; (b) CI-only; (c) allowed only with a distinct project_id and ports.
    - Source: synthesis Q11; plan-1.0 open questions ('Q11 resolved by ENV.md'); ENV.md
48. **Where do the UI acceptance checklist (U1-U18) and release-proof list (R3-R28) live?**
    - Why it matters: Neither is in the repo or Linear, so every gate mapping and coverage claim here is anchored to task text only.
    - Options: Point to the source; or adopt ACCEPTANCE_CRITERIA.md and TEST_STRATEGY.md as canonical.
    - Source: synthesis Q13; reader-gates_e2e; reader-linear_release
49. **Which dependency changes do you approve: @types/three plus a quoted-sample .d.ts (full strict), removing unused @radix-ui/react-popover, and adding @axe-core/playwright?**
    - Why it matters: OVD-595 and OVD-332 restrict new dependencies; the full-strict follow-up and the axe scan are deferred on this.
    - Options: Approve any subset; or defer.
    - Source: synthesis Q27; reader-prstack; plan-1.0 deferred A11Y-AXE
50. **May a PR close an acceptance item with 'inconclusive' or missing evidence when this environment blocked it, or must a permitted operator supply it?**
    - Why it matters: OVD-596's repeat evidence may stay inconclusive if the base shows no flake on a quiet host; the session permission guard refused the #583 case-4 mutation and #581's Weerg-manifest mutation, so those items are unmet.
    - Options: Accept with disclosure; require an operator run; or require a load-reproduction harness for OVD-596.
    - Source: plan-1.0 open question 6; PR #583 and #581 bodies
51. **Which Linear parents should the new child issues use?**
    - Why it matters: #564 could not verify its issue association; the run assumed intake under OVD-527, privilege under OVD-419, e2e under OVD-319, meta under OVD-359 and provider evidence under OVD-199.
    - Options: Confirm those; or one new parent.
    - Source: synthesis Q36; plan-1.0 open questions
52. **Should OVD-597 AC1 be met by an actual setup dedupe (a composite action was drafted this session) or closed with a written disposition, and should CI drop the Playwright cache in favour of 'install-deps chromium'?**
    - Why it matters: Linear marked AC1 done when no dedupe existed; the drafted composite action's push landed only partially; CI never launches the bundled Chromium.
    - Options: Keep the composite action; accept the disposition; adopt or decline the install-deps change.
    - Source: synthesis Q41; PR #566 follow-ups
53. **Is the #583 seed change acceptable as the default local seed (demo org enrolled, client.demo accepts the notice, an unenrolled org with a complimentary grant, rollout enabled)?**
    - Why it matters: It changes scripts/seed-dev.mjs for every local developer and needs host psql.
    - Options: Accept as default; or move behind a flag.
    - Source: plan-1.0 open question 5; PR #583

### Billing/plan

54. **How should the Linear free-plan issue limit be handled: upgrade the plan, free capacity by archiving or deleting issues, or keep issue specs in the handoff?**
    - Why it matters: Only OVD-599 to OVD-603 could be created; about 13 run PRs or units say 'issue pending', and #572's two follow-ups were refused. Upgrading or deleting is a protected action.
    - Options: Upgrade (purchase); archive/delete (deletion); keep specs in the handoff and file later.
    - Source: run facts; PR #572 body; pending_issue_specs

## Protected and owner-only actions

Agents did not and will not do these. Do not paste any secret value into a ticket, PR or chat when acting on them.

1. **Rotate the shared credential that was pasted into an agent prompt on 2026-09-27 (~08:44) and is still in a local ~/.codex/sessions log.**
   - Why protected: Credential change.
   - Needs first: None; do first.
   - Related: PR #564 body owner action 5 (not independently verifiable here)
2. **Run the production DB release window: exact dry-run selection against the hosted ledger (112 as of 2026-09-26), apply the approved migrations through #136 including #134 after #571's read-only pre-check, then read back grants and advisors.**
   - Why protected: Production database change.
   - Needs first: Sonar disposition; September 10 migrations decision; reviews on the stack; stack-base decision.
   - Related: OVD-527, OVD-536, OVD-419; PRs #564, #571, #573, #574
3. **After the apply, merge #564 to main (auto-deploys Vercel production), then the children in order: #566/#567/#568/#569/#571/#572, #570 (delete QuoteChart.tsx), #573, #574, then later stacked PRs such as #580.**
   - Why protected: Production deploy.
   - Needs first: Release-window apply; current-head gates, review and Sonar inspection.
   - Related: OVD-527; PR #564 stack
4. **Merge any of this run's PRs that target main (#575, #576, #577, #579, #581, #582).**
   - Why protected: Each merge auto-deploys Vercel production; merging was not authorized in this run.
   - Needs first: Hosted checks green at head; independent review; Sonar inspection.
   - Related: OVD-599, OVD-600, OVD-603
5. **Apply later Lane A migrations to production: OVD-598 #137 (#580), server empty-file rejection #138 (OVD-601), OVD-567 if built, and any Storage bucket limit or grant revocation you choose.**
   - Why protected: Production database and configuration change.
   - Needs first: Release window; the grants decision.
   - Related: OVD-598, OVD-601, OVD-567
6. **OVD-541: GET then PATCH password_hibp_enabled=true on the hosted Supabase project, with read-back and advisor recapture, or sign a deferral.**
   - Why protected: Production Auth configuration.
   - Needs first: Your enable-or-defer decision.
   - Related: OVD-541 blocks OVD-527, 419, 206, 199
7. **Mark triaged Sonar false positives on #564 and #574 in SonarCloud, or authorize scoped in-code suppressions instead.**
   - Why protected: Owner-only SonarCloud action.
   - Needs first: Sonar disposition decision.
   - Related: PRs #564, #573, #574
8. **OVD-527: approve the billing-disabled proof on the selected final SHA, then one billed Cloud Build image from that exact clean SHA.**
   - Why protected: Spending and production build.
   - Needs first: Stack merged; clean final SHA selected; OVD-541 resolved.
   - Related: OVD-527
9. **OVD-528: one-use approval to promote the digest to the Cloud Run Job and service with bounded automatic rollback.**
   - Why protected: Production worker deployment.
   - Needs first: OVD-527 image.
   - Related: OVD-528
10. **OVD-529: one approval covering exactly two sequential fresh-instance, no-upload Xometry auth probes.**
    - Why protected: Production execution against a provider.
    - Needs first: OVD-528 promotion.
    - Related: OVD-529, OVD-419
11. **OVD-593: Cloud Run smoke of non-root sandboxed Chromium and Camoufox, then flip the deploy sandbox default together with the OVD-419/410 contracts.**
    - Why protected: Production worker configuration.
    - Needs first: #572 merge decision.
    - Related: OVD-593; PR #572
12. **OVD-206: approve the validation package, immutable scope, session and operator, window, and spend/run cap for the five-run, two-session hosted Xometry series.**
    - Why protected: Provider quote execution and spending.
    - Needs first: OVD-419 final digest; OVD-416 reconciliation.
    - Related: OVD-206, OVD-199
13. **Live provider work needing credentials, MFA or CAPTCHA plus exact-file approval: Quickparts OVD-429, Weerg OVD-432, Geomiq OVD-435, Fictiv OVD-395/566 (password handoff), RMFG OVD-580, OSH Cut OVD-402.**
    - Why protected: Credentials and provider/customer-file operations.
    - Needs first: Provider bar decision; for Quickparts, the 72b45234 route fix.
    - Related: OVD-199, OVD-319
14. **OVD-520 X1: exact-source qualification on Workstation (Windows PowerShell 5.1, SolidWorks 2022 SP5, standalone Roslyn csc, prepare-runtime), including closing or scheduling around OVD-578's SolidWorks session (PID 7460).**
    - Why protected: Real Windows/SolidWorks machine actions.
    - Needs first: SolidWorks-session decision; a single activation commit with hosted CI green.
    - Related: OVD-520, OVD-578
15. **OVD-520 X2: backend activation packet: schema apply to the chosen target after an OVD-558 manifest refresh; principals and credentials (service role key, stop executor token, receipt HMAC key, verifier JWT issuer, private Storage bucket, model credential and spend); flags; allowlist and admission records.**
    - Why protected: Database apply, credentials, spending.
    - Needs first: Backend, adapter, #565 and pairing decisions; A1-A3 and C1 landed or declined.
    - Related: OVD-520, OVD-558
16. **OVD-520 X3: run and record the single connected phone-to-SolidWorks 7 mm request, labelled simulation vs replay vs native.**
    - Why protected: Real native action.
    - Needs first: X1, X2, phone-route decision.
    - Related: OVD-520 AC1-AC5
17. **U18: authenticated production smoke from signup to official vendor handoff on the deployed release candidate (real account, enrollment grant, provider dispatch of the approved package).**
    - Why protected: Production account, data and provider dispatch.
    - Needs first: Release window; e2e units landed; OVD-206.
    - Related: OVD-319
18. **Production read-backs: current migration ledger, advisor counts, grants, automatic-Xometry enablement, deployed SHA, and whether /debug/* is served.**
    - Why protected: Needs production credentials and access this environment does not have.
    - Needs first: None.
    - Related: OVD-419, OVD-598, U17
19. **OVD-358: send Founding Beta invitations, only after OVD-319 certifies.**
    - Why protected: External communication.
    - Needs first: OVD-319 certification; provider bar and run-cap decisions.
    - Related: OVD-358, OVD-319
20. **OVD-282: activate the paid Apple Developer identity (team CNCDUB33GL); later OVD-283 TestFlight upload.**
    - Why protected: Purchase and publishing.
    - Needs first: iOS scope decision.
    - Related: OVD-282, OVD-283
21. **Buy font licenses, if chosen.**
    - Why protected: Purchase.
    - Needs first: Fonts decision.
    - Related: DESIGN.md:66
22. **Upgrade the Linear plan, or archive/delete issues to free capacity.**
    - Why protected: Purchase or deletion.
    - Needs first: Linear plan decision.
    - Related: pending_issue_specs; PR #572 follow-ups
23. **Push or hand over owner-only artifacts that are on no remote: local commit 72b45234, branch feature/OVD-520-phone-loop, jarvis-source-complete-e5e3db0.bundle, the handoff zip (SHA-256 af316c1d...).**
    - Why protected: Not protected under AGENTS.md, but only you hold them.
    - Needs first: None.
    - Related: OVD-429, OVD-520, PR #565

## Units without a Linear issue

Issues that do exist from this run: OVD-599 (race-proof role cleanup, PR #575), OVD-600 (no automatic retry after operation failure, PR #576), OVD-601 (server empty-file rejection, in progress), OVD-602 (privilege inventory test, in progress), OVD-603 (composer re-entrancy, PR #577). Existing issues with run PRs: OVD-595 (#567), OVD-598 (#580). Everything below still needs an issue, or already has an older one where noted. Each spec is ready to paste once Linear has room.

### PR open

- **A7-failure-states-browser-fixture** (pr-open #582): Show failed and canceled changes truthfully in a browser fixture
  - Scope: One new @fixture Playwright spec with a Node-side mock: failed Change 1 blocks Change 2, no geometry, truthful Canceled states. Proposed parent OVD-520 (never named in the PR).
  - Acceptance: Field-scoped labels for both changes before and after cancel; No STEP-review request and zero non-GET requests; Mutation (Change 2 'queued') fails the spec; e2e:fixture 22 passed; hosted browser-test green at head
- **UI-META-FOUNDING-BETA** (pr-open #579): Replace the retired 'with Pro' offer in public meta descriptions
  - Scope: Point meta, og and twitter descriptions in index.html at the approved landing paragraph and pin them with a contract test. Proposed parent OVD-359.
  - Acceptance: Contract test fails on old index.html, passes after; dist/index.html has no 'with Pro'; Only the three description lines change; Merge deploys public copy; you merge
- **NAMED-PORTFOLIO-6061-MATRIX** (pr-open #581): Characterize the 1.0 6061 CNC package against named-portfolio envelopes
  - Scope: Test-only file evaluating the 1.0 package across the seven named providers; decision evidence, not admission. Proposed parent OVD-199.
  - Acceptance: Invariants: Weerg/Geomiq material_unknown; OSH Cut/RMFG not CNC-eligible; Xometry all unknown; '6061 aluminum' matches none; Mutation 2 recorded; Mutation 1 (Weerg manifest) refused by the permission guard and still owed; worker verify and lint pass
- **QUOTE-DECISION-FIXTURE-E2E** (pr-open #585): Browser-test quote comparison, sourcing filter, freshness and vendor links
  - Scope: New client-comparison fixture scenario and @fixture spec at 1440x900 and 390x844; no product code. Proposed parent OVD-319.
  - Acceptance: Grouping, selection sync, points-only chart, US-only vs all, missing lead time, stale/expired, vendor links, no order controls, keyboard path; Three scratch mutations each fail the spec; Reports, does not fix, the dropped first chart click and expired-offer live count; Hosted fixture step green
- **FOUNDING-BETA-SUBSCRIPTION-BYPASS-PGTAP** (pr-open #578): pgTAP: an active subscription never replaces Founding Beta enrollment
  - Scope: One rolled-back pgTAP suite (plan 44) proving subscription, allowance or complimentary grant without enrollment is denied at every draft, file and Xometry entry point. Proposed parent OVD-319.
  - Acceptance: Suite passes with no SKIP; positive control after enrollment; Mutation of resolve_founding_beta_access_state fails 24 denial assertions; Passes on #574's head; Hosted 'Test database policies' green
- **CLIENT-RPC-CROSS-ORG-PGTAP** (pr-open #584): pgTAP: anon, unverified and cross-org denials for client part/quote RPCs
  - Scope: One rolled-back pgTAP suite covering 15 untested client SECURITY DEFINER RPCs for anon, cross-org and unverified callers, with positive controls; characterizes, does not fix, two existence oracles. Proposed parent OVD-419.
  - Acceptance: No SKIP or TODO; org A data hash unchanged after all denials; Mutation removing a permission guard fails; Passes after a #574 reset; Hosted CI green
- **ACCESS-SCOPE-ENROLLMENT-E2E** (pr-open #583): Browser-test enrollment gating, cross-org denial and account-switch purge
  - Scope: Seeds two more orgs and an enrollment fixture (local only) and adds five authenticated-lane cases; found a real cross-account leak. Proposed parent OVD-319.
  - Acceptance: Locked run: new spec plus 9 smoke tests pass (case 4 opt-in until the fix lands); Case-4 mutation still owed (permission guard refused it); seed:dev idempotent and local-only; Hosted authenticated step green

### In progress, no PR yet

- **ACCOUNT-SWITCH-NAV-LEAK-FIX**: Clear the cached workspace navigation model on account or scope change
  - Scope: Key useWorkspaceNavigationModel's cached refs by user, organization and role so no frame shows the previous scope's rows; un-gate access-scope case 4. No parent named in the unit (release-proof R9 context).
  - Acceptance: Unit test fails on the base, passes after; checks every render; Case 4 fails on the base at least once, then passes 20/20 with 2 workers; No new copy; no auth semantics change; Lint, typecheck, affected vitest pass
- **INTAKE-STEP-E2E**: Browser-test STEP intake, reload restore, duplicate and empty selections
  - Scope: Authenticated-lane spec stacked on #583: upload and reload, held duplicate selection, empty file, garbage STEP. Proposed parent OVD-527.
  - Acceptance: Four cases pass in the locked run with access-scope and smoke; With the #564 guards reverted, cases 2 and 3 fail (recorded); Hosted authenticated step green; Never claims U3/U4 complete
- **ERROR-SANITIZATION-SCOPED**: Keep secrets and stack traces out of customer-visible errors
  - Scope: Replaces ERROR-SANITIZATION-E2E: deny JWT-shaped tokens, service_role, storageState dumps and stack frames in customer errors; raw boundary message only in DEV; support-email copy and PostgREST summaries unchanged. Proposed parent OVD-319.
  - Acceptance: Browser and unit tests show a leak before the fix; No sentinel in any toast, dialog or body after; Support-email enrollment message byte-identical (regression guard); No new copy; quote-confirmation lane passes
- **C1-staged-sql-proof-ci**: Run the staged native SQL proof chain in path-scoped CI
  - Scope: New standalone, non-required workflow running the disposable runner with --ovd563; stacked on #575. Proposed parent OVD-520 (never named in the PR).
  - Acceptance: Job green with OVD-560 11/11, OVD-561 24/24, races, OVD-563 21/21; A flipped expectation turns it red; revert turns it green; Baseline fetch of 000d82a3 fails closed; Not part of the ci aggregate; labelled disposable SQL, not native evidence
- **A2-step-review-peer-revocation-denial**: Deny STEP review to same-project peers and revoked owners
  - Scope: Add four assertions to the staged OVD-563 proof (peer denial, revoked-owner denial, controls) and move the runner pin from 21 to 25. Proposed parent OVD-520.
  - Acceptance: Runner exits 0 with OVD-563 25/25 locally and in the hosted proof check; Removing the owner clauses fails the peer denial; removing engineering_access fails the revoked-owner denial; If a denial fails on unmodified SQL, stop and open a security issue
- **A3-failed-attempt-terminal-proof**: Prove a failed native attempt cannot register, finalize or show geometry
  - Scope: New staged proof segment run under --ovd563: a failed attempt is denied registration and finalization, the successor stays blocked, review returns not_verified. Proposed parent OVD-520.
  - Acceptance: Exact pinned count passes locally and in hosted check; Removing the 560 phase guard or the 561 state guards fails the matching assertion; Catalog after proof equals catalog563; Labelled synthetic, not native evidence
- **A1-same-run-identity-proof**: Prove the finalized STEP review traces to its original request
  - Scope: Synthetic identity segment asserting message, interpretation, request, attempt, finalization and review IDs chain correctly. Proposed parent OVD-520.
  - Acceptance: Exact pinned count passes locally and in hosted check; A mismatched attempt in a scratch copy fails; PR states the fixture resolves the 7 mm message as 8 mm and the assertion is digest-based

### Queued

- **UI-LEGACY-SHELL-A11Y**: Accessible name for the legacy shell's mobile sheet, keyboard-operable resize, live status on auth loading
  - Scope: sr-only SheetTitle, focusable separator with arrow/Home/End, role=status on AuthBootstrapScreen; no visible copy change. Proposed parent OVD-332.
  - Acceptance: Failing vitest first; Keyboard-only pass at 390 px with no DialogTitle console error; Copy unchanged
- **UI-STATUS-BADGE-CONTRAST**: Fix WCAG-failing status badge text in quote comparison
  - Scope: Swap failing light-tone text classes for existing tokens on #564's base; labels, radius and mono wait for Lane B. Proposed parent OVD-385.
  - Acceptance: Rendered composited contrast >= 4.5:1 at 390, 768 and 1512 px; Labels unchanged; QUOTE-DECISION spec still passes
- **UI-ACCOUNT-MENU-CONTRAST**: Remove failing legacy status tones from WorkspaceAccountMenu
  - Scope: Contrast-only fix at WorkspaceAccountMenu.tsx:146, 391-399 and 438. Proposed parent OVD-332.
  - Acceptance: Rendered contrast >= 4.5:1; Enrollment meaning stays plain words; No radius changes
- **OSHCUT-ADAPTER-CONTRACT**: Run the OSH Cut adapter through the reusable provider adapter contract (existing issue OVD-402)
  - Scope: Add contract coverage plus a negative control; change oshcut.ts only behind a failing test. Low 1.0 value (not CNC).
  - Acceptance: Contract passes for the adapter; Mutated output without provenance is rejected; Stop if the repair is not bounded
- **SAMPLE-PLATE-NO-BUILD-E2E**: Private sample-plate build cannot start a build (rescoped SAMPLE-PLATE-RETAINED-LABEL-E2E)
  - Scope: Browser test: zero POST /sample-plate/api/runs, no Build button, /bootstrap only with #launch; no provenance claim until labels are decided. Proposed parent OVD-520.
  - Acceptance: Assertions as scoped; CI step outside #566's ci.yml hunks; Never names the parent
- **A11Y-KEYBOARD-NO-AXE**: Keyboard-only traversal of /parts and /quotes and CAD containment at 390/768/1512 px
  - Scope: Dependency-free remainder of the a11y unit in the fixture lane. Proposed parent OVD-319.
  - Acceptance: Keyboard path passes; No new devDependency
- **SERVER-EMPTY-METADATA-FOLLOWUP**: Finalize requires storage metadata.size to equal p_size_bytes
  - Scope: Next migration after OVD-601, only after proving storage-api v1.41.8 writes metadata.size before finalize; update founding_beta_file_boundaries fixtures. Proposed parent OVD-527.
  - Acceptance: Proof of storage-api behaviour first; Existing 38 assertions updated in the same PR
- **FOUNDING-BETA-GENERIC-PATH-FOLLOWUP**: Subscription-without-enrollment denial on generic api_request_provider_dispatch
  - Scope: Extend #578's case to the generic path once #573/#574 are accepted. Proposed parent OVD-319.
  - Acceptance: Denial asserted on the generic RPC; Waits on the Oct 3 decision confirmation
- **OVD593-FOLLOWUP-CLOUDRUN-SMOKE**: Cloud Run smoke of sandboxed non-root worker, then flip the deploy default (protected)
  - Scope: Drafted on #572; Linear refused the child issue. Smoke Chromium (playwright and patchright) and Camoufox as pwuser, then flip the default with the release-tuple contracts.
  - Acceptance: Protected smoke recorded; Default flipped with contracts in one change; Decision on tamper-evident browser assets
- **OVD593-FOLLOWUP-CAPTURE-MASKING**: Mask or disable Xometry and Fictiv screenshot and trace capture
  - Scope: Drafted on #572; Linear refused the child issue. Decide whether DOM captures move to metadata-only.
  - Acceptance: Capture policy decided; Tests pin the masking

### Deferred

- **A11Y-AXE-VIEWPORT-KEYBOARD**: Axe scan and allowlist in the fixture lane
  - Scope: Axe scan only; waits on the @axe-core/playwright approval and the fix-or-allowlist and 1440-vs-1512 decisions. Proposed parent OVD-319.
  - Acceptance: Pinned devDependency approved; Policy for serious/critical findings applied
- **U595-FIXTURES-OUT-OF-BUNDLE**: Keep client-workspace-fixtures.ts out of the production App chunk
  - Scope: Only if fixture bytes must be excluded: dynamic fixture-mode import on #567 after OVD595 and QUOTE-DECISION; collides with #570. Proposed parent OVD-595.
  - Acceptance: Bundle scan asserts bytes absent; Fixture lane still passes
- **OVD567-CAPABILITY-SNAPSHOT**: Resolve capability inside the generic dispatch preflight snapshot (existing issue OVD-567)
  - Scope: Migration #139 on the SERVER-EMPTY branch if generic-only is approved and the Oct 3 decisions are confirmed; Xometry output stays identical.
  - Acceptance: Xometry result ::text-identical; Profile re-pinned 138 to 139; Generic requests deny until capability observations exist
- **OVD568-WORKER-CAPABILITY-HANDOFF**: Bind capability decision, staged file identity and expiry in the worker preflight (existing issue OVD-568)
  - Scope: Waits on OVD-567's SQL response shape; must not overlap #574's providerDispatchPreflight.ts edits.
  - Acceptance: Starts after OVD-567; Same decisions as OVD-567
- **OVD429-QUICKPARTS-SIGNIN-ROUTE**: Restore the Quickparts '#/' sign-in root (existing issue OVD-429)
  - Scope: Only if you do not push 72b45234; re-create on #564 at quickpartsPortal.ts:96.
  - Acceptance: Offline definition and test use '#/'; No conflict with #564
- **OVD463-RESULT-VALIDATOR**: Standalone provider-neutral normalized result and provenance validator (existing issue OVD-463)
  - Scope: Waits on whether the Oct 3 lift clears OVD-380/413/414 blockers and on decision provenance.
  - Acceptance: Starts after the ordering answer
- **OVD462-SESSION-LEASE**: Atomic provider/account/environment session lease (existing issue OVD-462)
  - Scope: Waits on DB-backed vs worker-local and on the ordering answer.
  - Acceptance: Exactly one holder guaranteed under the chosen design
- **UI-DOCS-DRIFT**: Align part-workspace docs and concept briefs with the launch shell
  - Scope: Waits on the inspector question and the DESIGN.md Decisions rows. Proposed parent OVD-332.
  - Acceptance: Docs match the decided behaviour; Concept briefs marked superseded
- **UI-SYSTEM-PAGES-RESTYLE**: Bone, hairline and radius restyle of NotFound and AppErrorBoundary
  - Scope: Lane B work after the design pick; the live-region part moved to UI-LEGACY-SHELL-A11Y. Proposed parent OVD-332.
  - Acceptance: Conforms to DESIGN.md:291 after the pick
- **A5-worker-task-rejects-retry-actions**: Pin that the worker task route exposes no retry path
  - Scope: Waits on the native_startup_timeout retry decision; Deno tests run only in hosted CI. Proposed parent OVD-520.
  - Acceptance: Pin covers only what the retry decision allows; Hosted 'Test Edge Functions' green
- **A6-step-review-attempt-binding-ui**: Show geometry only when the STEP review's attempt matches the current attempt
  - Scope: Mismatch is unreachable from the real backend and the visible IDs are new copy; revisit with the provenance-label decision. Proposed parent OVD-520.
  - Acceptance: Decision on labels and IDs first

### Dropped

- **UI-SYSTEM-PAGES**: Standalone system-pages unit
  - Scope: Split: live region moved to UI-LEGACY-SHELL-A11Y; visual restyle deferred to Lane B.
  - Acceptance: None
- **ERROR-SANITIZATION-E2E**: Original error-sanitization unit
  - Scope: Superseded by ERROR-SANITIZATION-SCOPED after the email pattern would have broken approved support-email copy.
  - Acceptance: None
- **P1-pr565-vitest-node-environment**: Fix #565's failing test job with the node test environment
  - Scope: #565 is a frozen preservation checkpoint; the 2-line fix is recorded as evidence for the #565 decision.
  - Acceptance: None unless you unfreeze #565
- **P2-pr565-windows-inert-ci**: Diagnose #565's windows-desktop-inert failure
  - Scope: #565 frozen; root cause unknown (artifact 11267781542 unread); needs a Windows PowerShell 5.1 runner.
  - Acceptance: None unless you unfreeze #565

## Process deviations to disclose

- Full local Supabase stack (about 8 containers, published ports, volumes) ran in the ephemeral cloud container for pgTAP and authenticated e2e, exceeding the control-plane fixture-lane ceiling of two containers, one network and no persistent volume (docs/agent-development-control-plane.md:68-70). Synthetic data only. It was treated as allowed by the run's own environment notes, not by you.
- The readers and synthesis called the stack's owner unknown; scratchpad logs show this session started it at 08:22-08:23 UTC, reset it repeatedly under a shared lock, and restarted it with the Docker daemon around 16:53-16:54 UTC after the outage.
- The local stack excluded or patched Realtime, edge-runtime, studio, logflare, vector and imgproxy (no IPv6; deno.land blocked), so local runs are not identical to hosted CI.
- Deno Edge Function tests could not run here (deno.land blocked by egress policy); hosted CI 'Test Edge Functions' is the only evidence.
- pwsh 7.4.6 runs are PowerShell Core contract tests only; they are not Windows PowerShell 5.1, compiler or SolidWorks qualification.
- The disposable replay runner used Docker Hub images re-tagged under the public.ecr.aws names it expects; image IDs match the reviewed manifest.
- Sonar issue lists were taken from GitHub check-run annotations (capped at 50) or the bot summary because sonarcloud.io is blocked; the AGENTS.md:56 inspection is incomplete for #564, #565, #573 and #574.
- The Linear workspace hit its free-plan issue limit: only OVD-599 to OVD-603 exist; other PRs say 'issue pending', so the one-issue-per-PR contract is unmet for them. Some PR bodies (for example #582) call this an 'owner decision'; the established cause is the limit, and there is no record that you decided it.
- A spend-limit outage around 16:30-16:50 UTC interrupted agents mid-run; fixer pushes to #566 and #572 landed only partially. Verify both heads before trusting their bodies.
- The session permission guard refused two required mutation runs (#583 case-4 removeQueries; #581 Weerg-manifest mutation); those acceptance items are unmet.
- #575's hosted browser-test failed once (client-shell.spec.ts:256) and passed on rerun; the rerun is disclosed as a flake, not hidden.
- No PR from this run has an independent review yet; CodeRabbit skips drafts.
- OVD-598 (#580) and PRIV-DEFINER-ALLOWLIST were built on #573/#574, whose go-ahead rests on the unconfirmed Oct 3 decision comments.
- ERROR-SANITIZATION was re-scoped mid-run under a label reading 'owner-decision re-scope'; there is no record you made that decision. The re-scope only narrows the work to avoid two open questions.

## Notes on the sources

Where the synthesis and the individual readers disagreed, the reader's cited evidence (or this run's own logs) was preferred:

- Local Supabase stack owner: readers and the synthesis said unknown; the run's own logs show this session started it at 08:22-08:23 UTC.
- Open PR count: the Linear reader said 11 open drafts; the PR-stack reader lists 13 by number (#530, #563-#574), which is the figure used here.
- OVD-598 wait behaviour: the synthesis said an edit during issuance never waits; the plan and PR #580 show a jobs edit waits at the final jobs update but still leaves a stale permit.
- Sonar issue lists: the PR-stack reader said they cannot be read here; the synthesis showed GitHub annotations expose up to 50 per head. Both hold: sonarcloud.io is blocked, and the GitHub view is capped.
- Sandboxed browser runs: the PR-stack reader said the 50-repeat run could not run as root; the synthesis and environment notes show it runs as the non-root ubuntu user.
- PowerShell: the OVD-520 reader recorded pwsh as missing; it was installed later (7.4.6). That does not change the Windows-qualification limit.
- Linear capacity: the Linear reader inferred no current issue limit; the run then hit the free-plan limit.
- The 'local stack may be reset' answer came from the run's own environment notes, not from you; it is listed as an open question for ratification.
