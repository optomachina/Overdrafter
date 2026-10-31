# OVD-206 hosted Xometry window kit

Source only. Nothing in this file has been run against a hosted database,
Cloud Run, Vercel, or Xometry. Every production action is labeled **Blaine
runs**. An agent may prepare evidence files and read results Blaine pastes in,
and does nothing else in production.

The kit serves one outcome: five consecutive hosted runs of the same approved
quote scope, each returning a real Xometry offer with every variant preserved,
plus one forced failure and a rollback drill. Per Blaine decision 5 (Oct 13,
recorded on Linear OVD-206), all five runs may use one Xometry provider session.
The second, separately established session proof is deferred to OVD-319. Sources: `docs/1-0-beta-runbook.md`,
`ACCEPTANCE_CRITERIA.md` (Production certification), `worker/README.md`,
`docs/workflows/ovd410-stable-egress.md`, `docs/release/ovd-419-contained-live-handoff.json`,
and the Linear text of OVD-206 and OVD-723.

## 0. Gates before the window opens

Do not start until every line is true and the evidence is linked in the OVD-206
rolling comment. Linear shows OVD-206 as Blocked on this ladder.

- [ ] OVD-359 and every dispatch blocking child are closed with deployed evidence.
- [ ] OVD-419 final OVD-408 worker digest is promoted to both the service and the
      Job, with hosted readback. The recorded OVD-419 handoff
      (`ovd-419-contained-live-handoff.json`) shows a contained probe failure and
      says a fresh explicit authorization is needed for any new live controller
      attempt. Treat that file as history, not as a pass.
- [ ] OVD-416 release reconciliation is complete, and the OVD-408 hosted path
      proves each run preserves every Xometry variant.
- [ ] OVD-410 stays satisfied: two fresh instance, one task, zero retry, no upload
      probes authenticated after the last credential rotation or network change.
- [ ] OVD-722 (provider kill switch) and OVD-723 (export block) are merged and
      deployed. 723 window 1 is expand only, so confirm the backfill and the
      declaration path described in section 2 are live, not just the schema. Section 1 check 6 and section 2 depend on them. If either is not
      deployed, stop; do not substitute the manual fallback for this window.
- [ ] Blaine approved, in the access controlled approval artifact, the exact
      validation package STEP hash for disclosure to Xometry, its export control
      status, and the complete `quote-lane-scope.v1` record (section 4).
- [ ] Public distribution rights for the retired validation part are decided and
      recorded separately (ACCEPTANCE_CRITERIA, Production certification).
- [ ] Billing, promotions, order administration, and ordering are off, and
      `BILLING_SELF_SERVICE_ENABLED=false`.
- [ ] A named day, a named operator (Blaine), and a stop time are recorded.

## 1. Read only preflight (Blaine runs)

Run in the Supabase SQL editor as a read only session. Open every script with
`begin read only;` and close with `rollback;`. Paste the output, with
organization and user identifiers truncated to the first 8 characters, into the
window log (section 6). Placeholders are in angle brackets. Column names below
come from the repository migrations; if a query errors, stop and report the
error text rather than editing the query live.

```sql
begin read only;

-- 1. Rollout disabled before the window. Expect enabled = false for all four.
select capability, enabled, revision, updated_at
from private.commercial_rollout_controls
order by capability;

-- 2. Queues empty. Expect zero rows in both results.
select id, task_type, status, attempts, locked_by, created_at
from public.work_queue
where status in ('queued', 'running');

select id, organization_id, status, created_at
from public.quote_requests
where status in ('queued', 'requesting');

-- 3. Vendor config. The enrolled organization must have rows whose effective
-- enabled set is exactly xometry. Expect one row: xometry, true.
select vendor, enabled_for_client_quote_requests
from public.org_vendor_configs
where organization_id = '<ENROLLED_ORG_ID>'
  and enabled_for_client_quote_requests
order by vendor;

-- 4. Session owner and age. Expect no live lease before the window: any lease
-- in an active state whose expires_at is in the future fails this check. Expect a
-- binding whose account_ref matches the session owner Blaine recorded.
select provider, account_ref, environment, session_binding_ref, next_generation, updated_at
from public.provider_session_bindings
where provider = 'xometry' and environment = 'production';

select state, generation, owner_task_ref, acquired_at, expires_at, ended_at
from public.provider_session_leases
where provider = 'xometry' and environment = 'production'
order by created_at desc
limit 5;

-- 5. Founding Beta enrollment. Expect latest action = 'grant' for the org.
select action, policy_revision, created_at
from private.founding_beta_enrollment_events
where organization_id = '<ENROLLED_ORG_ID>'
order by id desc
limit 1;

-- 6. Kill switches (OVD-722). Both tables are private. Expect xometry
-- engaged = false and the global row engaged = false. Fail closed: a missing
-- xometry row or a missing global row means ENGAGED, so the check fails.
select provider, engaged, reason, engaged_by, engaged_at, version
from private.provider_kill_switches
where provider = 'xometry';

select engaged, reason, engaged_by, engaged_at, version
from private.provider_global_kill_switch;

rollback;
```

Check 7, the cross organization denial, runs as a signed in user from a second,
not enrolled organization. Use a throwaway test account that Blaine already owns;
create nothing new in production for it.

```sql
begin;
set local role authenticated;
select set_config('request.jwt.claims',
  json_build_object('sub', '<NON_ENROLLED_USER_ID>', 'role', 'authenticated')::text, true);

-- Every count must be 0.
select count(*) from public.quote_requests        where organization_id = '<ENROLLED_ORG_ID>';
select count(*) from public.vendor_quote_results  where organization_id = '<ENROLLED_ORG_ID>';
select count(*) from public.vendor_quote_offers   where organization_id = '<ENROLLED_ORG_ID>';
rollback;
```

Also from the customer surface of the not enrolled organization, request an
automatic quote and record that the server rejects it with the neutral
unavailable response and creates no queue row (rerun checks 2 and 3 after).

Environment checks (Blaine runs, read only):

- [ ] Deployed worker env shows `WORKER_LIVE_ADAPTERS=xometry` exactly. No other
      value, no extra adapters, no trailing entries.
- [ ] `npm run verify:xometry-egress` from the repository root passes.
- [ ] Service and Job image digests match each other and the OVD-419 promoted digest.
- [ ] Profile snapshot object generation and age recorded. Name the session
      owner. If the snapshot is older than the age Blaine sets for the window,
      or the recorded owner is not Blaine, stop.
- [ ] Health and readiness endpoints pass.
- [ ] Engine recorded (Camoufox snapshot mode per the current deployment, or
      Playwright if that has changed). No Cloudflare, no op, or 401 material
      failures in the last no upload probe.

Any failed check stops the window. Do not edit data to make a check pass.

## 2. Participant requirements after OVD-723

The enrolled participant is the single enrolled organization. Before the first
run, confirm each of these in the product, not by database edit:

- [ ] Founding Beta enrollment is a current grant for the organization
      (preflight check 5). A manual entitlement grant or Stripe subscription does
      not count.
- [ ] The acting member has MFA enabled (AAL2) and has accepted the current
      Founding Beta notice revision.
- [ ] The job carries a recorded, required export declaration answered "not
      ITAR, not EAR controlled other than EAR99, and not uncertain" (OVD-723).
      The declaration is on the job (the part request), with an optional part
      id. A controlled or uncertain answer blocks upload and nothing is stored.
      It must be declared, not defaulted.
- [ ] 723 backfill: every pre existing job with files starts as missing and is
      denied until declared. A clean declaration queues scan only rescans, and
      those rescans must finish before run 1.
- [ ] The private package job has clean scans: no ITAR or EAR marking flags on the
      STEP or the drawing, and no pending review flag. A flagged file is blocked
      pending review and cannot be used.
- [ ] The customer disclosure confirmation names only Xometry, the exact file
      names, the normalized requirements, the authority to share and non export
      controlled affirmations, quote only, and the notice revision.

If the production declaration path is not deployed, stop. Do not set the
declaration by SQL.

## 3. Vendor config and rollout steps (Blaine runs)

### 3.1 Xometry only organization config

The window needs exactly one enabled vendor for the enrolled organization. The
legacy no row default includes other vendors and is never acceptable.

```sql
-- Blaine runs, once, before the window, in the Supabase SQL editor.
-- Service role session. One row for xometry enabled; every other vendor
-- either has no row of its own enabled, or an explicit false row.
insert into public.org_vendor_configs (organization_id, vendor, enabled_for_client_quote_requests)
values ('<ENROLLED_ORG_ID>', 'xometry', true)
on conflict (organization_id, vendor)
do update set enabled_for_client_quote_requests = true;

-- Add an explicit false row for each remaining value of public.vendor_name so
-- the effective set cannot fall back to the legacy default.
insert into public.org_vendor_configs (organization_id, vendor, enabled_for_client_quote_requests)
select '<ENROLLED_ORG_ID>', v.enumlabel::public.vendor_name, false
from pg_enum v
join pg_type t on t.oid = v.enumtypid
where t.typname = 'vendor_name' and v.enumlabel <> 'xometry'
on conflict (organization_id, vendor)
do update set enabled_for_client_quote_requests = false;
```

Then rerun preflight check 3. Expect exactly one enabled row, xometry. Record
the readback. Rollback of this step is the same upsert with xometry false.

### 3.2 Rollout enable (Blaine runs)

Follow `docs/workflows/commercial-rollout-controls.md` (Inspect state, Change
state). Use only the 1.0 subset in the runbook; do not run its Stripe or billing
steps. Order:

1. Read `public.api_get_commercial_rollout_controls()` and record every revision.
2. Prove the disabled automatic path creates no vendor work, and prove a not
   enrolled organization is rejected (preflight check 7 and its UI case).
3. Only if the organization needs its expiring capability grant, open a bounded
   audited administration window, grant, and close it before step 4.
4. Enable for this window only:

```sql
select public.api_set_commercial_rollout_control(
  'automatic_quote_collection',
  true,
  'OVD-206 certification window <YYYY-MM-DD>',
  '<operator identifier>',
  <revision read in step 1>,
  'ovd206-window-<YYYYMMDD>-enable'
);
```

5. Read the controls again and record the new revision and the audit event.

Record in the OVD-206 comment: control revision, enrolled organization and
capability, the rejected not enrolled case, effective vendor list, operator,
reason, and idempotency key.

### 3.3 Rollout disable (Blaine runs)

Run at the end of every day the window ran, and immediately on any stop rule.

```sql
select public.api_set_commercial_rollout_control(
  'automatic_quote_collection',
  false,
  'OVD-206 window <YYYY-MM-DD> closed',
  '<operator identifier>',
  <revision read just before>,
  'ovd206-window-<YYYYMMDD>-disable'
);
```

Then read the controls API and confirm: `automatic_quote_collection` false, the
audit event shows the expected previous state, new state, revision, reason,
operator, and idempotency key, and uploads and existing results still open.
Rerun preflight checks 2 and 3. Return the day to a clean state before leaving.

## 4. `quote-lane-scope.v1` record template

The approved record lives only in the access controlled approval artifact, never
in Linear or this repository. The worker builds it with
`buildQuoteLaneScopeSnapshot` (`worker/src/quoteScope.ts`); the template below
mirrors its output. Fill it in the approval artifact. All five runs must carry
the same scope fingerprint. Changing the bytes, identifiers, timestamps, MIME
types, requirements, or specification invalidates approval and restarts the series.

```json
{
  "schema": "quote-lane-scope.v1",
  "vendor": "xometry",
  "quantity": "<integer>",
  "destination": {
    "confirmationRevision": "<positive integer string>",
    "street": "<redacted in this copy>",
    "city": "<redacted in this copy>",
    "region": "<state or null for non US>",
    "postalCode": "<redacted in this copy>",
    "country": "<ISO country>",
    "state": "confirmed"
  },
  "part": {
    "id": "<part uuid>",
    "cad": {
      "fileId": "<file uuid>",
      "sha256": "<64 hex, worker trusted digest>",
      "name": "<original file name>",
      "mimeType": "<recorded MIME type>",
      "sizeBytes": "<integer>"
    },
    "drawing": {
      "fileId": "<file uuid>",
      "sha256": "<64 hex>",
      "name": "<original file name>",
      "mimeType": "<recorded MIME type>",
      "sizeBytes": "<integer>"
    }
  },
  "requirements": {
    "id": "<approved requirement uuid>",
    "capturedAt": "<timestamp>",
    "description": "<text>",
    "partNumber": "<text>",
    "revision": "<text>",
    "material": "<text>",
    "finish": "<text>",
    "tightestToleranceInch": "<number>",
    "requestedDeliveryDate": "<YYYY-MM-DD or null>",
    "specification": { "<fields from spec_snapshot, without requestedByDate>": "" }
  }
}
```

Approval fields to record next to it (access controlled artifact only):

| Field | Value |
| --- | --- |
| Scope fingerprint (64 hex) | |
| STEP SHA-256 and drawing SHA-256 | |
| Disclosure to Xometry approved by Blaine, date | |
| Export control status (not ITAR, EAR99 or not controlled) | |
| Notice revision | |
| Dispatch permit approval reference | |
| Series start date | |

Before each run Blaine confirms the staged and current fingerprints equal the
approved fingerprint. A mismatch stops the series and restarts it.

## 5. Window procedure

Run in order. Every production action is Blaine runs. Do not issue overlapping
requests; one run finishes (offer, failure, or timeout) before the next begins.

1. Run section 1 in full. Record results.
2. Run section 3.1 if not already done, then 3.2 to enable.
3. Record the one provider session used for all five runs: session owner,
   snapshot generation, engine, and start time.
4. Blaine runs requests 1 to 5 through the normal customer path as the enrolled
   participant. No database repair, no staff operation of the customer UI. If a
   run needs either, the series stops and restarts later.
5. Section 6 evidence after each run, before the next starts.
6. Re-establishing the session is optional and happens only on Blaine's explicit
   call. Default is one session for all five runs. If Blaine calls for it, stop
   the worker lease cleanly, wait for the lease to end (check 4), run the
   documented two execution no upload authentication probe, and record the new
   owner, generation, and start time. Never authenticate again on the same day
   (section 8). The second, separately established session proof is deferred to
   OVD-319.
7. Forced failure and rollback drill (section 7).
8. Disable (section 3.3), then rerun preflight checks 2 and 3.
9. Post the sanitized evidence in the single rolling OVD-206 Linear comment.

A run counts only if it ends with a real Xometry offer, passes the live offer
gate, preserves every variant, uses the approved fingerprint, and
needed no repair. Five counted runs in a row complete the series. One uncounted run restarts the count of consecutive runs.

## 6. Per run evidence template (sanitized)

Copy once per run into the window log. Allowed content: counts, hashes, timings,
prices, lead times, quote references, truncated identifiers. Not allowed:
credentials, cookies, session material, raw screenshots with account details,
customer files, full addresses, or provider page dumps.

```text
Run:                      <1 to 5>      Date: <YYYY-MM-DD>
Operator:                 Blaine
Session owner / account:  <account_ref prefix>   Snapshot generation: <n>
Engine:                   <name and version>     Image digest: <first 12 of sha256>
Scope fingerprint:        <64 hex>               Matches approval: <yes/no>
Quote request / run id:   <first 8>  /  <first 8>
Lifecycle transitions:    queued <ts> > requesting <ts> > received <ts>   (or failed <ts>, reason)
Timing:                   enqueue to worker pickup <s>; pickup to offer <s>; total <s>
Approximate run cost:     <USD>  (Cloud Run seconds, egress, any provider cost; method noted)
Xometry variants preserved (one line per variant, none omitted):
  offer_key | lane_label | tier | unit_price_usd | total_price_usd | lead_time_business_days | quote_ref
  <row> ...
  Variant count seen on Xometry page: <n>   Stored vendor_quote_offers rows: <n>   Equal: <yes/no>
Provider reference:       <quote_ref / vendor source reference>
Provenance:               <trusted provenance fields shown by the live offer gate>
Live offer gate:          <pass/fail and reason>
Degradation checks:       Cloudflare/no op: <none/seen>   401 material API: <none/seen>
Repair or staff UI use:   <none> (anything else voids the run)
Result:                   <counts / does not count>   Notes: <one line>
```

Readback query for the stored side of the variant check (Blaine runs, read only):

```sql
begin read only;
select o.offer_key, o.lane_label, o.tier, o.unit_price_usd, o.total_price_usd,
       o.lead_time_business_days, o.quote_ref
from public.vendor_quote_offers o
join public.vendor_quote_results r on r.id = o.vendor_quote_result_id
where r.quote_run_id = '<RUN_ID>'
order by o.sort_rank, o.offer_key;
rollback;
```

## 7. Forced failure and rollback drill (Blaine runs)

Run after run 5, still inside the window, with the lane enabled. Goal: a finite
safe outcome, no stranded work, and a working rollback that keeps uploads and
existing results available.

1. Choose one failure to force. Prefer a safe simulation that cannot reach the
   provider with bad state: engage the Xometry kill switch with
   `npm run provider:kill -- xometry --on --reason "OVD-206 drill"` (OVD-722;
   the reason needs at least 10 characters)
   so the next request must refuse before any browser launch. If Blaine instead
   chooses a provider or session failure, he states the exact method first and
   it must not touch a credential or the profile snapshot.
2. Submit one request as the participant. Expect a finite terminal state
   (`failed` with a recorded reason, or refused at dispatch) within the
   expected timeout, with no browser launch and no upload to Xometry when the
   kill switch is on.
3. Run preflight checks 2 and 3. Expect zero queued or running rows and zero
   active quote requests. A stranded row is a failed drill.
4. Record the failure reason, the time to terminal state, and the audit event.
5. Switch the kill switch off for xometry
   (`npm run provider:kill -- xometry --off --reason "OVD-206 drill over"`),
   confirm state by rerunning preflight check 6.
6. Rollback: run section 3.3. Verify with the read API, verify uploads and
   existing result pages still open for the participant, and verify a new
   automatic request now returns the neutral unavailable response and creates
   no vendor work.
7. Session recovery: run the documented two execution no upload authentication
   probe (`worker/README.md`, Durable hosted profile snapshots) only if Blaine
   authorizes it for that day. Record each probe as one task, zero retry.
8. Record everything in the window log. Confirm cross organization denial again
   (preflight check 7).

## 8. Stop rules

Any of these ends the window for the day. Blaine runs the disable in section
3.3 first, then records the event.

- CAPTCHA, a Cloudflare challenge, an access block, a rate limit message, an
  account warning, or a ban notice from Xometry: stop, no retry, no workaround.
  Xometry stays off for the day. Order: flip the provider kill switch first
  (`npm run provider:kill -- xometry --on --reason "OVD-206 provider block <YYYY-MM-DD>"`),
  then run the rollout disable (section 3.3). Never rotate IPs,
  solve a CAPTCHA, mimic human pacing, or retry around a block.
- `login_required`, an anonymous session, or a 401 on the material API: stop, no
  retry, provider off for the day. Do not authenticate again on the same day.
- Daily cap: there is no default cap (OVD-829). If an admin set a Xometry
  daily quote cap for the window, count the 5 runs, the drill request, and any
  probes against it, and stop at the cap.
- Any non Xometry lane or task created, or `WORKER_LIVE_ADAPTERS` not exactly
  `xometry`.
- Any scope fingerprint mismatch, wrong file disclosed, wrong organization
  access, requirement mismatch, duplicate run, or unbounded queue state.
- Any run that would need database repair or staff operation of the customer UI.
- A variant missing from the stored offers.
- Any sign of vendor session compromise or a spend control failure.
- Any export declaration or ITAR/EAR flag problem.

After a stop: record sanitized diagnostics, correct the scoped fault in a
separate issue, and repeat the relevant certification gate before another
window. Stopping resets the consecutive run count unless Blaine records why a
partial series remains valid.

## 9. Close out

- [ ] Rollout disabled, readback recorded, queues empty.
- [ ] Vendor config returned to the intended resting state.
- [ ] All run evidence posted to the OVD-206 rolling comment, sanitized.
- [ ] Linear acceptance boxes checked only where evidence exists.
- [ ] Open questions and defects filed as separate bounded issues, not absorbed.

## Open items this kit could not settle from the repository

- The OVD-722 tables (`private.provider_kill_switches` and the singleton
  `private.provider_global_kill_switch`) are not on this branch's base. The names
  come from `docs/migration-drafts/ovd-722.sql` at PR #676 head a53e794b and
  `docs/providers/permissions-matrix.md`. Confirm them once OVD-722 merges.
- The OVD-723 export declaration column or table is not on this branch's base.
  Section 2 states the behavior from the Linear acceptance text; confirm the
  readback query once it merges.
- The age limit for the profile snapshot is a number Blaine sets.

## Eligibility check log

- 2026-10-31, agent session, `origin/main` at `826d17d`: **not eligible, window
  not opened.** Linear could not be read from the session, so the check used
  repository evidence only. `ovd-419-contained-live-handoff.json` still records
  `contained_probe_preacceptance_failure`. `OVD-528` and `OVD-529` have no
  merged work on `main`, and no `OVD-416` reconciliation evidence is checked in.
  `docs/1-0-beta-runbook.md` still requires Blaine's separate go for the window.
  No production, provider, or credential action was taken.
