// @vitest-environment node

import { describe, expect, it } from "vitest";

import {
  createProviderManifest,
  deriveProviderKey,
  deriveRegistrableDomain,
  normalizeProviderUrl,
  validateProviderManifest,
} from "./provider-manifest.mjs";

const SECRET_VALUE_SHAPES = Object.freeze({
  jwt: "eyJhbGciOiJIUzI1NiJ9xx",
  akia: "AKIAIOSFODNN7EXAMPLE",
  ghp: "ghp_01234567890123456789",
  openai: "sk-abcdefghijklmnopqrstuv",
  entropy: "n7Q2vL9xR4mP8wK3tY6bC1hF5jD0sA2u",
  hex32: "0123456789abcdef0123456789abcdef",
});

describe("provider hostname identity", () => {
  it("derives a stable registrable identity from an application subdomain", () => {
    expect(deriveRegistrableDomain("app.shopname.com")).toBe("shopname.com");
    expect(normalizeProviderUrl("https://app.shopname.com/quote/new")).toBe("https://shopname.com/");
    expect(deriveProviderKey("https://app.shopname.com/quote/new")).toBe("shopname");
  });

  it("supports common multi-label public suffixes", () => {
    expect(deriveRegistrableDomain("quote.shopname.co.uk")).toBe("shopname.co.uk");
    expect(deriveProviderKey("https://quote.shopname.com.au/")).toBe("shopname");
  });

  it.each([
    "https://shopname.localhost/",
    "https://portal.shopname.local/",
    "https://shopname.internal/",
    "https://10.0.0.1/",
    "https://127.0.0.1/",
    "https://[::1]/",
  ])("rejects local-use or private hostname %s", (url) => {
    expect(() => normalizeProviderUrl(url)).toThrow("unsafe provider domain");
  });

  it("rejects an unrecognized country-code multi-label suffix instead of guessing", () => {
    expect(() => deriveRegistrableDomain("quote.shopname.com.de")).toThrow(
      "ambiguous multi-label public suffix",
    );
  });
});

describe("provider capability bounds", () => {
  it("preserves deterministic code-unit ordering for canonical manifest arrays", () => {
    const manifest = createProviderManifest({
      key: "shopname",
      displayName: "Shopname",
      officialUrl: "https://shopname.com/",
    });
    manifest.capabilityEnvelope.processes = {
      status: "supported",
      values: ["a-b", "a_b"],
    };

    expect(validateProviderManifest(manifest)).toBe(manifest);
    manifest.capabilityEnvelope.processes.values.reverse();
    expect(() => validateProviderManifest(manifest)).toThrow("must be sorted");
  });

  it.each([
    ["quantity", "minimum", "maximum"],
    ["tolerance", "minimumMm", "maximumMm"],
  ])("rejects reversed %s bounds", (field, minimumKey, maximumKey) => {
    const manifest = createProviderManifest({
      key: "shopname",
      displayName: "Shopname",
      officialUrl: "https://shopname.com/",
    });
    manifest.capabilityEnvelope[field] = {
      status: "supported",
      [minimumKey]: 10,
      [maximumKey]: 2,
    };

    expect(() => validateProviderManifest(manifest)).toThrow("must not exceed");
  });

  it("accepts equal or increasing supported bounds", () => {
    const manifest = createProviderManifest({
      key: "shopname",
      displayName: "Shopname",
      officialUrl: "https://shopname.com/",
    });
    manifest.capabilityEnvelope.quantity = { status: "supported", minimum: 1, maximum: 1 };
    manifest.capabilityEnvelope.tolerance = { status: "supported", minimumMm: 0.01, maximumMm: 0.1 };

    expect(validateProviderManifest(manifest)).toBe(manifest);
  });
});

describe("provider manifest secret-value scan", () => {
  function shopnameManifest() {
    return createProviderManifest({
      key: "shopname",
      displayName: "Shopname",
      officialUrl: "https://shopname.com/",
    });
  }

  it.each(Object.entries(SECRET_VALUE_SHAPES))(
    "rejects a %s token in displayName, URLs, and other string fields",
    (_shape, token) => {
      const displayName = shopnameManifest();
      displayName.displayName = token;
      expect(() => validateProviderManifest(displayName)).toThrow("secret-value-like string");

      const officialUrl = shopnameManifest();
      officialUrl.official.urls = [`https://shopname.com/${token}`];
      expect(() => validateProviderManifest(officialUrl)).toThrow("secret-value-like string");

      const evidenceUrl = shopnameManifest();
      evidenceUrl.evidence.firstPartyUrls = [`https://shopname.com/docs/${token}`];
      evidenceUrl.evidence.reviewedAt = "2026-09-28";
      expect(() => validateProviderManifest(evidenceUrl)).toThrow("secret-value-like string");

      const processFamily = shopnameManifest();
      processFamily.integration.processFamily = token;
      expect(() => validateProviderManifest(processFamily)).toThrow("secret-value-like string");
    },
  );
});
