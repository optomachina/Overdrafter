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

There are two paths. Both write the same switch and the same audit table.

| Path | Who | Auth | Audit actor |
| --- | --- | --- | --- |
| Admin page, Provider kill switch card | a platform admin | own session, **AAL2 required** (authenticator code; OVD-771) | `actor` = the admin's user id |
| `npm run provider:kill` CLI | an operator with the service role secret | service role (no MFA; OVD-771) | `actor` = `cli:service_role`, `operator` = the `--operator` name |

Use the admin page when a platform admin can complete MFA. Use the CLI when
they cannot (lost authenticator, MFA outage, no admin reachable): the emergency
brake never depends on MFA.

### CLI (service role)

Secrets are referenced by name only. Never paste the key into a ticket, chat,
or shell history. The CLI never prints it and redacts it from every output and
error line.

- `SUPABASE_URL` (or `VITE_SUPABASE_URL`): the project URL.
- The service role key, from one of:
  - **Secret Manager (preferred):** `--secret-name <GCP secret name>` (or env
    `OVERDRAFTER_SERVICE_ROLE_SECRET_NAME`), optionally `--secret-project
    <GCP project>` (or env `OVERDRAFTER_SERVICE_ROLE_SECRET_PROJECT`; otherwise
    the gcloud default project). The CLI runs `gcloud secrets versions access
    latest --secret=<name>` with your gcloud login. The worker's secret is
    `supabase-service-role-key` in `overdrafter-worker-9133`. A secret name
    takes precedence over the environment variable.
  - **Environment:** `SUPABASE_SERVICE_ROLE_KEY`, already loaded into the shell
    from the secret store.

  The key must be a service role secret (`sb_secret_...` or a legacy
  service_role JWT); a publishable key or a user session token is refused.
  `OVERDRAFTER_ADMIN_ACCESS_TOKEN` is no longer read. With no key the CLI exits
  with code 2 and says so; nothing is sent.

```bash
npm run provider:kill -- <provider_key> --on --reason "C&D received YYYY-MM-DD <reference>" --operator "<your name>"
```

The reason must be at least 10 characters. `--operator` is required for every
flip (2 to 120 printable characters): the service role has no user identity, so
the audit row records `actor = 'cli:service_role'` (set by the database, not by
the CLI) and this name as `operator`. `<provider_key>`
is the matrix key (`xometry`, `fictiv`, `quickparts`, `weerg`, `geomiq`, `rmfg`,
`oshcut`, `sendcutsend`, or `protolabs`).

The CLI prints the change and asks you to type the provider key (or `all`)
back; anything else changes nothing. `--yes` skips that prompt. `--list` shows
every switch, its version, and the operator of the latest CLI flip.

To stop every provider:

```bash
npm run provider:kill -- --all --on --reason "C&D received YYYY-MM-DD <reference>" --operator "<your name>"
```

The CLI calls the service_role-only RPCs
`api_service_set_provider_kill_switch`, `api_service_set_global_kill_switch` and
`api_service_list_provider_kill_switches`
(`docs/migration-drafts/ovd-771.sql`). **Pending OVD-771
migration window:** until that draft is applied, the CLI fails with a 404 that
names the missing migration. In that window use the admin page (with MFA), or
the manual fallback below if no admin can complete MFA.

### Admin page (AAL2)

Open Internal admin, Provider kill switch, choose Stop, type the reason and the
provider key, and press Confirm. If the session is not already AAL2, an
authenticator-code dialog opens; the switch is written only after the code
verifies, and is sent once. Cancelling the dialog writes nothing. If your
account has no authenticator enrolled, the card says so and offers "Set up
authenticator" (the same authenticator used for Commercial accounts and Founding
Beta changes); enroll, then submit the change again. If no admin can do this in
time, use the CLI. The admin page calls

```text
api_admin_set_provider_kill_switch(p_provider := '<provider_key>', p_engaged := true, p_reason := 'C&D received YYYY-MM-DD <reference>')
```

Confirm immediately:

1. The admin page or `provider:kill -- --list` shows that provider engaged, with
   timestamp and reason. A CLI flip shows no user actor on the admin page;
   `--list` shows `cli:service_role` and the operator.
2. `private.provider_kill_switch_audit` gained a row in the same transaction
   (`actor = 'cli:service_role'` plus `operator` for CLI flips, the admin's user
   id for admin flips).
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
- the kill-switch audit row (who: `actor` or `operator`, when, reason)

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
2. An OVD-722 release with a reason of at least 10 characters, from the admin
   page (AAL2) or the CLI:

```bash
npm run provider:kill -- <provider_key> --off --reason "Written permission recorded <reference>" --operator "<your name>"
```

A release reads the current switch first, shows it, and sends that version; the
database refuses it (`kill_switch_version_conflict`) if anyone flipped the
switch after that read.

Admission, rollout, and worker enablement stay on their own gates.
