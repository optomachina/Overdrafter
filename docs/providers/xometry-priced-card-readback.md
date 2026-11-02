# Experimental Xometry priced-card read-back (OVD-1094)

`XOMETRY_PRICED_CARD_READBACK_ENABLED` defaults to false. No deployment or environment setting is changed by this PR. The existing October capture has no printed quantity in its discount summaries; enabling this experiment against that layout refuses prices. Activation requires separately authorized real-capture qualification. The added quantity fixtures are synthetic contracts, not provider evidence.

When enabled, every tier card must have one visible discount summary containing a separate quantity child. Quantity and price in one child are ambiguous. Two reads 250 ms apart must agree exactly, with one retry. Empty/hidden summaries refuse. Card count and SHA-256 of each complete trimmed card text must match the parser-produced offers in order, so a price change after collection refuses. Every offer uses its own stated quantity; no requested/page quantity fallback supplies it. Multi-piece unit and total prices must both be observed.

Only whole `Qty N`, `Quantity: N`, and optional `pc`/`pcs` lines are exempt from unknown-line rejection. Mixed prose, minimum quantities, and lot/set descriptions remain unknown lines.

Rollback: leave the flag false, or disable it before reverting the PR. No migration or provider operation is involved.

Review scope: the generic provider-contract quantity fallback remains legacy normalization metadata, not an input to this admission helper. It does not establish independent printed quantity evidence. The public `PageQuantity` structural type remains a known minor API-hardening follow-up; the live helper always constructs its own DOM read and never accepts caller-supplied page provenance. The raw-text parser rejects CR; browser HTML parsing normalizes CRLF, so the Chromium CRLF row is a rendering case, not evidence of exercising that raw guard.
