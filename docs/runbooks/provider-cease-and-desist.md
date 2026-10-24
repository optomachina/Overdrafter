# Provider cease-and-desist playbook

Owner: Blaine. This playbook defines no kill switch of its own. It uses the
OVD-722 per-provider switch.

This is an operations playbook, not legal advice. Escalate to paid counsel if any
financial demand is made.

## Target

Turn the named provider off **within 1 hour** of receiving a cease-and-desist,
by flipping the OVD-722 config switch. The flip needs **no deploy**. Latency is
the next preflight or worker check, typically a few seconds. There is no cache.

> **Dependency: OVD-722 is not merged yet.** The RPCs, tables, deny code and
> task state below are the planned OVD-722 interface, not shipped behavior.
> Until it merges, this playbook cannot be executed as written. Do not build a
> second switch here. Re-verify every name below against the merged OVD-722
> migration before the first real use.

Planned interface:

- RPC `api_admin_set_provider_kill_switch(provider, engaged, reason)`
- RPC `api_admin_set_global_kill_switch(engaged, reason)`
- Tables `private.provider_kill_switches` (per provider) and
  `private.provider_global_kill_switch` (all providers)
- Terminal denial code `provider_kill_switch_engaged`
- In-flight queued tasks end `cancelled_provider_disabled`

## Step 1 — Flip the OVD-722 switch (exact)

Use the platform-admin session. Never the service role.

```text
api_admin_set_provider_kill_switch(provider := '<provider_key>', engaged := true, reason := 'C&D received YYYY-MM-DD <reference>')
```

`<provider_key>` is the matrix key (`xometry`, `fictiv`, `quickparts`, `weerg`,
`geomiq`, `rmfg`, `oshcut`, `sendcutsend`, or `protolabs`). The flip is a config
change, so it needs no deploy.

To stop every provider:

```text
api_admin_set_global_kill_switch(engaged := true, reason := 'C&D received YYYY-MM-DD <reference>')
```

Confirm immediately:

1. The `private.provider_kill_switches` row for that provider shows `engaged`,
   with actor, timestamp, and reason (or `private.provider_global_kill_switch`
   for the global flip).
2. The next dispatch authorization for that provider is denied with
   `provider_kill_switch_engaged`. That deny is terminal and not retryable.
3. Queued in-flight tasks for that provider end `cancelled_provider_disabled`.
4. Other providers continue unless the global switch was used.

No deploy, no admission-policy edit, and no envelope withdrawal is required for
the emergency stop. Envelope withdrawal remains the durable follow-up.

## Step 2 — Preserve evidence

Keep, without altering:

- the letter or email and its envelope/headers
- ToS snapshots used in the permissions matrix
- our traffic logs for that provider
- the kill-switch row and its audit trail (who, when, reason)

Do not delete tasks, permits, or audit rows.

## Step 3 — Update the matrix

Set that provider's `permission_status=cease_and_desist`. The lint then forces
`enabled_for_paid_automation` to false. Record the receipt date and a short
summary on the row's `replies`.

## Step 4 — Reply-template draft for Blaine

Do not send this. Blaine approves and sends it.

```text
We received your letter dated <date> regarding automated access to <provider>.
We have stopped automated traffic to <provider>. We make no admissions.
Please send any further correspondence to <Blaine's address>.
```

Acknowledge, confirm we stopped, and make no admissions.

## Step 5 — Ownership and escalation

Owner: Blaine. Team bots do not contact the vendor. Escalate to paid counsel if
the letter demands money, a release, or anything beyond stopping access.

## Re-enable

Re-enabling requires both:

1. Written permission recorded on the matrix row.
2. An OVD-722 off-to-on flip with a reason:

```text
api_admin_set_provider_kill_switch(provider := '<provider_key>', engaged := false, reason := 'Written permission recorded <reference>')
```

Admission, rollout, and worker enablement stay on their own gates.
