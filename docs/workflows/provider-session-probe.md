# Provider session probe

The session probe answers one question for a stored provider credential: is the restored session still logged in. It makes one attempt, reads only, and never retries. Nobody runs it against a real provider until Blaine says yes.

Covered providers: Fictiv, Quickparts, Geomiq (Playwright storage state) and RMFG (API key). Weerg is out of scope because its login loops in automated browsers.

## What the probe does

For storage state providers it loads the state from a file or from Secret Manager into memory only, launches Chromium with the standard sandbox options, and aborts every request that is not https to the provider's own domains or that is not a GET or HEAD. It makes exactly one navigation to the provider landing page, checks the page without clicking or submitting anything, and closes. Each redirect hop is checked against the same host rule. A script driven second navigation is aborted and reported.

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

To test a local export instead of Secret Manager, use `--storage-state <path>` in place of `--secret <name>`. RMFG accepts only `--secret`.

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
| `blocked` | A challenge or CAPTCHA, an access denied page, HTTP 403 or 429, RMFG 401, a redirect off the allowed hosts, or an unexpected extra navigation. | Stop. The provider is off for the day (see below). |
| `error` | The probe could not decide: secret unavailable, malformed state, navigation failure, unexpected status, or the RMFG endpoint is not configured. | Fix the cause. This is not evidence about the provider. |

`no_authenticated_marker` can also mean the landing page is logged in but has no visible log out control. If a logged in state keeps returning it, tell the team so the marker can be declared per provider.

## Blocked turns the provider off for the day

A blocked outcome is the standing rule trigger: the provider is turned off for the rest of the day. Do not rerun the probe, do not try another browser, and do not use the provider for any other automation until the next day. Record the evidence line in the tracking issue.

## Open item: RMFG endpoint

The repository has no RMFG HTTP client and no documented account or health endpoint. `rmfgQuoteTransport.ts` is an offline contract, and the materials catalog may be public, so a 200 from it would not prove the key works. `RMFG_PROBE_ENDPOINT` in `worker/src/providerSessionProbe.ts` is therefore a marked TODO set to null, and the RMFG command currently returns `error` with reason `rmfg_endpoint_not_configured` without any network call. Once Blaine or the RMFG docs name the endpoint, set it and add a real transport. The probe already enforces https, the rmfg.com domain, key shape, one call, a ten second cap, and treats 401, 403 and 429 as blocked.

## Safety properties

The secret value is held in memory, is never printed, and is never written to disk. Evidence contains fixed reason codes only. The probe does not click, upload, request a quote or submit a form, and it makes at most one attempt per run.

## Tests

`worker/src/providerSessionProbe.test.ts` covers authenticated, logged out, challenge, off host redirect, blocked host request, secret never logged, single navigation enforced, and RMFG 200, 401 and 429. Browser cases run against fixture pages on 127.0.0.1 with a stubbed secret loader and never contact a provider.
