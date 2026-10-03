// @vitest-environment node

import { describe, expect, it } from "vitest";
import { redactProviderPortalHtml, scrubProviderEvidenceText } from "./providerEvidenceRedaction";
import { scrubProviderEvidenceText as kernelScrub } from "./providerPortalKernel";

const LOGGED_IN_HTML = `<!doctype html>
<html>
<head>
  <meta name="csrf-token" content="csrf-9f8e7d6c">
  <script>window.__STATE__ = {"accessToken":"eyJhbGciOiJIUzI1NiJ9.payload.sig","user":{"email":"buyer@acme.example"}};</script>
  <script src="/static/app.js?v=1&amp;session=abc"></script>
</head>
<body class="quote-page">
  <div data-user-id="user-42" data-testid="part-row">Bracket</div>
  <input type="hidden" name="authenticity" value="hidden-form-secret">
  <img src="https://cdn.example/thumbnail.png?X-Amz-Signature=signedvalue#frag" alt="thumb">
  <a href="/quoting/quote/Q00-1?token=link-token">Open</a>
  <p>Contact buyer@acme.example or +1 (555) 123-4567. session=plain-session-value</p>
  <p>account id:ACCT-7781 trace ${"a".repeat(40)}</p>
</body>
</html>`;

describe("redactProviderPortalHtml", () => {
  const redacted = redactProviderPortalHtml(LOGGED_IN_HTML);

  it("removes session, token, and account material from a logged-in DOM", () => {
    for (const secret of [
      "csrf-9f8e7d6c",
      "eyJhbGciOiJIUzI1NiJ9",
      "buyer@acme.example",
      "user-42",
      "hidden-form-secret",
      "signedvalue",
      "link-token",
      "555) 123-4567",
      "plain-session-value",
      "ACCT-7781",
      "a".repeat(40),
    ]) {
      expect(redacted).not.toContain(secret);
    }
  });

  it("keeps markup structure useful for selector diagnosis", () => {
    expect(redacted).toContain("<body class=\"quote-page\">");
    expect(redacted).toContain("data-testid=\"part-row\"");
    expect(redacted).toContain("src=\"https://cdn.example/thumbnail.png\"");
    expect(redacted).toContain("href=\"/quoting/quote/Q00-1\"");
    expect(redacted).toContain("<script data-overdrafter-redacted=\"script\"></script>");
    expect(redacted).toContain("\n");
  });
});

describe("scrubProviderEvidenceText", () => {
  it("is the same function the portal kernel exports", () => {
    expect(kernelScrub).toBe(scrubProviderEvidenceText);
  });
});
