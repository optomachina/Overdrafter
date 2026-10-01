# ChatGPT plugin foundation

Status: disabled local integration with a runnable synthetic HTTP demo; not a production-connected or submitted plugin.
Verified documentation date: October 1, 2026.

## Ownership and acceptance

Owner: delegated ChatGPT integration task, local host; branch
`spike/chatgpt-app-foundation`, worktree `task-3/chatgpt-app`, source
`8d8d243513b928a59bd9d63858732dad50498f09`. One bounded development/review
cycle (extended by the parent to include HTTP and an existing-service adapter), synthetic data only. No production, provider, OAuth grant, credential,
purchase, publication, or merge authority is exercised.

This slice must negotiate MCP through the official SDK, expose only read-only
job/quote tools, reject extraneous identity inputs, reauthorize each call, enforce
exact returned job/organization identity, whitelist output, preserve null prices,
and fail closed when disabled or on errors. Tests use linked in-memory MCP transports and a real loopback HTTP client/server
with synthetic Supabase HTTP responses, never a customer backend. This proves
the connected transport/tool/adapter boundary, not real OAuth or database RLS.

Complexity: High for the eventual integration (identity, access, billing and
external protocol). This independently testable slice adds SDK-backed tools, a local HTTP harness,
a user-scoped Supabase reader, synthetic fixtures, tests and dependencies; independent security review is required. No migration or
UI demo applies. Removing the module/dependencies rolls back this inactive slice.

## Architecture decision

Use a current ChatGPT **plugin** with MCP tools. The Apps SDK documentation now
redirects to the plugin documentation. Optional UI and skills can follow the
working tools; no custom widget is required for the first release.

`server/chatgpt/tools.ts` creates an MCP server but opens no port, installs no
production route, reads no environment or credentials, and has no production
composition. Without supplied dependencies, calls return disabled. The local
HTTP composition is restricted to an exact `http://127.0.0.1:<port>` origin,
checks Host/Origin, rejects forwarding headers, requires authorization, caps
request bodies at 64 KiB and handles each request with a fresh stateless server.
The production enable callback must remain false until a reviewed outer OAuth
bridge, hosted transport and deployment approval exist.
The two tools are `get_job_status` and `list_job_quotes`; their sole argument is
a UUID job ID. They require the proposed local `overdrafter:read` scope, which
is not an OpenAI plan-usage scope. Tool metadata is descriptive, not enforcement.

Dependencies must be bound to each request/session, never a shared mutable
principal. `resolvePrincipal` must validate issuer, audience, expiry and scopes,
resolve the existing Overdrafter user and selected organization, and reject
revoked accounts/grants. `resolvePrincipal` performs a per-call organization-membership preflight;
`readAuthorizedJob` applies existing user/job RLS and exact organization filters.
These separate reads are not an atomic membership snapshot: existing
`user_can_access_job` can preserve creator/project access after organization
membership loss. Atomic revocation/membership-race semantics remain a production
qualification blocker. A same-organization row alone does not establish access. The module additionally rejects wrong job/tenant
rows and validates/strips output. It intentionally has no service-role fallback.
The interface does not prove database policy correctness.

The existing app uses Supabase sessions and organization authorization.
`supabase-reader.ts` composes those services with a request-bound upstream user
token and a publishable key, without the browser singleton, session persistence,
refresh, privileged keys, or credentials from the environment. It verifies the
user through `getUser`, checks exact organization membership, filters the job by
ID and organization under the user JWT, and invokes the user-authorized quote
RPC. It rejects foreign results and malformed projections; missing schema is
not represented as an empty successful quote list. Calls have a ten-second
network timeout and refuse redirects. Only modern `sb_publishable_` keys are
accepted. An outer OAuth bridge must supply the server-resolved connection;
the plugin must never accept a Supabase user token as an OpenAI identity grant.
`getUser` is not a substitute for outer grant/session revocation validation.
Client-safe quote data comes from `public.api_list_client_quote_workspace`,
which applies `user_can_access_job`. Inspect the latest projection migration and
`src/features/quotes/api/jobs-api.ts` when building the adapter. Do not forward
its whole JSON payload: it contains more fields and artifacts than MCP needs.
Preserve canonical USD pricing separately from any future native-currency field;
never relabel native prices as USD. Unknown prices remain null. No raw CAD,
filenames, storage URLs, signed URLs, provider payloads or tokens are returned.
Quotes are existing vendor-result summaries, not every offer variant, new quote
requests, or validity guarantees. A future offer-comparison tool must preserve
per-offer validity/provenance; this tool does not claim an expired offer is usable.

## Source-only OAuth bearer bridge

`oauth-bridge.ts` implements the resource-server side of the proposed outer
OAuth bridge using server-held opaque grant records. It is disabled unless its
explicit enable callback returns true. It does not implement authorization-code
issuance, PKCE consent, login, refresh tokens, or a persistent grant store.

The bridge accepts a single bounded bearer header only at its configured resource
URL. It hashes the bearer before lookup and checks the returned record's token
digest, issuer, exact audience, user, organization, scope, issued/expiry times and
revocation flag. It resolves the upstream connection by server-held connection
ID and binds its user/organization to the grant. The outer bearer is never passed
to Supabase as a session token. Returned reader principals and direct data calls
must match that same binding. Grants and active connection mappings are re-read before principal resolution
and data access; changed grants, removed connections, narrowed scopes or rotated
upstream sessions fail closed. The connection resolver must reject revoked
sessions; no production resolver is configured here. Store errors do not disclose details.

The local HTTP demo now runs through this bridge with an ephemeral synthetic
bearer and an in-memory fixture grant that expires after one hour. It does not
create a real OAuth grant or account linkage. Production remains blocked on an
approved authorization server, transactionally managed persistent grants and
session revocation, protected-resource discovery, credentials/consent setup and
independent review of the new bridge. Separate preflight/read calls do not make
revocation atomic with database reads. Never treat this bridge as Sign in with
ChatGPT inference authorization.

## Three separate authorization and payment boundaries

1. **ChatGPT host reasoning over Overdrafter MCP:** ChatGPT invokes read tools;
   Overdrafter supplies authorized records. No additional backend inference is
   needed to summarize the records. This is the smallest useful first release.
2. **Plugin account linking:** the outer OAuth 2.1 flow authorizes the host to
   access Overdrafter. Existing Overdrafter login can be used for consent; an
   inner Sign in with ChatGPT identity flow is optional and distinct. No user
   ID, organization or email provided by a model is an authorization grant.
3. **Own-site Sign in with ChatGPT plan inference:** eligible users may authorize
   plan-funded Responses API usage. Commercial/hosted deployment requires the
   selected-partner route and registered client. Identity sign-in alone grants
   no inference budget. This slice neither implements nor enables that flow.

Plan usage draws from existing user allowances and app budgets, not a new free
pool. Do not extend that permission to arbitrary Agents API or Jev calls.
Streaming, `store: false`, client context, eligible models and preview limitations
must be checked against the approved contract before implementation. Hosted MCP,
computer use, image generation, Code Interpreter, background work and persistent
conversation storage are not assumed to be covered by the preview. A local or
open-source label does not make hosted commercial Overdrafter eligible.

Plugin commerce policy and own-site conversion are distinct. Existing paid
entitlements can be honored, but no digital subscription/credit checkout or
freemium upgrade CTA belongs in the plugin. Own-site approved plan-usage UX can
have a secondary app-credit fallback under the applicable guidelines. Existing
organization entitlements remain authoritative; ChatGPT identity/plan is not an
Overdrafter subscription. No Stripe objects, webhooks, payment paths or
entitlements are changed here, so no billing event/replay behavior is introduced.

## Minimal meaningful first release and remaining gates

A signed-in customer connects their existing account, reads a known job's
status, and reads existing client-visible vendor quote-result summaries in ChatGPT.
Full offer-variant comparison with validity/provenance is a subsequent tool. No uploads,
quote dispatch, provider browser operations, offer selection, checkout, or
backend inference is needed. Add profile/account selection and bounded job
search only after their privacy and authorization contracts are reviewed.

Remaining work before a connected release:

- Implement/verify production OAuth 2.1 transport/discovery, PKCE-capable
  authorization server and persistent grant/session lifecycle, then qualify the
  source-only resource/audience and expiry/revocation bridge with real RLS.
  Generic errors in this prototype are not a production linking UX.
- Qualify the implemented user-scoped reader with real RLS tests: another user in
  the same organization without job access, another organization, removed
  membership, revoked token, private/unpublished data, and pagination/size bounds.
  The current 100-quote bound fails closed on overflow; never silently truncate.
- Add production rate limits, full request cancellation, sanitized audit events,
  TLS transport/deployment configuration and directory auth discovery. Local
  HTTP end-to-end tests, request size/reading limits and upstream deadlines exist;
  no customer payloads or tokens belong in telemetry.
- For own-site plan inference separately: obtain commercial partner approval and
  client registration, approve credentials/grants, review account linkage and
  revocation storage, quota exhaustion and consented billing fallback. Never
  silently switch to paid API calls or reuse identity tokens as inference tokens.
- Agree release sequencing against `PLAN.md` (controlled beta; revenue is a later
  milestone), obtain publication authorization, and complete directory review.

## Runnable synthetic demo

After `npm ci`, run:

```sh
OVD_CHATGPT_LOCAL_DEMO=1 npx vite-node scripts/chatgpt-local-demo.ts
```

The process binds an ephemeral port on `127.0.0.1` and prints JSON containing
`url`, an ephemeral synthetic-only `bearer`, and `jobId`. An MCP Streamable HTTP
client can connect with `Authorization: Bearer <bearer>`, list tools, and read
the sample. Stop with Ctrl-C. Startup without the flag fails before listening.
The demo never reads real credentials or a database; it uses a synthetic in-memory grant and replaces upstream fetch
with fixed synthetic responses while executing the bridge and Supabase reader. Its
sample price is not a vendor quote. Do not expose this demo through a public
tunnel or deploy it. This local-only form does not confer commercial SIWC rights.

## Verification

Run `npx vitest run server/chatgpt`, `npm run typecheck`,
`npm run lint` and `npm run verify` using committed npm lockfiles.
The tests negotiate SDK MCP connections in memory and over loopback HTTP through
the actual Supabase reader with synthetic responses. They cover
read-only discovery, strict input, disabled access, revocation, denied scope,
wrong-tenant/wrong-job results, opaque token/resource/grant/connection binding,
expiry/revocation and concurrent request isolation, user-scoped headers/queries, membership and hidden
job denial, field minimization, unknown prices, HTTP input guards and failures.
Production auth/RLS, ChatGPT installation and real-user usability remain
unverified. Hosted check/review results are tracked at each exact PR revision. Local verification receipts belong in the task handoff.

## Official references

- [Plugin architecture](https://developers.openai.com/plugins/concepts/plugins)
- [Build an MCP server](https://developers.openai.com/plugins/build/mcp-server)
- [MCP authorization](https://developers.openai.com/plugins/build/auth)
- [Sign in inside a plugin](https://developers.openai.com/siwc/chatgpt-plugin)
- [Sign in with ChatGPT quickstart](https://developers.openai.com/siwc/quickstart)
- [Commercial client request](https://developers.openai.com/siwc/request-client-id)
- [Plan inference contract](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference)
- [Preview limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations)
- [Own-site usage UX](https://developers.openai.com/siwc/ui-ux-guidelines)
- [Plugin commerce guidelines](https://developers.openai.com/plugins/plugin-guidelines)
