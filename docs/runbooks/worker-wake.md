# Worker wake rollout (OVD-1127, follow-up to OVD-1093 / PR #947)

Source only. No deploy, secret provisioning, IAM grants, flag changes, or worker
configuration changes were performed by this PR. The original referenced
`/workspace/plans/wake-on-submit-plan.md` was unavailable locally; this implements
the IAM option documented in PR #947. Reconcile with that original plan before activation.

## Contract

`POST /functions/v1/worker-wake` accepts no body or `{}` only (64 byte maximum).
Gateway JWT verification and `auth.getUser` require a current, non-anonymous user
with role `authenticated`; an anon API key or service-role JWT alone is insufficient.
CORS preflight is public and has no side effects. The server gate
`WORKER_WAKE_ENABLED=true` is required; every other value disables the endpoint.

The edge's service role consumes `api_take_worker_wake_slot()`. A private singleton
row atomically admits one wake sequence per ten seconds globally, across users,
tabs and isolates. Other callers cannot execute the RPC or edit the row. Failure
consumes the slot; there is no unbounded map, caller-selected key, or interval.
Global coalescing means a throttled request is not a promise of a later wake.
A scheduled safety net and verified idle-exit behavior remain rollout prerequisites.

`WORKER_WAKE_URL` is an operator-configured HTTPS `*.run.app` origin, with no path,
query, credentials or nonstandard port. The handler sends only `GET /`; redirects
are rejected. No request data, Supabase JWT, or worker response body reaches the
worker/client respectively. A 503 gets one retry after 500 ms. The whole request
has a 15 second deadline, including authentication, throttle, token mint and wake.
204 means the worker's health GET succeeded, not that queued work finished. 429
includes `Retry-After: 10`; auth is 401, invalid payload 400, disabled/internal
failure 503, unsuccessful worker response 502, deadline 504. Responses are empty
and no credentials, upstream errors, or user payloads are logged.

`WORKER_WAKE_SERVICE_ACCOUNT_JSON` is a server-only Supabase secret containing a
Google service account key (`type`, `client_email`, `private_key`). It signs a
five-minute RS256 assertion with the worker origin as `target_audience`, exchanged
at Google's fixed token endpoint for an ID token. The ID token goes only to the
configured worker origin. No static bearer token is used or returned. This follows
[Google's service-to-service authentication flow](https://docs.cloud.google.com/run/docs/authenticating/service-to-service).
No new dependency is required. Never put this secret in Vite, git, logs or PRs.

## Separately authorized operator sequence

1. Review this source and migration, run `npm run test:functions`, the SQL suite,
   and concurrent database checks below in an isolated staging environment. The
   migration creates one private row and one service-only SECURITY DEFINER RPC;
   it does not touch queue/customer rows. Apply only this reviewed migration via
   the normal migration release process, not an indiscriminate production push.
2. Provision a dedicated invoker identity with `roles/run.invoker` scoped only to
   the target Cloud Run service. Store its service-account JSON through the
   approved secret channel as `WORKER_WAKE_SERVICE_ACCOUNT_JSON`. Set
   `WORKER_WAKE_URL` to the service's canonical origin. Do not print secret values.
   Supabase supplies `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`. Keep
   `WORKER_WAKE_ENABLED` absent until the above is ready. IAM/key management is
   separately authorized work; this PR does not grant it.
3. Deploy staging with an explicit staging project ref, retaining config JWT
   verification (never use `--no-verify-jwt`):
   `supabase functions deploy worker-wake --project-ref <staging-ref>`.
   Enable the server gate in staging. Verify missing/expired/anonymous/service
   credentials cannot cause worker calls, malformed bodies fail, parallel valid
   calls coalesce globally, and the IAM-protected GET wakes a cold service.
4. Confirm PR #947's client hook is merged and available in the frontend build.
   Set `VITE_WORKER_WAKE_ON_SUBMIT=true` in staging and rebuild/redeploy the
   frontend: Vite flags are build-time values. Verify a successful allowlisted
   enqueue wakes the worker and the queue drains. Failed/non-allowlisted RPCs
   must not wake. Exercise worker 503, auth expiry and token-mint failure paths.
5. Only with exact production approval, apply the reviewed migration and secrets
   then deploy: `supabase functions deploy worker-wake --project-ref ozuatdcakezjtevztjlr`.
   Enable the server gate, validate, then set the frontend flag and rebuild it.
   This project ref is deliberately explicit; never rely on a linked default.
6. Keep the reported Oct 29 min-instances=1 stopgap until cold-start, queue-drain,
   idle-exit and scheduled safety-net evidence pass. The worker is
   `overdrafter-cad-worker`, project `overdrafter-worker-9133`, region `us-west1`.
   `worker/scripts/deploy-cloud-run.sh` requires min=0 under stable egress; do not
   bypass that guard or use a routine worker deploy to preserve the stopgap.
   A separate approved worker/config rollout must reconcile min=0,
   `WORKER_EXIT_WHEN_IDLE=on`, background CPU allocation, idle-exit behavior and
   the safety-net wake. This PR alone does not make scale-to-zero reliable.

For the concurrency check, expire the singleton in an isolated fixture, then
invoke the RPC from two independent service-role transactions simultaneously:
exactly one returns true, the other false, with one row remaining. Repeat after
expiry and verify revoked anon/authenticated/table grants. Never run fixture SQL
against production. `supabase/tests/worker_wake_throttle.sql` covers sequential
admission, expiry, grants, RLS and bounded state; concurrency needs two connections.

## Revert and failure recovery

First set `WORKER_WAKE_ENABLED=false` to stop outgoing wakes. Unset the client
flag (or set `false`) and rebuild the frontend; existing tabs may still invoke the
edge but its server gate rejects them. Preserve the approved warm worker stopgap
until an operator provides an independently verified replacement. If min=0 was
later enabled, restoring min=1 is a separate explicit production action.

Revert the eventual squash commit with `git revert <squash-sha>` (no rebase or
force push), and redeploy only with approval. A git revert alone changes neither
an already deployed edge nor database state. The unused throttle row/RPC can
remain inert after disabling the edge. If removal is required, use a new reviewed
forward migration to revoke/drop the RPC and table; never delete migration history.
Revoke the dedicated invoker grant/key only through an approved credential change.
Verify no outgoing wakes with the server gate off, normal submissions still
succeed, and the worker continues draining via the approved warm/safety-net path.
