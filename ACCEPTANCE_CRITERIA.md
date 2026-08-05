# OverDrafter Acceptance Criteria

Last updated: July 29, 2026

## Purpose

This document defines what it means for the current repository-hardening phase to be complete.

## Acceptance criteria

### Feature addendum — Quote Intelligence web and iOS release

- Authenticated clients can navigate directly to Parts, Quotes, Search, and quote detail.
- Project remains the backend collaboration/procurement-workflow container and legacy Project/Part links remain compatible; Organization is the commercial account boundary.
- All/Parts/Assemblies is one filter control over the accessible artifact collection.
- Search updates while typing and explains structured engineering interpretations without using fabricated geometry.
- Quote detail presents request facts and supplier offers directly.
- Buyer comparison uses independent fixed-size points with working-day lead time on X and total quoted price on Y.
- The chart has no connecting, trend, or Pareto line, and chart/table selection remains synchronized.
- Missing quote validity, response time, estimate, or benchmark data is shown as unavailable or suppressed rather than inferred.
- Existing sign-in, upload, quote-request, cancel/retry, and offer-selection behavior remains functional.
- Signing out, switching accounts, or changing organization/role context cannot render cached workspace data from the prior access scope.
- The universal iPhone/iPad app exposes native Parts, Quotes, and Search destinations and reuses the authorized production workflow without embedding privileged credentials.
- Responsive web, iPhone, and iPad verification passes before release.
- Production website and TestFlight install links are smoke-tested against the release build.
- Product, architecture, design, test, and release documentation reflect the shipped behavior.

### Contract addendum — iOS browser authentication

- The versioned contract defines browser start, provider callback, browser
  completion, claimed HTTPS app callback, and app-web-store bootstrap.
- The app callback contains only an opaque handoff code and transaction state;
  access and refresh tokens never enter a callback URL or native persistence.
- Transaction-specific native state and PKCE S256 bind the callback and
  one-time bootstrap to the initiating app instance.
- Provider OAuth validation remains Supabase-owned; the website callback
  validates its browser transaction before exchanging the Supabase code with a
  ceremony-scoped PKCE verifier and never reuses the native handoff values or
  the website's persistent Supabase client.
- Handoff material contains at least 256 bits of entropy, expires within two
  minutes, and is single-use under serial and concurrent redemption.
- Shared-browser sign-in, ephemeral account switching, process death, external
  email verification/recovery, relaunch, local-session logout, and revocation
  behavior are explicit.
- Cancellation, expiry, replay, state mismatch, provider failure, network loss,
  and bootstrap failure have stable codes and retry behavior.
- The threat review covers browser/app storage separation, callback
  interception, token leakage, replay, CSRF, open redirects, cross-tenant
  access, stale subject data, and logging boundaries.
- Runtime, native UI, navigation, Ask OverDrafter, and standards-content
  acceptance remain with their owning issues rather than `OVD-220`.

### Historical MVP addendum — no-Stripe live quote path for `dmrifles@gmail.com`
- This delivered milestone remains regression context but is no longer the complete commercial product boundary.
- The existing `dmrifles@gmail.com` user can sign in to the target environment.
- `dmrifles@gmail.com` has a client membership in the target organization.
- The client user can upload supported CNC part files, including STEP/PDF packages.
- Uploaded parts appear in the client workspace without requiring internal-only navigation.
- STEP-backed parts receive a persistent isometric CAD preview tied to the current part and CAD file, with sketch styling used by default in collection thumbnails and matching local rendering retained as a fallback.
- The client user can request a quote from a part or project workspace.
- The request creates durable quote-request intent and worker queue records.
- A live worker can process the request with `WORKER_MODE=live` and a narrow `WORKER_LIVE_ADAPTERS` rollout.
- Xometry live runs use the Camoufox persistent-profile path unless a later validated path replaces it.
- The client UI shows quote lifecycle state and either a received quote result or explicit manual-follow-up/failure state.
- No Stripe, billing, card capture, or in-app order placement is required for this MVP.

### Commercial account and quote-mode addendum
- The commercial plan is owned by the organization, not by an individual user or membership role.
- Every organization resolves to either Free or Pro through a server-side effective-entitlement contract.
- Free users may upload parts and create projects without a customer-facing usage quota.
- A supported Free upload returns ranked potential providers, fit explanations, and official RFQ links without starting worker or operator work.
- Every sourcing result is explicitly one of: live offers available, provider recommendations available, or unsupported package.
- The same sourcing result is visible in the single-part workspace and for the selected part in a project workspace.
- Potential providers are never presented as returned quotes, and synthetic or stale prices are never labeled live.
- A live offer must come from a successful trusted Xometry or Fictiv live-adapter result and be no more than 14 days old; all other persisted offers fall back to recommendations.
- Pro adds the `automatic_quote_collection` entitlement.
- Automatic quote APIs independently enforce Pro and return a stable `pro_required` result when the UI is bypassed.
- Vendor authentication expiry, timeout, disabled adapters, and portal failures expose provider guidance rather than stranding the customer.
- Existing operational throttles and organization cost ceilings remain invisible safeguards, not plan quotas.
- Authorized billing admins may create and revoke audited trial and complimentary Pro grants under AAL2.
- Trial grants require an expiration. Complimentary grants require a reason and review date and may optionally expire.
- Self-service launch Pro costs $49/month through hosted Stripe Checkout.
- Eligible past-due Pro subscriptions retain Pro access for a seven-day grace period, then resolve to Free without affecting uploads or sourcing guidance.
- Stripe subscription and invoice facts are synchronized through signed, replay-safe webhooks before they affect access.
- Annual billing, coupons, promotion codes, procurement handoffs, orders, manufacturing payment collection, automated supplier order placement, tax automation, and ERP/accounting integration remain excluded.

### Feature addendum — Client-triggered quote requests
- A logged-in client user can request a quote from the part workspace for an uploaded part they can edit.
- A client user can request quotes for the ready parts in a project workspace without using an internal-only surface.
- Quote request creation is idempotent for active requests. Repeated clicks do not create uncontrolled duplicate active runs.
- The backend validates ownership, readiness, and required package prerequisites before queueing work.
- Client-triggered requests dispatch across the org-enabled vendors that are applicable to the current package.
- Quote request intent is persisted separately from quote run execution and vendor-specific result records.
- The worker picks up the queued work and starts vendor quote collection through the adapter boundary for each queued vendor lane.
- The client UI clearly shows quote request lifecycle state: `not requested`, `queued`, `requesting`, `received`, `failed`, or `canceled`.
- Cross-org users cannot request or inspect quote request state for jobs they do not own or cannot access.
- Relevant product, planning, architecture, and test documents are updated in the same change.

### Feature addendum — Supplier discovery foundation

- Instant-quote vendor adapters remain distinct from supplier-directory companies and facilities.
- Supplier records can preserve multiple facilities, capabilities, certifications, aliases, source records, and verification events.
- Geographic search is facility-based and does not assume a company has only one location.
- Imported historical records retain source and effective-date provenance and are not represented as currently verified by default.
- Customer-suggested suppliers can enter a candidate state without becoming published or verified automatically.
- Organic technical eligibility and match scoring are independent of paid placement.
- Any future paid placement is explicitly labeled and cannot make an ineligible supplier appear qualified.

### 1. Canonical root documentation
- `PRD.md` exists at repo root.
- `PLAN.md` exists at repo root.
- `ARCHITECTURE.md` exists at repo root.
- `TEST_STRATEGY.md` exists at repo root.
- `ACCEPTANCE_CRITERIA.md` exists at repo root.
- `README.md` points to the canonical docs.

### 2. Source-of-truth hierarchy is explicit
- The repo clearly states the hierarchy of truth.
- `AGENTS.md` names the hierarchy explicitly.

### 3. `AGENTS.md` is a real operating manual
- Root `AGENTS.md` is sufficient to guide an agent or contributor.
- It includes verification expectations.
- It includes package manager policy.
- It includes branch/worktree guidance.

### 4. Package and tooling ambiguity is removed
- One package manager is authoritative.
- The unused lockfile is removed.
- Standard local verification scripts are present and documented.

### 5. Local verification is standardized
- Lint is runnable locally.
- Typecheck is runnable locally.
- Tests are runnable locally.
- Build is runnable locally.

### 6. CI is stronger than build-only validation
- CI runs more than just a basic build.
- CI includes the key static checks and automated verification expected by the repo.

### 7. Testing policy is explicit and enforceable
- The repo defines when tests are expected by change type.
- Bug fixes require tests when practical.
- Behavior-changing changes require test evidence or an explicit rationale for omission.

### 8. PR discipline is standardized
- A PR template exists.
- The template requests problem, scope, verification evidence, and risk notes.

### 9. Branch and worktree discipline is documented
- The repo states when worktrees should be used.
- Branch naming conventions are documented.
- Nontrivial work is expected to happen in isolated branches or worktrees.
