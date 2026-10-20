import { afterEach, describe, expect, it, vi } from "vitest";
import { isQuoteProviderNotesEnabled } from "./quote-provider-notes-flag";

describe("isQuoteProviderNotesEnabled", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("is off unless explicitly set to 1", () => {
    expect(isQuoteProviderNotesEnabled(undefined)).toBe(false);
    expect(isQuoteProviderNotesEnabled("")).toBe(false);
    expect(isQuoteProviderNotesEnabled("0")).toBe(false);
    expect(isQuoteProviderNotesEnabled("true")).toBe(false);
    expect(isQuoteProviderNotesEnabled("1")).toBe(true);
  });

  it("reads VITE_ENABLE_QUOTE_PROVIDER_NOTES by default", () => {
    vi.stubEnv("VITE_ENABLE_QUOTE_PROVIDER_NOTES", "");
    expect(isQuoteProviderNotesEnabled()).toBe(false);
    vi.stubEnv("VITE_ENABLE_QUOTE_PROVIDER_NOTES", "1");
    expect(isQuoteProviderNotesEnabled()).toBe(true);
  });
});
