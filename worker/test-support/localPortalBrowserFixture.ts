import type { Browser, BrowserContext, Route } from "playwright";
import { expect } from "vitest";

export type LocalPortalServed = { pages: Record<string, string> };
export type LocalPortalObserved = { requests: string[]; uploads: Buffer[] };

/**
 * Answers kernel `continue` locally and records every request. Shared by the
 * stacked production-portal browser fixtures so each provider file keeps only
 * its locator table, hosts, and assertions.
 */
export function createLocalPortalBrowser(browser: Browser, served: LocalPortalServed, observed: LocalPortalObserved): Browser {
  return {
    newContext: async (options?: Parameters<Browser["newContext"]>[0]) => {
      const context: BrowserContext = await browser.newContext(options);
      const route = context.route.bind(context);
      context.route = (async (url: string, handler: (route: Route) => Promise<void>) =>
        route(url, async (real: Route) => {
          observed.requests.push(`${real.request().method()} ${real.request().url()}`);
          const local = new Proxy(real, {
            get(target, property) {
              if (property === "continue") {
                return async () => {
                  const requestUrl = new URL(target.request().url());
                  if (requestUrl.pathname === "/api/upload") {
                    observed.uploads.push(target.request().postDataBuffer() ?? Buffer.alloc(0));
                    return target.fulfill({ status: 200, body: "{}" });
                  }
                  const body = served.pages[`${requestUrl.host}${requestUrl.pathname}`];
                  return body === undefined
                    ? target.fulfill({ status: 404, body: "" })
                    : target.fulfill({ status: 200, contentType: "text/html", body });
                };
              }
              const value = Reflect.get(target, property, target);
              return typeof value === "function" ? value.bind(target) : value;
            },
          });
          await handler(local);
        })) as BrowserContext["route"];
      return context;
    },
    close: async () => undefined,
  } as unknown as Browser;
}

export function expectOnlyHostContacted(observed: LocalPortalObserved, host: string) {
  expect(observed.requests.length).toBeGreaterThan(0);
  for (const request of observed.requests) {
    expect(new URL(request.split(" ")[1]).host).toBe(host);
  }
}

export const PRODUCTION_PORTAL_BROWSER_TIMEOUT_MS = 60_000;

export function sandboxedChromiumLaunchOptions() {
  return {
    chromiumSandbox: true as const,
    channel: process.env.CI === "true" && !process.env.OVD_TEST_CHROMIUM_EXECUTABLE_PATH ? "chrome" as const : undefined,
    executablePath: process.env.OVD_TEST_CHROMIUM_EXECUTABLE_PATH || undefined,
  };
}
