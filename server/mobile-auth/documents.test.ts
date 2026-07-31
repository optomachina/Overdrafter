// @vitest-environment node

import { describe, expect, it } from "vitest";
import { createMobileAuthBrowserBinding } from "./cookies";
import {
  createMobileAuthStorageNamespace,
  escapeMobileAuthInertJson,
  renderMobileAuthBootstrapFailureDocument,
  renderMobileAuthBootstrapSuccessDocument,
  renderMobileAuthCeremonyDocument,
  renderMobileAuthProviderCallbackDocument,
  renderMobileAuthRecoveryDocument,
} from "./documents";
import { encodeCanonicalBase64Url } from "./crypto";

function ceremonyConfig() {
  const binding = createMobileAuthBrowserBinding();

  return {
    storageNamespace: createMobileAuthStorageNamespace(binding.transactionId),
    csrf: binding.csrf,
    supabaseUrl: "https://project.supabase.co",
    supabasePublishableKey: "publishable-test-key",
    providerCallbackUrl: `https://app.example.com/auth/mobile/provider-callback?cb=${binding.transactionId}`,
    completeUrl: "https://app.example.com/auth/mobile/complete",
  };
}

const state = encodeCanonicalBase64Url(new Uint8Array(32).fill(1));

describe("mobile-auth HTML documents", () => {
  it("renders the fixed ceremony DOM against only the dedicated same-origin bundle", () => {
    const document = renderMobileAuthCeremonyDocument(ceremonyConfig());

    expect(document.body).toContain('id="overdrafter-mobile-auth-config"');
    expect(document.body).toContain("data-mobile-auth-password-form");
    expect(document.body).toContain('name="email"');
    expect(document.body).toContain('name="password"');
    expect(document.body).toContain('data-mobile-auth-action="sign-in"');
    expect(document.body).toContain('data-mobile-auth-action="sign-up"');
    expect(document.body).toContain("data-mobile-auth-interactive disabled");
    expect(document.body).toContain("/?auth=forgot-password");
    expect(document.body).toContain("<noscript>");
    expect(document.body).toContain('data-mobile-auth-provider="google"');
    expect(document.body).toContain('data-mobile-auth-provider="azure"');
    expect(document.body).toContain('data-mobile-auth-provider="apple"');
    expect(document.body).toContain('class="mobile-auth-card"');
    expect(document.body).toContain("<style nonce=");
    expect(document.body).toContain('src="/assets/mobile-auth.js"');
    expect(document.body).not.toContain("src=\"http");
    expect(document.body).not.toContain("src/pages/AuthCallback");
    expect(document.body).not.toContain("src/integrations/supabase/client");
  });

  it("removes provider callback history before loading the ceremony bundle", () => {
    const document = renderMobileAuthProviderCallbackDocument(ceremonyConfig(), {
      mode: "code",
      code: "pkce-code",
    });

    const replaceIndex = document.body.indexOf("history.replaceState");
    const moduleIndex = document.body.indexOf('src="/assets/mobile-auth.js"');

    expect(replaceIndex).toBeGreaterThan(-1);
    expect(moduleIndex).toBeGreaterThan(replaceIndex);
    expect(document.body).toContain('"mode":"code"');
    expect(document.headers["Referrer-Policy"]).toBe("no-referrer");
  });

  it("requires one canonical transaction binding on the provider callback URL", () => {
    const config = ceremonyConfig();

    expect(() =>
      renderMobileAuthCeremonyDocument({
        ...config,
        providerCallbackUrl:
          "https://app.example.com/auth/mobile/provider-callback",
      }),
    ).toThrow();
    expect(() =>
      renderMobileAuthCeremonyDocument({
        ...config,
        providerCallbackUrl: `${config.providerCallbackUrl}&next=https://evil.example`,
      }),
    ).toThrow();
  });

  it("escapes token and callback values as inert JSON instead of executable source", () => {
    const attack = "</script><script>alert(1)</script>";
    const document = renderMobileAuthBootstrapSuccessDocument({
      state,
      returnTo: "/quotes",
      accessToken: `access${attack}`,
      refreshToken: `refresh${attack}`,
      supabaseUrl: "https://project.supabase.co",
    });

    expect(document.body).not.toContain(attack);
    expect(document.body).toContain("\\u003c/script\\u003e");
    expect(document.body).toContain(
      'id="overdrafter-mobile-auth-bootstrap-config"',
    );
    expect(document.body).toContain('src="/assets/mobile-bootstrap.js"');
    expect(escapeMobileAuthInertJson({ value: attack })).not.toContain("</script>");
  });

  it("renders the fixed bootstrap success and error config unions", () => {
    const success = renderMobileAuthBootstrapSuccessDocument({
      state,
      returnTo: "/parts/part-1",
      accessToken: "access-token",
      refreshToken: "refresh-token",
      supabaseUrl: "https://project.supabase.co",
    });
    const failure = renderMobileAuthBootstrapFailureDocument({
      state,
      code: "mobile_auth_expired",
      retry: "restart",
      supabaseUrl: "https://project.supabase.co",
    });

    expect(success.body).toContain(
      `"version":1,"state":"${state}","returnTo":"/parts/part-1"`,
    );
    expect(success.body).not.toContain('"status":"ready"');
    expect(success.body).toContain(
      '"session":{"accessToken":"access-token","refreshToken":"refresh-token"}',
    );
    expect(failure.body).toContain(
      '"error":{"code":"mobile_auth_expired","retry":"restart"}',
    );
  });

  it("uses a fresh nonce per scripted response and a script-free recovery page", () => {
    const first = renderMobileAuthCeremonyDocument(ceremonyConfig());
    const second = renderMobileAuthCeremonyDocument(ceremonyConfig());
    const recovery = renderMobileAuthRecoveryDocument();

    expect(first.headers["Content-Security-Policy"]).not.toBe(
      second.headers["Content-Security-Policy"],
    );
    expect(recovery.body).not.toContain("<script");
    expect(recovery.headers["Content-Security-Policy"]).toContain(
      "script-src 'none'",
    );
  });
});
