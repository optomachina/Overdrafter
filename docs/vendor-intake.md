# Website vendor intake (VI-0)

Last updated: October 17, 2026

Status: **design note and decision record only.** Nothing described here is
implemented, migrated, or deployed. This note adds no table, RPC, route, or
flag. Each object below is a proposal for the child units in
[Decomposition](#decomposition).

## Purpose

Fixture should make vendor onboarding fast and safe **on the website**. Anyone
in the allowed submitter class (see [D1](#d1-anonymous-or-authenticated-submission))
can submit a vendor into a persisted queue. An administrator-configured policy
decides what happens next, and every consequential step is an audited action
by an authorized administrator.

A CLI-only or registry-only path does not meet this goal. The existing Fixture
work (Linear OVD-687, OVD-688, OVD-689, OVD-690, OVD-692 and OVD-707) is the
CLI and registry path: `fixture:onboard` ([docs/fixture.md](fixture.md)), the
single live-adapter registry (`provider-integrations/provider-registry.v1.json`)
and providers as data (`docs/migration-drafts/ovd-707-notes.md`). Website
intake **feeds** that path. It does not replace it, duplicate it, or skip any of
its gates in [the provider integration lifecycle](provider-integration.md).

## No-external-execution rule

This rule is the core of the design. Every child must keep it, and the test
plan proves it.

> No vendor-intake policy action, automatic or administrator-applied, may
> contact a vendor or any other external party, fetch a vendor URL
> server-side, store credentials or secrets, or enable provider dispatch.
> Each of those stays a protected action under `AGENTS.md` and needs
> Blaine's separate, explicit authorization.

In practice:

- The allowed actions form a closed list ([Actions](#closed-action-allowlist)).
  None of them takes an endpoint, URL to call, message body, recipient,
  credential, or secret as a parameter.
- Intake functions do not call any network-capable database facility. Today
  no migration installs `pg_net` or uses `net.http_*`. Intake functions must
  not reference `net.`, `http`, `dblink` or `pg_notify`.
- The website never fetches, prefetches, unfurls, or previews the submitted
  URL. The admin queue shows it as plain text with a copy button, not as a
  link.
- Intake never writes to `provider-integrations/**`, the generated catalogs,
  `private.quote_provider_admission_policies`, `private.provider_kill_switches`,
  `REVIEWED_PROVIDER_DISPATCH_ENVELOPES`, or (until
  [D4](#d4-what-approve_internal-produces) says otherwise)
  `private.provider_definitions` or `public.supplier_companies`.
- Intake sends no outbound email, chat or other notification in v1. A
  submitter sees status only on the website.

## Scope

In scope:

- a website form that submits a vendor candidate (name, official HTTPS URL,
  process families, short notes);
- a persisted, append-audited queue in the `private` schema;
- deterministic policy evaluation inside the submit transaction;
- an AAL2 admin queue to review, decide and hand off requests;
- submitter-visible status for their own requests;
- the handoff record an operator feeds into
  `npm run fixture:onboard -- --stage=envelope --url <url> --dry-run`.

Non-goals (v1):

- fetching, crawling, screenshotting or validating the vendor site;
- contacting the vendor or the submitter outside the website;
- collecting vendor credentials, API keys, portal accounts or session state;
- creating manifests, registry entries, enum values, admission rows or kill
  switch rows, or running `provider:sync`;
- any dispatch, live evaluation or quote execution;
- replacing the `add-quote-provider` skill or the Fixture CLI;
- a bulk import or a public directory of submitted vendors.

## Existing objects this aligns with

Verified at base `953666ce` (main):

| Object | File | How intake uses it |
| --- | --- | --- |
| `private.require_provider_definition_admin()` pattern: `public.require_verified_auth()`, `public.is_platform_admin()`, `public.current_user_has_aal2()` | `docs/migration-drafts/ovd-707-a.sql`; helpers in `supabase/migrations/20260303133000_require_verified_auth_for_sensitive_actions.sql`, `20260325120000_add_platform_admin_god_mode.sql`, `20260731015213_secure_commercial_admin_operations.sql` | Same admin guard, as `private.require_vendor_intake_admin()` |
| Reason rule `reason_required_min_10_chars` (`private.provider_definition_reason`) | `docs/migration-drafts/ovd-707-a.sql` | Same rule for free-text admin reasons |
| Append-only audit (`private.provider_audit_log`, triggers block UPDATE, DELETE and TRUNCATE; `actor`, `actor_kind`, `request_id` from `x-request-id`) | `docs/migration-drafts/ovd-707-a.sql` | Same shape for `private.vendor_intake_events` |
| Private tables with RLS enabled and forced, no policies, `revoke all` from `anon`, `authenticated` and `service_role` | `docs/migration-drafts/ovd-707-a.sql`, `supabase/migrations/20261013043100_ovd722_provider_kill_switch.sql` | Same posture for every intake table |
| Provider slug `^[a-z][a-z0-9]{1,49}$` | `private.provider_definitions.slug` in `ovd-707-a.sql`; `deriveProviderKey` in `scripts/provider-manifest.mjs` | `proposed_key` uses the same rule |
| `parseSafeHttpsUrl`, `normalizeOfficialDomain`, `deriveRegistrableDomain`, `deriveProviderKey` | `scripts/provider-manifest.mjs` | URL and domain rules; SQL must match them (parity test) |
| Anon executes no `SECURITY DEFINER` function (OVD-736) | `supabase/migrations/20261015074957_ovd736_revoke_anon_definer_execute.sql`, `supabase/tests/ovd736_anon_definer_privileges.sql`, `supabase/tests/api_role_privilege_inventory.sql` | Submit RPCs are `authenticated` (or `service_role` for the anonymous variant) |
| Supplier directory (OVD-214): `public.supplier_companies` with `origin = 'customer_suggested'`, unique `lower(website_domain)`, internal-only RLS, no client insert | `supabase/migrations/20260725090000_add_supplier_directory_foundation.sql`, `src/features/quotes/supplier-directory-foundation-migration.test.ts` | Duplicate source; intake does not open client writes to it |
| `provider.integration_added` notification on a disabled admission insert | `supabase/migrations/20260905030647_add_provider_admin_notifications.sql` | Unchanged; intake never inserts admission rows |
| Per-user rate window (`user_window_minutes`, `user_max_requests_per_window`, `rate_limited_user`) | `supabase/migrations/20260323190000_add_quote_request_guardrails.sql` | Same rate-limit vocabulary |
| Default-off client flags (`VITE_BILLING_SELF_SERVICE_ENABLED`) | `src/lib/billing-flags.ts` | Same pattern for `VITE_VENDOR_INTAKE_ENABLED` |
| Web provider catalog (presentation only) | `src/features/quotes/generated/provider-catalog.ts` | Admin UI hint for "possible existing provider" |
| RLS deny-tag convention | `docs/rls-deny-coverage.md`, `scripts/check-rls-deny-coverage.mjs` | Three deny cases per new table |

No `supplier_intake` table, `api_supplier_intake` RPC or other website intake
object exists at this base (searched `supabase/`, `src/`, `worker/`, `scripts/`
and `docs/`). OVD-688, OVD-689 and OVD-692 are named here from the unit brief;
the repository does not reference them.

Naming: tables and RPCs use the `vendor_intake` prefix. "Vendor" is the
website word. An approved request becomes a candidate **provider** for the
OVD-707 and Fixture path, keyed by `proposed_key`.

## End-to-end flow

```
website form ──submit──> api_submit_vendor_intake (one transaction)
                            │ 1. flag on? caller allowed? rate limit ok?
                            │ 2. validate + normalize URL, derive domain and key
                            │ 3. duplicate checks (open request, known provider)
                            │ 4. insert private.vendor_intake_requests (status submitted)
                            │ 5. evaluate active policy revision (pure SQL)
                            │ 6. auto action only if allowed (D2) and enabled
                            │ 7. append events (submit, policy_evaluated, auto_action)
                            ▼
                 private queue ──> admin queue UI (platform admin + AAL2)
                            │ api_admin_decide_vendor_intake_request
                            │   (closed action, typed reason, expected version)
                            ▼
                 approved_internal ──operator, offline──> fixture:onboard --stage=envelope --dry-run
                            │ api_admin_link_vendor_intake_onboarding (issue/PR ref)
                            ▼
                 onboarding_linked (then the normal provider lifecycle and its gates)
```

The policy runs in the submit transaction, so there is no worker, queue
consumer or background job, and so nothing that could reach the network.

## Request state machine

| From | Event | To | Who |
| --- | --- | --- | --- |
| (none) | `submit` | `submitted` | submitter |
| `submitted` | `escalate` | `escalated` | policy (auto) or admin |
| `submitted`, `escalated` | `needs_info` | `needs_info` | policy (auto) or admin |
| `submitted`, `escalated` | `mark_duplicate` | `duplicate` | policy (auto) or admin |
| `submitted`, `escalated` | `approve_internal` | `approved_internal` | admin only |
| `submitted`, `escalated`, `needs_info` | `decline` | `declined` | admin only |
| `needs_info` | `resubmit` | `submitted` (policy runs again) | submitter |
| `submitted`, `escalated`, `needs_info` | `withdraw` | `withdrawn` | submitter |
| `approved_internal` | `link_onboarding` | `onboarding_linked` | admin only |
| `approved_internal` | `decline` | `declined` | admin only |
| `declined`, `duplicate` | `reopen` | `submitted` | admin only |

`withdrawn` and `onboarding_linked` are terminal. Any other transition raises
`vendor_intake_invalid_transition`. Every row has a `version` integer. Admin
and submitter mutations pass `p_expected_version`, and a mismatch raises
`vendor_intake_stale_version`, so two admins cannot both decide a request.

Audit events (`private.vendor_intake_events.action`): `submit`,
`policy_evaluated`, `auto_action`, `admin_action`, `resubmit`, `withdraw`,
`link_onboarding`, `reopen`, `policy_revision_created`,
`policy_revision_activated`, `settings_changed`. Each event records actor,
actor kind (`user`, `policy`, `service_role` or `cli`), `from_status`,
`to_status`, action name, `reason_code`, admin reason, policy revision, rule
id and `request_id`. Events never copy the submitter's free-text notes, so
notes can be purged ([D6](#d6-retention-of-free-text)).

### What the submitter sees

Status text is fixed copy keyed by status and `reason_code`. Admin free-text
reasons and internal states are never shown.

| Internal status | Submitter sees |
| --- | --- |
| `submitted`, `escalated` | Received. In review. |
| `needs_info` | We need more information, plus fixed copy for the reason code, and an edit form |
| `approved_internal`, `onboarding_linked` | Accepted for onboarding review. This does **not** say the vendor is live, quoting or partnered. |
| `declined` | Not accepted, plus fixed copy for the reason code |
| `duplicate` | Already submitted |
| `withdrawn` | Withdrawn |

Invalid input is refused synchronously with a field-level message and is
**not** persisted. Rate-limited submissions are not persisted either; the form
shows "Too many submissions, try again later".

## Proposed tables and RPCs (design level)

All tables live in `private`, with RLS enabled and forced, no policies, and
`revoke all` from `public`, `anon`, `authenticated` and `service_role`. Every
RPC is `SECURITY DEFINER` with `set search_path = ''`, is granted only to the
role listed, and is revoked from `public` and `anon`. Admin RPCs call
`private.require_vendor_intake_admin()` first (verified auth, platform admin,
AAL2), like OVD-707.

Tables:

- `private.vendor_intake_settings`: one row. `submissions_enabled boolean
  default false`, `auto_actions_enabled boolean default false`,
  `anonymous_enabled boolean default false`, rate-limit values, `revision`,
  `change_reason`, `updated_by`.
- `private.vendor_intake_requests`: `id uuid`, `submitter_kind`
  (`authenticated` or `anonymous`), `submitted_by uuid null`,
  `idempotency_key uuid`, `vendor_display_name` (1 to 120 characters),
  `official_url` (normalized HTTPS, at most 2048), `official_domain`,
  `proposed_key` (`^[a-z][a-z0-9]{1,49}$` or null), `process_families`
  (values of `public.process_types`), `notes` (at most 2000, plain text),
  `status`, `reason_code`, `duplicate_of uuid`, `matched_provider_key`,
  `onboarding_ref` (`OVD-<n>` or a GitHub PR URL in this repo),
  `policy_revision_id`, `version`, `created_at`, `updated_at`. Unique
  `(submitted_by, idempotency_key)`. Unique partial index on
  `official_domain` where status is `submitted`, `escalated`, `needs_info` or
  `approved_internal`.
- `private.vendor_intake_events`: append-only (UPDATE, DELETE and TRUNCATE
  triggers raise `42501`), shaped like `private.provider_audit_log`.
- `private.vendor_intake_policy_revisions`: append-only `policy jsonb`
  (validated), `proposed_by`, `approved_by`, `state` (`draft`, `active`,
  `superseded`). At most one `active` row.
- `private.vendor_intake_rate_buckets`: `(bucket_key, window_start)` counters.
  `bucket_key` is the user id, `domain:<domain>`, `global`, or for the
  anonymous variant an HMAC of the client address. It never stores a raw IP
  address.

RPCs:

| RPC | Grantee | Purpose |
| --- | --- | --- |
| `api_submit_vendor_intake(jsonb, uuid)` | `authenticated` | Submit with an idempotency key; returns id, status and fixed status copy |
| `api_list_my_vendor_intake_requests()` | `authenticated` | Caller's own requests only |
| `api_update_my_vendor_intake_request(uuid, jsonb, integer)` | `authenticated` | Resubmit from `needs_info` |
| `api_withdraw_my_vendor_intake_request(uuid, integer)` | `authenticated` | Withdraw |
| `api_admin_list_vendor_intake_requests(text)` | `authenticated` (admin, AAL2) | Queue by status |
| `api_admin_get_vendor_intake_request(uuid)` | `authenticated` (admin, AAL2) | Request plus events |
| `api_admin_decide_vendor_intake_request(uuid, text, text, text, integer)` | `authenticated` (admin, AAL2) | Action, reason code, reason, expected version |
| `api_admin_link_vendor_intake_onboarding(uuid, text, text, integer)` | `authenticated` (admin, AAL2) | Record the Fixture issue or PR ref |
| `api_admin_reopen_vendor_intake_request(uuid, text, integer)` | `authenticated` (admin, AAL2) | Reopen `declined` or `duplicate` |
| `api_admin_create_vendor_intake_policy_revision(jsonb, text)` | `authenticated` (admin, AAL2) | Validated draft |
| `api_admin_activate_vendor_intake_policy_revision(uuid, text, boolean)` | `authenticated` (admin, AAL2) | Four-eyes rule in [D3](#d3-who-may-change-the-policy) |
| `api_admin_set_vendor_intake_settings(jsonb, text)` | `authenticated` (admin, AAL2) | Flags and limits; turning a flag **off** is always single-admin |
| `api_service_submit_vendor_intake(jsonb, text)` | `service_role` | Anonymous variant only, called by an edge function; not built in the first release ([D1](#d1-anonymous-or-authenticated-submission), decided: authenticated first) |

Owner-only helpers (revoked from every API role):
`private.require_vendor_intake_admin()`, `private.vendor_intake_reason(text)`,
`private.vendor_intake_normalize_url(text)`,
`private.vendor_intake_policy_is_valid(jsonb)`,
`private.evaluate_vendor_intake_policy(private.vendor_intake_requests)`,
`private.write_vendor_intake_event(...)`, `private.vendor_intake_take_rate(text)`.

Typed errors: `vendor_intake_disabled`, `vendor_intake_rate_limited`,
`vendor_intake_invalid_url`, `vendor_intake_invalid_field`,
`vendor_intake_not_found` (`P0002`, also returned for another user's request,
so ids cannot be probed), `vendor_intake_invalid_transition`,
`vendor_intake_stale_version`, `vendor_intake_action_not_allowed`,
`vendor_intake_reason_code_invalid`, `reason_required_min_10_chars`,
`platform_admin_required`, `four_eyes_required`, and the OVD-707 AAL2 message.

Typed reason codes (closed per action):

- `decline`: `out_of_scope_process`, `not_a_manufacturer`,
  `insufficient_evidence`, `policy_blocked`, `spam`, `other`.
- `needs_info`: `missing_official_url`, `missing_process`,
  `unclear_identity`, `other`.
- `mark_duplicate`: `open_request`, `existing_provider`,
  `existing_supplier`.

Admin actions also need a free-text reason of at least 10 characters (OVD-707
A8). Policy actions record the rule id instead.

## Policy grammar

A policy revision is JSON with a closed shape. `private.vendor_intake_policy_is_valid`
rejects unknown keys, unknown predicates and unknown actions, as
`private.provider_definition_check_input` does for OVD-707.

```json
{
  "schema": "vendor-intake-policy.v1",
  "rules": [
    { "id": "known-provider", "when": { "matchesExistingProvider": true },
      "then": "mark_duplicate", "reasonCode": "existing_provider", "mode": "auto" },
    { "id": "no-process", "when": { "missingFields": ["process_families"] },
      "then": "needs_info", "reasonCode": "missing_process", "mode": "recommend" },
    { "id": "default", "when": {}, "then": "escalate", "mode": "recommend" }
  ]
}
```

- Rules run in order and the first match wins. The last rule must have an
  empty `when` and `mode: "recommend"`. At most 50 rules; ids match
  `^[a-z0-9-]{1,40}$` and are unique.
- `when` is an AND of the predicates present. There is no OR, NOT, regex,
  expression, script or user-defined function.
- Predicates (closed): `submitterKind` (list), `matchesOpenRequest` (boolean),
  `matchesExistingProvider` (boolean: `public.vendor_name` values,
  `public.supplier_companies.website_domain`, and OVD-707
  `host_allowlist` once promoted), `domainSuffixIn` (at most 50 lowercase
  suffixes), `processFamiliesAny` (values of `public.process_types`),
  `missingFields` (optional field names), `priorDeclinesForDomainAtLeast`
  (1 to 10).
- `mode` is `recommend` (the admin queue shows it; nothing changes) or `auto`
  (applied in the submit transaction). `auto` takes effect only when the
  action is auto-eligible ([D2](#d2-which-policy-actions-may-auto-execute))
  and `auto_actions_enabled` is true. Otherwise the rule acts as `recommend`
  and the event records why.
- All predicates read only the request row and OverDrafter's own tables.
  None of them reads the network.

### Closed action allowlist

| Action | Effect inside OverDrafter | Auto-eligible (D2, decided) |
| --- | --- | --- |
| `escalate` | status `escalated` | yes |
| `needs_info` | status `needs_info`, fixed copy shown to the submitter | yes |
| `mark_duplicate` | status `duplicate`, `duplicate_of` or `matched_provider_key` set | yes |
| `decline` | status `declined` | no, admin only |
| `approve_internal` | status `approved_internal`; the handoff record is shown to admins | no, admin only |
| `link_onboarding` | status `onboarding_linked`, `onboarding_ref` recorded | no, admin only (not a policy action) |

Adding an action needs a reviewed schema change and this document's update.
An action that would contact anyone, fetch anything, store a credential,
or touch provider registry, admission, dispatch or kill switch state can
never be added to this list. See [the rule](#no-external-execution-rule).

### Handoff to the Fixture path

`approve_internal` makes the handoff record visible: normalized
`official_url`, `official_domain` and `proposed_key`. An operator or agent
then runs the existing offline path from
[the provider integration lifecycle](provider-integration.md#add-a-provider-offline):

```bash
npm run fixture:onboard -- --stage=envelope --url "<official_url>" --dry-run
```

Fixture never reads the network ([docs/fixture.md](fixture.md)), so this step
also stays offline. The operator records the issue or PR with
`api_admin_link_vendor_intake_onboarding`. Envelope research, the live stage,
exact-file approval, admission and go-live keep all of their existing gates.

## Abuse model

| Threat | Control |
| --- | --- |
| Spam and queue flooding | Per-user limit (default 5 per hour, 20 per day), per-domain limit (3 open requests per day), global limit (200 per hour; above it, submit returns `vendor_intake_rate_limited` for everyone). Length caps on every field. Admin `decline` with `spam`. `submissions_enabled = false` stops intake at once. |
| Duplicates | Normalized `official_domain` with a unique partial index over open statuses. A concurrent second insert hits the index; the RPC catches it and records `duplicate` with `open_request`. Idempotency key per submitter makes retries return the first result. |
| Known providers resubmitted | `matchesExistingProvider` predicate; the admin UI also flags matches against `src/features/quotes/generated/provider-catalog.ts` (a hint only). |
| SSRF | v1 never fetches. If fetching is ever proposed, it is a new, separately authorized design: a sandboxed fetcher with no provider secrets, HTTPS on 443 only, DNS resolved and checked against private, loopback, link-local and metadata ranges (including `169.254.169.254`, RFC 1918, `::1`, `fc00::/7`) before connect and after every redirect, no cross-host redirects, no cookies or credentials, strict size and time caps, and public first-party pages only. |
| Malicious URLs | `parseSafeHttpsUrl` rules: HTTPS only, no userinfo, default port, no IP literal, no local-use suffix, at most 2048 characters. Rendered as text, not a link, so an admin never clicks through by accident. |
| Stored XSS and HTML injection | Notes and names are plain text and are never rendered as HTML or Markdown. |
| Enumeration | Random UUID ids. Submitters read only their own rows. Another user's id returns `vendor_intake_not_found`. There is no public list, count or search. |
| Policy tampering | Policy revisions are append-only, need AAL2 and a reason, and any rule with `mode: "auto"` needs a second admin ([D3](#d3-who-may-change-the-policy)). |
| Admin account misuse | AAL2 on every admin RPC, typed reasons, append-only events, `vendor_intake_stale_version` on races. |
| Evaluation cost | At most 50 rules and closed predicates, with no regex and no loops over user input. |
| Personal data | No vendor contact fields in v1 ([D5](#d5-vendor-contact-data)). Notes are purgeable ([D6](#d6-retention-of-free-text)). |

Anonymous variant (not in the first release: D1 was decided on 2026-10-18 as authenticated first, anonymous later behind `anonymous_enabled`): submission goes through an edge
function that verifies a bot challenge and then calls the `service_role`-only
`api_service_submit_vendor_intake`, so `anon` still executes no `SECURITY
DEFINER` function (OVD-736). Limits are lower (per HMAC'd client address:
2 per hour; anonymous global: 50 per hour). Anonymous requests can never be
auto-advanced beyond `escalate`. Duplicate and accepted submissions get the
same "Received" response, so the form is not an existence oracle. Status is
read with a random one-time token shown once and stored only as a hash.

## Feature flag and rollback

Flag name: **`vendor_intake`**, enforced in two places, both default off.

- Client: `VITE_VENDOR_INTAKE_ENABLED` (unset or not `"true"` means off; same
  pattern as `src/lib/billing-flags.ts`). It hides the routes and nav entries.
- Server: `private.vendor_intake_settings.submissions_enabled` (seeded
  `false` at promotion). Every submit RPC refuses with `vendor_intake_disabled`
  when it is off, whatever the client does. `auto_actions_enabled` and
  `anonymous_enabled` are separate sub-flags, also seeded `false`.

Rollback, fastest first:

1. Set `submissions_enabled = false` (single admin, audited). Queue and
   history stay readable by admins.
2. Set `auto_actions_enabled = false` to stop all automatic actions while
   intake stays open.
3. Unset `VITE_VENDOR_INTAKE_ENABLED` and redeploy the web app.
4. `git revert` the UI children.
5. Schema rollback (protected, migration window): a rollback script that
   drops the intake objects, and refuses while admin-written events exist
   unless their export is confirmed, as `docs/migration-drafts/ovd-707-a.rollback.sql`
   does.

No step touches provider registry, admission, dispatch or kill switch state,
because intake never wrote any.

## Test plan

pgTAP (pending suites first, as OVD-707 does, under
`supabase/tests/pending/`):

- **Posture:** every intake table has RLS enabled and forced, zero policies,
  and no privileges for `anon`, `authenticated` or `service_role`; three deny
  tags per table per `docs/rls-deny-coverage.md`.
- **Denial matrix:** for every RPC, `anon` cannot execute it; a plain
  `authenticated` user cannot call admin RPCs (`platform_admin_required`); an
  AAL1 admin is refused; a user cannot read, update or withdraw another
  user's request (`vendor_intake_not_found`); a submitter cannot apply admin
  actions; `api_service_submit_vendor_intake` is `service_role` only; every
  helper is revoked from every API role. Exact ACLs are pinned and the OVD-602
  inventory rows are added at promotion.
- **Validation:** each malformed URL class, field length caps, unknown
  process family, unknown policy key, action and predicate, `auto` on a
  non-auto-eligible action, missing catch-all rule, unknown reason code, and
  short reasons are refused. SQL normalization matches `scripts/provider-manifest.mjs`
  for a shared vector file (a Vitest test checks the same vectors against the
  JS functions).
- **State machine:** every allowed transition writes exactly one event, and
  every other transition raises `vendor_intake_invalid_transition`.
- **Flags:** submit is refused while `submissions_enabled` is false; auto rules
  act as `recommend` while `auto_actions_enabled` is false.
- **Concurrency:** two sessions submit the same domain at once and end with
  exactly one open request plus one `duplicate`; two admins decide one
  request with the same expected version and exactly one wins
  (`vendor_intake_stale_version` for the other); parallel submits by one user
  never exceed the rate limit.
- **No external effects:** `pg_net` is not installed, and no intake function
  body references `net.`, `http`, `dblink` or `pg_notify`. After every action
  and policy path runs, row counts and contents of
  `private.quote_provider_admission_policies`, `private.provider_kill_switches`,
  `private.platform_admin_notifications`, `public.supplier_companies` and
  (once promoted) `private.provider_definitions` are unchanged.
- **Audit:** events reject UPDATE, DELETE and TRUNCATE, and never contain notes.

Vitest: client flag off hides the routes; form validation mirrors the server;
fixed status copy per status and reason code; no `fetch` to the submitted URL.

Playwright (fixture-backed, like `e2e/admin-operations.spec.ts`): sign in,
submit, see "Received", see a policy-driven `needs_info`, edit, resubmit,
withdraw; an admin with AAL2 sees the queue, declines with a reason code, and
the submitter sees the fixed copy; an admin approves and links an onboarding
ref. A route guard fails the test on any browser request to a host other than
the app origin and the local Supabase API, which proves the vendor URL is
never requested.

Mutation checks to run once: remove the AAL2 check, remove the
ownership check on the status read, and add an `auto` approve. Each must fail
the suite.

## Decomposition

Each child is one bounded, independently testable change of about 200 lines
or fewer (excluding tests), lands default off behind `vendor_intake`, and
follows `AGENTS.md`. Sensitive children touch paths in
`docs/sensitive-paths.json` (schema, migrations, auth, RLS, `SECURITY
DEFINER`) and need Blaine's explicit OK before merge; the migration
promotion also needs a migration window.

| Child | Change | Paths (expected) | Sensitive | Flag |
| --- | --- | --- | --- | --- |
| VI-0 | This design note | `docs/vendor-intake.md` | no | `vendor_intake` (documents it) |
| VI-1 | SQL draft: settings, requests, events, rate buckets, append-only triggers, RLS posture; rollback draft | `docs/migration-drafts/vi-1-*.sql` | **yes** (schema) | `submissions_enabled` seeded false |
| VI-2 | SQL draft: submit, list-mine, update-mine, withdraw RPCs, URL normalization, rate limits, duplicate handling | `docs/migration-drafts/vi-2-*.sql` | **yes** (schema, `SECURITY DEFINER`) | refuses unless `submissions_enabled` |
| VI-3 | SQL draft: policy validator, evaluator, policy revision RPCs, four-eyes | `docs/migration-drafts/vi-3-*.sql` | **yes** (schema, `SECURITY DEFINER`) | auto only with `auto_actions_enabled` |
| VI-4 | SQL draft: admin list, get, decide, link and reopen RPCs, typed reasons, AAL2 | `docs/migration-drafts/vi-4-*.sql` | **yes** (schema, auth) | `vendor_intake` |
| VI-5 | Pending pgTAP: posture, denial matrix, concurrency, no external effects, plus CI wiring like `.github/workflows/ovd707-pending-pgtap.yml` | `supabase/tests/pending/vi_*.sql.pending`, workflow | **yes** (`.github/workflows`) | n/a |
| VI-6 | Shared normalization vectors and TS policy types; parity Vitest against `scripts/provider-manifest.mjs` | `src/features/vendor-intake/*.ts`, tests | no | `VITE_VENDOR_INTAKE_ENABLED` |
| VI-7 | Submit form and "my requests" status page, mocked API until promotion | `src/pages/VendorIntake*.tsx`, `src/features/vendor-intake/**` | no | `VITE_VENDOR_INTAKE_ENABLED` |
| VI-8 | Admin queue page: list, detail, decide, handoff, link | `src/pages/VendorIntakeQueue*.tsx`, `src/features/vendor-intake/**` | no by path; review the RPC calls | `VITE_VENDOR_INTAKE_ENABLED` |
| VI-9 | Playwright journey with the network guard | `e2e/vendor-intake.*` | no | `VITE_VENDOR_INTAKE_ENABLED` |
| VI-10 | Promotion: one migration from VI-1 to VI-4, tests renamed from pending, OVD-602 inventory rows, settings seeded off | `supabase/migrations/**`, `supabase/tests/**` | **yes** (migrations; protected window) | all sub-flags seeded false |

Order: VI-1, then VI-2, VI-3 and VI-4 in sequence (one writer for the draft
files), with VI-5 growing alongside; VI-6 to VI-9 can run in parallel against
mocks; VI-10 last. An anonymous variant, an OVD-707 draft-definition handoff,
a supplier directory write, and any URL fetching are **not** children of this
design. Each needs its own design note and Blaine's authorization.

## Open decisions

Status 2026-10-18: D1 and D2 are decided by Blaine (recorded in Linear OVD-965). D3 to D7 are still open and keep their recommended defaults until Blaine changes them.

### D1. Anonymous or authenticated submission

- Options: (a) authenticated with verified email only; (b) anonymous through
  an edge function with a bot challenge; (c) (a) now, (b) later behind
  `anonymous_enabled`.
- **Recommendation: (c), shipping (a) only.**
- **Decided 2026-10-18 (Blaine): (c), shipping (a) only.** Authenticated submission first. Anonymous submission stays off behind `anonymous_enabled` and is not built in the first release.
- Consequence: vendors must create an account, which adds friction. In
  return, OVD-736's "anon executes no definer function" holds, status shows
  in-app with no email, and no new challenge vendor, secret or dependency is
  added. (b) adds a third-party challenge service and a server secret, both
  protected and needing Blaine.

### D2. Which policy actions may auto-execute

- Options: (a) none, recommend only; (b) `escalate`, `needs_info` and
  `mark_duplicate` may run automatically, and `approve_internal` and `decline`
  always need an admin; (c) (b) plus automatic `decline` for `spam`.
- **Recommendation: (b) as the ceiling, launched with
  `auto_actions_enabled = false`** until the recommend-mode results have been
  reviewed.
- **Decided 2026-10-18 (Blaine): (b) as the ceiling, launched with `auto_actions_enabled = false`.** `escalate`, `needs_info` and `mark_duplicate` may auto-run once enabled; `approve_internal` and `decline` always need an admin.
- Consequence: no automatic path can accept or reject a vendor. Under (c) a
  false positive would silently reject a real vendor.

### D3. Who may change the policy

- Options: (a) any AAL2 platform admin; (b) four-eyes for any revision that
  adds or changes an `auto` rule, and a single admin otherwise; (c) four-eyes
  for every revision.
- **Recommendation: (b)**, with the OVD-707 single-admin override (Blaine
  only, audited). Turning `auto_actions_enabled` or `submissions_enabled` off
  is always single-admin, like provider suspend.
- Consequence: a policy change that can act without a human gets a second
  reviewer, while recommend-only tuning stays fast.

### D4. What `approve_internal` produces

- Options: (a) status and handoff record only; (b) also an OVD-707 provider
  definition in `draft`; (c) also a `public.supplier_companies` row with
  `lifecycle_status = 'candidate'` and `origin = 'customer_suggested'`.
- **Recommendation: (a)** until OVD-707 is promoted; then (b) as a separate,
  sensitive child.
- Consequence: an operator runs Fixture by hand from the handoff record. (b)
  and (c) write to provider or supplier data and need their own review.

### D5. Vendor contact data

- Options: (a) none, only the submitter's own account; (b) an optional vendor
  contact email that no automation ever uses.
- **Recommendation: (a).**
- Consequence: less personal data and no temptation to email vendors.
  Outreach stays a protected, human, drafted action
  (`docs/providers/outreach/`).

### D6. Retention of free text

- Options: (a) keep notes forever; (b) purge notes of terminal requests after
  180 days through an audited admin RPC; (c) no notes field.
- **Recommendation: (b).** Events never copy notes, so the purge leaves the
  audit trail intact.
- Consequence: one extra admin RPC and a scheduled human task. No automated
  deletion job.

### D7. Where the form lives

- Options: (a) a signed-in app route; (b) the public marketing site that
  hands off to sign-in.
- **Recommendation: (a)** for v1. A marketing link may point to it.
- Consequence: marketing copy must stay truthful: it may say "apply to be
  considered", never that a vendor is live or partnered.
