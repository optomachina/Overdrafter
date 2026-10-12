# OVD-678 RMFG live readiness

Last updated: October 12, 2026

This workflow describes the RMFG quote path as far as it exists today. It
follows the shape of `docs/workflows/ovd675-weerg-live-readiness.md`, with one
difference: RMFG is an API provider (`adapterKind: "api"`), not a browser
portal. The client is implemented and disabled. Shipping the code does not
authorize any of the following:

- using an RMFG API key
- any call to `api.rmfg.com`
- CAD upload
- quote creation
- deployment
- admission
- rollout

Each of those remains a protected action under `AGENTS.md`. Promotion still
follows the three stages in `docs/provider-integration.md`. The public
capability record in `docs/rmfg-public-capability-recon.md` is unchanged.

## What the code provides

| Layer | Behavior |
| --- | --- |
| Contract | `worker/src/adapters/rmfgQuoteTransport.ts` (OVD-581, unchanged) maps the documented analyze, catalog and quote steps to a finite result. It accepts an injected transport and has no network code. |
| HTTP client | `worker/src/adapters/rmfgHttpTransport.ts` implements that injected transport with `fetch`. It can send only the closed `RmfgQuoteRequest` union, so cart, checkout and order endpoints are unreachable. The origin is pinned to `https://api.rmfg.com`; plain `http` is accepted only for a loopback stub and only when the caller passes `allowInsecureLoopbackForTests`, so production construction requires https. Redirects are refused so the key is never forwarded. |
| API key | The caller passes the key in. The client holds it in a closure, sends it only as a bearer header, and never logs it, returns it, or reads a default. A missing key, a key with any control character (including NUL and DEL), or a key with surrounding whitespace throws at construction. |
| Stop on block | After any HTTP 401, 403 or 429 the client latches `blockedReason()` and answers every later call without making a request. Nothing retries around a block. The result is `authorization_required` or `rate_limited` and needs a manual follow up. |
| Daily cap | At most 20 quote attempts (analyze calls) per UTC day, then the client answers as rate limited without a request. The cap must be a finite integer from 1 to 20, or construction throws. The cap and the block latch live in a module level store keyed by provider, so they hold for the whole process across transport instances; a test reset hook clears them. A durable cross process cap belongs to the dispatch layer. |
| Kill switch hook | An optional `isBlocked` callback, sync or async, is awaited before every request so a later database backed switch can read fresh. It is the seam for the per provider kill switch (OVD-722) and the ITAR/EAR block (OVD-723). Nothing wires it yet. |
| Tests | `rmfgHttpTransport.test.ts` runs the real client against a local stub HTTP server with synthetic responses. No live call is made. |

The client is not in `LIVE_AUTOMATION_VENDORS`, the adapter registry, the
worker config, or any deploy script. Two existing tests pin this
(`rmfgQuoteTransport.test.ts` and `rmfgSourceEnvelope.test.ts`).

## Default off switches

A new RMFG quote needs all of these. None is on.

1. **Admission policy.** `private.quote_provider_admission_policies` for `rmfg`
   is `disabled` (migrations 20260928081530 and 20260928081534).
2. **Reviewed envelope.** No `rmfg` envelope is reviewed. The Fixture live
   stage was not run (see Fixture gaps).
3. **Rollout and organization enablement.** As for the other providers.
4. **Registry.** `provider-integrations/provider-registry.v1.json` keeps
   `liveAdapter: false`, `sessionSecrets: []`, `egress: "none"`.
5. **Worker.** No dispatch path constructs the HTTP client.

## Fixture gaps for API providers

- The live stage only emits portal scaffolding (portal kernel definition,
  browser tests, a storage state secret entry), and it refuses `rmfg` until the
  vendor is in `LIVE_AUTOMATION_VENDORS`, which is the browser automation list.
  There is no API provider live stage.
- The registry validator rejects `sessionSecrets` while `liveAdapter` is
  false, and `egress: "stable_nat"` the same way. The API key secret name
  cannot be declared in a PR that keeps the adapter off.
- Secret shape is session oriented. `mountPath` must match
  `/var/secrets/<name>/storage-state.json`. An API key fits `mountEnv`, as
  Fictiv does, but the naming and file assumptions come from storage states.
- The admit stage needs the live stage's envelope fixture, so it is also
  blocked.

## Registry edit for a later reviewed PR (not applied)

The current validator rejects this entry because `sessionSecrets` must stay
empty while `liveAdapter` is false. It is shown with `liveAdapter: false`, as
it would read once a reviewed validator change allows secret names for an
adapter that is off. When the adapter goes live, `liveAdapter` becomes `true`
in the same reviewed edit. The entry would become:

```json
{
  "key": "rmfg",
  "liveAdapter": false,
  "sessionSecrets": [
    {
      "secretNameEnv": "RMFG_API_KEY_SECRET_NAME",
      "mountEnv": "RMFG_API_KEY",
      "requiredWhenListed": true
    }
  ],
  "egress": "none"
}
```

Then run `npm run provider:sync`. Never edit the generated files by hand.

## Known gaps before admission

- **No observed response.** Field names come from the published OpenAPI
  document and have not been checked against an authorized account response.
- **Lead time.** The contract reports `leadTimeBusinessDays: null`.
- **Egress.** RMFG is an HTTP API with a key, not a stable address allow list
  case. Whether RMFG needs a stable address is unknown.
- **Per provider cap.** The 20 per day cap lives in the client only.
- **Wiring.** The kill switch and export control callbacks are not connected
  to the database rows.

## Inputs only Blaine can provide

1. The Secret Manager secret name for the RMFG API key, which becomes the
   value of `RMFG_API_KEY_SECRET_NAME`. The worker runtime service account must
   be able to read it.
2. Permission basis, as in `docs/providers/permissions-matrix.md#rmfg`.
3. A decision on the Fixture follow ups above.
4. An exact file approval before any live upload, and the admission values and
   certification run described in the Fictiv workflow.

## Permissions matrix (OVD-724)

RMFG is listed in [`docs/providers/permissions-matrix.md`](../providers/permissions-matrix.md#rmfg).
A cease and desist uses the OVD-722 kill switch as step one
([playbook](../runbooks/provider-cease-and-desist.md)).
