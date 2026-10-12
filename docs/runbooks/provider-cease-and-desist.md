# Provider cease-and-desist playbook

Owner: Blaine. This playbook defines no kill switch of its own. It uses the
OVD-722 per-provider switch.

This is an operations playbook, not legal advice. Escalate to paid counsel if any
financial demand is made.

Target: 1 hour, no code deploy (a Cloud Run env change creates a new revision), **pending OVD-722** (until the kill switch ships, follow the manual fallback below)

Turn the named provider off **within 1 hour** of receiving a cease-and-desist,
by flipping the OVD-722 config switch. The flip needs **no code deploy**. Latency is
the next preflight or worker check, typically a few seconds. There is no cache.

Until OVD-722 lands, the command and RPC below are the planned interface from
that issue's design. Do not invent a second switch.

## Step 1: Engage the OVD-722 kill switch

Use the platform-admin session. Never the service role.

```bash
npm run provider:kill -- <provider_key> --on --reason "C&D received YYYY-MM-DD <reference>"
```

The reason must be at least 10 characters. `<provider_key>` is the matrix key
(`xometry`, `fictiv`, `quickparts`, `weerg`, `geomiq`, `rmfg`, `oshcut`,
`sendcutsend`, or `protolabs`).

Equivalent RPC from the OVD-722 plan:

```text
api_admin_set_provider_kill_switch(provider := '<provider_key>', engaged := true, reason := 'C&D received YYYY-MM-DD <reference>')
```

To stop every provider, the planned global command is:

```bash
npm run provider:kill -- --all --on --reason "C&D received YYYY-MM-DD <reference>"
```

Confirm immediately:

1. The admin page shows that provider engaged, with actor, timestamp, and reason.
2. `private.provider_kill_switch_audit` gained a row in the same transaction.
3. The next `api_authorize_provider_worker_dispatch` (and the Xometry preflight)
   returns `provider_kill_switch_engaged`. That deny is terminal and not retryable.
4. The worker re-check `api_worker_provider_kill_switch_state` refuses before
   browser launch, navigation, upload, or API call. Queued tasks end
   `cancelled_provider_disabled`.
5. Other providers continue unless the global switch was used.
6. Customers see "provider temporarily unavailable".

No code deploy, no admission-policy edit, and no envelope withdrawal is required for
the emergency stop. Envelope withdrawal remains the durable follow-up.

## Manual fallback until OVD-722 ships

If `provider:kill` or the RPC does not exist yet, Blaine stops traffic by hand within the same hour. No code is deployed, but changing a Cloud Run env var creates a new Cloud Run revision, so allow a few minutes for it to roll out. Do not build a second kill switch.

1. Read the current list. The worker is the Cloud Run service `overdrafter-cad-worker` in project `overdrafter-worker-9133`, region `us-west1`
   (see `docs/workflows/ovd410-stable-egress.md` and `worker/scripts/deploy-cloud-run.sh`, which sets `WORKER_LIVE_ADAPTERS`):

   ```bash
   gcloud run services describe overdrafter-cad-worker --project overdrafter-worker-9133 --region us-west1 --format=json | grep -A1 WORKER_LIVE_ADAPTERS
   ```

2. Set it again without the provider key. This example drops `fictiv` from `xometry,fictiv,quickparts,weerg`. The `^@^` prefix is needed because the list contains commas:

   ```bash
   gcloud run services update overdrafter-cad-worker --project overdrafter-worker-9133 --region us-west1 --update-env-vars "^@^WORKER_LIVE_ADAPTERS=xometry,quickparts,weerg"
   ```

   The deploy script refuses an empty list, so if the C&D provider is the only adapter (for example `xometry`), stop and escalate to Blaine. The manual path for that case is TBD pending OVD-722.
3. Admission policy `disabled`: the repo shows no admin RPC or CLI for this. Admission is currently set by reviewed migrations
   (for example `supabase/migrations/20260928081534_seed_rmfg_disabled_admission.sql`). The admin path is TBD pending OVD-722. Step 1 above is the supported route once it ships.
4. Record what was done and when, then continue with Step 2.

## Step 2: Preserve evidence

Keep, without altering:

- the letter or email and its envelope/headers
- ToS snapshots used in the permissions matrix
- our traffic logs for that provider
- the kill-switch audit row (who, when, reason)

Do not delete tasks, permits, or audit rows.

## Step 3: Update the matrix

Set that provider's `permission_status=cease_and_desist`. The lint then forces
`enabled_for_paid_automation` to false. Record the receipt date and a short
summary on the row's `replies`.

## Step 4: Reply-template draft for Blaine

Do not send this. Blaine approves and sends it.

```text
We received your letter dated <date> regarding automated access to <provider>.
We have stopped automated traffic to <provider>. We make no admissions.
Please send any further correspondence to <Blaine's address>.
```

Acknowledge, confirm we stopped, and make no admissions.

## Step 5: Ownership and escalation

Owner: Blaine. Team bots do not contact the vendor. Escalate to paid counsel if
the letter demands money, a release, or anything beyond stopping access.

## Re-enable

Re-enabling requires both:

1. Written permission recorded on the matrix row.
2. An OVD-722 off-to-on flip with a reason of at least 10 characters:

```bash
npm run provider:kill -- <provider_key> --off --reason "Written permission recorded <reference>"
```

Admission, rollout, and worker enablement stay on their own gates.
