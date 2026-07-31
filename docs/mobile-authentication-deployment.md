# Mobile Authentication Bridge Deployment

Last updated: July 30, 2026

## Purpose

This runbook deploys the OVD-219 website-mediated authentication bridge and
the OVD-221 native iOS integration. The native app uses a claimed-HTTPS
callback, `ASWebAuthenticationSession`, a shared `WKWebsiteDataStore`
bootstrap host, a credential-free session probe, and local-scope logout.

The canonical security contract remains
[`mobile-authentication-contract.md`](mobile-authentication-contract.md).

## Deployed boundary

One same-origin Vercel Function serves:

- `GET /auth/mobile/start`
- `GET /auth/mobile/provider-callback`
- `POST /auth/mobile/complete`
- `GET /auth/mobile/callback`
- `POST /auth/mobile/bootstrap`

The SPA also serves
`GET /auth/mobile/native-session?app=ios&action=probe|logout`. That control
route reports only versioned, credential-free session status through the fixed
`mobileAuth` WebKit message handler. The same origin serves
`/.well-known/apple-app-site-association` for the exact production app ID and
callback path.

Vite emits two stable, first-party entry assets:

- `/assets/mobile-auth.js`
- `/assets/mobile-bootstrap.js`

The ceremony bundle uses transaction-scoped `sessionStorage` and never imports
the application's persistent Supabase singleton. The bootstrap bundle is the
only bridge bundle that uses the existing persistent web client.

## Required server-only environment

Configure these server values in Vercel. The existing browser build variables
`VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY` remain required and
must exactly match `SUPABASE_URL` and `SUPABASE_PUBLISHABLE_KEY`; the function
fails closed during configuration if either pair drifts.

| Variable | Requirement |
|---|---|
| `MOBILE_AUTH_APP_ORIGIN` | Exact stable HTTPS origin, with no path, query, fragment, or trailing slash |
| `MOBILE_AUTH_ENVIRONMENT` | One of `local`, `test`, `preview`, or `production` |
| `MOBILE_AUTH_KEYRING` | JSON object mapping positive integer versions to canonical unpadded base64url encodings of 32 random bytes |
| `MOBILE_AUTH_CURRENT_KEY_VERSION` | Positive integer version present in the keyring |
| `MOBILE_AUTH_ALLOW_INSECURE_LOCALHOST` | `1` only for explicit `local` or `test` loopback fixtures; `0` otherwise |
| `SUPABASE_URL` | Exact Supabase HTTPS origin; must equal `VITE_SUPABASE_URL` |
| `SUPABASE_PUBLISHABLE_KEY` | Public Auth key used by isolated ceremony/bootstrap verification clients; must equal `VITE_SUPABASE_PUBLISHABLE_KEY` |
| `SUPABASE_SERVICE_ROLE_KEY` | Server-only key used solely by the mobile-auth repository RPC adapter |
| `CRON_SECRET` | At least 32 printable characters; Vercel sends it as the cleanup Bearer token |

In production, `MOBILE_AUTH_APP_ORIGIN` must equal the origin portion of the
Supabase Auth Site URL. That exact shared scheme, host, and port lets Supabase
accept the transaction-bound provider callback without a wildcard redirect.

The service-role key and mobile-auth keyring must never enter a browser bundle,
mobile binary, URL, log, analytics event, or crash report.

The function has a sixty-second platform duration and every Supabase HTTP call
has an eight-second application deadline. A timeout after browser completion
terminates the claimed transaction when authority is still known; a timeout
around atomic redemption fails closed and requires a fresh ceremony. Vercel
does not retry failed cron invocations, so alert on cleanup responses whose
`ok` field is false and rerun the protected endpoint after correcting the
upstream failure.

## Supabase configuration

1. Apply `20260728190000_mobile_auth_bridge.sql` before deploying the Vercel
   function.
2. Confirm the private tables are not in the exposed PostgREST schemas.
3. Confirm every `api_mobile_auth_*` RPC is executable only by
   `service_role`.
4. Keep the provider redirect fixed at
   `<MOBILE_AUTH_APP_ORIGIN>/auth/mobile/provider-callback`. At runtime,
   `redirectTo` adds one unpredictable `cb=<transaction UUID>` query. Hosted
   Supabase must accept and preserve that query through the Site URL origin
   match, then return to the same callback path.
5. Do not use a production host or path wildcard. Preview smoke testing must
   confirm the transaction query returns to the same configured callback path.

The migration stores only keyed digests, authenticated ciphertext, verified
subject/session identifiers, and allowlisted audit metadata. The atomic consume
RPC checks the bound `auth.sessions` row and clears the encrypted session
envelope in the same update.

## Cleanup and retention

`vercel.json` schedules a production cleanup request daily at 04:17 UTC.
Vercel authenticates it with `Authorization: Bearer <CRON_SECRET>`.

Each run uses bounded batches to:

- expire unfinished ten-minute browser transactions and ninety-second handoffs
- destroy encrypted state and session envelopes
- prune seven-day terminal transaction rows
- prune expired persistent rate counters
- prune thirty-day safe audit events

The function drains full batches in one invocation, up to forty batches
(10,000 rows per cleanup category). Reaching that safety cap returns HTTP 503
with `ok: false` and `drained: false`, making the remaining backlog observable
as a failed cron invocation. Operations must alert and run an additional
cleanup.

A successfully drained daily run gives abandoned encrypted envelopes a maximum
scheduler delay of roughly twenty-four hours after expiry. Vercel does not
automatically retry a failed or cap-exhausted cron; deployment monitoring must
alert on the next missing or failed run.

## Key rotation

1. Add the new 32-byte key under a higher integer version.
2. Keep the prior key in `MOBILE_AUTH_KEYRING`.
3. Set `MOBILE_AUTH_CURRENT_KEY_VERSION` to the new version and deploy.
4. Retain older keys for at least fifteen minutes and until cleanup confirms no
   transaction can still reference them.
5. Remove old versions only in a later deployment.

New transactions use the current version. Transactions already in progress
continue with their stored version, including session-envelope encryption and
handoff digests.

## Deployment and rollback

Deploy in this order:

1. additive Supabase migration
2. server-only environment and exact provider redirect
3. Vercel Function, route rewrites, and stable browser assets
4. native-session SPA route, AASA document, and response headers
5. endpoint/header checks on the stable host
6. signed OVD-221 app and physical-device gate

Rollback by disabling the five public rewrites or reverting the function
deployment. Leave the additive private tables and cleanup schedule in place
until every outstanding transaction has expired and its envelope has been
destroyed. If a key or service credential may have been exposed, rotate it
before restoring service.

## Verification

Before enabling a signed iOS build:

- run the repository verification gate and Supabase pgTAP suite
- confirm password, Google, Microsoft, and Apple ceremonies on the stable host
- inspect start, callback, completion, bootstrap, replay, expiry, wrong-state,
  wrong-verifier, revoked-session, and rate-limit behavior
- confirm all responses are `no-store` and bootstrap CSP matches the contract
- confirm the AASA document is JSON, matches the signed Team ID and bundle ID,
  allows only `/auth/mobile/callback` under `applinks`, and declares the same
  app ID under `webcredentials`
- confirm session probe, local logout, and ordinary-workspace sign-out report
  only the fixed credential-free status shapes
- confirm one winner under simultaneous redemption
- confirm Vercel access-log access and retention are restricted for start and
  provider callback query strings
- confirm no credential, verifier, body, cookie, callback fragment, email, or
  domain content appears in application logs
- confirm the iOS 17.4 app has both production `applinks` and
  `webcredentials` Associated Domains entitlements
- complete password/provider, cancellation, relaunch, revocation, logout,
  account-switching, and credential-leak checks on a signed physical iPhone
