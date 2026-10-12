# OVD-611: Evidence Redaction Decisions and Remaining Gaps

Records what Xometry and Fictiv evidence capture uploads after OVD-611, and each
remaining DOM-redaction limit with its disposition. Parent issue: OVD-593.

## Decisions

### Screenshots: not captured

Xometry and Fictiv `capturePageArtifacts()` no longer call `page.screenshot()`.

- Full-page screenshots of logged-in portals show credentials, account identifiers,
  customer names, addresses, and pricing, and deterministic image masking does not exist.
- This matches the kernel policy: `providerPortalKernel.ts` documents "Image capture
  remains disabled until deterministic masking exists".
- Redacted HTML snapshots remain the debugging evidence.

Tests: `captures a live evaluation upload and instant quote ...` (Xometry) asserts
every artifact is an `html_snapshot`; `does not capture screenshots per OVD-611
evidence masking policy` exists in both `xometry.test.ts` and `fictiv.test.ts`.

### Playwright traces: discarded, never written or uploaded

When `PLAYWRIGHT_CAPTURE_TRACE=true` tracing still runs, but both adapters call
`browserContext.tracing.stop()` without a `path`. Playwright then discards the
recording: it is not added to `artifacts` and no `trace.zip` is left in the run
directory, including when a later step fails.

- `trace.zip` holds unredacted DOM snapshots and request headers, so it must not
  leave the worker, and there is no value in leaving it on the worker disk either.

Tests: the Xometry live-evaluation success test and the Fictiv instant-quote test run
with trace capture on and off. With it on they assert `tracing.stop` was called with
no path, no `trace` artifact or `trace.zip` path is returned, and no `trace.zip`
exists in the run directory. Each adapter also has a test for a run that ends early
(Xometry: failure; Fictiv: manual-review result) that checks the same.

### HTML snapshots: retained, redacted

HTML snapshots are still uploaded. Both adapters pass `page.content()` through
`redactProviderPortalHtml()` (`providerEvidenceRedaction.ts`, already on main) before
writing, and this PR does not change that. It strips scripts, textarea content, form
values, sensitive/structured attribute values, URL queries (including in custom
attributes such as `data-src`), bearer tokens, and JWT-shaped values, then applies
the shared identifier rules.

## DOM-redaction limits

### 1. Names and addresses in visible text: accepted

Customer names, company names, and addresses in visible text are not detected.
Detecting them needs semantic name/address recognition, which regex rules cannot do
reliably, and over-redacting would remove the page text selector diagnosis needs.
Revisit if deterministic PII detection is added to the shared module.

### 2. Account ID with a space after the separator: accepted

`redactProviderIdentifiers()` matches `(account|customer|order|quote)[^\r\n:#=]{0,24}[:#=][^\s]+`,
so `account id:ABC-123` is redacted but `account id: ABC-123` is not.
Allowing whitespace after the separator would also redact ordinary prose such as
`Quote: Total price ...` that selector diagnosis relies on, and this rule is shared by
every adapter, so the change is out of scope here. Changing it needs its own test
sweep across adapters.

### 3. Root-relative URLs with signed queries in custom attributes: closed

Closed by `redactProviderPortalHtml()` on main (`URL_VALUE` applies query stripping to
any attribute whose value is an absolute, protocol-relative, root-relative, or
dot-relative URL). Covered by `providerEvidenceRedaction.test.ts` (`data-full`,
`data-thumb`, `data-up`, and the directory-only `/?Signature=` cases).
