# Provider session probe

The session probe answers one question for a stored provider credential: is the restored session still logged in. It makes one attempt, reads only, and never retries. Nobody runs it against a real provider until Blaine says yes.

Covered providers: Fictiv, Quickparts, Geomiq (Playwright storage state) and RMFG (API key). Weerg is out of scope because its login loops in automated browsers.

## What the probe does

For storage state providers it loads the state from a file or from Secret Manager into memory only, launches Chromium with the standard sandbox options, and aborts every request that is not https to the provider's own domains or that is not a GET or HEAD. It makes exactly one navigation to the provider landing page (followed through at most 5 checked redirect hops), checks the page without clicking or submitting anything, and closes. Any other page navigation, whether a script redirect or a popup opened with `window.open`, counts toward the single navigation cap, is aborted before it is sent, and is reported.

### Redirects, cookies and origin

Chromium is never allowed to follow a redirect on its own, because it would follow the rest of the chain without asking the probe. Every hop is checked before it is sent: it must be https (anything else, including `about:blank`, `data:` and plain http, ends as `non_https_target`) and its host must be in the allowlist (otherwise `off_host_redirect`).

- **The landing page.** Each hop is its own browser navigation. The probe fetches the hop once with no automatic redirect following. If the answer is a 3xx, it checks the `Location` target, cancels that navigation without handing the 3xx to the browser, and navigates the page to the next hop, which comes back through the same check. Only the final non redirect response is handed to the browser, under its own URL. So each URL in the chain is requested exactly once, the final document runs on its real origin with that origin's localStorage, sessionStorage and `document.cookie`, and its same origin calls go to its real host. At most 5 hops are followed; a sixth ends the run as `blocked` with reason `redirect_limit_exceeded`.
- **Cookies.** The probe never writes a Cookie header itself. For each hop, Playwright reads the cookies for that exact URL from the browser context's cookie jar (the restored storage state), and every `Set-Cookie` on a hop, including on a 3xx, is written back to the jar with its domain, path, secure and host only rules. A host only cookie of one host is therefore never sent to another, and a cookie set by one hop is sent on the next, as in a normal browser.
- **Subresources and iframes** (images, scripts, API calls) follow the same per hop checks and cookie handling, with the final response handed to the request that asked for it. A failed check on a subresource redirect aborts that one request and adds to `blockedRequests`; the run continues. Only a failed check on the page itself ends the run as `blocked`.

The reported `finalHost` is the host of the final page.

Landing page and allowed hosts come from the provider catalog generated from the manifests (`officialRfqUrl` and `officialDomains`). One exception: the Quickparts catalog URL is the marketing site, so the probe lands on the QuickQuote app at `https://quickquote.quickparts.com/` instead (the adapter's upload URL, inside the `quickparts.com` allowlist). The authenticated marker is provider neutral: a visible log out or sign out control, with no password field or challenge.

### What counts as blocked

A page is called blocked only on a real signal: HTTP 403, 429 or 503; a Cloudflare challenge marker (the challenge form, the challenge options object, or the challenge platform orchestrate script); a Turnstile widget on a page with no password field; or a challenge or denial title such as "Just a moment", "Attention required" or "Access denied". Body text never decides a block. A "protected by reCAPTCHA" footer, a reCAPTCHA or Turnstile widget on a login form, or the word "Forbidden" in ordinary text does not make a page blocked; a login page with such a widget reads `logged_out`.

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
| `logged_out` | A login form, a login redirect or hash route (such as `#/login`), a 401, or no logged in marker. Reasons: `login_form`, `http_unauthorized`, `no_authenticated_marker`. | The stored state has expired or is wrong. Capture a fresh state and store a new secret version. Do not loop. |
| `blocked` | A challenge (`challenge_page`: a Cloudflare or Turnstile marker, a challenge title, or HTTP 503), a denial title (`access_denied`), HTTP 403 or 429, RMFG 401, a page redirect off the allowed hosts (`off_host_redirect`) or to anything but https (`non_https_target`), a redirect chain longer than 5 hops (`redirect_limit_exceeded`), a state changing (non GET) page navigation that was aborted (`non_get_navigation`), or an extra navigation or popup (`unexpected_extra_navigation`). | Stop. The provider is off for the day (see below). |
| `error` | The probe could not decide: secret unavailable, malformed state (`storage_state_invalid`), navigation failure, page inspection failure, unexpected status, or the RMFG endpoint is not configured. | If the reason is local (`secret_unavailable`, `storage_state_invalid`, `probe_not_supported`, `rmfg_endpoint_not_configured`, `rmfg_key_invalid`) fix the cause and run again. For `navigation_failed` or `page_inspection_failed`, look at the record first. If `httpStatus` is set, the provider did answer: do not rerun, and treat it like a block until someone has looked at the record. There is no same day rerun after a `blocked` outcome or a `challenge_page` reason, and no retry around a block: the provider stays off for the day. |

`no_authenticated_marker` can also mean the landing page is logged in but has no visible log out control. If a logged in state keeps returning it, tell the team so the marker can be declared per provider. For Quickparts treat `no_authenticated_marker` as inconclusive: the QuickQuote app's signed in page has not been captured in the repository, so it is not known to show a log out control on first load. A Quickparts `login_form` is still a real logged out answer.

## Blocked turns the provider off for the day

A blocked outcome is the standing rule trigger: the provider is turned off for the rest of the day. Do not rerun the probe, do not try another browser, and do not use the provider for any other automation until the next day. Record the evidence line in the tracking issue.

## Limits of this probe

These are design limits, not bugs, and they bias the result toward caution.

- **Traffic goes through Node, not Chrome.** Every request, including each redirect hop, is made by Playwright's Node HTTP stack inside the probe's route handler, so each hop is checked before it is sent. Chromium only receives final responses. The provider sees HTTP/1.1 and a Node TLS fingerprint under a Chrome user agent. Bot management may challenge that. A `blocked` result with reason `challenge_page` or `http_forbidden` may therefore mean the probe's fingerprint was challenged, not that the stored session is bad. It still turns the provider off for the day.
- **Only GET and HEAD are allowed.** Every other request is aborted. A single page app that loads its account data with a POST (for example a GraphQL query) may never render its log out control, and the probe will then report `logged_out` with reason `no_authenticated_marker`. Treat that reason as inconclusive for such providers rather than as proof the session expired.
- **Subresource redirects keep the requested address.** A redirected image, script or API call is answered under the address the page asked for. The landing page itself is not affected: it always ends on its real final URL.
- **Popups and script redirects count as navigations.** A landing page that opens a popup or redirects with script reads `blocked` with reason `unexpected_extra_navigation`, unless the target looks like a login page, which reads `logged_out`.
- **The logged in marker is generic.** It looks for a visible log out or sign out control. A logged in page without one reads as `logged_out`.

## Open item: RMFG endpoint

The repository has no RMFG HTTP client and no documented account or health endpoint. `rmfgQuoteTransport.ts` is an offline contract, and the materials catalog may be public, so a 200 from it would not prove the key works. `RMFG_PROBE_ENDPOINT` in `worker/src/providerSessionProbe.ts` is therefore a marked TODO set to null, and the RMFG command currently returns `error` with reason `rmfg_endpoint_not_configured` without any network call. Once Blaine or the RMFG docs name the endpoint, set it and add a real transport. The probe already enforces https, the rmfg.com domain, key shape, one call, a ten second cap, and treats 401, 403 and 429 as blocked.

## Safety properties

The secret value is held in memory, is never printed, and is never written to disk. Evidence contains fixed reason codes only. The probe does not click, upload, request a quote or submit a form, and it makes at most one attempt per run.

## Tests

`worker/src/providerSessionProbe.test.ts` covers authenticated, logged out, challenge, off host redirect, blocked host request, secret never logged, single navigation enforced, and RMFG 200, 401 and 429. It also covers redirect chains (an off host third hop with zero hits on the other server, an all allowed three redirect chain with one GET per hop, a loop stopped at the hop cap, a redirect to http and to `about:blank`, and 3xx bodies that must never render), cookies and origin across two loopback hosts (an SSO round trip from host A to host B and back, an apex to www style hop that needs a host only cookie of the second host, a hop that sets a cookie the next hop needs, and a final host whose session lives in localStorage with a same origin API call), a subresource redirect that is aborted while the run continues, the challenge title, Cloudflare marker, Turnstile and 503 branches, reCAPTCHA footers and the word "Forbidden" that must not block, a hash login route, a blocked POST navigation, a popup counted toward the navigation cap, a single page app showing "Just a moment" while loading that must not read as a challenge, and the real command line wrapper run through tsx with a fake `gcloud` (found through `GCLOUD_PATH`) and a loopback fixture. The wrapper accepts `PROBE_TEST_LOOPBACK_URL` for that test only. Any value other than a plain `http://127.0.0.1:<port>` address makes the probe throw before any secret is read, so a mistyped value can never fall back to a real provider. Browser cases run against fixture pages on 127.0.0.1 and 127.0.0.2 with stubbed secrets and never contact a provider.
