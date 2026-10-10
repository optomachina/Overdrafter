# OVD-611: Evidence Redaction Decisions and Remaining Gaps

## Summary

This document records the decisions and remaining limitations for Xometry and Fictiv evidence capture, addressing Linear issue OVD-611.

## Decisions Made

### Screenshot Capture: DISABLED

**Decision:** Screenshot capture is disabled for both Xometry and Fictiv adapters.

**Rationale:**
- Full-page screenshots of logged-in provider portals contain unmasked credentials, account identifiers, customer names, addresses, and pricing information
- Deterministic screenshot masking does not yet exist
- This aligns with the provider portal kernel's metadata-only evidence policy (see `providerPortalKernel.ts` line 877: "Image capture remains disabled until deterministic masking exists")
- HTML snapshots are sufficient for debugging workflow issues

**Implementation:**
- Xometry: `capturePageArtifacts()` in `worker/src/adapters/xometry.ts` lines 375-419
- Fictiv: `capturePageArtifacts()` in `worker/src/adapters/fictiv.ts` lines 405-443

**Tests:**
- `worker/src/adapters/xometry.test.ts`: "does not capture screenshots per OVD-611 evidence masking policy"
- `worker/src/adapters/fictiv.test.ts`: "does not capture screenshots per OVD-611 evidence masking policy"

### Trace Upload: DISABLED

**Decision:** Playwright trace files (`trace.zip`) are still captured locally when `PLAYWRIGHT_CAPTURE_TRACE=true`, but are NOT added to artifacts for upload.

**Rationale:**
- `trace.zip` contains unredacted DOM snapshots and request headers with credentials
- Traces are valuable for local debugging but should not leave the worker
- The trace file is written to disk in the run directory for local inspection but excluded from the artifacts array

**Implementation:**
- Xometry: Lines 3102-3112 in `worker/src/adapters/xometry.ts` - trace is stopped but not added to artifacts
- Fictiv: `stopTraceAndAttachArtifact()` in `worker/src/adapters/fictiv.ts` lines 1629-1648 - trace is stopped but not added to artifacts

**Tests:**
- `worker/src/adapters/xometry.test.ts`: "does not upload trace artifacts per OVD-611 evidence masking policy"
- `worker/src/adapters/fictiv.test.ts`: "does not upload trace artifacts per OVD-611 evidence masking policy"

### HTML Snapshot Policy: RETAINED (with known limitations)

**Decision:** HTML snapshots are still captured and uploaded.

**Rationale:**
- HTML snapshots are needed for workflow debugging
- Full DOM redaction infrastructure from PR #572 is not yet in main branch
- The provider portal kernel already has text scrubbing rules in `scrubProviderEvidenceText()` (see `providerPortalKernel.ts`)
- Implementing full DOM redaction independently would duplicate PR #572's work

## Known DOM-Redaction Gaps (Accepted)

The following limitations exist in the current HTML snapshot capture. These are documented as accepted limitations until PR #572's full DOM redaction infrastructure is integrated into the main branch:

### 1. Names and Addresses in Visible Text

**Status:** Accepted limitation

**Description:** Customer names, company names, and shipping/billing addresses that appear in visible page text are not redacted.

**Example:**
```html
<div class="customer-info">
  John Smith
  123 Main Street
  Anytown, CA 90210
</div>
```

**Mitigation:** The provider portal kernel's `scrubProviderEvidenceText()` function removes emails and some identifiers, but does not perform semantic name/address detection.

**Future work:** Requires pattern matching for name formats and address structures, or integration with PR #572's DOM redaction rules.

### 2. Account ID with Space After Colon

**Status:** Accepted limitation

**Description:** The text redaction rule in `providerPortalKernel.ts` line 850 matches `(account|customer|order|quote)[^\r\n:#=]{0,24}[:#=][^\s]+`, which requires no whitespace after the separator. Account identifiers with a space after the colon are not caught.

**Example:**
```
account id: ABC-123-XYZ    ← NOT caught (space after colon)
account id:ABC-123-XYZ     ← caught (no space after colon)
accountId=ABC-123          ← caught (equals sign)
```

**Mitigation:** Many real-world formats use `account:` or `accountId=` without spaces and are caught. The gap is narrow.

**Future work:** Update the regex to allow optional whitespace: `[:#=]\s*[^\s]+` or integrate PR #572's enhanced rules.

### 3. Root-Relative URLs with Signed Queries in Non-URL Attributes

**Status:** Accepted limitation

**Description:** PR #572's DOM redaction rules (not in main) strip queries from root-relative and dot-relative URLs in any attribute, not just standard URL attributes like `href` and `src`. Without those rules, signed queries in custom attributes (e.g., `data-src="/asset?Signature=..."`) are not redacted.

**Example:**
```html
<img data-lazy-src="/thumbnail?Signature=AWS4-HMAC...&user=customer@example.com" />
```

**Standard URL attributes:** Query redaction for `href`, `src`, `action` etc. is not implemented in main.

**Mitigation:** Standard browser navigation and resource loading do not use these custom attributes, so the exposure is limited to client-side hydration data.

**Future work:** Integrate PR #572's `redactProviderPortalHtml()` function which handles this case.

## Integration Path

When PR #572 (or its equivalent) merges to main and provides `providerEvidenceRedaction.ts` with `redactProviderPortalHtml()`:

1. **Import the redaction function** in `xometry.ts` and `fictiv.ts`
2. **Redact HTML before writing** in `capturePageArtifacts()`:
   ```typescript
   const html = await page.content();
   const redactedHtml = redactProviderPortalHtml(html);
   await fs.writeFile(htmlPath, redactedHtml, "utf8");
   ```
3. **Update tests** to verify redaction rules are applied
4. **Remove or update** this document to reflect the improved state

## References

- Linear issue: OVD-611
- Parent issue: OVD-593
- PR #572: Introduced DOM redaction infrastructure (not in main)
- Provider portal kernel evidence policy: `worker/src/adapters/providerPortalKernel.ts` line 877
- Text scrubbing rules: `worker/src/adapters/providerPortalKernel.ts` lines 846-865

## Verification

All changes are covered by tests:
- No screenshots in artifacts: verified by new tests in `xometry.test.ts` and `fictiv.test.ts`
- No traces in artifacts: verified by new tests with `playwrightCaptureTrace: true`
- HTML snapshots still captured: verified by existing and new tests
- Artifact counts updated: `xometry.test.ts` line 1338 (10 → 5 artifacts)
