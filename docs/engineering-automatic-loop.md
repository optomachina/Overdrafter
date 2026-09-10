# Automatic engineering request-to-result milestone

Approved for staged implementation in the engineering task on September 10,
2026 UTC. This milestone is High complexity; the user authorized the explicitly
classified six-slice plan. It does not promote general customer CAD operation.

## Outcome and fixed decisions

The signed-in user sends a natural-language request from Mac or phone through
the minimal bottom composer. The request survives browser closure; Workstation
returns verified native files, measured results and actual STEP geometry without
manual JSON transport. Access is restricted server-side to the configured user
and organization in the existing app.

Use the current synthetic two-cylinder assembly and SolidWorks 2022 SP5 on
Workstation. The first operation is absolute depth, 6–10 mm. Clear supported
requests are accepted by Send; ambiguity requires clarification. AI proposes
structured interpretation, never executable code or its own authority.

Changes accumulate in one ordered chain. A successor consumes the previous
verified output. Failed work blocks successors. Resolution is an explicit retry
or cancellation of the failed change and pending suffix; no silent skip/rebase.

The Windows companion requires explicit enablement after each restart. Sessions
last eight hours. Pause/expiry finish the current job and prevent new claims.
Only one native job runs, with at most five accepted outstanding changes. Poll
every five seconds while enabled, heartbeat every ten seconds, lease sixty
seconds, native timeout ten minutes. Retry once only for a classified transient
failure after confirming the prior native process stopped. Lease expiry alone
is not proof of shutdown. Unrelated SolidWorks sessions prevent startup.

The companion uses outbound HTTPS and a revocable worker credential protected by
DPAPI, paired with a single-use ten-minute code. It has no general database or
PDM credentials. Upload retries reuse immutable attempt outputs, not CAD edits.

## Delivery sequence and completion evidence

1. OVD-495: cumulative v2 contracts and real 5 → 8 → 9 → 7 mm native proof.
2. Durable engineering tables, scoped authorization, private artifacts and
   ordered task transitions, separate from the quoting queue.
3. Companion pairing/sessions, dispatcher, leases, output uploads and recovery.
4. Durable bounded AI interpretation and clarifications, initial direct OpenAI
   model configuration `gpt-5.4`, versioned prompt/schema, finite call budgets.
5. Authenticated `/engineering` workspace with cross-device conversation,
   distinct execution/verification states and automatic real CAD previews.
6. Adverse-case qualification, recorded desktop/mobile demonstration and staged
   activation after required review and checks.

Use Supabase Edge Functions with immediate pg_net notifications and a one-minute
pg_cron recovery sweep. Durable database records, not notifications, own state.
State-changing APIs require idempotency and applicable expected revisions.
Reserve spending before model calls. Initial allocation: $40/month AI and
$10/month incremental platform usage; activation must verify usage limits fit.
Do not purchase upgrades automatically.

Completion requires cross-device request/result demonstrations, five queued
changes, browser-closure recovery, correct predecessor lineage, all seven native
checks, source preservation, duplicate/stale/late result rejection, tenant and
worker credential tests, budget refusal, pause/expiry/restart tests and explicit
failure propagation. Run required repository checks plus real Windows cases.
Track acknowledgement (target p95 <2 seconds excluding upload/interpretation),
interpretation/queue/native duration, retries, failures and incremental cost.

## Activation and limits

Deployment is default-off and account-allowlisted. Production migration,
credential, scheduler and companion activation changes need a concrete reviewed
activation packet and the applicable user authorization. Rollback disables new
admission/scheduling, drains the active job and retains records/evidence.

Candidates remain unadopted. Customer files, component edits, DFM/DFA, branching,
approved export, PDM publication, overnight operation and general customer
environment qualification remain later milestones. The broader architecture
remains in `engineering-control-plane.md`; existing local operator behavior is
documented in `prepared-dimension-workflow.md`.
