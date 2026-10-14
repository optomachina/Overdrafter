# Provider session probe

The session probe answers one question for a stored provider credential: is the restored session still logged in. It makes one attempt, reads only, and never retries. Nobody runs it against a real provider until Blaine says yes.

Covered providers: Fictiv, Quickparts, Geomiq (Playwright storage state) and RMFG (API key). Weerg is out of scope because its login loops in automated browsers.

## Run it

One time setup on the Mac, from the repository root: `npm --prefix worker ci`, then `npm --prefix worker run install:browsers` (installs the Playwright Chromium). Sign in with `gcloud auth login` first. Run one provider at a time, and read the single JSON line it prints.

```bash
npm --prefix worker run probe:session -- fictiv --secret fictiv-storage-state --project overdrafter-worker-9133
npm --prefix worker run probe:session -- quickparts --secret quickparts-storage-state --project overdrafter-worker-9133
npm --prefix worker run probe:session -- geomiq --secret geomiq-storage-state --project overdrafter-worker-9133
```

| Outcome | What it means | What to do next |
| --- | --- | --- |
| `authenticated` | The landing page loaded on the provider's own domain and shows a log out control. | Nothing. The stored session works. |
| `logged_out` with `login_form` or `login_redirect_off_host` | The provider asked the session to sign in again. | Recapture the storage state and store a new secret version. |
| `logged_out` with `no_authenticated_marker` | The page loaded but no log out control was found. | Inconclusive. Do not recapture for this alone. Tell the team so the marker can be set per provider. |
| `blocked` | The provider challenged or refused the probe. | Stop. That provider is off for the day. Do not rerun. Save the JSON line in the tracking issue. |
| `error` | The probe could not decide. | If the reason is `browser_launch_failed`, run the one time setup above and rerun. If it is `secret_unavailable` or `storage_state_invalid`, fix the secret or sign in to gcloud and rerun. If `httpStatus` is set, the provider did answer, so do not rerun until someone has read the record. |

Exit code 0 means `authenticated`. Anything else exits 1.

## What the probe does

For storage state providers it loads the state from a file or from Secret Manager into memory only, launches Chromium with the standard sandbox options, and aborts every request that is not https to the provider's own domains or that is not a GET or HEAD. It makes exactly one navigation to the provider landing page (followed through at most 5 checked redirect hops), checks the page without clicking or submitting anything, and closes. Any other page navigation, whether a script redirect or a popup opened with `window.open`, counts toward the single navigation cap, is aborted before it is sent, and is reported.

### Redirects, cookies and origin

Chromium is never allowed to follow a redirect on its own, because it would follow the rest of the chain without asking the probe. Every hop is checked before it is sent: it must be https (anything else, including `about:blank`, `data:` and plain http, ends as `non_https_target`) and its host must be in the allowlist (otherwise `off_host_redirect`).

- **The landing page.** Each hop is its own browser navigation. The probe fetches the hop once with no automatic redirect following. If the answer is a 3xx, it checks the `Location` target, cancels that navigation without handing the 3xx to the browser, and navigates the page to the next hop, which comes back through the same check. Only the final non redirect response is handed to the browser, under its own URL. So each URL in the chain is requested exactly once, the final document runs on its real origin with that origin's localStorage, sessionStorage and `document.cookie`, and its same origin calls go to its real host. At most 5 hops are followed; a sixth ends the run as `blocked` with reason `redirect_limit_exceeded`.
- **Cookies.** The probe never writes a Cookie header itself. For each hop, Playwright reads the cookies for that exact URL from the browser context's cookie jar (the restored storage state), and every `Set-Cookie` on a hop, including on a 3xx, is written back to the jar with its domain, path, secure and host only rules. A host only cookie of one host is therefore never sent to another, and a cookie set by one hop is sent on the next, as in a normal browser.
- **Subresources and iframes** (images, scripts, API calls) follow the same per hop checks and cookie handling, with the final response handed to the request that asked for it. A failed check on a subresource redirect aborts that one request and adds to `blockedRequests`; the run continues. Only a failed check on the page itself ends the run as `blocked`.

The reported `finalHost` is the host of the final page.

Landing page and allowed hosts come from the provider catalog generated from the manifests (`officialRfqUrl` and `officialDomains`). One exception: the Quickparts catalog URL is the marketing site, so the probe lands on the QuickQuote app at `https://quickquote.quickparts.com/` instead (the adapter's upload URL, inside the `quickparts.com` allowlist). The authenticated marker is provider neutral: a log out or sign out link or button found in the page, with no challenge. It is matched in the page markup whether or not it is visible, because many sites keep it in an account menu that is closed on load.

Before deciding, the probe takes a second look at the page a short moment after the first (600 ms) and only accepts the answer if both looks agree. A single page app that shows a password form for a moment before its session check finishes is therefore not read as logged out.

### What counts as blocked

A page is called blocked only on a real signal: HTTP 403, 429 or 503; a Cloudflare challenge marker (the challenge form, the challenge options object, or the challenge platform orchestrate script); a Turnstile widget on a page with neither a password field nor a log out control; or a challenge or denial title such as "Just a moment", "Attention required" or "Access denied". Body text never decides a block. A "protected by reCAPTCHA" footer, a reCAPTCHA or Turnstile widget on a login form, or the word "Forbidden" in ordinary text does not make a page blocked; a login page with such a widget reads `logged_out`. A log out control on the page wins over a CAPTCHA widget alone, so a signed in page that carries a Turnstile widget reads `authenticated`. It does not win over a Cloudflare challenge marker, a challenge title, or HTTP 403, 429 or 503.

A redirect to a login or identity host outside the provider's own domains (for example a single sign on host) is not a block. The request is still refused, with zero hits on that host, and the run reads `logged_out` with reason `login_redirect_off_host` and the host name only in the `offHost` field. A host counts as an identity host when its name has a label such as `login`, `auth`, `sso`, `id` or `accounts`, belongs to a known identity service (Auth0, Okta, OneLogin, Microsoft), or the redirect path looks like a login page. Any other off host redirect stays `blocked` with `off_host_redirect`.

For RMFG it makes one authenticated GET with the key. See the RMFG endpoint section below.

## Commands Blaine runs

Run from the repository root. Each needs `gcloud` signed in with access to project `overdrafter-worker-9133`. The probe finds `gcloud` in fixed install locations rather than through PATH; if yours is elsewhere, set `GCLOUD_PATH` to its absolute path. When `GCLOUD_PATH` is set it is the only location tried: if it is not an absolute, executable path the run ends as `secret_unavailable` instead of using another gcloud. Add `--out <path>` to also write the JSON record.

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
| `logged_out` | A login form, a login redirect or hash route (such as `#/login`), a redirect to an off domain login or identity host, a 401, or no logged in marker. Reasons: `login_form`, `login_redirect_off_host`, `http_unauthorized`, `no_authenticated_marker`. | For `login_form`, `login_redirect_off_host` and `http_unauthorized` the stored state has expired or is wrong: capture a fresh state and store a new secret version. Do not loop. `no_authenticated_marker` is inconclusive for all three providers (see below) and is not a reason to recapture on its own. |
| `blocked` | A challenge (`challenge_page`: a Cloudflare or Turnstile marker, a challenge title, or HTTP 503), a denial title (`access_denied`), HTTP 403 or 429, RMFG 401, a page redirect off the allowed hosts that is not a login or identity host (`off_host_redirect`) or to anything but https (`non_https_target`), a redirect chain longer than 5 hops (`redirect_limit_exceeded`), a state changing (non GET) page navigation that was aborted (`non_get_navigation`), or an extra navigation or popup (`unexpected_extra_navigation`). | Stop. The provider is off for the day (see below). |
| `error` | The probe could not decide: secret unavailable, malformed state (`storage_state_invalid`), navigation failure, Chromium failing to start (`browser_launch_failed`), page inspection failure, unexpected status, or the RMFG endpoint is not configured. | If the reason is local (`secret_unavailable`, `storage_state_invalid`, `probe_not_supported`, `rmfg_endpoint_not_configured`, `rmfg_key_invalid`) fix the cause and run again. For `navigation_failed` or `page_inspection_failed`, look at the record first. If `httpStatus` is set, the provider did answer: do not rerun, and treat it like a block until someone has looked at the record. There is no same day rerun after a `blocked` outcome or a `challenge_page` reason, and no retry around a block: the provider stays off for the day. |

`no_authenticated_marker` is inconclusive for Fictiv, Quickparts and Geomiq alike. The marker is a generic check in the page markup, not one confirmed against each provider's signed in page, so a logged in page without a log out link or button reads this way. Do not recapture a session because of it alone. If a logged in state keeps returning it, tell the team so the marker can be declared per provider. For Quickparts, in addition, treat `no_authenticated_marker` as inconclusive: the QuickQuote app's signed in page has not been captured in the repository, so it is not known to show a log out control on first load. A Quickparts `login_form` is still a real logged out answer.

## Blocked turns the provider off for the day

A blocked outcome is the standing rule trigger: the provider is turned off for the rest of the day. Do not rerun the probe, do not try another browser, and do not use the provider for any other automation until the next day. Record the evidence line in the tracking issue.

## Limits of this probe

These are design limits, not bugs, and they bias the result toward caution.

- **Traffic goes through Node, not Chrome.** Every request, including each redirect hop, is made by Playwright's Node HTTP stack inside the probe's route handler, so each hop is checked before it is sent. Chromium only receives final responses. The provider sees HTTP/1.1 and a Node TLS fingerprint under the headless Chromium user agent, which names itself `HeadlessChrome`. That string can itself draw a challenge, as can the Node fingerprint. A `blocked` result with reason `challenge_page` or `http_forbidden` may therefore mean the probe's fingerprint was challenged, not that the stored session is bad. It still turns the provider off for the day.
- **Only GET and HEAD are allowed.** Every other request is aborted. A single page app that loads its account data with a POST (for example a GraphQL query) may never render its log out control, and the probe will then report `logged_out` with reason `no_authenticated_marker`. Treat that reason as inconclusive for such providers rather than as proof the session expired.
- **Subresource redirects keep the requested address.** A redirected image, script or API call is answered under the address the page asked for. The landing page itself is not affected: it always ends on its real final URL.
- **Popups and script redirects count as navigations.** A landing page that opens a popup or redirects with script to an allowed host reads `blocked` with reason `unexpected_extra_navigation`, unless the target looks like a login page, which reads `logged_out`. A script redirect to a host outside the allowed domains reads `logged_out` with `login_redirect_off_host` when it is a login or identity host, and `blocked` with `off_host_redirect` otherwise.
- **A valid session can still read logged out.** If a provider's login depends on an off domain identity host, a good session may read `logged_out` with `login_redirect_off_host`. Read it as probably expired and recapture; it is not a block.
- **The logged in marker is generic.** It looks for a log out or sign out link or button in the page markup, visible or not. A logged in page without one reads as `logged_out` with reason `no_authenticated_marker`, which is inconclusive.
- **Identity host detection is a name heuristic.** An off domain login host that does not look like one by name or path reads `blocked` with `off_host_redirect`, which is the cautious answer.

## RMFG endpoint

The RMFG command makes one `GET https://api.rmfg.com/v1/account` with the key as a bearer header (`RMFG_PROBE_ENDPOINT` in `worker/src/providerSessionProbe.ts`). The host matches `RMFG_API_ORIGIN` in `worker/src/adapters/rmfgHttpTransport.ts`. The path comes from RMFG's OpenAPI and has not yet been checked against a live account response, so confirm it on the first real run. The transport (`createRmfgFetchTransport`) follows no redirect, never reads the body, caps the call at ten seconds and returns only the status. The probe enforces https, the rmfg.com domain and key shape. A 2xx is `authenticated`, 401, 403 and 429 are `blocked`, other statuses are `error`, and a timeout or network failure is `rmfg_transport_error`. The key is never logged or placed in the record.

## Safety properties

The secret value is held in memory, is never printed, and is never written to disk. Evidence contains fixed reason codes only. The probe does not click, upload, request a quote or submit a form, and it makes at most one attempt per run.

## Tests

`worker/src/providerSessionProbe.test.ts` covers authenticated, logged out, challenge, off host redirect, blocked host request, secret never logged, single navigation enforced, and RMFG 200, 401 and 429. It also covers redirect chains (an off host third hop with zero hits on the other server, an all allowed three redirect chain with one GET per hop, a loop stopped at the hop cap, a redirect to http and to `about:blank`, and 3xx bodies that must never render), cookies and origin across two loopback hosts (an SSO round trip from host A to host B and back, an apex to www style hop that needs a host only cookie of the second host, a hop that sets a cookie the next hop needs, and a final host whose session lives in localStorage with a same origin API call), a subresource redirect that is aborted while the run continues, the challenge title, Cloudflare marker, Turnstile and 503 branches, reCAPTCHA footers and the word "Forbidden" that must not block, a hash login route, a blocked POST navigation, a popup counted toward the navigation cap, a single page app showing "Just a moment" while loading that must not read as a challenge, a log out control beating a Turnstile widget alone (and not beating a Cloudflare marker, a challenge title or a 403), a log out control in a closed menu, a single page app that flashes a password form before its session check finishes, off domain login and identity redirects (by redirect, by chain, by identity host name and by script) that read `logged_out` with zero hits on the other host, a failing page sampler after a refused script redirect, a Chromium launch failure, and `GCLOUD_PATH` set to a non executable, missing or relative path, and the real command line wrapper run through tsx with a fake `gcloud` (found through `GCLOUD_PATH`) and a loopback fixture. The wrapper accepts `PROBE_TEST_LOOPBACK_URL` for that test only. Any value other than a plain `http://127.0.0.1:<port>` address makes the probe throw before any secret is read, so a mistyped value can never fall back to a real provider. Browser cases run against fixture pages on 127.0.0.1 and 127.0.0.2 with stubbed secrets and never contact a provider.

## Health status (OVD-763 slice 1)

`worker/src/providerSessionHealth.ts` turns probe evidence into a per provider health record and decides when the next probe is due. It is pure and injectable: the probe, the store and the clock are passed in, and it makes no vendor call, opens no browser and reads no secret. Covered providers: Fictiv, Quickparts, Xometry (storage state) and RMFG (API key).

- **Status.** `healthy`, `logged_out`, `blocked`, `error` or `unknown`. `authenticated` is `healthy`; the other outcomes map to themselves, except an HTTP 401 answer (the RMFG probe reports it as `blocked`), which reads `logged_out` because the credential was rejected.
- **Record.** Provider, status, a fixed reason code, `checkedAt`, `consecutiveFailures`, `lastHealthyAt` and `changed` (true only when the status differs from the previous record). Nothing else is stored: no storage state, cookies, keys, URLs or error text.
- **Check run.** `runProviderHealthCheck` probes each provider once and never retries. A thrown probe error becomes `error` with reason `probe_threw`; its message is dropped unread because it could carry a secret. A reason that is not a short lowercase code becomes `probe_reason_invalid`.
- **Kill switch.** With a guard supplied, an engaged switch (`provider_kill_switch_engaged`) or an unreadable one (`provider_kill_switch_unavailable`) skips the probe. The status and counts stay as they were and only the reason changes.
- **Schedule.** `isProbeDue` is true every 6 hours (default); `shouldProbeBeforeDispatch` is true when the record is older than 15 minutes (default), for use before a dispatch batch. Both treat a missing or `unknown` record as due. A `blocked` record is not due for 24 hours, matching the rule that a blocked provider is off for the day.
- **Persistence.** Slice 1 ships an in memory store only. The draft table is in `docs/migration-drafts/ovd763_provider_session_health.sql` and is not applied.

Not in this slice: wiring a real probe, a scheduler, alerts, any automatic kill switch flip, or any login or MFA handling.
