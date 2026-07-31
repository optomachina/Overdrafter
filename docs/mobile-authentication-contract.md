# Mobile Browser Authentication Contract

- Status: Approved contract; OVD-219 server/browser runtime implemented
- Issues: `OVD-220` contract, `OVD-219` runtime, `OVD-221` native adoption
- Last updated: July 29, 2026

## Decision

OverDrafter iOS authentication will use a native welcome screen and
`ASWebAuthenticationSession` to authenticate through the OverDrafter website.
The browser flow will return only an opaque, single-use handoff code and
transaction state. A dedicated bootstrap page will redeem that handoff inside
OverDrafter's persistent `WKWebsiteDataStore` and establish the existing
Supabase JavaScript session there.

OVD-219 implements the website, same-origin Vercel Function, private
persistence, single-use bootstrap, isolated browser bundles, rate limits,
audit boundary, and scheduled cleanup described here. OVD-221 still owns native
callback capture, bootstrap hosting, relaunch, local-scope logout, account
switching, and the physical-device release gate.

This is a website-mediated native sign-in flow, not OAuth inside `WKWebView`,
not a native password form, and not a token-bearing deep link.

The production callback is a claimed HTTPS URL at the configured OverDrafter
origin and exact path `/auth/mobile/callback`. The iOS target must therefore
raise its minimum supported version from iOS/iPadOS 17.0 to 17.4, where
`ASWebAuthenticationSession.Callback.https(host:path:)` is available, unless a
later security review explicitly approves a different callback mechanism.
Custom-scheme callbacks are not a production fallback.

## Why this contract exists

The current iOS app hosts access-controlled routes in several `WKWebView`
instances backed by `WKWebsiteDataStore.default()`. The current web Supabase
client persists its access and refresh tokens in that website data store's
`localStorage`.

`ASWebAuthenticationSession` deliberately uses a browser security context that
the app cannot inspect. Its cookies and web storage do not automatically become
the app's `WKWebView` storage. A successful website login therefore cannot
authenticate the current app merely by returning to a deep link.

The bridge defined here moves a newly authenticated, transfer-only Supabase
session through a short-lived server-side envelope and redeems it exactly once
inside the shared app web store.

## Security references

- [Apple: ASWebAuthenticationSession](https://developer.apple.com/documentation/authenticationservices/aswebauthenticationsession)
- [Apple: HTTPS callback matching](https://developer.apple.com/documentation/authenticationservices/aswebauthenticationsession/callback/https%28host%3Apath%3A%29)
- [Apple: Supporting associated domains](https://developer.apple.com/documentation/xcode/supporting-associated-domains)
- [RFC 8252: OAuth 2.0 for Native Apps](https://www.rfc-editor.org/rfc/rfc8252.html)
- [RFC 9700: OAuth 2.0 Security Best Current Practice](https://www.rfc-editor.org/rfc/rfc9700.html)
- [Supabase: JavaScript `setSession`](https://supabase.com/docs/reference/javascript/auth-setsession)
- [Supabase: JavaScript `getUser`](https://supabase.com/docs/reference/javascript/auth-getuser)
- [Supabase: User sessions](https://supabase.com/docs/guides/auth/sessions)
- [Supabase: JavaScript `signOut`](https://supabase.com/docs/reference/javascript/auth-signout)

The words MUST, MUST NOT, SHOULD, SHOULD NOT, and MAY describe requirements for
the runtime issues that implement this contract.

## Scope

This contract defines:

- the native-to-browser start request
- browser authentication and completion
- the claimed HTTPS callback
- the one-time server-side handoff
- bootstrap into the persistent app web store
- session restoration, logout, account switching, and revocation behavior
- stable public error codes and retry behavior
- storage, redaction, expiry, and replay requirements
- the verification matrix for the backend and native implementations

## Out of scope

- implementing any endpoint, migration, Swift type, or UI
- replacing the current Supabase JavaScript client
- moving the whole web application to HttpOnly-cookie sessions
- adding identity providers that the website does not already support
- passkeys or enterprise SAML configuration
- native storage of Supabase access or refresh tokens
- agent authorization, quote-domain changes, or mobile navigation redesign

## Existing boundary

The contract preserves these as-built choices:

- `src/integrations/supabase/client.ts` uses PKCE, detects browser callback
  sessions, and persists the session in browser `localStorage`.
- `ios/OverDrafter/Core/Web/WebWorkspaceSession.swift` supplies a shared,
  persistent `WKWebsiteDataStore`.
- workspace routes are limited to the configured application origin.
- the existing iOS build contains no privileged Supabase or backend credential.
- app web views share session storage, but an external authentication browser
  does not share that storage.

The bridge MUST use only the public app configuration plus one-time user-bound
material. It MUST NOT add a Supabase service-role key, encryption key, provider
secret, or other privileged credential to the iOS bundle or web client.

## Environment and callback contract

Each deployable environment MUST have one stable, configured HTTPS application
origin. The callback is derived by adding `/auth/mobile/callback` to that
origin; a callback supplied by the app or query string is never trusted.

| Environment | Requirement |
|---|---|
| Production | Stable first-party HTTPS host, Associated Domains entitlement, and matching AASA file |
| Preview/beta | Stable allowlisted HTTPS host with its own matching AASA declaration |
| Local simulator | Mocked completion or a stable HTTPS development host |
| Physical device | Production or stable HTTPS development host; localhost is not a production callback |

Before `OVD-221` can ship, the team MUST choose the canonical production auth
host and supply the Apple Team ID needed for its AASA `appID`. This contract
does not invent a domain or Team ID.

The iOS app MUST declare:

```text
applinks:<configured-host>
webcredentials:<configured-host>
```

The `applinks` association permits the exact `/auth/mobile/callback` path for
the production bundle identifier. The `webcredentials` association names the
same production app ID and is required by
`ASWebAuthenticationSession.Callback.https(host:path:)`. The callback matcher,
Associated Domains entitlements, AASA host, backend callback route, and
configured app origin MUST agree exactly.

## Cryptographic material

The native app creates new material for every authentication attempt:

| Value | Generation | Lifetime | Storage |
|---|---|---|---|
| `state` | 32 random bytes, base64url without padding | One authentication attempt | Native memory; encrypted server echo copy until callback; keyed server digest until expiry |
| `code_verifier` | 32 random bytes, base64url without padding | One authentication attempt | Native memory only |
| `code_challenge` | base64url(SHA-256(`code_verifier`)) | Server transaction lifetime | Native memory and server row |
| `handoff_code` | At least 32 server-generated random bytes, base64url without padding | At most 120 seconds | Callback fragment plus native memory; only keyed digest at rest |

The app MUST use PKCE `S256`. Plain PKCE is forbidden. State and verifier values
MUST NOT be reused, persisted to analytics, included in crash reports, or
written to OS logs.

## Two independent authorization bindings

The browser's Supabase authorization-code ceremony and the native handoff are
two different redirect protocols. They MUST NOT reuse a verifier, challenge,
transaction identifier, or storage namespace.

### Browser Supabase Auth binding

The mobile-auth website creates a dedicated Supabase client for the browser
ceremony. It uses a transaction-namespaced `window.sessionStorage` adapter so
the Supabase PKCE verifier survives the cross-origin provider redirect but is
isolated to that authentication tab. Supabase Auth owns validation of the
upstream provider's OAuth/OIDC state, nonce, response, and provider-side PKCE
when applicable; those values are not exposed to or revalidated by the
OverDrafter callback. Supabase returns its own single-use authorization code to
the separate `/auth/mobile/provider-callback` route. The ceremony client
exchanges that code using its transaction-scoped Supabase PKCE verifier.

The dedicated client MUST NOT import or reuse the application's generated
Supabase singleton, global auth-storage key, or persistent `localStorage`. It
MUST set `detectSessionInUrl: false` so the callback can validate the
browser-bound transaction before explicitly calling
`exchangeCodeForSession(code)`.
After browser completion it clears the namespaced `sessionStorage` entry,
whether completion succeeds or fails.

### Native handoff binding

The native app's state and PKCE pair bind the server handoff to the app instance
that opened `ASWebAuthenticationSession`. They never become the provider's
OAuth state or provider PKCE pair. The server stores the native challenge and
an encrypted echo copy plus keyed digest of native state.

## End-to-end sequence

```mermaid
sequenceDiagram
    actor User
    participant App as "Native iOS app"
    participant Browser as "ASWebAuthenticationSession"
    participant Web as "OverDrafter mobile-auth web UI"
    participant Bridge as "Mobile auth bridge"
    participant Auth as "Supabase Auth"
    participant Bootstrap as "Bootstrap WKWebView"

    App->>App: Generate state and PKCE verifier/challenge
    App->>Browser: Open GET /auth/mobile/start
    Browser->>Bridge: state, S256 challenge, allowlisted return path
    Bridge-->>Web: No-store mobile sign-in page
    User->>Web: Authenticate with website-supported method
    Web->>Auth: Start password flow or provider OAuth with ceremony-scoped storage
    Auth->>Auth: Validate upstream provider response, state, and nonce
    Auth-->>Web: Return Supabase code to /auth/mobile/provider-callback
    Web->>Web: Validate browser-bound transaction
    Web->>Auth: Exchange Supabase code with ceremony PKCE verifier
    Auth-->>Web: Access and refresh token pair in ceremony-scoped storage
    Web->>Bridge: Complete transaction over HTTPS POST
    Bridge->>Auth: Verify authenticated user and session
    Bridge->>Bridge: Encrypt session; hash handoff; expire in <= 120s
    Bridge-->>Browser: 303 to exact HTTPS callback fragment with code and state
    Browser-->>App: Callback URL
    App->>App: Verify HTTPS host, path, and constant-time state match
    App->>Bootstrap: POST code, state, and verifier in request body
    Bootstrap->>Bridge: Redeem through shared app website data store
    Bridge->>Bridge: Verify and atomically consume handoff
    Bridge-->>Bootstrap: No-store bootstrap document
    Bootstrap->>Auth: supabase.auth.setSession(...)
    Auth-->>Bootstrap: Session verified/refreshed
    Bootstrap->>Auth: supabase.auth.getUser()
    Auth-->>Bootstrap: Authenticated subject confirmed
    Bootstrap->>Bootstrap: Persist session in shared WKWebsiteDataStore
    Bootstrap-->>App: Versioned ready message without credentials
    App->>App: Create authenticated workspace destinations
```

The native app MUST keep only one active authentication attempt. Starting a
new attempt cancels the previous `ASWebAuthenticationSession` and discards its
state and verifier. Server transactions remain unusable without the matching
verifier and expire normally.

## Endpoint contract

### 1. Start: `GET /auth/mobile/start`

This endpoint starts the website authentication ceremony.

Example:

```http
GET /auth/mobile/start?v=1&state=<state>&code_challenge=<challenge>&code_challenge_method=S256&return_to=%2Fquotes
Accept: text/html
```

Required query fields:

| Field | Rule |
|---|---|
| `v` | Exact supported contract version; initially `1` |
| `state` | Canonical base64url encoding of exactly 32 random bytes |
| `code_challenge` | Canonical base64url SHA-256 challenge |
| `code_challenge_method` | Exact value `S256` |
| `return_to` | Relative, allowlisted client route; defaults to `/quotes` |

The endpoint MUST:

- accept HTTPS only outside explicit local test fixtures
- reject duplicate or malformed fields
- reject protocol-relative values, absolute URLs, encoded path traversal,
  control characters, fragments, and non-client routes
- accept only route shapes owned by the mobile client, initially `/parts`,
  `/parts/:id`, `/quotes`, `/quotes/:code`, `/search`, and
  `/projects/:id`
- create a server transaction with a 10-minute browser-completion deadline
- bind the transaction to an HttpOnly, Secure, SameSite=Lax browser cookie and
  a separate CSRF value
- return `Cache-Control: no-store`, `Pragma: no-cache`, and
  `Referrer-Policy: no-referrer`
- render the dedicated website login experience with every website-supported
  provider, including social providers currently hidden inside `?app=ios`
  `WKWebView` routes

The endpoint MUST NOT:

- accept a caller-provided callback URL or origin
- redirect to an unparsed string
- place a verifier, access token, refresh token, email address, or membership
  detail in a URL
- treat a client-supplied organization, role, or user ID as authority

The mobile sign-in page SHOULD reuse the website's visual experience. It MUST
use the dedicated ceremony client described above, with a unique
`sessionStorage` namespace and no access to the website's persistent auth
storage. Password sign-in may complete in the page. Social sign-in returns to
the separate provider callback below. A successful transfer session is never
written into the external browser's OverDrafter `localStorage`.

### 2. Provider OAuth callback: `GET /auth/mobile/provider-callback`

This same-origin browser route completes social-provider OAuth inside the
active `ASWebAuthenticationSession`. It is not the claimed native callback.
Its origin MUST be the Supabase Auth Site URL origin for that environment, its
path is fixed, and its server-generated `cb` query value MUST equal the active
transaction ID. This allows the transaction-specific redirect without a
production wildcard and prevents an unrelated cross-site top-level navigation
from cancelling the active browser transaction.

The route MUST:

- use only the transaction-namespaced ceremony Supabase client
- reject a transaction that does not match the browser-bound mobile-auth cookie
- reject a missing, malformed, duplicated, or nonmatching `cb` transaction
  binding before processing either provider success or provider failure
- accept exactly one Supabase authorization code or an allowlisted provider
  error response; reject duplicated or unexpected callback parameters
- copy the code into page memory and remove it from browser history with
  `history.replaceState` before the network exchange
- recover the Supabase PKCE verifier only from the matching
  ceremony-scoped `sessionStorage` namespace
- explicitly call `exchangeCodeForSession(code)` on the same ceremony client
- treat Supabase Auth as the authority that validated the upstream provider's
  state, nonce, response, and provider-side PKCE
- reject missing transaction state, ceremony storage, or verifier, and surface
  an expired or replayed Supabase code as a stable callback failure
- apply `Cache-Control: no-store` and `Referrer-Policy: no-referrer`
- proceed to browser completion only after a verified transfer session exists

The provider callback MUST NOT use `src/pages/AuthCallback.tsx` or the generated
global Supabase client because those write the resulting session into the
website's persistent `localStorage`. It also MUST NOT attempt to parse or
validate an upstream provider state or nonce, or exchange an upstream provider
authorization code itself; Supabase does not expose those values to this route.

Supabase Auth protects and validates the provider exchange. The ceremony
client's Supabase PKCE pair protects its authorization-code return. Native
state/PKCE protects the later app handoff. Satisfying one layer never bypasses
the others.

### 3. Browser completion: `POST /auth/mobile/complete`

This is an internal browser-flow endpoint, not a general mobile API.

It receives:

- the server-bound transaction and CSRF proof
- a newly authenticated transfer-only Supabase session from the
  ceremony-scoped client over an HTTPS request body, or equivalent server-owned
  provider callback state

It MUST verify the session with Supabase Auth, derive the user and source
session from verified server data, and confirm that the access and refresh
material belongs to the same transfer session. A raw browser claim that login
succeeded is insufficient.

The implementation MUST NOT clone an arbitrary long-lived website session into
the app. The mobile ceremony owns a fresh, ceremony-scoped transfer session.
Once the encrypted handoff record is accepted, the browser page clears its
namespaced storage and discards its in-memory copy.

On success the bridge:

1. generates at least 256 bits of random handoff material
2. stores only an HMAC-SHA-256 digest of the handoff code
3. encrypts the transfer session with authenticated encryption and a key held
   outside the transaction table
4. binds the envelope to the transaction, verified user, source session,
   PKCE challenge, callback host/path, return route, and expiry
5. sets handoff expiry to no more than 120 seconds
6. deletes the encrypted state echo copy after constructing the callback
7. returns a `303 See Other` to the exact configured callback

The callback location contains exactly:

```text
https://<configured-host>/auth/mobile/callback#code=<opaque-code>&state=<state>
```

Authentication or provider failure may either remain in the browser with an
actionable retry or produce a failure-status handoff. If it produces a
callback, that callback fragment still contains only an opaque code and state;
raw provider errors never enter the URL.

### 4. Callback: `GET /auth/mobile/callback`

The production app registers an exact HTTPS callback matcher for the configured
host and `/auth/mobile/callback`.

Before redemption, native code MUST verify:

- scheme is exactly `https`
- host and effective port match the configured production origin
- path is exactly `/auth/mobile/callback`
- query is empty
- fragment contains exactly one `code` and one `state`
- neither value is empty, duplicated, malformed, or oversized
- returned state matches the active state using a timing-safe comparison

Unexpected callbacks fail closed. They do not dismiss the signed-out state,
load a workspace, or attempt bootstrap.

If the route is opened as a normal website instead of being captured by the
authentication session, it MUST render a script-free, no-store recovery page.
URL fragments are not sent to that server route. The recovery page MUST NOT
read the fragment, redeem the handoff, load analytics or third-party assets,
expose transaction status, or redirect elsewhere.

### 5. Bootstrap: `POST /auth/mobile/bootstrap`

After callback validation, the native app creates a dedicated bootstrap
`WKWebView` using the same persistent `WKWebsiteDataStore` as all workspace
destinations. Workspace tabs MUST NOT be created or loaded before bootstrap
succeeds.

The native app loads an HTTPS POST request in that web view:

```http
POST /auth/mobile/bootstrap
Content-Type: application/x-www-form-urlencoded
Accept: text/html
X-OverDrafter-Mobile-Auth: bootstrap-v1

v=1&code=<opaque-code>&state=<state>&code_verifier=<verifier>
```

The code, state, and verifier MUST be in the request body. They MUST NOT be
copied into a navigation URL, custom header likely to be logged, page title,
JavaScript console message, or native diagnostic.

The fixed nonsecret `X-OverDrafter-Mobile-Auth` marker is required so an
ordinary cross-site HTML form cannot trigger bootstrap. The bridge MUST reject
missing markers, cross-site `Origin`, or cross-site Fetch Metadata before
parsing the request body and return a script-free response. The bootstrap
document MUST also confirm that the fixed native `mobileAuth` message handler
exists before calling `setSession`; opening it in an ordinary browser cannot
replace that browser's current account.

The bridge MUST:

1. normalize and validate the request without logging the body
2. find the transaction by keyed handoff digest
3. verify the transaction is complete, unexpired, unrevoked, and unconsumed
4. verify state and the exact callback configuration
5. calculate S256 from the verifier and compare it with the stored challenge
6. decrypt the session envelope into request-local memory only
7. verify the source Supabase session is still usable
8. atomically transition `completed -> consumed` and delete the stored envelope
   so concurrent requests yield one winner
9. discard request-local session material for every losing or failed request
10. return a minimal bootstrap document with no cacheable credential material

The atomic consume and stored-envelope deletion MUST be one database transaction
conditioned on the same transaction version/digest that was read. More than one
request may reach pre-consume verification, but only the request that wins that
transition may receive a bootstrap document containing session material. A
network retry after an ambiguous successful consume does not redeem again; the
user restarts authentication.

The bootstrap document MUST:

- use `supabase.auth.setSession(...)` against the existing configured web client
- wait for Supabase to validate or refresh the session
- confirm the persisted subject with server-backed `supabase.auth.getUser()`
- persist only through the existing Supabase storage adapter in the shared
  `WKWebsiteDataStore`
- erase temporary JavaScript variables and any partially written auth storage
  on failure
- preserve an existing app session when the server rejects bootstrap before
  `setSession` starts
- contain no user-supplied HTML
- load no analytics, fonts, images, ads, or third-party application scripts
- send native code only a versioned status object without credentials

Success message:

```json
{
  "version": 1,
  "status": "ready",
  "state": "<state>",
  "returnTo": "/quotes"
}
```

Failure message:

```json
{
  "version": 1,
  "status": "error",
  "state": "<state>",
  "code": "mobile_auth_expired",
  "retry": "restart"
}
```

The native message is UI coordination, not authentication authority. Native
code MUST validate its version, shape, state, and sending frame/origin. A
`ready` message is accepted only after the bootstrap document reports that
`setSession` and the server-backed subject check completed. Workspace routes
then perform their normal server-side membership and authorization checks.

Required response headers:

```text
Cache-Control: no-store, max-age=0
Pragma: no-cache
Referrer-Policy: no-referrer
X-Content-Type-Options: nosniff
Content-Security-Policy:
  default-src 'none';
  script-src 'self' 'nonce-<per-response-value>';
  connect-src 'self' <configured-supabase-origin>;
  base-uri 'none';
  form-action 'none';
  frame-ancestors 'none';
  img-src 'none';
  object-src 'none'
```

The generated document MUST escape session values as data, use a per-response
CSP nonce, and never concatenate them into executable JavaScript source.

## Transaction record

The runtime storage name is implementation-defined, but its contract is:

| Field | Requirement |
|---|---|
| transaction ID | Random server identifier; not authority by itself |
| contract version | Exact supported version |
| state binding | Keyed digest plus encrypted echo copy; echo copy is deleted when callback is constructed |
| PKCE challenge | S256 challenge and method |
| Supabase ceremony binding | Fixed provider callback path, unpredictable transaction binding, and transaction-namespaced browser-storage identifier; never an upstream provider state or nonce |
| callback | Server-derived environment host and exact path |
| return route | Parsed allowlisted relative route |
| browser binding | Digest of server cookie/CSRF binding |
| handoff digest | HMAC-SHA-256; never plaintext code |
| session envelope | Authenticated encryption with external key/version |
| verified subject | Supabase user ID and source session ID |
| status | State-machine value below |
| timestamps | Created, browser expiry, handoff expiry, consumed, revoked |
| audit correlation | Random trace ID with no credential material |
| internal failure reason | Restricted operational value; never provider payload |

Secret-bearing rows MUST be encrypted at rest, excluded from normal application
queries, protected from client access by RLS or a private schema, and accessible
only to the bridge's server identity. Expired envelopes MUST be destroyed by
bounded cleanup even if a transaction is never redeemed. Nonsecret audit
metadata may be retained under the normal security-event retention policy.

## State machine

```text
created -> authenticating
created -> verifying
authenticating -> verifying
verifying -> completed
completed -> consumed

created -> failed | expired | cancelled
authenticating -> failed | expired | cancelled
verifying -> failed | expired | cancelled
completed -> expired | revoked

consumed -> terminal
failed -> terminal
expired -> terminal
cancelled -> terminal
revoked -> terminal
```

Only `completed -> consumed` releases a session envelope. Only the request that
wins `created | authenticating -> verifying` may rotate the transfer session
and construct the encrypted handoff. Every other state fails closed. No
transition returns to `created`, `authenticating`, `verifying`, or `completed`.

## Stable error contract

Public responses expose a stable code, a safe message key, and one retry
instruction. Raw Supabase/provider errors remain in restricted, redacted
operational telemetry.

| Code | Meaning | Native behavior |
|---|---|---|
| `mobile_auth_cancelled` | User dismissed the browser ceremony | Return quietly to welcome |
| `mobile_auth_invalid_request` | Malformed version, state, challenge, callback, or route | Start a new ceremony; report if repeated |
| `mobile_auth_provider_failed` | Website/provider could not authenticate | Show retry and provider alternatives |
| `mobile_auth_network_failed` | Required browser/bootstrap request lost connectivity | Retry network step only before consume; otherwise restart |
| `mobile_auth_state_mismatch` | Callback or status state differs from the active attempt | Abort, discard attempt, start over |
| `mobile_auth_expired` | Browser transaction or handoff exceeded its deadline | Start over |
| `mobile_auth_replayed` | Handoff was already consumed or concurrent redemption lost | Clear partial state and start over |
| `mobile_auth_pkce_failed` | Verifier does not match the bound S256 challenge | Abort, discard attempt, start over |
| `mobile_auth_session_invalid` | Transfer session was revoked, invalid, or unusable | Start over and authenticate again |
| `mobile_auth_bootstrap_failed` | Session could not be persisted or verified in the app web store | Clear partial storage and start over |
| `mobile_auth_logout_failed` | Current-session revocation could not be confirmed | Clear protected local state, report unconfirmed revocation, and require sign-in |
| `mobile_auth_rate_limited` | Start or redemption limit exceeded | Keep signed out and retry after server delay |
| `mobile_auth_service_unavailable` | Auth bridge or Supabase dependency unavailable | Keep signed out and retry later |

The public bootstrap endpoint intentionally collapses every no-match lookup
(including a wrong state, wrong verifier, callback mismatch, expired handoff,
or serial replay) into `mobile_auth_expired`. That prevents the endpoint from
becoming an oracle for which secret proof was correct. Native may report
`mobile_auth_state_mismatch` before bootstrap when the returned state differs
from its active in-memory attempt. `mobile_auth_replayed` is returned only when
a request found and verified the same live transaction but then lost the
atomic consume race. The remaining codes stay reserved for failures the
responsible layer can classify without disclosing transaction existence.

The UI SHOULD translate these codes into short user-facing copy. It MUST NOT
display raw provider messages, HTTP bodies, stack traces, user IDs, session IDs,
or whether an arbitrary handoff code ever existed.

## Browser modes and account switching

Default sign-in uses the shared browser session:

```swift
prefersEphemeralWebBrowserSession = false
```

This allows the authentication browser to reuse browser and identity-provider
cookies, password managers, and existing provider sign-in state. It does not
permit the app to read those values.

`Use another account` uses:

```swift
prefersEphemeralWebBrowserSession = true
```

Ephemeral mode requests an isolated browser ceremony. It does not clear Safari,
provider, or website data outside that ceremony.

When switching accounts, the app MUST:

1. complete local app logout
2. clear all subject-bound query, mutation, page, and web-view state
3. destroy existing workspace web views
4. start a new ephemeral browser ceremony
5. create workspace destinations only after the new bootstrap succeeds

The server derives the user and memberships from the verified new session.
Native code never supplies a user, organization, role, or workspace claim.

## Interrupted ceremonies and email-based account flows

Native state and the handoff verifier intentionally live only in memory. If the
app process terminates, the device reboots, or the operating system discards the
authentication session before bootstrap, that ceremony cannot resume. On the
next launch the app discards any callback without an active in-memory attempt,
shows the welcome screen, and starts a new ceremony. The abandoned server and
browser records expire and are cleaned normally.

Account creation, email confirmation, magic links, and password recovery may
leave the active authentication browser or complete on another device. They do
not carry a mobile handoff or preserve the native ceremony:

- if sign-up immediately returns a verified session, it may continue through
  normal browser completion
- if email confirmation is required, the browser explains that the current
  ceremony will end
- confirmation and recovery links use the normal website flow and never embed
  native state, verifier, or handoff material
- after confirmation or recovery, the user returns to the app and starts a new
  sign-in ceremony
- the app does not poll email status or persist native transaction secrets
  while waiting

An expired or abandoned browser page may offer `Return to OverDrafter`, but it
cannot mint or redeem a handoff.

## Relaunch, session restoration, and revocation

The shared `WKWebsiteDataStore` is the sole client-side owner of the Supabase
session for this hybrid app. The native layer MUST NOT duplicate the access or
refresh token in `UserDefaults`, Keychain, application state restoration, push
payloads, or diagnostics.

On cold launch:

1. show a neutral loading state, not authenticated workspace data
2. create a same-origin session probe using the shared web store
3. let the existing Supabase client restore/refresh its persisted session
4. verify the user through the normal server-backed app-session path
5. show the shell only after authentication and membership resolution succeed
6. otherwise clear stale subject-bound state and show the welcome screen

On a protected-route `401`, invalid refresh, revoked source session, or explicit
sign-out event, all destinations return to the signed-out gate. Cached Parts,
Quotes, files, notifications, and search results from the former subject MUST
be synchronously removed before any new session is published.

Supabase access tokens may remain valid until their configured expiry. Sensitive
server operations continue to perform the repository's normal authorization
checks and MUST NOT rely solely on native signed-in UI state.

## Logout

Logout occurs inside a same-origin app web context so the current Supabase
client can revoke/sign out the transferred app session and remove its persisted
storage. iOS logout MUST use `supabase.auth.signOut({ scope: "local" })`.
The current shared web helper uses global scope and therefore cannot be reused
unchanged for this app-local behavior.

`local` describes the server-side Supabase session scope, not a client-only
storage deletion. Logout is complete only after Supabase accepts termination of
the current transferred session and its refresh-token family. Other browser and
device sessions remain active. The current access-token JWT may remain usable
until its expiry, so sensitive APIs continue their normal server authorization
checks.

If the revocation request fails or loses connectivity, the app still removes
protected local data and returns to welcome, but records
`mobile_auth_logout_failed` and MUST NOT claim that server revocation succeeded.
No stale workspace remains visible, and a new sign-in is required.

Logout MUST:

- stop outstanding app requests where practical
- perform server-backed Supabase sign-out with explicit `local` scope and check
  its result before reporting successful logout
- remove the Supabase auth key and helper keys from the shared website store
- clear cookies or caches owned specifically by the app origin when required
- clear all subject-bound React Query, mutation, page, and native navigation
  state
- destroy and recreate workspace web views
- return to the native welcome screen

Logout MUST NOT:

- clear Safari or identity-provider cookies
- erase unrelated browsing data
- revoke the user's sessions in other browsers or devices
- imply that a short-lived access token is globally invalid before the server
  enforces revocation or token expiry

## Multiple web views

All app-owned web views MUST use one persistent `WKWebsiteDataStore` and a
consistent process/session configuration. They are created only after auth
bootstrap or a successful cold-launch probe.

Authentication state changes are broadcast to every destination. A tab that
detects sign-out cannot continue showing cached protected content. Logout and
account switching destroy all destination web views rather than relying on
eventual `localStorage` propagation.

## Threat review

| Threat | Required mitigation |
|---|---|
| Credential interception by embedded web content | Authenticate only through `ASWebAuthenticationSession`; no OAuth/provider login in `WKWebView` |
| Callback interception | Claimed HTTPS callback, exact host/path match, Associated Domains, AASA |
| Authorization-code or handoff interception | PKCE S256, transaction state, 120-second maximum, single use |
| Provider/native transaction confusion | Supabase-owned upstream-provider validation, a dedicated browser PKCE callback/storage namespace, and independent native state/PKCE |
| CSRF/login swapping | Native state, native-only bootstrap marker, server browser cookie/CSRF binding, transaction-bound provider callback, and server-verified session subject |
| PKCE downgrade | Reject every method except exact `S256`; never accept a verifier without a stored challenge |
| Replay and concurrent completion/redemption | Atomic claim before refresh rotation, keyed code digest, and one atomic `completed -> consumed` transition |
| Open redirect | Server-derived callback and parsed allowlist for relative return routes |
| Token leakage through URLs/history/referrers | No access/refresh token in any URL; app handoff values use a fragment; provider code is PKCE-bound; bootstrap uses POST; no-referrer and no-store |
| Token leakage through logs/analytics/crash reports | Body/header redaction, no third-party bootstrap scripts, structured safe events |
| Transaction-table disclosure | Handoff HMAC, authenticated encryption, key outside table, bounded secret deletion |
| XSS in bootstrap document | No user HTML, restrictive CSP, per-response nonce, escaped data, no third-party content |
| Cross-tenant access | Server derives actor from verified session; every domain request still enforces membership/RLS |
| Stale data after account change | Synchronous subject-cache purge and web-view destruction before new session publication |
| Compromised or revoked session | Verify at bootstrap, respect refresh failure/401, server-check sensitive operations |
| Browser/app storage confusion | Dedicated ceremony-scoped transfer session; provider data stays in namespaced `sessionStorage`; app web store is sole post-handoff owner |
| Process death or external email flow | Memory-only native attempt is abandoned; confirmation/recovery finishes on the website; user starts a new ceremony |
| Debug or preview callback escape | Stable allowlisted HTTPS hosts; no wildcard or caller-selected production callback |

## Audit and observability

Allowed security events:

- start accepted/rejected
- browser authentication completed/failed
- handoff created
- bootstrap accepted/rejected
- replay detected
- logout requested/completed
- session restoration succeeded/failed

Allowed event fields:

- contract version
- coarse environment
- transaction or trace ID generated for logging
- coarse failure code
- timestamps and duration buckets
- app version and OS version

Forbidden event fields:

- access token, refresh token, handoff code, verifier, or session envelope
- provider authorization code or state in application-controlled logs
- native state after it reaches application-controlled code
- request or response body
- cookie values
- email address or provider profile
- file, quote, part, project, organization, or membership content
- full callback URL or query string

Application redaction MUST happen before data reaches the logger, analytics SDK,
or error reporter. The initial start request necessarily exposes native state
and the public PKCE challenge to the TLS-terminating host, as normal OAuth-style
authorization requests do. The provider callback may likewise expose a
single-use, provider-PKCE-bound authorization code to infrastructure that
terminates TLS.

Infrastructure configuration SHOULD suppress query strings for
`/auth/mobile/start` and `/auth/mobile/provider-callback`. If the deployment
platform cannot do so, access to those logs MUST be restricted and retention
bounded; the security review records that limitation. The app callback uses a
fragment specifically so its handoff code and returned native state are never
sent in the HTTP request or reverse-proxy access log.

## Verification matrix

### Contract and backend

- successful password and every enabled social-provider flow
- provider callback validates the browser transaction before exchanging the
  Supabase code with its ceremony-scoped PKCE verifier; Supabase owns upstream
  provider state/nonce validation
- missing or mismatched provider callback transaction binding cannot cancel an
  active ceremony
- malformed and unsupported start requests
- disallowed, encoded, and protocol-relative return routes
- provider failure and browser cancellation
- exact 120-second handoff boundary
- wrong state, wrong verifier, and wrong callback configuration
- concurrent browser completion rotates exactly one transfer session; first
  redemption succeeds and serial/concurrent replay fails
- source session revoked between completion and bootstrap
- bootstrap network loss before and after atomic consume
- process death during browser auth, provider return, app callback, and
  bootstrap
- sign-up with and without email confirmation, external email verification,
  magic link, and password recovery followed by a fresh sign-in ceremony
- HMAC/encryption key rotation and secret cleanup
- response header and CSP assertions
- application log/analytics redaction plus deployment query-log review
- successful local-scope iOS logout revokes only the transferred session and
  leaves other device/browser sessions active
- failed/offline logout clears protected local state without claiming server
  revocation succeeded
- existing desktop/web password and OAuth callback regression tests

### Native

- shared-browser sign-in
- ephemeral `Use another account`
- callback host, path, field-count, size, and state validation
- cancellation is quiet and retryable
- callback fragment is parsed only for the exact configured HTTPS host/path
- each stable error maps to the correct recovery action
- bootstrap status messages require correct origin, version, shape, and state
- app shell is absent before successful bootstrap
- cold launch restores a valid session
- expired/revoked relaunch returns to welcome
- logout clears every destination without clearing external browser state
- process death and external email flows require a fresh ceremony without
  persisting state or verifier
- switching users never renders the prior user's data
- all app destinations observe one authenticated shared web store

### Physical-device release gate

- Associated Domains entitlement is present in the signed build
- the production AASA file is reachable and matches the signed Team ID/bundle ID
- email/password plus each enabled provider completes on a physical iPhone
- callback returns to the app without token-bearing URL data
- app relaunch, background/foreground, logout, and account switching pass
- a proxy/log review confirms no credential or verifier material is emitted

## Delivery boundaries

- `OVD-219` implements the server transaction, storage, completion, and
  bootstrap contract. It remains High complexity and requires explicit human
  approval plus security review before implementation.
- `OVD-221` implements the native welcome screen,
  `ASWebAuthenticationSession`, exact HTTPS callback, session probe, logout,
  account switching, and app-shell gate.
- `OVD-224` changes navigation only after the app has a reliable authenticated
  shell boundary.

No later issue may weaken this contract silently. A change to callback type,
token ownership, PKCE, expiry, single-use behavior, storage location,
authorization source, or redaction is a security-contract change and requires
an updated threat review.
