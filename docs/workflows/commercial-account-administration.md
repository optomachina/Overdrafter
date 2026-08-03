# Commercial Account Administration Guide

Last reviewed: August 2, 2026

Audience: provisioned billing administrators and service operators

Use this guide for day-to-day administration of organization-level Free and
Pro access. The browser entry point is `/internal/commercial`.

This guide describes the current interface. It does not make Linear issues or
pull requests part of the operating procedure. Those remain implementation
history, not the administrator's manual.

## Related references

- [Billing Workflow](./billing-workflow.md) is authoritative for Stripe event synchronization, Checkout, Billing Portal, and entitlement resolution.
- [Commercial Rollout Controls](./commercial-rollout-controls.md) is authoritative for capability provisioning, feature switches, rollout, monitoring, and rollback.
- [Architecture: commercial access and operations](../../ARCHITECTURE.md#9-commercial-access-and-operations-layer) is authoritative for authorization and data boundaries.
- [PRD: commercial account and billing boundary](../../PRD.md#commercial-account-and-billing-boundary) is authoritative for the product contract.

## What the interface can do

| Operation | Current interface | Required access |
| --- | --- | --- |
| Search organizations by name or slug | `/internal/commercial` | Active `billing_admin` capability; AAL1 or AAL2 |
| Search organizations by member email | `/internal/commercial`; email-like searches remain in page memory and are not written to browser history | Active `billing_admin` capability; AAL1 or AAL2 |
| Review effective plan, source, dates, subscription history, members, quote activity, grants, and audit | Commercial account detail | Active `billing_admin` capability; AAL1 or AAL2 |
| Grant trial or complimentary Pro | Commercial account detail | Active `billing_admin`, AAL2, and enabled `commercial_admin_mutations` control |
| Revoke one manual Pro grant | Commercial account detail | Active `billing_admin`, AAL2, and enabled `commercial_admin_mutations` control |
| Complete an exact manual quote request | Manual quote inbox at `/internal/admin` | Active `billing_admin`, AAL2, and the internal-workspace route authorization |
| Start or manage a paid subscription | Customer-facing Checkout or Billing Portal | Authorized organization billing owner or internal organization administrator |
| Create promotion codes | Not implemented | Reserved `promotion_codes` control remains off |
| Administer manufacturing orders | Not implemented | Reserved `order_administration` control remains off |

Manual grants never create or impersonate a Stripe subscription. Promotion
codes, manufacturing payments, refunds, order discounts, automated supplier
placement, and ERP actions are not account-administration functions.

## Access and safety model

An operator must be signed in with a separately provisioned `billing_admin`
capability. An organization-admin membership and the platform-viewer allowlist
do not grant commercial-account access. Provisioning and revocation are
server-only procedures documented in [Commercial Rollout Controls](./commercial-rollout-controls.md#provision-billing-administrators).

Account search and read-only detail work at AAL1. Any trial, complimentary, or
revocation mutation requires AAL2 through a verified authenticator-app code.
The operator's factor must have been independently established before the
`billing_admin` capability is provisioned. If the interface offers TOTP
enrollment to an AAL1 session, do not use it for commercial access. There is no
compliant in-product bootstrap path for a new commercial operator yet; stop and
do not provision or mutate access until the approved security workflow exists.

Every successful manual access change records the signed-in operator, exact
organization or grant, reason, time, before and after state, and idempotency
evidence. The operator never switches into or impersonates the customer's
account.

## Open the account directory

1. Sign in with the approved operator account.
2. Open `/internal/commercial`, or choose **Commercial accounts** from the internal workspace sidebar.
3. If **Not authorized** appears, stop. Ask a service operator to verify the exact auth user ID and active `billing_admin` assignment. Do not work around the capability boundary by adding an organization membership.
4. Search by organization name, organization slug, or member email. Name and slug searches remain in the URL so they can be refreshed or shared. Any trimmed query containing `@` is treated as sensitive: it stays in page memory, is not written to the browser URL or history, and is lost on refresh. If an older link contains an email-like `q` value, the page keeps that search for the current session while replacing the URL with a scrubbed version. Other URL parameters are retained.
5. Choose **View** or **View account** for the exact organization. Check the organization name, slug, and member list before changing access.

The directory shows the effective Free or Pro plan, its source, validity,
member count, and recent manual and automatic quote activity. Use **Previous**
and **Next** for paginated results.

## Read the account truth

The detail page keeps paid subscriptions and manual grants separate.

| Effective source | Meaning | Operator response |
| --- | --- | --- |
| Free account | No eligible paid subscription and no active manual grant | Leave Free unless an approved trial or complimentary grant is required. |
| Paid subscription | Stripe-synchronized subscription currently resolves to Pro | Use Stripe/Billing Portal procedures for billing changes. Do not replace it with a manual grant. |
| Manual trial grant | Time-limited Pro access with a required expiration | Confirm the end time and business reason. |
| Manual complimentary grant | Reasoned Pro access with a required review date | Review it on schedule and revoke it when no longer approved. |
| Past-due grace period | Paid Pro remains active through the displayed grace end | Investigate Stripe synchronization and payment state; do not manually rewrite access. |

The **Automatic quotes on** badge describes the organization's effective Pro
entitlement. The independent `automatic_quote_collection` rollout control can
still stop automatic vendor collection globally. Inspect that control through
the rollout runbook when operational behavior does not match entitlement.

Also review:

- **Paid subscriptions** for status, interval, paid-through date, and scheduled cancellation;
- **Organization members** to confirm the account boundary;
- **Quote activity** for manual, automatic, waiting, received, and failed request counts;
- **Grant history** for active, expired, and revoked manual grants;
- **Commercial audit** for reasoned, append-only billing actions on the exact organization.

## Grant trial Pro

Use a trial for approved, time-limited evaluation access.

1. Confirm the exact organization and verify that a paid subscription or another active grant does not already satisfy the request.
2. In **Manual Pro access**, choose **Trial**.
3. Set **Starts** and the required **Trial expiration**. Expiration must be after the start time.
4. Enter a specific reason that another operator can understand later. Do not include passwords, tokens, payment-card data, or other secrets.
5. Choose **Grant trial Pro**. If the page shows **Verify with MFA to grant**, verify with the independently established factor. If the dialog offers factor setup instead, stop without changing access.
6. Confirm the success message, the effective-access summary, the new grant-history row, and the corresponding commercial-audit event.

Do not represent a trial as paid. Extending access requires another explicit,
reasoned grant; do not edit or delete history.

## Grant complimentary Pro

Use complimentary access only for an approved non-paid relationship.

1. Confirm the exact organization and the approval behind the complimentary access.
2. In **Manual Pro access**, choose **Complimentary**.
3. Set **Starts** and the required **Complimentary review date**. The review date must be after the start time.
4. Enter the business reason and owner for the next review.
5. Choose **Grant complimentary Pro**, verifying with the independently established factor when prompted. If the dialog offers factor setup instead, stop.
6. Confirm the effective-access summary, grant history, and commercial audit.

A review date is not an automatic expiration. The grant remains explicitly
complimentary until it expires, is revoked, or is superseded by other effective
access. Treat **Review due now** as an operator action item.

## Revoke a manual grant

Revocation removes only the selected manual grant. It does not cancel or alter
a paid Stripe subscription.

1. In **Grant history**, identify the exact trial or complimentary grant.
2. Choose **Revoke**. Verify with the independently established factor if the button says **Verify to revoke**. If the dialog offers factor setup instead, stop.
3. Enter a specific revocation reason.
4. Confirm **Revoke grant**.
5. Verify the grant is labeled **Revoked**, the effective-access summary is recalculated, and a commercial-audit event is present.

Never delete the grant or its audit history. If another active grant or eligible
Stripe subscription remains, the organization can correctly remain Pro after
the selected grant is revoked.

## Review paid subscription state

The account detail is a read-only view of the webhook-synchronized Stripe
projection. It is not a substitute for Stripe or the customer Billing Portal.

- Checkout success is pending until a signed webhook updates local state.
- Cancellation retains Pro through the paid period.
- Eligible past-due subscriptions retain Pro through the displayed seven-day grace period.
- Trial and complimentary grants can resolve to Pro without displaying a paid-subscription management action.

When Stripe and the local projection disagree, follow the replay and
reconciliation procedures in [Billing Workflow](./billing-workflow.md#stripe-event-synchronization).
Do not edit subscription, invoice, event-inbox, or entitlement projection rows
by hand.

## Review the audit trail

Use **Commercial audit** to answer who changed access, what changed, when, and
why. Events are newest first and paginated with **Previous** and **Next**.

For every manual access change, confirm:

- the action matches the intended grant or revocation;
- the actor is the signed-in operator;
- the reason is specific and contains no sensitive data;
- the event belongs to the exact organization;
- the idempotency key is present;
- the resulting effective access matches the active subscription and grant history.

Reads do not append mutation events. Audit rows are append-only and must not be
updated or deleted.

## Common failure states

| What the operator sees | Meaning | Response |
| --- | --- | --- |
| **Not authorized** | The signed-in user lacks an active `billing_admin` capability. | Verify the auth user ID, assignment, expiration, and revocation state through the server-only procedure. |
| **MFA required** | Reads are allowed, but the current session is not AAL2. | Verify the independently established factor. If the dialog offers factor setup or no verified factor exists, stop; do not enroll from the AAL1 commercial session. |
| Mutation-disabled error | `commercial_admin_mutations` is off or was disabled while the operator was working. | Leave it off until the incident or rollout owner approves enablement. Check the control and latest event; do not bypass it. |
| Account, audit, or authorization load failure | The guarded API or session could not return current truth. | Use **Retry** once. If it persists, stop changing access and investigate auth, migration, PostgREST, and service health. |
| Unexpected Free or Pro result | Another grant, subscription, grace period, expiry, or rollout control affects the result. | Reconcile all displayed sources before taking another action. Do not add a compensating grant merely to hide stale state. |
| Duplicate-looking result | A safe retry may have replayed an existing idempotent action. | Confirm the success message, grant history, and audit event before submitting anything new. |

## Before and after every mutation

Before:

- verify the organization identity and requester authorization;
- inspect paid subscriptions and existing grants;
- choose trial or complimentary truthfully;
- use required expiration or review dates;
- write a reason without secrets or payment data;
- confirm an independently established MFA factor and rollout-control readiness.

After:

- verify effective access and automatic-quote entitlement;
- verify the exact grant state;
- verify the append-only audit event;
- record any required business follow-up outside the product without copying credentials or payment data;
- escalate Stripe or rollout inconsistencies instead of editing database projections.
