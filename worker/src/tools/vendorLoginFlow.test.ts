// @vitest-environment node

import type { BrowserContext, Route } from "playwright";
import { describe, expect, it, vi } from "vitest";
import { confirmStorageState } from "./vendorLoginFlow";
import { resolveVendorSessionProfile } from "./vendorSession";

// Drive the real guard through its document route without launching Chromium.
// Browser tests separately prove that Chromium enforces the delivered policy.
async function guardDocument(options: { status?: number; child?: boolean; fetchFails?: boolean } = {}) {
  let handler: (route: Route) => Promise<void>;
  const response = {
    status: () => options.status ?? 200,
    headers: () => ({ "content-security-policy": "script-src 'self'", location: "https://unreviewed.example.test/" }),
    body: async () => Buffer.from("<html>synthetic portal</html>"),
    dispose: vi.fn(async () => undefined),
  };
  const mainFrame = {};
  const page = {
    mainFrame: () => mainFrame,
    url: () => "about:blank",
    goto: async () => {
      await handler(route as unknown as Route);
      throw new Error("fixture ends after document handling");
    },
  };
  const route = {
    request: () => ({
      url: () => "https://quickquote.quickparts.com/",
      isNavigationRequest: () => true,
      method: () => "GET",
      frame: () => options.child ? { page: () => page } : mainFrame,
    }),
    fetch: vi.fn(async () => {
      if (options.fetchFails) throw new Error("fixture transport failed");
      return response;
    }),
    fulfill: vi.fn(async () => undefined),
    abort: vi.fn(async () => undefined),
    fallback: vi.fn(async () => undefined),
  };
  const context = {
    newPage: async () => page,
    on: () => undefined,
    route: async (_url: string, callback: typeof handler) => { handler = callback; },
    routeWebSocket: async () => undefined,
  } as unknown as BrowserContext;
  await confirmStorageState({ profile: resolveVendorSessionProfile("quickparts"), context });
  return { route, response };
}

describe("login document worker containment", () => {
  it.each([false, true])("delivers worker refusal alongside the existing CSP (child frame: %s)", async (child) => {
    const { route, response } = await guardDocument({ child });
    expect(route.fetch).toHaveBeenCalledWith({ maxRedirects: 0, maxRetries: 0 });
    expect(route.fulfill).toHaveBeenCalledWith({
      status: 200,
      headers: { "content-security-policy": "script-src 'self', worker-src 'none'", location: "https://unreviewed.example.test/" },
      body: Buffer.from("<html>synthetic portal</html>"),
    });
    expect(route.fallback).not.toHaveBeenCalled();
    expect(response.dispose).toHaveBeenCalledOnce();
  });

  it.each([301, 302, 303, 307, 308])("refuses a %s document redirect without following it", async (status) => {
    const { route } = await guardDocument({ status });
    expect(route.fetch).toHaveBeenCalledWith({ maxRedirects: 0, maxRetries: 0 });
    expect(route.abort).toHaveBeenCalledWith("blockedbyclient");
    expect(route.fulfill).not.toHaveBeenCalled();
    expect(route.fallback).not.toHaveBeenCalled();
  });

  it("refuses the document when its policy cannot be installed", async () => {
    const { route } = await guardDocument({ fetchFails: true });
    expect(route.abort).toHaveBeenCalledWith("blockedbyclient");
    expect(route.fulfill).not.toHaveBeenCalled();
    expect(route.fallback).not.toHaveBeenCalled();
  });
});
