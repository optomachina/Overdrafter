// @vitest-environment node

import { describe, expect, it } from "vitest";
import type { MobileAuthMasterKeyring } from "./contract";
import {
  constantTimeCsrfMatch,
  createBrowserBindingLookupCandidates,
  createMobileAuthBindingDigests,
  createMobileAuthBrowserBinding,
  createRateLimitDigest,
  readMobileAuthCookie,
  serializeExpiredMobileAuthCookie,
  serializeMobileAuthCookie,
  verifyMobileAuthBrowserBinding,
  verifyMobileAuthCsrf,
} from "./cookies";

const keyring: MobileAuthMasterKeyring = {
  currentVersion: 1,
  keys: [{ version: 1, key: new Uint8Array(32).fill(9) }],
};

describe("mobile-auth browser binding", () => {
  it("sets a host-only secure HttpOnly cookie with the contract lifetime", () => {
    const binding = createMobileAuthBrowserBinding();
    const serialized = serializeMobileAuthCookie(binding);

    expect(serialized).toContain("__Host-ovd-mobile-auth=v1.");
    expect(serialized).toContain("Path=/");
    expect(serialized).toContain("Max-Age=600");
    expect(serialized).toContain("Secure");
    expect(serialized).toContain("HttpOnly");
    expect(serialized).toContain("SameSite=Lax");
    expect(serialized).not.toContain("Domain=");
    expect(serializeExpiredMobileAuthCookie()).toContain("Max-Age=0");
  });

  it("round-trips the target cookie and rejects duplicates", () => {
    const binding = createMobileAuthBrowserBinding();
    const cookiePair = serializeMobileAuthCookie(binding).split(";")[0];

    expect(readMobileAuthCookie(`other=value; ${cookiePair}`)).toEqual({
      transactionId: binding.transactionId,
      browserSecret: binding.browserSecret,
    });
    expect(() =>
      readMobileAuthCookie(`${cookiePair}; ${cookiePair}`),
    ).toThrow();
  });

  it("stores only purpose-separated browser and CSRF digests", () => {
    const binding = createMobileAuthBrowserBinding();
    const digests = createMobileAuthBindingDigests(keyring, binding);
    const cookie = {
      transactionId: binding.transactionId,
      browserSecret: binding.browserSecret,
    };

    expect(verifyMobileAuthBrowserBinding(keyring, digests.browser, cookie)).toBe(true);
    expect(
      verifyMobileAuthCsrf(keyring, digests.csrf, binding.transactionId, binding.csrf),
    ).toBe(true);
    expect(
      verifyMobileAuthCsrf(
        keyring,
        digests.csrf,
        binding.transactionId,
        createMobileAuthBrowserBinding().csrf,
      ),
    ).toBe(false);
    expect(createBrowserBindingLookupCandidates(keyring, cookie)).toHaveLength(1);
    expect(digests.browser.digest).not.toBe(digests.csrf.digest);
  });

  it("supports constant-time CSRF comparison and keyed rate-limit identifiers", () => {
    const binding = createMobileAuthBrowserBinding();

    expect(constantTimeCsrfMatch(binding.csrf, binding.csrf)).toBe(true);
    expect(
      constantTimeCsrfMatch(binding.csrf, createMobileAuthBrowserBinding().csrf),
    ).toBe(false);
    expect(createRateLimitDigest(keyring, "203.0.113.1").purpose).toBe("rate-limit");
    expect(() => createRateLimitDigest(keyring, "line\nbreak")).toThrow();
  });
});
