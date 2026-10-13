# Provider cease-and-desist playbook

Owner: Blaine. This playbook defines no kill switch of its own. It uses the
OVD-722 per-provider switch.

This is an operations playbook, not legal advice. Escalate to paid counsel if any
financial demand is made.

Target: 1 hour, no deploy, **pending OVD-722** (until the kill switch ships, follow the manual fallback below)

Turn the named provider off **within 1 hour** of receiving a cease-and-desist,
by flipping the OVD-722 config switch. The flip needs **no deploy**. Latency is
the next worker check, typically a few seconds. There is no cache.

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
3. A new dispatch request for that provider is refused with
   `provider_kill_switch_engaged` (the permit insert is blocked). That deny is
   terminal and not retryable. The server preflights themselves are unchanged
   in window 1; the worker check below is what stops running work.
4. The worker re-check `api_worker_provider_kill_switch_state` refuses before
   browser launch, navigation, upload, or API call. Queued tasks end
   `cancelled_provider_disabled`.
5. Other providers continue unless the global switch was used.
6. Customers see "provider temporarily unavailable".

Operator live tools do not read the switch. `npm --prefix worker run
eval:live-provider`, `smoke:vendor-workflow`, `sweep:xometry-quantity` and
`sweep:fictiv-quantity` open the provider directly and have no database client,
so engaging the switch does not stop them. While a provider is engaged or under
a C&D, do not run any of them for that provider, and stop any that are running.

No deploy, no admission-policy edit, and no envelope withdrawal is required for
the emergency stop. Envelope withdrawal remains the durable follow-up.

## Manual fallback until OVD-722 ships

If `provider:kill` or the RPC does not exist yet, Blaine stops traffic by hand
within the same hour.

1. Remove the provider key from `WORKER_LIVE_ADAPTERS` on the Cloud Run worker
   `overdrafter-cad-worker`. This is not a no-deploy change: Cloud Run creates a
   **new revision** whenever an environment variable is updated.

```bash
gcloud run services update overdrafter-cad-worker \
  --project overdrafter-worker-9133 \
  --region us-west1 \
  --update-env-vars "^@^WORKER_LIVE_ADAPTERS=<remaining_comma_separated_keys>"
```

The `^@^` prefix changes the list delimiter to `@`. Without it gcloud splits the
value on commas and fails with `Bad syntax for dict arg` whenever two or more
adapters remain, which would leave the provider live. Replace
`<remaining_comma_separated_keys>` with the current list minus the provider being
stopped.

Never set an empty remainder. In live mode an empty `WORKER_LIVE_ADAPTERS` is a
readiness error (`worker/src/runtimeSecrets.ts`), so the new revision does not
become ready and the old revision, with the provider still on, keeps traffic. If
the provider is the last live adapter, stop here and get Blaine's decision on
stopping the worker service.

Verify that the new revision is serving and the provider is gone (read only):

```bash
gcloud run services describe overdrafter-cad-worker \
  --project overdrafter-worker-9133 \
  --region us-west1 \
  --format="yaml(status.latestCreatedRevisionName,status.latestReadyRevisionName,status.traffic)"
gcloud run services describe overdrafter-cad-worker \
  --project overdrafter-worker-9133 \
  --region us-west1 \
  --format="value(spec.template.spec.containers[0].env)" | grep WORKER_LIVE_ADAPTERS
```

The latest created and latest ready revisions must match, traffic must point at
that revision, and the `WORKER_LIVE_ADAPTERS` value must no longer list the
provider.

2. Admission policy lives in `private.quote_provider_admission_policies`, which no
   admin role can write. There is no command to paste for it. Do not run SQL by
   hand. The `gcloud` step above is what stops traffic. Open a **reviewed migration**
   that sets that provider's `admission_state` to `disabled` as the durable follow-up.

Record what was done and when, then continue with Step 2.

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
