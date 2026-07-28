# Quote Intelligence App Release

Status: In progress
Task ID: `OVERNIGHT-QUOTE-INTELLIGENCE-APP`
Authorized: July 28, 2026
Approved product contract: Quote Intelligence design review approved July 28, 2026

## Problem

OverDrafter’s working client quote path is hidden inside a Project-first desktop shell. The approved product direction requires a simple, responsive `Parts | Quotes | Search` entry model and an iPhone/iPad application that preserves the same upload, quote-request, comparison, and selection workflow.

## Intended scope

### Responsive web

- Launch navigation: Parts, Quotes, Search.
- Existing Project remains the backend collaboration/commercial container.
- Parts collection includes an `All | Parts | Assemblies` filter without inventing unsupported assembly data.
- Search reranks while typing and parses explicit engineering aliases and units where source metadata exists.
- Quotes collection exposes quote state, part/project context, offer count, and a short display code.
- Quote detail lets the user add a customer/internal reference without changing the immutable display code.
- Quote detail shows request facts and offers directly.
- Buyer scatter uses ready-to-ship working days on X and quoted manufacturing total on Y.
- Scatter points are independent, fixed-size points with no connecting, trend, or Pareto line.
- Chart and offer table share selection state.
- Noncomparable offers remain visible with an exclusion reason.
- Existing sign-in, upload, extraction visibility, quote request/cancel/retry, offer selection, projects, files, and internal routes remain reachable.
- Account, organization, and role changes isolate workspace query keys and synchronously discard prior subject-bound client state.

### iPhone and iPad

- Universal SwiftUI application under `ios/`.
- Native Parts, Quotes, and Search navigation.
- Production workflow is reused through hardened route-specific web workspaces for the first TestFlight release, rather than reimplementing authenticated Supabase mutations inconsistently.
- Configuration supports local, preview, and production app URLs without embedding privileged credentials.
- Loading, offline, navigation failure, external-link, download, and file-picker behavior are handled.
- Secure payment-provider subframes remain embedded while external main-frame links leave the app.
- The first beta uses email/password authentication inside the app; social OAuth is hidden until native callback and
  session handoff support exists.
- iPhone and iPad simulator builds pass before archive/upload.

### Release

- Website changes pass release-confidence verification and browser smoke checks.
- The verified branch is published through the repository’s Vercel production integration.
- The iOS app is archived, validated, uploaded, and installed through TestFlight when Apple signing/App Store Connect authority permits it.
- Live URLs and release evidence are recorded.

## Explicitly excluded or suppressed

These capabilities remain part of the approved roadmap but may not be simulated or misrepresented in this release:

- PDM release/approval controls
- public marketplace publication or monetization
- customer-visible price estimate without an approved persisted prediction
- supplier outcome benchmarking without event closure, an anonymized minimum cohort, approved data-purpose terms, privacy safeguards, and competition counsel
- whole-assembly price estimation without immutable BOM/revision support
- exact response-time or quote-validity claims when the source record does not contain the required event

The eventual estimate experience is an estimated range with ranked approximate cost drivers for the uploaded design
as-is. It uses internal uncertainty to widen the range, not a customer-facing confidence score, and is automatically
evaluated against every later firm quote. The eventual supplier view is post-event and anonymized; it may compare price,
ready-to-ship lead time, and response latency only after the legal, cohort, and privacy gates above are satisfied.

## Acceptance criteria

### Navigation and responsive behavior

- [x] Authenticated clients can navigate directly to `/parts`, `/quotes`, `/search`, and a quote detail route.
- [x] Legacy Project/Part URLs remain compatible.
- [x] Phone, tablet, and desktop layouts expose the same primary actions without horizontal page overflow.
- [x] Mobile uses tap-visible edit/action affordances; desktop follows hover/focus affordance rules.

### Parts and search

- [x] Parts and project-backed groupings render from access-filtered client data.
- [x] `All | Parts | Assemblies` is one filter control, not separate columns.
- [x] Results update on every query change without Enter.
- [x] Search covers title, description, tags, material, finish, process, threads, tolerance, and part reference when present.
- [x] Diameter aliases (`dia`, `diameter`, `Ø`, `⌀`) share one parsed query form.
- [x] Numeric/unit interpretations are shown to the user and never sourced from fabricated geometry projection data.

### Quotes

- [x] Quotes show title/reference context, stable opaque display code, state, offer count, and request timing.
- [x] A user can rename the quote-facing customer reference without changing its route or immutable code.
- [x] Quote detail shows offer information directly rather than behind a generic review gate.
- [x] The chart uses total price on Y and ready-to-ship working days on X.
- [x] Scatter points are independent and fixed-size.
- [x] Table and chart share hover/selection state.
- [x] Source URLs are shown only when present and valid.
- [x] Missing validity or response-time facts display as unavailable, not inferred.
- [x] Existing request, retry, cancel, and offer-selection mutations retain their authorization and idempotency behavior.
- [x] Signing out or switching accounts cannot reuse the prior account’s cached parts, quotes, activity, or project data.

### iOS

- [x] The universal app has native Parts, Quotes, and Search destinations.
- [x] The app loads only configured HTTPS production/preview hosts outside local development.
- [ ] Auth sessions and uploads work inside the app workspace.
- [x] External supplier/source URLs leave the app safely.
- [x] Offline and load failure states offer retry.
- [x] iPhone and iPad simulator builds and tests pass.
- [ ] A generic-device archive validates.
- [ ] A TestFlight build is uploaded and its install link is verified.

### Release verification

- [x] Web lint passes.
- [x] Web typecheck passes.
- [x] Relevant unit/component tests pass.
- [x] Web production build passes.
- [x] Full repository verification passes or every unrelated baseline failure is documented.
- [x] Browser smoke covers anonymous landing, authenticated navigation fixture, search, and quote comparison.
- [x] Production Vercel deployment is HTTP 200 and matches the release commit.
- [ ] TestFlight installation is smoke-tested.

## Verification evidence

- `npm run verify`: passed July 28, 2026; 1,098 tests passed and two live-environment tests were intentionally skipped.
- iPhone 17 Pro Max simulator: 15 routing, configuration, and security tests passed.
- iPad Pro 13-inch (M5) simulator: 15 routing, configuration, and security tests passed.
- Unsigned generic-device Release build: passed store validation and compiled `com.optomachina.overdrafter`.
- Browser smoke: anonymous landing, signed-out private quote gate, login-path preservation, iOS email-auth mode,
  authenticated fixtures, live engineering search, phone/tablet/desktop responsiveness, and quote scatter comparison.
- Production: merge commit `de76c3146a6dd2f18955ba751b4134daff415bb9` deployed successfully to
  `https://overdrafter.vercel.app` and passed desktop/mobile smoke checks with no console warnings or errors.

## Remaining release authority

- Signed archive is blocked because Xcode reports no signed-in Apple account and cannot create the provisioning profile
  for `com.optomachina.overdrafter`.
- App Store Connect has no active browser session on this machine.
- An internal TestFlight build can proceed after the Apple account is reauthenticated and the app record exists.
- External/public TestFlight distribution additionally requires finalized privacy disclosures and policy URL,
  in-app account deletion or an approved exception, external-test metadata, and Apple Beta App Review.
- The dependency-free archive, upload, review, and public-link procedure is recorded in
  [`docs/ios-testflight-release.md`](ios-testflight-release.md).

## Complexity report

- Level: High
- Drivers:
  - cross-platform web and iOS work
  - responsive route and navigation changes
  - auth/upload behavior inside an iOS web workspace
  - quote comparison semantics
  - external Vercel and Apple release systems
  - broad regression surface
- Recommendation:
  - Split implementation by web, iOS, and release ownership while preserving one integrator.
- Human override:
  - The July 28, 2026 directive explicitly authorizes the high-complexity overnight build.

## Rollback

- Legacy routes remain available.
- New client routes can be removed from routing without changing quote data.
- The iOS app URL can be changed through build configuration.
- Website rollback uses the previous Vercel production deployment.
- No new customer-visible estimator or benchmark data is persisted by this release.
