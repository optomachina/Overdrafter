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

  it("removes secrets that neither an attribute name nor the text rules recognize", () => {
    const html = `<html><head>
  <script>window.__BOOT__={"csrf":"plain_script_secret_value"}</script>
  <style>.hero{background:url(https://cdn.example/hero.png?Expires=1&Signature=stylesig)}</style>
</head><body>
  <div data-page="{&quot;auth&quot;:{&quot;jwt&quot;:&quot;entity_json_secret&quot;}}" class="[&>svg]:size-4">Part</div>
  <div data-props='{"accessToken":"tok_LIVE_abcdef123456"}' data-test-target="quote-row">Row</div>
  <div style="background-image: url(&quot;https://cdn.example/bg.png?Signature=cfsig&amp;Policy=cfpolicy&quot;)">Hero</div>
  <pre>authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJlX3ZhbHVl</pre>
  <pre>Authorization: Bearer opaque_bearer_secret</pre>
  <span data-hint="ref eyJhbGciOiJub25lIn0.eyJzdWIiOiIyIn0.">Hint</span>
  <textarea name="notes" rows="2">api_key=sk_live_textarea_secret</textarea>
</body></html>`;
    const output = redactProviderPortalHtml(html);
    for (const secret of [
      "plain_script_secret_value",
      "stylesig",
      "entity_json_secret",
      "tok_LIVE_abcdef123456",
      "cfsig",
      "cfpolicy",
      "eyJzdWIiOiIxIn0",
      "c2lnbmF0dXJlX3ZhbHVl",
      "opaque_bearer_secret",
      "eyJzdWIiOiIyIn0",
      "sk_live_textarea_secret",
    ]) {
      expect(output).not.toContain(secret);
    }
    expect(output).toContain("class=\"[&>svg]:size-4\"");
    expect(output).toContain("data-test-target=\"quote-row\"");
    expect(output).toContain("url(https://cdn.example/hero.png)");
    expect(output).toContain("<textarea name=\"notes\" rows=\"2\"></textarea>");
  });

  it("stays linear on long runs of sensitive-looking attribute names", () => {
    const pathological = ` ${"token".repeat(40_000)} ${"user-".repeat(40_000)}x`;
    const started = performance.now();
    expect(redactProviderPortalHtml(pathological)).toContain("token");
    // The previous alternation pattern backtracked quadratically here (seconds).
    expect(performance.now() - started).toBeLessThan(2_000);
  });
});

describe("scrubProviderEvidenceText", () => {
  it("is the same function the portal kernel exports", () => {
    expect(kernelScrub).toBe(scrubProviderEvidenceText);
  });
});
