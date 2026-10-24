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
| Stop on block | After any HTTP 401, 402, 403 or 429 the client latches `blockedReason()` and answers every later call without making a request. Nothing retries around a block. The result is `authorization_required`, `account_action_required` (a payment, plan or terms demand) or `rate_limited`. |
| Daily cap | Not in the client (OVD-829). Every live dispatch, RMFG included and the operator tools (`vendorWorkflowSmoke`, `xometryQuantitySweep`) too, passes the shared supplier settings gate before launch, which refuses `provider_daily_cap_reached` with no request once a supplier's admin-set daily cap is spent. There is no default cap: a supplier is unlimited unless an admin sets a positive cap. With `WORKER_PROVIDER_DURABLE_DISPATCH_CAP=on` the count is the durable database counter; off (the default, pre-migration) it is a per-process count against the cap read from the database. A cap that cannot be read is no cap; the kill switch still fails closed. The block latch lives in a module level store keyed by provider, so it holds for the whole process across transport instances; a test reset hook clears it. |
| Kill switch hook | An optional `isBlocked` callback, sync or async, is awaited before every request so a later database backed switch can read fresh. It is the seam for the per provider kill switch (OVD-722) and the ITAR/EAR block (OVD-723). Nothing wires it yet. |
| Tests | `rmfgHttpTransport.test.ts` runs the real client against a local stub HTTP server with synthetic responses. No live call is made. |
| Adapter | `worker/src/adapters/rmfg.ts` (`RmfgAdapter`, the Weerg substitute for 1.0) wraps the client as a `VendorAdapter`. It reads the key from the `RMFG_API_KEY` environment variable at quote time, only after every gate below passes, and returns a quote only offer. It refuses a part whose stated process is CNC only (`cnc_only_not_supported`), a missing process, or a non STEP file before any request. |
| Kill switch and export control | Before each request the adapter awaits `providerKillSwitchCheckpoint` (OVD-722: `before_upload` for analyze, `before_configure` for the quote, `before_navigation` otherwise) and, before the upload, `beforeProviderDisclosure` (OVD-723). Both are the input fields those PRs add, so they plug in when they merge. A refusal is rethrown unchanged and no further request is sent. The adapter also refuses an authorization whose envelope lacks the non export controlled affirmation. |
| Block handling | A 401 is `login_required`; a 403 or a real 429 is `anti_detection_block`; a non JSON answer (a challenge or interstitial page) is `captcha`; a 402, or an error whose code names a payment, billing, credit, plan, consent or terms step, is an account action. A challenge and an account action latch for the process. None is retried, and each carries a finite terminal state for the provider adapter contract: `login_required`, `captcha`, `unavailable` or `manual_review`. |
| Operator live evaluation (OVD-1057) | `npm --prefix worker run eval:live-provider -- --vendor rmfg --rmfg-grade 6061-T6 --rmfg-thickness-in 0.125 ...` runs RMFG only when named (never in `--vendor all`), at quantity 1, behind the operator kill switch and daily cap gate. The harness's digest bound file capture replaces the dispatch authorization. The adapter requires exactly one sheet part with instance count 1 and the stated thickness, picks the single current `/v1/materials` entry of that alloy, temper and nominal thickness (no substitutions), and reports a price only when the quote, its DFM echo, its line items and its totals all match the request with no finish, operation, shipping or tax added. RMFG has no delete for designs or quotes, so each run leaves one design and one expiring quote in the account and no cart. |
| Adapter tests | `rmfg.test.ts` runs the adapter and the real client against a fake fetch: quote success, provider error, challenge, block, rate limit and login (each stops and a fresh adapter sends nothing), kill switch engaged before and during a quote, export control denial, CNC refusal, default off gates, no client side cap, and a cap refusal from the shared settings gate. |

`rmfg` is in `LIVE_AUTOMATION_VENDORS` and the adapter registry. It stays off
because it is not in the `WORKER_LIVE_ADAPTERS` default, the RMFG envelope
(`rmfg-quote-envelope.v1`) is not in `REVIEWED_PROVIDER_DISPATCH_ENVELOPES`,
and the admission policy is disabled. The transport and envelope tests pin the
unreviewed envelope; `rmfg.test.ts` pins the default config and registry.

## Default off switches

A new RMFG quote needs all of these. None is on.

1. **Admission policy.** `private.quote_provider_admission_policies` for `rmfg`
   is `disabled` (migrations 20260928081530 and 20260928081534).
2. **Reviewed envelope.** No `rmfg` envelope is reviewed. The Fixture live
   stage was not run (see Fixture gaps).
3. **Rollout and organization enablement.** As for the other providers.
4. **Registry.** `provider-integrations/provider-registry.v1.json` keeps
   `liveAdapter: false`, `sessionSecrets: []`, `egress: "none"`.
5. **Worker.** `rmfg` must be added to `WORKER_LIVE_ADAPTERS` and
   `RMFG_API_KEY` mounted. The default is `xometry` only and no deploy script
   sets either.
6. **Reviewed dispatch envelope.** `rmfg-quote-envelope.v1` must be added to
   `REVIEWED_PROVIDER_DISPATCH_ENVELOPES` with its review row. Until then every
   generic dispatch for RMFG is refused with `provider_envelope_unknown`.

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
- **Per provider cap: merge and deploy gate.** The durable per supplier cap
  (OVD-829) needs a migration; the draft is
  `docs/migration-drafts/ovd-828-s1.sql` (not applied). The worker flag
  `WORKER_PROVIDER_DURABLE_DISPATCH_CAP` gates it:
  - Off (default). Required until the migration is applied. The kill switch
    still fails closed, and each worker process (and each operator run) counts
    a capped supplier against the cap read from the database. When that read
    fails or the settings RPC does not exist yet there is no cap (never a
    default of 20). Not shared across processes, and reset by a restart.
  - On. Turn it on in the same window, after the migration is applied. Every
    dispatch reserves through `api_worker_reserve_provider_dispatch`. If that
    RPC is missing or fails, the worker re-reads the settings: a supplier with
    a readable admin-set cap is refused (`provider_dispatch_counter_unavailable`);
    an uncapped supplier, or one whose cap cannot be read, dispatches uncounted.
    The kill switch fails closed in every case.
  - Rollback. Turn the flag off first, then run
    `docs/migration-drafts/ovd-828-s1.rollback.sql`.
- **Wiring.** The kill switch and export control seams are read from the
  adapter input; they take effect once OVD-722 and OVD-723 set them.
- **Stock selection.** RMFG needs a catalog stock ID per analyzed part. The
  adapter reads optional `rmfgSelections` from the requirement spec snapshot;
  without them a quote ends as manual follow up (`requires_input`) after one
  capped attempt.

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
