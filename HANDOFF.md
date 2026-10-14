# Handoff: 2026-10-14

Lead engineer session handoff for Overdrafter (repo `optomachina/Overdrafter`, Linear team OVD, Supabase project `ozuatdcakezjtevztjlr`, Cloud Run project `overdrafter-worker-9133`).
Written at the end of the session on 2026-10-14 (UTC). Main is at `6c2e5c926868e005df0769be1ba8ae90dbc9cd1e`; CI on that commit is green (all check runs success).

State in one paragraph: window 1 is fully applied in production and recorded on main. The OVD-722 kill switch and OVD-723 export control worker code are merged. The release candidate for the worker is main `6c2e5c92`. Nothing has been built or deployed from it yet: the Cloud Run worker still runs the last known good image `sha256:3dd67a3c...` (build `25452595`). Blaine was partway through the read only preflight on his Mac when the session stopped (see Resume).

## Done

Every PR merged since 2026-10-12 (63). Merge commit is the squash commit on main.

| PR | What | Merge commit | Merged (UTC) |
|---|---|---|---|
| [#665](https://github.com/optomachina/Overdrafter/pull/665) | docs: approved 1.0 beta launch plan and business model | `15242087` | 2026-10-12 |
| [#669](https://github.com/optomachina/Overdrafter/pull/669) | OVD-569: Pure delivered-cost and arrival projection (OVD-385 slice 1) | `a9d21689` | 2026-10-12 |
| [#668](https://github.com/optomachina/Overdrafter/pull/668) | OVD-726 Treat public ECR toomanyrequests and data-limit as rate limit | `46148442` | 2026-10-12 |
| [#680](https://github.com/optomachina/Overdrafter/pull/680) | OVD-731 Match fixture session-secret markers structurally | `84b9e290` | 2026-10-12 |
| [#585](https://github.com/optomachina/Overdrafter/pull/585) | OVD-617: Browser-test quote comparison, sourcing filter, freshness and vendor links | `3e27c254` | 2026-10-12 |
| [#679](https://github.com/optomachina/Overdrafter/pull/679) | docs: lock OverDrafter pricing (Alpha free, Beta paid, Jarvis free) | `1be88029` | 2026-10-12 |
| [#569](https://github.com/optomachina/Overdrafter/pull/569) | OVD-596: Close phone nav sheet on Escape before Radix layer registers | `b376d466` | 2026-10-12 |
| [#623](https://github.com/optomachina/Overdrafter/pull/623) | OVD-654: require Chromium sandbox in fixture launchers | `69cd2cd4` | 2026-10-12 |
| [#674](https://github.com/optomachina/Overdrafter/pull/674) | OVD-730 Parse LIVE_AUTOMATION_VENDORS with the TypeScript AST | `efbe516f` | 2026-10-12 |
| [#663](https://github.com/optomachina/Overdrafter/pull/663) | OVD-692: add-quote-provider skill drives fixture:onboard at every stage | `57b2647c` | 2026-10-12 |
| [#673](https://github.com/optomachina/Overdrafter/pull/673) | OVD-729 Fail provider:check closed on envelope source, default-deny placement, readiness d | `43ec3072` | 2026-10-12 |
| [#684](https://github.com/optomachina/Overdrafter/pull/684) | OVD-732: Jev PR risk screen with a replayable decision log | `a92a06e7` | 2026-10-12 |
| [#672](https://github.com/optomachina/Overdrafter/pull/672) | OVD-728 Harden provider permissions lint | `b6a66c83` | 2026-10-12 |
| [#685](https://github.com/optomachina/Overdrafter/pull/685) | OVD-676: Geomiq live readiness through fixture:onboard (default off) | `4a4bf0f2` | 2026-10-12 |
| [#682](https://github.com/optomachina/Overdrafter/pull/682) | OVD-461: Provider authorization consumer and execution seam | `21377c7a` | 2026-10-12 |
| [#670](https://github.com/optomachina/Overdrafter/pull/670) | OVD-727 Harden provider registry secret names, live adapters, and egress messaging | `cc9a5fe8` | 2026-10-12 |
| [#686](https://github.com/optomachina/Overdrafter/pull/686) | OVD-678: RMFG live readiness through fixture:onboard (default off) | `e0ffe743` | 2026-10-12 |
| [#688](https://github.com/optomachina/Overdrafter/pull/688) | OVD-733: Never show a substitute offer as the selected quote | `9cd1f6a2` | 2026-10-12 |
| [#683](https://github.com/optomachina/Overdrafter/pull/683) | OVD-463: Validate normalized provider results and provenance | `e81603e6` | 2026-10-12 |
| [#690](https://github.com/optomachina/Overdrafter/pull/690) | OVD-732 Log Jev screens for the Oct 12 evening batch | `c21fc687` | 2026-10-12 |
| [#692](https://github.com/optomachina/Overdrafter/pull/692) | Jarvis path to OVD-520: evidence map and remaining units | `dae2445b` | 2026-10-12 |
| [#678](https://github.com/optomachina/Overdrafter/pull/678) | OVD-571: Delivered-date comparison and accessible deadline controls (OVD-385 slice 2) | `fa1cd834` | 2026-10-12 |
| [#689](https://github.com/optomachina/Overdrafter/pull/689) | OVD-622: Browser test STEP intake, reload restore, duplicate and empty selections | `8f65d1aa` | 2026-10-12 |
| [#695](https://github.com/optomachina/Overdrafter/pull/695) | OVD-678 follow ups: harden the RMFG transport cap, key and origin checks | `f5c7ae9a` | 2026-10-12 |
| [#700](https://github.com/optomachina/Overdrafter/pull/700) | OVD-739: Deterministic set depth interpretation adapter for the OVD-520 run | `fdd9dc46` | 2026-10-12 |
| [#693](https://github.com/optomachina/Overdrafter/pull/693) | OVD-623 and OVD-620: pgTAP denials for client RPCs and Founding Beta enrollment | `db15bc17` | 2026-10-12 |
| [#698](https://github.com/optomachina/Overdrafter/pull/698) | OVD-463 follow ups: harden nested provenance, URL and validity checks | `036befb1` | 2026-10-12 |
| [#707](https://github.com/optomachina/Overdrafter/pull/707) | Harden ClientPart and ovd419 timing tests that turned main red | `80b48f13` | 2026-10-12 |
| [#706](https://github.com/optomachina/Overdrafter/pull/706) | Raise Playwright expect timeout to 15s for cold dev server first render | `0c089ad2` | 2026-10-12 |
| [#701](https://github.com/optomachina/Overdrafter/pull/701) | OVD-738: Carve 7 transport registration binding onto TransferBudget | `31749320` | 2026-10-12 |
| [#696](https://github.com/optomachina/Overdrafter/pull/696) | OVD-733 and OVD-571 follow ups: no preset auto select, deadline edges, unavailable notice | `e254d032` | 2026-10-12 |
| [#694](https://github.com/optomachina/Overdrafter/pull/694) | OVD-621 and OVD-624: Browser-test enrollment gating, cross-org denial, account-switch purg | `dc157bef` | 2026-10-12 |
| [#699](https://github.com/optomachina/Overdrafter/pull/699) | OVD-464: Integrate provider-neutral worker routing and retries | `21c67607` | 2026-10-12 |
| [#708](https://github.com/optomachina/Overdrafter/pull/708) | OVD-732: Log Oct 12 Jev screens and require a Codex cross review for dispatch PRs | `c22bd15f` | 2026-10-12 |
| [#711](https://github.com/optomachina/Overdrafter/pull/711) | Clear main's Sonar gate: mark contained promise calls as intentionally unawaited | `87d7c242` | 2026-10-12 |
| [#697](https://github.com/optomachina/Overdrafter/pull/697) | OVD-619: Keep secrets and stack traces out of customer-visible errors | `9b208cbd` | 2026-10-12 |
| [#621](https://github.com/optomachina/Overdrafter/pull/621) | OVD-650: Carve inert Windows companion output replay and qualification CI | `35ea451a` | 2026-10-12 |
| [#671](https://github.com/optomachina/Overdrafter/pull/671) | OVD-725 Stripe tier catalog at locked prices (disabled) | `dc5fb52b` | 2026-10-12 |
| [#702](https://github.com/optomachina/Overdrafter/pull/702) | OVD-737: Lock first and READ COMMITTED guard for the OVD-558 reverse | `00588b26` | 2026-10-12 |
| [#704](https://github.com/optomachina/Overdrafter/pull/704) | OVD-740: Admin flagged /engineering in the hosted build, off by default | `23231ed4` | 2026-10-12 |
| [#709](https://github.com/optomachina/Overdrafter/pull/709) | OVD-733: review nits from PR 696 | `df6c41c1` | 2026-10-12 |
| [#705](https://github.com/optomachina/Overdrafter/pull/705) | OVD-752: Bounded read only session probe for stored provider credentials | `75d851dc` | 2026-10-12 |
| [#620](https://github.com/optomachina/Overdrafter/pull/620) | OVD-649: Carve the observer-to-stop workflow and staged observer-evidence replay SQL from | `26b0b76e` | 2026-10-12 |
| [#619](https://github.com/optomachina/Overdrafter/pull/619) | OVD-651: Carve the registered result reader, durable finalization and pending persistence | `b1c9ecb8` | 2026-10-12 |
| [#703](https://github.com/optomachina/Overdrafter/pull/703) | OVD: Stage the guardrail redesign for Blaine to apply (supersedes #691) | `5e89acfc` | 2026-10-12 |
| [#710](https://github.com/optomachina/Overdrafter/pull/710) | OVD-747: OCR every drawing page and install tesseract in the worker image | `0c50c359` | 2026-10-12 |
| [#713](https://github.com/optomachina/Overdrafter/pull/713) | OVD-727 follow ups: bash 3.2 safe egress message and a stronger secret value detector | `45dbbbba` | 2026-10-12 |
| [#712](https://github.com/optomachina/Overdrafter/pull/712) | OVD-752: Probe outcome accuracy and doc fixes before the first run | `dbc6ad5b` | 2026-10-12 |
| [#715](https://github.com/optomachina/Overdrafter/pull/715) | OVD-732 Log Jev screens for #709, #710, #712, #713, #714 and #658 | `0a4a5a1c` | 2026-10-12 |
| [#658](https://github.com/optomachina/Overdrafter/pull/658) | OVD-690 Provider go-live checklist and required PR template section | `bcce6b2f` | 2026-10-12 |
| [#717](https://github.com/optomachina/Overdrafter/pull/717) | OVD-462 window 1: record the applied provider session lease migration | `5773decb` | 2026-10-12 |
| [#675](https://github.com/optomachina/Overdrafter/pull/675) | OVD-462: Add atomic provider session lease | `0da88e49` | 2026-10-13 |
| [#724](https://github.com/optomachina/Overdrafter/pull/724) | OVD-527: build qualification packet tooling | `16c3ba16` | 2026-10-13 |
| [#720](https://github.com/optomachina/Overdrafter/pull/720) | Fixture kit: API providers, Fictiv adoption, Quickparts admit, provider:check in CI | `cbccf88e` | 2026-10-13 |
| [#723](https://github.com/optomachina/Overdrafter/pull/723) | Jarvis U4: first loop runtime composition and Storage version probe | `2124b063` | 2026-10-13 |
| [#722](https://github.com/optomachina/Overdrafter/pull/722) | RMFG live adapter (Weerg substitute), default off | `903cb6ea` | 2026-10-13 |
| [#721](https://github.com/optomachina/Overdrafter/pull/721) | OVD-206 window kit | `3bcd7044` | 2026-10-13 |
| [#725](https://github.com/optomachina/Overdrafter/pull/725) | Send to all applicable providers (behind a flag) | `aa4bccb9` | 2026-10-13 |
| [#726](https://github.com/optomachina/Overdrafter/pull/726) | Vercel: skip preview deploys for agent branches | `83d3964b` | 2026-10-13 |
| [#727](https://github.com/optomachina/Overdrafter/pull/727) | OVD-762: let Xometry join a multi provider confirmation (draft migration) | `c165d762` | 2026-10-13 |
| [#728](https://github.com/optomachina/Overdrafter/pull/728) | Window 1: record the applied OVD-723 expand and OVD-722 migrations | `e514f2ca` | 2026-10-13 |
| [#676](https://github.com/optomachina/Overdrafter/pull/676) | OVD-722 Per-provider and global provider kill switch | `8f273568` | 2026-10-13 |
| [#719](https://github.com/optomachina/Overdrafter/pull/719) | OVD-723 worker side: export control dispatch, extraction and rescan (split from #677) | `6c2e5c92` | 2026-10-13 |

Also finished in this session (not PRs):
- Window 1 applied in production (see Applied to prod).
- Mac release runbook for OVD-419: `docs/handoff/2026-10-14-ovd419-mac-runbook.md` (on this branch; agent generated, not yet executed end to end).
- Window 1 one paste apply sheet (private artifact https://claude.ai/artifact/Vj3Jb6kMo4aknX8avFthbx). Used once; historical only.

## In progress

| PR | What is left | CI on head | Blocked? |
|---|---|---|---|
| [#677](https://github.com/optomachina/Overdrafter/pull/677) OVD-723 client (draft, `ce52eff6`) | Re-cut to client only is done (25 files: src/, e2e, docs, window 2 contract pending suite; worker/src equals main). Needs one independent review, then flip to ready and merge. | ci success, provider-go-live success (run 38476014151) | Yes: must deploy with or after the new worker. Merging deploys the client through Vercel. |
| [#729](https://github.com/optomachina/Overdrafter/pull/729) Fixture closeout (draft, `1c33e70c`) | Fictiv admit stage, RMFG in REVIEWED_PROVIDER_DISPATCH_ENVELOPES, provider:check executes Fictiv and RMFG default deny suites. Two independent reviews APPROVE (on `3044b039`; head since gained a main merge). | ci success; provider-go-live FAILURE by design | Yes: provider-go-live needs Blaine's 9 go-live attestations in the PR body (named envelope reviewer, rollback and kill switch rehearsal, legal stance items). |
| [#714](https://github.com/optomachina/Overdrafter/pull/714) Guardrail polish (draft, `67c57391`) | Round 15: no folding; any command over 32 variants blocks. Needs one final independent review. Staged only under tools/guardrails/proposed/; not installed. | ci success, provider-go-live success | No hard block; review not run. 15 rounds so far. |
| [#716](https://github.com/optomachina/Overdrafter/pull/716) OVD-743 window 2 packet (draft, `bd930ab9`) | Address Opus and Codex findings (stale README pin, caller row, connector protocol, atomicity, column ACLs, ledger warning) and REPIN against the post window 1 production catalog (pins predate 723 and 722). | ci success | Yes: needs a repin round, then a migration window with Blaine. Touches migration SQL drafts: do not merge without Blaine. |
| [#718](https://github.com/optomachina/Overdrafter/pull/718) OVD-736 + OVD-759 (draft, `a8002009`) | Refresh the SECURITY DEFINER allowlist for the 20 definers added by 723 and 722; fix the test 106 savepoint nit; then a migration window. OVD-759: project invites are broken in production until this ships (verified Oct 12). | ci success, provider-go-live success | Yes: migration window with Blaine. RLS/definer change: do not merge without Blaine. |
| [#687](https://github.com/optomachina/Overdrafter/pull/687) Window 1 packet (`ba867e88`) | Window 1 is done. Decide: merge as the rehearsal record or close. | ci success, provider-go-live success | No. Contains window tooling and drafts; not merged during wrap up per instructions. |
| [#581](https://github.com/optomachina/Overdrafter/pull/581) OVD-612 6061 package characterization (draft, `d7d8c70f`) | Untouched this session. | ci success | Unknown (not reviewed this session). |

Branches with no PR: `handoff/2026-10-14` (this file). `claude/relaxed-darwin-nozus2` was recreated by accident at `aba6b3d9` (see Risks).

All worker sessions were told to stand down and unsubscribe. No scheduled check-ins remain. No workflows or subagents are running.

## Applied to prod

| Date (UTC) | Change | How applied | How verified |
|---|---|---|---|
| 2026-10-12 ~21:23 | Migration `20261012212325_ovd462_provider_session_lease` (OVD-462) | Supabase connector apply_migration | Run sheet readbacks true; OVD-602 inventory diff matched the expected file; recorded on main by [#717](https://github.com/optomachina/Overdrafter/pull/717). |
| 2026-10-12 | Branch protection on main: required checks `ci` and `provider-go-live` | Blaine in GitHub settings | Read back through the GitHub API. |
| 2026-10-13 ~15:10 | Migrations `20261013043000_ovd723_export_control_upload_block` (OVD-723 expand) and `20261013043100_ovd722_provider_kill_switch` (OVD-722), byte identical to drafts at `efdb41ac` (sha256 ed1a2f17...) and `a53e794b` (sha256 7acf12f0...) | Blaine, Supabase SQL editor, one paste, one implicit transaction, from the apply sheet ("Run without RLS"; the SQL enables RLS itself) | Lead, read only: ledger 151; 723 readbacks 4/4 true; 722 readbacks 2/2 true; RLS on all 8 new private tables (3 forced); OVD-602 inventory (316 functions, 133 relations, 137 policies) diff equals `ovd-723+ovd-722.json` exactly against both the pin and the pre window baseline. Rehearsed first on PostgreSQL 17.11 with a forced failure proving atomicity. Recorded on main by [#728](https://github.com/optomachina/Overdrafter/pull/728). |
| 2026-10-13 | Data side effect of 723: 4 `job_export_declarations` rows backfilled as `missing` | Part of the 723 migration | Counted in the readback. Kill switches: every provider off, global off (722 seed, readback true). |
| 2026-10-13 09:09 | Vercel: `vercel.json` skips deployments for claude/**, codex/**, cursor/** branches | Merge of [#726](https://github.com/optomachina/Overdrafter/pull/726) | Not verified on Vercel after merge. |
| 2026-10-13 ~15:40 | Secret Manager `rmfg-api-key`: new version with a new RMFG key (scopes designs, dfm, quotes, carts, webhooks; not orders; no API card), all older versions disabled, `overdrafter-worker-runner` has Secret Accessor | Blaine in the Cloud console | Reported by Blaine. NOT verified: the probe has no RMFG endpoint yet and the curl check result was never reported. |
| 2026-10-13 ~20:20 | Fictiv and Quickparts storage state secrets: refresh instructed after both probes returned `logged_out` | Blaine (auth:fictiv, auth:vendor quickparts, gcloud secrets versions add) | NOT verified: no post refresh probe output was received. |
| Not changed | Cloud Run Service `overdrafter-cad-worker` and Job `overdrafter-xometry-auth-probe` | n/a | Read back by Blaine ~22:00 Oct 13: both on `...overdrafter-cad-worker@sha256:3dd67a3ce58817417d94da3b580c1eb99cdfdf9aa9d9ed2317c535ad69bf0daf`, build `25452595367f81d7b46bda960020ecd6aefb153e`, mode live, adapters xometry, trace false, camoufox, lease env empty, concurrency 1, maxScale 1, 20 executions, 0 active. |
| Automatic | Vercel production deploys of main after each merge (includes the #676 admin kill switch card) | Vercel git integration | Not verified this session. |

## Left to do for the Nov 13 beta

Definition of done (from Blaine): 1.0 = a part gets quotes across providers, Xometry certified with 5 clean runs. Fixture = every non Xometry 1.0 provider (Fictiv, Quickparts, RMFG) passes fixture:onboard with a green provider:check. Jarvis = OVD-520, one verified 7 mm phone to native SolidWorks result behind an admin flag. No date estimates are given here; none has evidence behind it.

1.0, in critical path order:
1. OVD-527 / OVD-528 / OVD-529 / OVD-419: build `6c2e5c92` on Blaine's Mac (build packet), promote Job then Service, run the two no upload Xometry probes (`scripts/run-ovd419-live-release.mjs`). Has never succeeded live. Runbook on this branch.
2. OVD-410: if the probes report `login_required` (likely: last good probe 2026-08-29), the Xometry credential recovery ceremony (`docs/workflows/ovd410-stable-egress.md`, "Full credential recovery ceremony", separately authorized, destructive), then rerun step 1 with a new authorization.
3. OVD-723 client: review and merge [#677](https://github.com/optomachina/Overdrafter/pull/677) with or after the worker deploy. Until it ships, every job without a declaration (the 4 backfilled ones and any new upload) is refused by the new worker.
4. OVD-206: Xometry certification, 5 clean runs (window kit `docs/release/ovd-206-window-kit.md`, merged in [#721](https://github.com/optomachina/Overdrafter/pull/721)). Needs Blaine's approval artifact (STEP hash, export status, quote lane scope) and billing and ordering off.
5. OVD-759 invites (production bug) and OVD-736 anon revoke: [#718](https://github.com/optomachina/Overdrafter/pull/718) refresh and a migration window.
6. Providers: Fictiv (OVD-395) and Quickparts (OVD-429) session refresh verified by probe, then admission and certification; RMFG (OVD-580): probe endpoint (`RMFG_PROBE_ENDPOINT` is null in `worker/src/providerSessionProbe.ts`; RMFG's OpenAPI lists `GET /v1/account`), then flip `liveAdapter` with the secret name as a release step. Geomiq and Weerg are 1.1 (Blaine).
7. OVD-762: migration window for the draft merged in [#727](https://github.com/optomachina/Overdrafter/pull/727) so Xometry can join a multi provider send; then the send to all applicable providers flag ([#725](https://github.com/optomachina/Overdrafter/pull/725)). OVD-758 lease gate before the session lease flag goes on.
8. OVD-416 release contracts, OVD-199 multi provider certification, OVD-319 scoped beta enablement (second session proof moved here).

Fixture:
1. [#729](https://github.com/optomachina/Overdrafter/pull/729): Blaine's go-live attestations, then merge.
2. Follow ups found in review (no issues filed yet): provider:check full suite mode does not verify which deny tests ran; Fictiv passes only through the OVD-673 exception (expires 2026-12-31); generated Fictiv admit runbook is stale (its review row is already a migration); `RMFG_DISPATCH_ENVELOPE` defined twice.

Jarvis:
1. OVD-743: [#716](https://github.com/optomachina/Overdrafter/pull/716) review round plus repin against the post window 1 catalog.
2. Window 2 migration window (Jarvis chain, OVD-558 to OVD-563 and related), run by Blaine in the SQL editor the same way as window 1.
3. U11 on the Windows workstation (SolidWorks 2022 SP5 installed, clone at `C:\dev\Overdrafter` @ `0da88e49`; no scripts run there yet).
4. OVD-520: one verified 7 mm phone to native SolidWorks result behind the admin flag.

## Needs Blaine

1. **Release run.** Question: "Will you finish the Mac preflight and build today, then run the release command yourself?" Recommendation: yes. Rollback to `3dd67a3c` on probe failure is the agreed acceptable outcome (you said "Go ahead" on Oct 13).
2. **Xometry login recovery.** Question: "If the release probes say the Xometry login expired, do you authorize the OVD-410 credential recovery ceremony (revokes the old session, temporary cloud browser on the fixed IP, you log in)?" Recommendation: yes, schedule it right after a `login_required` result. Certification cannot start without a working session.
3. **#729 go-live attestations.** Question: "Do you attest the 9 provider-go-live items for RMFG?" Recommendation: wait until the kill switch rehearsal can run on the new worker, then attest and merge.
4. **#714 guardrail.** Question: "Merge #714 after one final review, accepting that any command with more than 32 variants is blocked? And should the hook also protect .github/workflows?" Recommendation: yes to merge after review; add workflows protection as a separate small PR.
5. **Next migration windows.** Question: "When will you run window 2 (Jarvis) and the OVD-736/759 window, apply sheet style?" Recommendation: after the worker release; bundle #718 (invites fix) into the first one.

## Risks and surprises

- The OVD-419 controller has never succeeded live (Sept 4 rolled back at probe preacceptance; 5th attempt cause not established; 6th failed at `probe_result` with no reason recorded). The probe reason is now logged.
- The Xometry session was last proven on 2026-08-29. Probably expired. Unverified.
- Fictiv and Quickparts stored sessions returned `logged_out` on 2026-10-13 20:20Z. Refresh was instructed, not confirmed.
- RMFG key: stored, not verified working. The session probe cannot test RMFG yet.
- After the new worker deploys, jobs without an export declaration are refused until [#677](https://github.com/optomachina/Overdrafter/pull/677) ships. Deploy them together.
- Mac runbook is agent generated and not executed end to end. Unverified gcloud details: `configure-docker`, the `update_time` field, secrets list sort order, manual rollback in its section 5.4. Its preflight block 3 needs all eleven OVD-410 env values for `npm run verify:xometry-egress` (the session stopped right after a run that failed for missing values; the corrected command was given but not run).
- Window 1 was applied as one transaction (723 then 722) instead of two separate runs. Rehearsed on PostgreSQL 17.11 with failure injection; production diff matched. The ledger `statements` column holds a provenance comment, not the SQL.
- Production database changes cannot be applied by agents: the Supabase connector times out on destructive statements (3 times), and the auto mode classifier blocks autonomous production migration prep. Every window needs Blaine.
- Worker sessions often refuse lead relayed approvals (classifier: "Instruction Poisoning", "Security Weaken"). Blaine had to approve in session several times on Oct 13.
- Guardrail [#714](https://github.com/optomachina/Overdrafter/pull/714) took 15 rounds; each review found new fail opens until folding was removed. Not installed. The hook does not protect `.github/workflows`.
- Incident (Oct 13): a reviewer subagent ran a real `git push` and recreated branch `claude/relaxed-darwin-nozus2` at `aba6b3d9` (the merged #715 head). Harmless; left in place.
- `docs/migration-drafts/provider-fanout-guards.sql` lines 89 to 93 read `provider_kill_switches.disabled`, but the column is `engaged`, and the query ignores the global switch. Fix before that draft is reviewed.
- `assertExportControlDispatchAllowed` has no worker side timeout (a hung RPC stalls the lane; it fails closed by blocking).
- Comment at `worker/src/index.ts` (around line 1378) still says the OVD-462 lease manager is not on main; it is.
- [#716](https://github.com/optomachina/Overdrafter/pull/716) pins and [#718](https://github.com/optomachina/Overdrafter/pull/718) allowlist are stale since window 1 changed the production catalog.
- Local `npm run preflight` test stage fails in cloud containers (missing Chromium, shallow clones). Hosted CI is the evidence.
- Linear statuses were not updated for most of Oct 13 (OVD-722, OVD-723 still In Progress). Treat GitHub as the source of truth.
- Vercel free tier hit its 100 deploys per day limit on Oct 12 to 13. [#726](https://github.com/optomachina/Overdrafter/pull/726) reduces agent branch deploys; production deploys were at risk while the quota was exhausted.
- Blaine's Mac had stray untracked files (two migration copies from a db push attempt, two empty files named Connect and Session). All moved to `~/ovd-old/`.

## Resume

1. On Blaine's Mac, in the Claude session or the release tab, at `6c2e5c92` with a clean tree, rerun the stable egress check with the full config, and confirm the operational envelope shows every control off and both active counts 0:
   ```
   GOOGLE_CLOUD_PROJECT=overdrafter-worker-9133 CLOUD_RUN_REGION=us-west1 CLOUD_RUN_NETWORK=overdrafter-xometry-egress CLOUD_RUN_SUBNET=overdrafter-xometry-egress-us-west1 CLOUD_RUN_SUBNET_RANGE=10.81.0.0/26 CLOUD_RUN_ROUTER=overdrafter-xometry-egress-router CLOUD_RUN_NAT=overdrafter-xometry-egress-nat CLOUD_RUN_NAT_ADDRESS=overdrafter-xometry-egress-ip CLOUD_RUN_NAT_ADDRESS_ID=7266654960671511103 SERVICE_NAME=overdrafter-cad-worker XOMETRY_AUTH_PROBE_JOB_NAME=overdrafter-xometry-auth-probe CLOUD_RUN_SERVICE_ACCOUNT=overdrafter-worker-runner@overdrafter-worker-9133.iam.gserviceaccount.com npm run verify:xometry-egress
   node scripts/collect-ovd410-operational-envelope.mjs
   ```
2. Build (Section 2 of the runbook): `node scripts/ovd527-build-packet.mjs source --sha 6c2e5c926868e005df0769be1ba8ae90dbc9cd1e`, then `node scripts/ovd527-build-packet.mjs commands --sha 6c2e5c926868e005df0769be1ba8ae90dbc9cd1e` and run its 7 blocks in one shell. Check that the block 4 digest differs from `3dd67a3c...` and block 7 prints `plan-valid`.
3. In a real Terminal tab (not a Claude shell; the controller checks terminal ownership), with the runbook's step 1.2, 1.4 and 1.5 exports set: create the authorization file (runbook Section 3) and run `node scripts/run-ovd419-live-release.mjs --execute --authorization-file ... --bundle-file ... --evidence-file ...`. Keep the freeze (no app use, no queue rows) until it exits. On success, review and merge [#677](https://github.com/optomachina/Overdrafter/pull/677); on `login_required`, go to OVD-410.
