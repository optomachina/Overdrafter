# Provider session probe

The session probe answers one question for a stored provider credential: is the restored session still logged in. It makes one attempt, reads only, and never retries. Nobody runs it against a real provider until Blaine says yes.

Covered providers: Fictiv, Quickparts, Geomiq (Playwright storage state) and RMFG (API key). Weerg is out of scope because its login loops in automated browsers.

## What the probe does

For storage state providers it loads the state from a file or from Secret Manager into memory only, launches Chromium with the standard sandbox options, and aborts every request that is not https to the provider's own domains or that is not a GET or HEAD. It makes exactly one navigation to the provider landing page, checks the page without clicking or submitting anything, and closes. A script driven second navigation is aborted and reported.

Redirects are followed by the probe itself, never by Chromium. For every request the probe fetches one hop at a time with Node and no automatic redirect following. On each 3xx it resolves `Location` against the current URL and checks the new URL against the https rule and the host allowlist before sending it. It follows at most 5 redirect hops; a sixth ends the run as `blocked` with reason `redirect_limit_exceeded`. A hop that fails a check ends the run as `blocked` with reason `off_host_redirect`. Only the final non redirect response is handed to the browser, and a 3xx is never handed over. The reported `finalHost` is the host of that final response, not of the address the browser was first sent to.

Landing page and allowed hosts come from the provider catalog generated from the manifests (`officialRfqUrl` and `officialDomains`). The authenticated marker is provider neutral: a visible log out or sign out control, with no password field, challenge or denial text.

For RMFG it makes one authenticated GET with the key. See the open item below.

## Commands Blaine runs

Run from the repository root. Each needs `gcloud` signed in with access to project `overdrafter-worker-9133`. The probe finds `gcloud` in fixed install locations rather than through PATH; if yours is elsewhere, set `GCLOUD_PATH` to its absolute path. Add `--out <path>` to also write the JSON record.

```bash
npm --prefix worker run probe:session -- fictiv --secret fictiv-storage-state --project overdrafter-worker-9133
npm --prefix worker run probe:session -- quickparts --secret quickparts-storage-state --project overdrafter-worker-9133
npm --prefix worker run probe:session -- geomiq --secret geomiq-storage-state --project overdrafter-worker-9133
npm --prefix worker run probe:session -- rmfg --secret rmfg-api-key --project overdrafter-worker-9133
```

To test a local export instead of Secret Manager, use `--storage-state <path>` in place of `--secret <name>`. RMFG accepts only `--secret`. Relative paths for `--storage-state` and `--out` resolve from the directory where you typed the command (the repository root), not from the worker folder.

Run one provider at a time. Do not rerun a provider that came back blocked.

## Expected output

One JSON line on stdout, for example:

```json
{"provider":"fictiv","timestamp":"2026-10-12T15:04:05.000Z","outcome":"authenticated","reason":"authenticated_marker_found","finalHost":"app.fictiv.com","httpStatus":200,"navigations":1,"blockedRequests":3}
```

The record holds no cookies, tokens, page content or path. `finalHost` is the host only. `navigations` counts navigation attempts, so a value above 1 means a second one was attempted and aborted. `blockedRequests` counts aborted requests, such as analytics on other hosts, and is normal above zero. The exit code is 0 only for `authenticated`.

## What each outcome means

| Outcome | Meaning | Action |
| --- | --- | --- |
| `authenticated` | Landing page loaded on an allowed host and shows a logged in marker. | Provider session is qualified for this run. |
| `logged_out` | A login form, a login redirect, a 401, or no logged in marker. Reasons: `login_form`, `http_unauthorized`, `no_authenticated_marker`. | The stored state has expired or is wrong. Capture a fresh state and store a new secret version. Do not loop. |
| `blocked` | A challenge or CAPTCHA, an access denied page, HTTP 403 or 429, RMFG 401, a redirect off the allowed hosts or to plain http, a redirect chain longer than 5 hops (`redirect_limit_exceeded`), a state changing (non GET) page navigation that was aborted (`non_get_navigation`), or an unexpected extra navigation. | Stop. The provider is off for the day (see below). |
| `error` | The probe could not decide: secret unavailable, malformed state (`storage_state_invalid`), navigation failure, page inspection failure, unexpected status, or the RMFG endpoint is not configured. | If the reason is local (`secret_unavailable`, `storage_state_invalid`, `probe_not_supported`, `rmfg_endpoint_not_configured`, `rmfg_key_invalid`) fix the cause and run again. For `navigation_failed` or `page_inspection_failed`, look at the record first. If `httpStatus` is set, the provider did answer: do not rerun, and treat it like a block until someone has looked at the record. There is no same day rerun after a `blocked` outcome or a `challenge_page` reason, and no retry around a block: the provider stays off for the day. |

`no_authenticated_marker` can also mean the landing page is logged in but has no visible log out control. If a logged in state keeps returning it, tell the team so the marker can be declared per provider.

## Blocked turns the provider off for the day

A blocked outcome is the standing rule trigger: the provider is turned off for the rest of the day. Do not rerun the probe, do not try another browser, and do not use the provider for any other automation until the next day. Record the evidence line in the tracking issue.

## Limits of this probe

These are design limits, not bugs, and they bias the result toward caution.

- **Traffic goes through Node, not Chrome.** Every request, including each redirect hop, is made by Node's HTTP stack inside the probe's route handler, so each hop is checked before it is sent. Chromium only receives the final response. The provider sees HTTP/1.1 and a Node TLS fingerprint under a Chrome user agent. Bot management may challenge that. A `blocked` result with reason `challenge_page` or `http_forbidden` may therefore mean the probe's fingerprint was challenged, not that the stored session is bad. It still turns the provider off for the day.
- **Only GET and HEAD are allowed.** Every other request is aborted. A single page app that loads its account data with a POST (for example a GraphQL query) may never render its log out control, and the probe will then report `logged_out` with reason `no_authenticated_marker`. Treat that reason as inconclusive for such providers rather than as proof the session expired.
- **The page address stays at the first URL.** Because redirects are followed outside the browser, the document URL inside Chromium is the address first requested, so relative links on a redirected page resolve against it. The probe records the true final host from the redirect chain.
- **The logged in marker is generic.** It looks for a visible log out or sign out control. A logged in page without one reads as `logged_out`.

## Open item: RMFG endpoint

The repository has no RMFG HTTP client and no documented account or health endpoint. `rmfgQuoteTransport.ts` is an offline contract, and the materials catalog may be public, so a 200 from it would not prove the key works. `RMFG_PROBE_ENDPOINT` in `worker/src/providerSessionProbe.ts` is therefore a marked TODO set to null, and the RMFG command currently returns `error` with reason `rmfg_endpoint_not_configured` without any network call. Once Blaine or the RMFG docs name the endpoint, set it and add a real transport. The probe already enforces https, the rmfg.com domain, key shape, one call, a ten second cap, and treats 401, 403 and 429 as blocked.

## Safety properties

The secret value is held in memory, is never printed, and is never written to disk. Evidence contains fixed reason codes only. The probe does not click, upload, request a quote or submit a form, and it makes at most one attempt per run.

## Tests

`worker/src/providerSessionProbe.test.ts` covers authenticated, logged out, challenge, off host redirect, blocked host request, secret never logged, single navigation enforced, and RMFG 200, 401 and 429. It also covers redirect chains (a two hop chain ending off host with zero hits on the other server, an all allowed three redirect chain with one GET per hop, a loop stopped at the hop cap, a redirect to http), a blocked POST navigation, a popup request, a single page app showing "Just a moment" while loading that must not read as a challenge, and the real command line wrapper run through tsx with a fake `gcloud` (found through `GCLOUD_PATH`) and a loopback fixture. The wrapper accepts `PROBE_TEST_LOOPBACK_URL` for that test only; it is honored only for a plain `http://127.0.0.1:<port>` address and narrows the probe to that host, so it cannot aim the probe at a provider. Browser cases run against fixture pages on 127.0.0.1 with a stubbed secret loader and never contact a provider.
