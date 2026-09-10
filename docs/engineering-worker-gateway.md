# Engineering worker HTTPS session gateway

OVD-499 adds a narrow transport for OVD-498 worker identity and session APIs.
It remains disabled unless `ENGINEERING_WORKER_GATEWAY_ENABLED` is exactly
`true`. Source landing does not activate a companion or grant execution.

## Protocol

POST `/functions/v1/engineering-worker` over HTTPS using `Content-Type:
application/json` and `Authorization: Bearer <worker-token>`. No URL parameters,
browser Origin headers, CORS or compressed request bodies are admitted. The
complete decoded body is limited to 8,192 bytes and the handler deadline to five
seconds, including body reads, hashing and database calls.

Every body has `schema: "overdrafter.worker-gateway.v1"`, `action` and `workerId`.
IDs are canonical lowercase, non-nil UUIDs. No additional keys are accepted.

| Action | Additional fields | Database API |
| --- | --- | --- |
| `pair` | `expectedRevision`, `idempotencyKey`, `installationId`, `pairingCode` | `api_consume_worker_pairing` |
| `boot` | `expectedRevision`, `idempotencyKey`, `bootId` | `api_register_worker_boot` |
| `session` | `bootId` | `api_worker_session_eligibility` |

Expected revisions are nonnegative safe integers smaller than
`Number.MAX_SAFE_INTEGER`; replies may include that maximum safe revision.
Pair and boot return the exact original immutable receipt on replay, even if a
later owner action or boot advanced current state. Read `session` for fresh
eligibility. Never infer current enablement from an old receipt.

## Secrets and authority

The worker token is `odw_` followed by 64 lowercase hex characters; the pairing
code uses `odp_` with an independently generated 32-byte cryptographic random
value. Hash the complete raw string using SHA-256, including the prefix. The
helper in the handler implements this format. The owner pairing flow must store
only the pairing digest; the companion must protect its raw token with Windows
DPAPI before consuming the code. Those owner UI and companion implementations
are subsequent work, not capabilities supplied by this endpoint.

The gateway accepts raw purpose-bound values and computes their digests itself.
A caller cannot pass a precomputed digest, RPC name, arbitrary scope or owner
action. A worker credential cannot enable its own session. The server's existing
Supabase service credential stays in the Edge environment and is never provided
to the worker. Only the fixed three RPCs are reachable from this handler.
The SDK transport rejects redirects before forwarding a request, so its server
credential cannot follow an upstream redirect away from the configured HTTPS
endpoint. Transport failure still leaves an attempted mutation's outcome unknown.

`verify_jwt = false` applies only to this function because a worker token is not
a Supabase JWT. Every admitted action still authenticates through the scoped
worker database contract. Disabling platform JWT validation does not make the
function anonymous. No other function's configuration changes.

## Responses and retries

A success contains `schema`, `action` and a filtered `receipt`. The receipt must
match the requested worker and, for mutations, the exact installation/boot and
next revision. Session receipts distinguish enabled, paused, expired,
boot mismatch and owner enablement required. Eligibility is not a task claim,
proof of stopped processes or permission to write authoritative CAD files.

An error contains only `schema`, `error`, `outcome` and `retrySameRequest`.
Authentication failures return 401, conflicts 409 and invalid input 400. Other
transport refusals use 403/405/413/415. Disabled service returns 503. Invalid
upstream receipts return 502 and a deadline returns 504. Raw backend messages,
credential values/digests and unexpected response fields are not emitted.
Responses use `Cache-Control: no-store`.

After a pairing or boot call might have reached PostgreSQL, an uncertain result
returns `outcome: "unknown"` and `retrySameRequest: true`. Abort attempts to stop
the HTTP transport; it does not prove rollback. Retry with the identical token,
body, revision and idempotency key. Do not rotate a token or invent a new key in
response to a lost reply. A definite database refusal is `not_applied`; a status
read also has no mutation to reconcile. A disconnected caller that receives no
reply must use the same conservative replay rule.

No raw secrets, request bodies or backend exceptions are logged by this handler.
Before deployment, inspect platform/proxy logging configuration so it does not
capture authorization headers or pairing bodies either.

## Verification

```sh
deno check --frozen --config supabase/functions/deno.json supabase/functions/engineering-worker/index.ts supabase/functions/engineering-worker/integration.ts
npm run test:functions
deno run --frozen --config supabase/functions/deno.json --allow-run=docker supabase/functions/engineering-worker/integration.ts supabase_db_ovd498-worker-sessions
npm run verify
```

The SDK transport regression uses the actual client and a simulated redirect at
the fetch boundary. It checks redirect rejection, exact RPC/body/header binding
and redacted uncertain outcomes without network access or real credentials.

The integration command accepts only an explicitly named disposable local
OVD-498 PostgreSQL container with migrations applied. It creates synthetic
fixtures and retains their evidence in that disposable database. It accepts no
hosted connection URL, key or arbitrary command. Output reports assertions,
never synthetic secrets. It injects SQL transport into the real HTTP handler
and invokes actual database APIs under owner and service roles. This verifies
hashing, replay, session transitions and credential scope across that boundary;
it does not qualify the Supabase HTTP router, deployed PostgREST or Windows TLS.

## Deployment, rollback and remaining gates

No migration, production data change, credential issuance or new dependency is
included. Apply OVD-498's additive migration before a reviewed gateway activation.
The Edge environment needs its existing `SUPABASE_URL` (HTTPS) and
`SUPABASE_SERVICE_ROLE_KEY`; they are read only when the enabled handler admits a
valid request. Missing configuration fails closed with a redacted response.

The activation packet must verify account/operator allowlisting, actual deployed
HTTPS/custom-auth routing, secret handling, provider rate/usage controls and the
agreed $40 AI/$10 incremental platform monthly ceiling before enabling service.
This source handler is not a hosting cost cap or a durable rate limiter. Do not
purchase upgrades or claim hosted availability from local tests.

Rollback disables the gateway flag/routing and retains worker/session/event
history. It does not prove an existing native process exited. Task admission,
leases/fences, attempt outputs, safe drain/retry, Windows DPAPI and process
isolation, cumulative native proof and the connected app remain required work.
Candidate files remain unadopted; PDM publication is outside this milestone.
