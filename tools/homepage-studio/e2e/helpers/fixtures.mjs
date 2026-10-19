// Shared Playwright fixtures: isolated studio servers per test, the static page server per worker, and an
// automatic guard that fails any test which (a) requests a host other than 127.0.0.1 or (b) logs a console
// error / page error that is not on the allow-list.
import { test as base, expect } from "@playwright/test";
import { startLocalStudio, startHostedStudio } from "./studio-server.mjs";
import { startStaticServer } from "./static-server.mjs";
import { StudioPage } from "./studio-page.mjs";

/** Console errors that are always allowed. Keep this list short and explained. */
export const BASE_CONSOLE_ALLOW = [
  // Chromium's own advisory for a password field that has no username field (the studio login dialog).
  /Password forms should have \(optionally hidden\) username fields/i,
  /\[DOM\] Input elements should have autocomplete attributes/i,
];

export const ALLOWED_HOSTS = new Set(["127.0.0.1"]);

function installGuard(context) {
  const requests = [];
  const offHost = [];
  const errors = [];
  const allow = [...BASE_CONSOLE_ALLOW];
  context.on("request", (req) => {
    let u;
    try {
      u = new URL(req.url());
    } catch {
      return;
    }
    if (!["http:", "https:", "ws:", "wss:", "ftp:"].includes(u.protocol)) return; // data:, blob:, about:srcdoc, chrome-error:
    requests.push(`${req.method()} ${u.origin}${u.pathname}`);
    if (!ALLOWED_HOSTS.has(u.hostname)) offHost.push(`${req.method()} ${req.url()}`);
  });
  context.on("console", (msg) => {
    if (msg.type() === "error") errors.push(msg.text());
  });
  context.on("weberror", (we) => {
    const e = we.error();
    errors.push(`pageerror: ${e && e.message ? e.message : String(e)} @ ${we.page()?.url() ?? "?"}`);
  });
  return {
    requests, offHost, errors,
    /** Expected, specific console errors for one test (for example the browser's log line for an intentional 401). */
    allowConsole(...patterns) {
      allow.push(...patterns);
    },
    /** The browser logs "Failed to load resource ... status of N" for every non-2xx response. List the N a test provokes on purpose. */
    expectHttp(...statuses) {
      allow.push(new RegExp(`Failed to load resource: the server responded with a status of (${statuses.join("|")})\\b`));
    },
    unexpected: () => errors.filter((e) => !allow.some((re) => re.test(e))),
  };
}

export const test = base.extend({
  // Options a spec can set with test.use({ studioOptions: {...} }).
  studioOptions: [{}, { option: true }],

  guard: [async ({ context }, use) => {
    const g = installGuard(context);
    await use(g);
    expect.soft(g.offHost, "requests to hosts other than 127.0.0.1").toEqual([]);
    expect.soft(g.unexpected(), "unexpected console or page errors").toEqual([]);
  }, { auto: true }],

  studio: async ({ studioOptions }, use) => {
    const s = await startLocalStudio(studioOptions);
    await use(s);
    await s.close();
  },

  hosted: async ({ studioOptions }, use) => {
    const s = await startHostedStudio(studioOptions);
    await use(s);
    await s.close();
  },

  site: [async ({}, use) => {
    const s = await startStaticServer();
    await use(s);
    await s.close();
  }, { scope: "worker" }],

  /** Page object for the studio under test (local by default). */
  sp: async ({ page, studio }, use) => {
    await use(new StudioPage(page, studio));
  },
  hsp: async ({ page, hosted }, use) => {
    await use(new StudioPage(page, hosted));
  },
});

export { expect };
