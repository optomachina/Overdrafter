# OverDrafter 1.0 Beta Launch Plan

Approved by Blaine on October 11, 2026. Source: the beta council synthesis
(Grok, Astra and Opus, two rounds) with Blaine's changes applied.

Amended by Blaine's October 13 and October 20 decisions (recorded in Linear on
`OVD-206`, `OVD-199` and `OVD-319`) and reconciled on October 23, 2026. The
provider scope, the session rules, the run budget, the go/no-go gates and the
open `TODO(Blaine)` decisions now live in the
[1.0 launch contract](../1-0-beta-runbook.md#10-launch-contract). Where this
plan disagrees with that section, the launch contract wins.

This plan sets dates and sequencing. `PRD.md` still owns product intent,
`ACCEPTANCE_CRITERIA.md` owns release gates, and
[`docs/1-0-beta-runbook.md`](../1-0-beta-runbook.md) owns the operating
contract. Where this plan and an older sequencing note disagree on dates or
scope cuts, this plan wins.

**Readiness:** the checkpoints below track launch readiness. A demo on
staging or seeded offers (including the October 24–25 demonstration) is demo
readiness only and passes no checkpoint here. See
[Demo readiness vs launch readiness](../1-0-beta-runbook.md#demo-readiness-vs-launch-readiness).
Current verdict: **NO-GO for a customer beta**. The Codex readiness review's
no-go stands because there are zero priced production runs.

## Dates

| Date | Checkpoint | Pass condition |
|---|---|---|
| Sat Oct 17 | Queue quiet | Fixture PRs merged or cut; stale drafts closed or moved to 1.1 |
| Fri Oct 23 | Go/no go | Superseded on Oct 20: this checkpoint no longer decides the provider count. Proposed remaining condition: Fictiv and Quickparts sessions live and RMFG API access granted; Windows host booked; migration window 1 done or scheduled. Outcome not recorded: `TODO(Blaine)` B13 |
| Sat Oct 31 | Release candidate | 686 ready candidate frozen; OVD-527, 528 and 529 proven. If this fails, the beta moves to Nov 20 that same day |
| Fri Nov 6 | Xometry certified | OVD-206 passes with five runs |
| **Fri Nov 13** | **Beta target** | OVD-319 certification walk passes |
| Fri Nov 20 | Fallback | Used only if the Oct 31 checkpoint fails |

## Scope

* **Providers.** Superseded on Oct 20. 1.0 covers Xometry, Fictiv and
  Quickparts on the CNC validation package and RMFG on the sheet-metal
  validation package. Weerg, Geomiq and OSH Cut are 1.1. Shipping with fewer
  than four, or with a substitute, is an explicit Blaine decision
  (`TODO(Blaine)` B1), never a silent slip.
* **Fixture** is a throughput multiplier, not a third product. It is done when
  the non Xometry providers have been onboarded through `fixture:onboard` with
  a green `provider:check`. Providers as data (OVD-707) stays in the Supplier
  Network incubator and is not on the 1.0 critical path.
* **Jarvis is not parked.** It continues in parallel with 1.0. It stays off the
  production spine and must not hold the 1.0 date. Jarvis is done for this
  phase when OVD-520 produces one 7 mm phone to native verified result behind
  an admin flag. It may be flagged on up to a week after 1.0 without moving
  the beta date.

## Cuts and deferrals

Moved to 1.1 or the deferred backlog, not deleted:

* OVD-413, OVD-567 and OVD-568 (capability gate hardening)
* OVD-594, OVD-595 and OVD-596 (strictNullChecks, bundle hygiene, mobile nav)
* OVD-647 (redaction edge cases)
* OSH Cut (OVD-402, OVD-677)
* Rehearsal drafts #627, #628 and #629. OVD-635's rehearsal is the only drill.
* Full 1.0 polish and the broader JARVIS backlog.

Provider umbrellas OVD-395 to OVD-398 collapse into one acceptance table per
provider (session live, envelope reviewed, admitted, live cert, kill switch
tested). The child issues keep their history.

Closed now: PRs #606 to #613. Merge when green: #663, #658, #656, #623 and
#585.

## Critical path

Parallel agent tracks, done by Oct 23:

* OVD-385 (569, 571, 572)
* OVD-461, 462, 463 and 464
* Fixture: settle the #661 registry, fix Sonar on #662
* Provider envelopes

Then the serial path:

1. **Migration window 1:** OVD-635 rehearsal, OVD-462 and the OVD-602 pin.
2. **Freeze** the release candidate.
3. **Release chain:** 527 → 528 → 529 → 419 → 416 → 206 (Xometry, five runs).
4. **Live certs** for the other providers.
5. **OVD-199**, then the **OVD-686 audit** (time boxed to 3 days, on the
   frozen candidate), then the **OVD-319 cert walk**. The audit always runs
   before 319 (Linear still lists 319 as a blocker of 686: `TODO(Blaine)` B12).
   The launch gates in the runbook, including `OVD-1018`, `OVD-1067`, wake on
   submit, `OVD-1068` and `OVD-1011`, must pass before the walk.
6. **Jarvis, in parallel:** #619 and #620 in migration window 2 after 206 →
   511 → 505 → 563 → one Windows host session for #621 and the OVD-520 run.

The real bottleneck is Blaine's serial manual chain
(541 → 527 → 528 → 529 → 419 → 416 → 206 → 199 → 686 → 319), not agent
capacity. Two fixed Blaine sessions are booked each week.

## Launch safety gates (from the business model)

These ship before any provider goes live for beta users:

* **Per provider kill switch.** Each provider can be turned off on its own,
  instantly, without a deploy.
* **ITAR/EAR upload block.** Controlled or uncertain uploads are blocked at
  launch. A user attestation plus US hosting is not authorization. Weerg and
  Geomiq are foreign providers, so sending them a controlled file is an
  export.
* **Provider permissions matrix** with partner API outreach to each provider.

## Migration windows

Production migrations ship only in batched, Blaine approved windows. Each
window needs:

* a disposable rehearsal (OVD-635)
* an OVD-602 SECURITY DEFINER and RLS inventory diff
* pgTAP RLS denial tests
* PITR confirmed
* expand then contract changes only

Window 1 is the week of Oct 19. The Jarvis SQL (#619, #620) goes in window 2,
after OVD-206.

## Merge guardrails

* Grok Bot's merge tool refuses anything touching migrations, RLS, SECURITY
  DEFINER or the #656 sensitive paths.
* A Claude Code hook blocks writes to migration paths without a
  `blaine-window` label.
* QA PASS requires a CI or preflight artifact, not a self report.
* Repair round 2 runs with fresh context or a different model.
* One worktree per task.
* Multi model review only for 635, 462 and the Jarvis finalization SQL.
* Each Blaine session gets one page: commands, expected output and rollback.

Opus does migrations, finalization and OVD-385. Sonnet does Fixture and
provider work. Grok takes overflow and safe merges.

## Operating routine: no PM bot

There is no PM bot. Triage runs an unstick routine twice a day and classifies
each PR as Vercel rate limit, real failure, Sonar, migration, stale or
obsolete.

* Grok Bot merges green PRs that touch no migrations.
* Everything else goes into a daily **Blaine queue**, capped at 5 items.
* Drafts with no owner after 10 days get closed or moved to 1.1.
* Vercel only failures caused by rate limiting get an explicit recorded
  exception, and previews rerun once a day, serialized. No hourly scanning.

## Next actions

1. Blaine toggles OVD-541 (leaked password protection).
2. Request live sessions for Fictiv and Quickparts, plus RMFG API access and
   partner API access; book the Windows/Mac host. (Weerg and Geomiq are now
   1.1.)
3. Close #606 to #613; merge the green PRs; record a Vercel exception for #660
   if rate limiting is its only red.
4. Ship the merge tool guardrail and the migration path hook before Grok Bot's
   next merge.
5. Start the twice daily unstick routine and the Blaine queue.
6. Settle the #661 registry and fix Sonar on #662; start OVD-385 and OVD-462
   in separate worktrees.
7. Calendar migration window 1 (week of Oct 19), the Oct 23 checkpoint and
   weekly release sessions.

See also [`docs/business/business-model.md`](../business/business-model.md).
