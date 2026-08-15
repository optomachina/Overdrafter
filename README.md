# OverDrafter — Part to Quote

OverDrafter helps a hands-on buyer upload a supported machined part, review its
requirements, receive a trustworthy sourcing outcome, compare real offers, and
continue with the selected vendor.

The active 1.0 product is a controlled design-partner beta: an authenticated
responsive-web journey for one exact machined-aluminum STEP/STP envelope and
one production-certified automatic quote lane. It is not general availability.
The broader CAD-native manufacturing co-pilot remains a captured incubator
vision; it is not the current product promise or execution queue.

`npm` is the authoritative package manager for both the repo root and `worker/`. Use the committed
`package-lock.json` files and do not introduce Bun, pnpm, or Yarn lockfiles unless the repo policy changes.
For nontrivial local changes, `npm run verify` is the canonical repo-level verification gate.

If your current workspace does not contain this `README.md`, plus root `PRD.md`, `PLAN.md`, `AGENTS.md`,
`package.json`, `worker/`, and `supabase/`, you are not in the correct OverDrafter repo root.

## Canonical Docs

Use repo documentation in this order when documents overlap:

1. `PRD.md` - canonical product intent
2. `PLAN.md` - active execution sequencing
3. `ROADMAP.md` - release ladder, exclusions, and idea-promotion rules
4. `ARCHITECTURE.md` - system boundaries and subsystem model
5. `TEST_STRATEGY.md` - verification expectations
6. `ACCEPTANCE_CRITERIA.md` - evidence required to release 1.0
7. specialized docs for a specific area
8. `README.md` - repo entry point and setup guidance

If a lower-priority doc disagrees with one of the files above, the higher-priority doc wins. `ROADMAP.md` precedence is limited to sequencing and classification; it cannot weaken architecture, security, privacy, testing, acceptance, or implementation constraints.

## Planning Material Status

- `REPO_MAP.md` is a non-canonical orientation aid for navigating the repo layout.
- `ROADMAP.md` is the short repository bridge to the release ladder, incubator
  routes, and idea-promotion rules.
- The
  [OverDrafter Product Portfolio & Future Capability Index](https://linear.app/overdrafter/document/overdrafter-product-portfolio-and-future-capability-index-e5566af77774)
  is the single detailed home for deferred feature ideas.
- `docs/1-0-beta-runbook.md` defines the exact package, disclosure,
  data-handling gate, browser checks, evidence record, and rollback rules for
  the active controlled beta.
- `docs/founding-beta-program.md` defines the Founding Beta cohort, safeguards,
  run limits, evidence, and decision protocol after production readiness.

The former horizon, capability-map, TODO, and speculative planning documents
were retired after their durable ideas were captured in Linear. Git history
preserves their prior contents.

Important specialized planning docs include:

- `docs/service-request-taxonomy.md` for service-type modeling and line-item boundaries
- `docs/DESIGN.md` for the canonical design system (typography, color, layout, anti-slop rules) — read before any UI or visual decision

### Commercial operations documentation

Start with the [Commercial Account Administration Guide](docs/workflows/commercial-account-administration.md)
for day-to-day account lookup, access review, manual Pro grants, revocation,
and audit checks. Its linked references keep the detailed rules in one place:

- [Billing Workflow](docs/workflows/billing-workflow.md) defines Stripe synchronization, Checkout, and entitlement behavior.
- [Commercial Rollout Controls](docs/workflows/commercial-rollout-controls.md) defines capability provisioning, staged enablement, monitoring, and rollback.
- [Architecture: commercial access and operations](ARCHITECTURE.md#9-commercial-access-and-operations-layer) defines the authorization and data boundaries.

## Current Release Posture

OverDrafter is preparing **1.0 — Part to Quote** as a controlled design-partner
beta, not a public general-availability launch. Release proof is repeatable
production completion of the signed-in upload-to-vendor-handoff journey, plus
unaided completion by external design partners. There is no calendar target.

The current next task is `OVD-359`, approval and enforcement of the data-
handling, disclosure, export-control, beta-organization, Xometry-only, and exact
validation-package safety contract. `OVD-206` hosted Xometry repeatability follows
that gate. The single authoritative queue and the reason for that ordering are
in `PLAN.md`; the exact package and operating boundary are in
[`docs/1-0-beta-runbook.md`](docs/1-0-beta-runbook.md).

After production certification, `OVD-358` runs the Founding Beta. Qualified
friends of the founder are the first intended cohort under the same safeguards
as any participant; the program contract is in
[`docs/founding-beta-program.md`](docs/founding-beta-program.md).

Billing is not a blocker for this sequence. `OVD-228` and the first external paid
organization (`OVD-320`) belong to 1.1 after 1.0 proves value. Automatic quote
access during 1.0 is limited to explicitly enrolled, audited design-partner
organizations; it is not opened to every signed-in organization.

iOS production readiness, CAD-native workspace expansion, supplier-network
development, manufacturing intelligence, and downstream fulfillment are
deferred in the Linear portfolio index and routed by `ROADMAP.md`.

## Execution Workflow

The agent's current plan is the execution source of truth. Linear provides issue
identity, human-visible status, and durable history. Codex handles bounded
planning, implementation, verification, and handoff work; GitHub pull requests
and CI provide review and repeatable verification.

## Code Review Workflow

OverDrafter uses a layered review stack:

- Linear is the issue and status source of truth.
- Codex is the planning, implementation, and local review agent.
- Codex GitHub review is the PR review layer.
- CI provides the repeatable verification layer.
- GitHub Actions fans CI out into parallel lint, typecheck, test, build, and worker lanes, then reports a final aggregate `ci` gate for branch protection.

Recommended developer flow:

1. Pick the Linear issue and confirm scope and acceptance criteria.
2. Create an isolated branch or worktree.
3. Implement locally with Codex CLI when helpful.
4. Run local verification and a local Codex `/review` before push.
5. Open a GitHub pull request.
6. Let native GitHub Codex automatic review post advisory findings on the PR.
7. Resolve findings and rerun local verification as needed.
8. Merge only after human approval and passing CI.

### Local Codex usage

Before opening a PR, use Codex CLI to catch review issues locally:

```text
/review
```

Run it against your working tree, a commit, or a base branch diff as appropriate for the task. Use
it alongside `npm run verify`, not instead of verification.

### GitHub Codex review

GitHub Codex review in this repo is the native subscription-backed review flow configured in GitHub
and OpenAI, not a repo-managed API-key workflow. The review should apply the root `AGENTS.md` policy
plus the closest `AGENTS.override.md` for changed files. Maintainers can request a fresh manual pass
with `@codex review` when a PR has materially changed.

### GitHub secrets and settings

Required repository settings:

- enable Codex code review for the repository in your OpenAI/Codex GitHub configuration
- enable automatic reviews so Codex reviews every PR through the native GitHub integration
- keep branch protection and human approval requirements in place
- keep GitHub Actions permissions at the repository default of read unless a workflow needs a scoped write permission for non-Codex CI work
- do not add `OPENAI_API_KEY` to this repo unless the repo policy intentionally changes away from the subscription-only path

Maintainership guidance:

- treat Codex findings as reviewer input, not merge authority
- fix or explicitly disposition material findings in the PR
- use CI failures as normal debugging input; do not expect repo-managed Codex autofix or diagnosis here

For recurring planning, verification, and handoff motions, use `docs/recurring-workflows.md`.

## Active Repo Layout

The active runtime and ownership model for this repository is:

- `src/` - the production React + Vite web application
- `ios/` - the universal SwiftUI iPhone/iPad application and XcodeGen source project
- `worker/` - the separate TypeScript worker package
- `supabase/` - migrations, local config, and Edge Functions
- `public/` - static assets served by the Vite app
- `scripts/` - repo automation, seed helpers, and workflow guard scripts
- `e2e/` - Playwright coverage for end-to-end flows

There is no active tracked `apps/` or `packages/` source layout in this repository. If those directories
appear in old diffs or stale local artifacts, do not treat them as canonical runtime roots. Use
`REPO_MAP.md` for the current directory map.

## What Was Implemented

### What Was Implemented (foundation)

The current React + Supabase + worker implementation provides foundations for
job intake, extraction/review, quote orchestration, live and manual sourcing,
comparison/selection, and vendor handoff. The 1.0 task is to certify this narrow
customer journey in production, not to wrap it in a broader agent experience.

The active client launch surface is `Parts | Quotes | Search` on responsive web.
Projects remain the collaboration/procurement-workflow container behind those
collections, while organizations are the commercial account and entitlement
boundary. Quote detail keeps request status, source facts, and the
lead-time-versus-total-price comparison together; the current short quote code
is a login-gated locator rather than an access token. The iOS implementation is
preserved in the repository, but production iOS work is deferred.

### iOS

iOS production readiness is deferred during the web-first launch phase. The
commands and runbooks below remain reference material for the later
re-authorized iOS cycle; they are not current release steps.

Generate and verify the checked-in Xcode project from its source definition:

```bash
cd ios
xcodegen generate
xcodebuild -project OverDrafter.xcodeproj -scheme OverDrafter \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro Max' test
xcodebuild -project OverDrafter.xcodeproj -scheme OverDrafter \
  -destination 'platform=iOS Simulator,name=iPad Pro 13-inch (M5)' test
```

The default app origin is `https://overdrafter.vercel.app`. Debug builds may override it with the
`OVERDRAFTER_BASE_URL` process environment variable, including an HTTP localhost URL. Release builds accept only HTTPS.
Archive signing supplies the Apple development team at release time; privileged credentials are not committed.
The first build supports detail-preserving `overdrafter://` deep links. Universal HTTPS links remain deferred until the
production associated-domain file and Apple capability are deployed together.
The embedded workspace uses email/password authentication for the first beta; web social-auth controls are suppressed
in iOS app mode until a native OAuth callback and session handoff are available.
The server/browser half of that handoff is now implemented at the versioned
`/auth/mobile/*` boundary. Native callback capture and shared-web-store
bootstrap remain gated on OVD-221; see the
[mobile authentication deployment runbook](docs/mobile-authentication-deployment.md)
before enabling the flow on a signed device build.
Use the [iOS TestFlight release runbook](docs/ios-testflight-release.md) for signing, upload, external-review, and
public-link requirements. Credentials and reviewer accounts must never be committed.

### Supabase

- Domain schema and enums in [`supabase/migrations/20260303101500_curated_cnc_quote_platform.sql`](supabase/migrations/20260303101500_curated_cnc_quote_platform.sql)
- Buckets for `job-files` and `quote-artifacts`
- RLS for internal vs client access
- RPCs for:
  - `api_get_founding_beta_access_state`
  - `api_accept_founding_beta_notice`
  - `api_admin_set_founding_beta_enrollment`
  - `api_create_job`
  - `api_attach_job_file`
  - `api_reconcile_job_parts`
  - `api_request_extraction`
  - `api_approve_job_requirements`
  - `api_start_quote_run`
  - `api_get_quote_run_readiness`
  - `api_publish_quote_package`
  - `api_select_quote_option`

## Local Setup

### 1. Frontend

```bash
npm install
cp .env.example .env
npm run generate:favicon
npm run dev
```

Required frontend environment variables:

- `VITE_APP_URL` for the canonical public app URL used in Supabase email links in deployed environments
- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_PUBLISHABLE_KEY`

Dormant subscription billing uses the authenticated `billing-sessions`
Supabase Edge Function. To preserve Billing Portal access for existing
subscribers, configure its server-only `OVERDRAFTER_APP_URL`,
`STRIPE_EXPECTED_LIVEMODE`, and `STRIPE_SECRET_KEY` values. The Checkout-only
`STRIPE_PRO_MONTHLY_PRICE_ID` may remain unset during the Founding Beta. Keep
`BILLING_SELF_SERVICE_ENABLED=false` while pricing is under validation; this
switch gates new Checkout only. The Billing Portal remains available solely to
authorized billing owners whose bound Stripe customer has an existing,
nonterminal subscription, preserving their cancellation path. Before Checkout
activation, the product owner must approve the monthly price and matching
Stripe catalog entry, configure `STRIPE_PRO_MONTHLY_PRICE_ID`, and verify the
signed `stripe-events` webhook in the same test/live mode. Checkout redirects
never activate access; the synchronized Stripe webhook does.

If you replace `src/assets/logo.png`, regenerate the favicon assets before committing:

```bash
npm run generate:favicon
```

The script refreshes `public/favicon.ico`, `public/favicon-32x32.png`, and `public/apple-touch-icon.png`.

If you want Google, Microsoft, and Apple sign-in enabled in the UI, also turn on the `Google`,
`Azure`, and `Apple` providers in Supabase Auth and add your app URL from `VITE_APP_URL` to the
allowed redirect URLs.

### 2. Supabase

Apply the repo's full migration head before using the app. Do not apply a single migration file in isolation.

For local development:

```bash
npm run db:start
npm run db:reset
```

For the linked hosted dev project:

```bash
npm run db:push
```

When schema changes affect the generated Supabase surface, regenerate
[`src/integrations/supabase/types.ts`](src/integrations/supabase/types.ts)
from local migration head after the local stack is running:

```bash
npm run db:types
```

The canonical local flow is `npm run db:start` or `npm run db:reset` first, then `npm run db:types`.

After either flow, verify the latest migrations have been applied and that `public.projects.archived_at`
and `public.jobs.archived_at` exist before debugging app-layer query failures.

Quote comparison data path:

- imported spreadsheet quote flows write into `jobs`, `parts`, `drawing_extractions`, `approved_part_requirements`, `quote_runs`, `vendor_quote_results`, and canonical per-lane `vendor_quote_offers`
- the client scatter chart reads quote comparison data only through `public.api_list_client_quote_workspace(uuid[])`
- client surfaces do not read `vendor_quote_results` or `vendor_quote_offers` directly because those tables remain internal-only behind RLS
- `vendor_quote_offers` is the authoritative chart lane source; `vendor_quote_results.raw_payload.offers` is compatibility fallback only
- hosted environments must include migration `20260319113000_add_client_quote_workspace_projection.sql` and a refreshed PostgREST schema cache before client quote charts can load real data
- hosted environments must also be at migration head for startup/auth RPCs such as `public.api_get_is_platform_admin()` and `public.api_create_self_service_organization(text)`; after pushing hosted migrations, refresh the PostgREST schema cache before debugging signed-in workspace bootstrap errors

Archive delete requires the hosted environment to have the archived delete RPCs at migration head:
`public.api_delete_archived_jobs(uuid[])` as the primary contract and
`public.api_delete_archived_job(uuid)` as the legacy compatibility fallback. Hosted archive delete
also depends on the `job-archive-fallback` Edge Function being deployed with `SUPABASE_DB_URL` plus
`SUPABASE_SERVICE_ROLE_KEY` so storage cleanup can run through the Storage API when direct
`storage.objects` deletes are blocked. The migration head still needs the published-package cleanup
inside `api_delete_archived_jobs(uuid[])` so quoted or published archived parts can be permanently
deleted without foreign-key failures before the storage cleanup fallback runs.
Vercel preview or production app deploys do not deploy Supabase Edge Functions automatically, so
confirm the active Supabase project for `VITE_SUPABASE_URL` also has `job-archive-fallback`
deployed and configured before treating preview archive-delete failures as app regressions.

Then create memberships for your users in `organization_memberships`.

Minimum bootstrap flow:

1. Create an organization row.
2. Add one `internal_admin` or `internal_estimator` membership for your own auth user.
3. Add any client users with role `client`.

### 3. Worker

```bash
cd worker
npm install
npm run dev
```

Required worker environment variables:

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`

Optional worker environment variables:

- `WORKER_MODE=simulate|live`
- `WORKER_NAME=quote-worker-1`
- `WORKER_POLL_INTERVAL_MS=5000`

## Local Verification

Install dependencies in both packages before using the repo-wide verification gate:

```bash
npm install
npm --prefix worker install
npm run verify
```

Use narrower commands when you are iterating on one area:

- root app: `npm run lint`, `npm run typecheck`, `npm run test`, `npm run build`
- worker from repo root: `npm run verify:worker`
- worker in `worker/`: `npm run typecheck`, `npm run build`, or `npm run verify`

## Debugging Workflows

Use the lane that matches the problem you are chasing:

- production-realistic: real local Supabase auth plus seeded app data
- fast E2E: Playwright with saved authenticated sessions
- UI tuning: local fixture surfaces for stable client workspace states

### Quickstart

Production-realistic local setup:

```bash
npm run db:start
npm run db:reset
npm run seed:dev
npm run dev
```

Docker note:

- `npm run db:start` and `npm run db:reset` require Docker Desktop because local Supabase runs in Docker
- if `supabase start` fails with `Cannot connect to the Docker daemon`, start Docker Desktop first
- if you do not want to use Docker, use the built-in fixture surfaces instead

Typical usage:

- first local setup or after Docker restart:

```bash
npm run db:start
npm run db:reset
npm run seed:dev
npm run dev
```

- normal frontend work when local Supabase is already running and seeded:

```bash
npm run dev
```

- reset local data back to the known demo state:

```bash
npm run db:reset
npm run seed:dev
npm run dev
```

Seeded local users:

- `client.demo@overdrafter.local`
- `estimator.demo@overdrafter.local`
- `admin.demo@overdrafter.local`
- password: `Overdrafter123!`

Dev-only instant login shortcut:

- visit `http://localhost:8080/dev-login?redirect=/`
- or run `npm run dev:login`
- this only works in local development and signs in as the legacy single-account
  development user when that user exists in the connected database

Fast E2E setup:

```bash
npm run e2e:prepare
npm run e2e
```

Notes:

- `npm run e2e:prepare` resets the local database, reseeds demo data, and writes saved auth sessions to `playwright/.auth/`
- Playwright starts its own dev server on `http://127.0.0.1:4173`
- failure artifacts are written to `test-results/` and `playwright-report/`

Fixture surfaces:

```bash
npm run dev
```

Then open one of these URLs:

- `http://127.0.0.1:5173/debug/state-gallery`
- `http://127.0.0.1:5173/?fixture=landing-anonymous&debug=1`
- `http://127.0.0.1:5173/?fixture=client-empty&debug=1`
- `http://127.0.0.1:5173/parts/fx-job-needs-attention?fixture=client-needs-attention&debug=1`
- `http://127.0.0.1:5173/projects/fx-project-quoted?fixture=client-quoted&debug=1`
- `http://127.0.0.1:5173/projects/fx-project-published/review?fixture=client-published&debug=1`

Fixture controls appear as a compact strip inside the client application frame in local dev and test builds. Open them from the account menu when no fixture is active.
Use `/debug/state-gallery` when you want the auth states and the existing fixture-backed workspace states in one review surface.
The quoted fixture and gallery sample use the public-use synthetic `FX-101` demo bracket. Its quote lanes preserve workbook-backed commercial examples for UI review, but the synthetic files do not represent the source geometry or an actual quote.

For a longer walkthrough, see `docs/debugging-workflows.md`.

### Which Lane To Use

- use production-realistic when you need real auth, real memberships, real Supabase queries, or seeded demo data
- use fast E2E when you want repeatable browser coverage with saved sessions
- use fixture surfaces when you want to tune client workspace UI without Docker or Supabase state

### Recurring Codex Workflows

Use `docs/recurring-workflows.md` instead of relying on pasted handoff snippets. It connects:

- recurring issue flow and handoff expectations from `WORKFLOW.md`
- change-type verification guidance from `TEST_STRATEGY.md`
- debugging lane selection from `docs/debugging-workflows.md`
- PR evidence expectations from `.github/pull_request_template.md`
- repo-local procedural skills in `.codex/skills/`

## Implemented foundation and release blockers

The portal and Supabase foundation are implemented. The historical no-Stripe
single-account pilot established a live quote-request loop: sign in, upload
parts, request quotes, and receive live vendor results or explicit manual-
follow-up states.

Recent live-adapter status:

- Fictiv live automation was repaired in PR #235 and validated historically for
  internal use. It is deferred and is not a certified 1.0 beta lane.
- Xometry live automation uses standard Playwright Chromium by default. PR #236 added Camoufox plus a persistent profile specifically to survive Cloudflare behavior that silently neutralized Patchright sessions, and proved a real quote. PR #277 later found standard Playwright loaded Xometry's material API correctly while Patchright returned `401`, so Playwright became the hosted default. Camoufox remains the anti-bot compatibility/rollback engine; hosting it requires an installed, persistent `XOMETRY_USER_DATA_DIR` path that the current Cloud Run deployment does not provide.
- Worker `/health` includes `xometry_session_age_days` from PR #231 for preflight session checks.

Commercial-access and Stripe foundations exist, but they are not the current
product promise. Customer surfaces describe a free, invitation-only Founding
Beta and provide no new-subscription Checkout or approved price. An automatic-
quote entitlement is only a technical access signal; it does not prove beta
enrollment. `OVD-361` owns the separate audited enrollment and policy-acceptance
boundary, and `OVD-362` owns the exact Xometry disclosure permit. Existing
Stripe subscribers retain a verified Billing Portal path to manage or cancel
their subscription. New Checkout remains server-disabled while pricing and
packaging stay unapproved 1.1 hypotheses.

The app publishes Founding Beta Terms and Privacy/data-handling revision
`founding-beta-2026-08-15` at `/legal/beta-terms` and `/legal/privacy`, with
`blaineswilson@gmail.com` as the support, privacy, security, and withdrawal
route. External proprietary-part testing remains blocked until the enrollment,
notice-acceptance, upload-enforcement, and disclosure gates in
[`docs/1-0-beta-runbook.md`](docs/1-0-beta-runbook.md) are deployed and
verified. The former public validation pair has been retired from the
application and must not be restored from repository history. `OVD-359`
records approval of a different, sanitized native STEP/PDF package for
Xometry-only disclosure. That package remains private; its exact identity and
outbound scope live in an access-controlled artifact and are never fixture or
build inputs.

Manufacturing card collection, order discounts, automated supplier order placement, tax automation, and ERP/accounting integration remain deferred. For controlled tests, a local live worker is acceptable; unattended use still requires hosting the live worker on a long-lived platform.

## Favicon Verification

When checking a favicon change locally or after deploy:

```bash
npm run build
npm run preview
```

Then verify:

- `/favicon.ico`
- `/favicon-32x32.png`
- `/apple-touch-icon.png`

If the browser still shows an old icon, use a hard refresh or a fresh/private browser profile. Favicons are commonly cached independently from the page HTML.
