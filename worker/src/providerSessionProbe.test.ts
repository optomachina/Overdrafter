import { execFile } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  isAllowedProbeUrl,
  loadStorageState,
  MAX_REDIRECT_HOPS,
  parseProbeCliArgs,
  probeUrlFailure,
  resolveSessionProbeTarget,
  runBoundedBrowserSessionProbe,
  runBoundedRmfgSessionProbe,
  runSessionProbe,
  findGcloud,
  SESSION_PROBE_PROVIDERS,
  type SessionProbeTarget,
} from "./providerSessionProbe.js";

const SECRET_SENTINEL = "SECRET-COOKIE-VALUE-DO-NOT-LOG";
const executablePath = process.env.PROBE_TEST_CHROMIUM_EXECUTABLE || undefined;
const sandbox = { playwrightDisableSandbox: true, playwrightDisableDevShmUsage: false };

const page = (body: string, title = "Fixture") => `<!doctype html><title>${title}</title><body>${body}</body>`;
const LOGOUT = '<nav><a href="/account/logout">Log out</a></nav>';

let server: http.Server;
let serverB: http.Server;
/** Host A, 127.0.0.1: the landing host. */
let origin = "";
/** Host B, 127.0.0.2: a second allowed host (SSO, www, app subdomain). */
let originB = "";
let offHostOrigin = "";
let offHostServer: http.Server;
/** "<host letter> <method> <path>" for every request either allowed host received. */
const hits: string[] = [];
/** Cookie header per hit, same order as hits. */
const hitCookies: string[] = [];
const offHostHits: string[] = [];

function cookieOf(req: http.IncomingMessage, name: string): string | null {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=");
  }
  return null;
}

function handle(hostLetter: "A" | "B") {
  return (req: http.IncomingMessage, res: http.ServerResponse) => {
    const url = req.url ?? "/";
    hits.push(`${hostLetter} ${req.method} ${url}`);
    hitCookies.push(req.headers.cookie ?? "");
    const html = (status: number, body: string, title?: string) =>
      res.writeHead(status, { "content-type": "text/html" }).end(page(body, title));
    const redirect = (location: string, extra: Record<string, string> = {}, body = "") =>
      res.writeHead(302, { location, ...extra }).end(body);
    if (hostLetter === "B") {
      switch (url) {
        // SSO identity host: needs its own host only cookie, never host A's.
        case "/authorize":
          return cookieOf(req, "idp") === "idp-ok"
            ? redirect(`${origin}/callback?code=c1`)
            : redirect("/login");
        case "/www-app":
          return cookieOf(req, "www_session") === "www-ok"
            ? html(200, `${LOGOUT}<h1>Quotes</h1>`)
            : html(200, '<form><input type="password" name="p"></form>');
        case "/ls-app":
          // Session token lives in localStorage of this origin; the account
          // API is a same origin call that needs this host's cookie.
          return html(
            200,
            '<div id="a">Loading</div><script>fetch("/api/me").then(function(r){if(r.ok&&localStorage.getItem("token")==="tok-ok"){document.getElementById("a").innerHTML=\'<a href="/logout">Log out</a>\'}})</script>',
          );
        case "/api/me":
          return res.writeHead(cookieOf(req, "www_session") === "www-ok" ? 200 : 401).end("{}");
        case "/login":
          return html(200, '<form><input type="password" name="p"></form>');
        default:
          return html(200, "other");
      }
    }
    switch (url) {
      case "/app":
        return html(200, `${LOGOUT}<h1>Upload</h1>`);
      case "/public":
        return html(200, "<h1>Welcome</h1>");
      case "/login":
        return html(200, '<form action="/login" method="post"><input type="password" name="p"></form>');
      case "/app-login-form":
        return html(200, '<form><input type="password" name="p"></form><a href="/logout">Log out</a>');
      case "/hash-login":
        return html(200, '<div id="r"></div><script>location.hash="#/login"</script>');
      case "/challenge":
        return html(200, '<form id="challenge-form" action="/x"></form><p>Verify you are human</p>', "Just a moment...");
      case "/challenge-title":
        return html(200, "<p>Checking</p>", "Just a moment...");
      case "/challenge-cf-marker":
        return html(200, '<form id="challenge-form" action="/?__cf_chl_f_tk=1"></form>');
      case "/turnstile-only":
        return html(200, '<div class="cf-turnstile" data-sitekey="x"></div>');
      case "/turnstile-login":
        return html(200, '<form><input type="password" name="p"><div class="cf-turnstile" data-sitekey="x"></div></form>');
      case "/turnstile-app":
        return html(200, `${LOGOUT}<h1>Upload</h1><div class="cf-turnstile" data-sitekey="x"></div>`);
      case "/challenge-with-marker":
        return html(200, `${LOGOUT}<form id="challenge-form" action="/x"></form>`, "Just a moment...");
      case "/forbidden-with-marker":
        return html(403, `${LOGOUT}<div class="cf-turnstile"></div>`);
      case "/menu-logout":
        return html(200, '<ul style="display:none"><li><a href="/account/logout">Log out</a></li></ul>');
      case "/spa-form-flash":
        return html(
          200,
          '<div id="a"><form><input type="password" name="p"></form></div><script>setTimeout(function(){document.getElementById("a").innerHTML=\'<a href="/logout">Log out</a>\'},800)</script>',
        );
      case "/off-host-login":
        return redirect(`${offHostOrigin}/login?next=/secret-path`);
      case "/off-host-sso":
        return redirect(`${offHostOrigin.replace("localhost", "sso.localhost")}/start`);
      case "/off-host-login-nav":
        return html(200, `<a href="/logout">Log out</a><script>setTimeout(()=>{location.href="${offHostOrigin}/signin"},50)</script>`);
      case "/chain-off-login":
        return redirect("/off-host-login");
      case "/recaptcha-app":
        return html(
          200,
          `${LOGOUT}<h1>Upload</h1><div class="grecaptcha-badge"></div><footer>This site is protected by reCAPTCHA and the Google Privacy Policy and Terms of Service apply.</footer>`,
        );
      case "/recaptcha-login":
        return html(
          200,
          '<form><input type="password" name="p"><div class="g-recaptcha"></div></form><footer>This site is protected by reCAPTCHA. Verify you are human.</footer>',
        );
      case "/forbidden-text":
        return html(200, `${LOGOUT}<p>Forbidden materials: none. Access denied parts are listed in the help center.</p>`);
      case "/denied":
        return html(200, "<h1>Sorry</h1>", "Access denied");
      case "/forbidden":
        return html(403, "<h1>nope</h1>");
      case "/limited":
        return html(429, "<h1>slow down</h1>");
      case "/cf-503":
        return html(503, "<h1>Just a moment...</h1>");
      case "/off-host":
        return redirect(`${offHostOrigin}/landed`);
      case "/chain-off1":
        return redirect("/chain-off2");
      case "/chain-off2":
        return redirect(`${offHostOrigin}/hop3`);
      case "/chain-ok1":
        return redirect("/chain-ok2");
      case "/chain-ok2":
        return redirect("/chain-ok3");
      case "/chain-ok3":
        return res.writeHead(303, { location: "/app" }).end();
      case "/loop":
        return redirect("/loop");
      case "/to-http":
        return redirect(`${offHostOrigin}/http-hop`);
      case "/to-about":
        return redirect("about:blank");
      case "/redirect-body-off":
        return redirect(`${offHostOrigin}/x`, { "content-type": "text/html" }, page(LOGOUT));
      case "/redirect-body-public":
        return redirect("/public", { "content-type": "text/html" }, page(LOGOUT));
      // SSO round trip: A -> B authorize -> A callback (sets the app cookie) -> A app.
      case "/sso-start":
        return redirect(`${originB}/authorize`);
      case "/callback?code=c1":
        return redirect("/sso-app", { "set-cookie": "app=app-ok; Path=/; HttpOnly" });
      case "/sso-app":
        return cookieOf(req, "app") === "app-ok"
          ? html(200, `${LOGOUT}<h1>Upload</h1>`)
          : html(200, '<form><input type="password" name="p"></form>');
      // Apex to www style hop: the session is a host only cookie of host B.
      case "/apex":
        return redirect(`${originB}/www-app`);
      case "/to-ls-app":
        return redirect(`${originB}/ls-app`);
      // A hop that sets a cookie the next hop needs.
      case "/set-hop":
        return redirect("/need-hop", { "set-cookie": "hop=hop-ok; Path=/" });
      case "/need-hop":
        return cookieOf(req, "hop") === "hop-ok" ? html(200, LOGOUT) : redirect("/login");
      case "/spa-loading":
        return html(
          200,
          '<div id="a">Just a moment...</div><script>setTimeout(function(){document.getElementById("a").innerHTML=\'<a href="/logout">Log out</a>\'},900)</script>',
        );
      case "/post-nav":
        return html(
          200,
          '<a href="/logout">Log out</a><form id="f" method="post" action="/submit"></form><script>setTimeout(function(){document.getElementById("f").submit()},50)</script>',
        );
      case "/popup":
        return html(200, '<a href="/logout">Log out</a><script>window.open("/popup-target")</script>');
      case "/redirect-login":
        return redirect("/login");
      case "/with-subresource":
        return html(
          200,
          `<a href="/logout">Log out</a><img src="${offHostOrigin}/pixel.png"><form id="f" method="post" action="/submit"></form><script>fetch("/submit",{method:"POST",body:"x"}).catch(()=>{});</script>`,
        );
      case "/with-subresource-redirect":
        return html(200, '<a href="/logout">Log out</a><img src="/img-off"><img src="/img-ok">');
      case "/img-off":
        return redirect(`${offHostOrigin}/pixel.png`);
      case "/img-ok":
        return redirect(`${originB}/pixel.png`);
      case "/second-nav":
        return html(200, '<a href="/logout">Log out</a><script>setTimeout(()=>{location.href="/app-second"},50)</script>');
      case "/login-nav":
        return html(200, '<script>setTimeout(()=>{location.href="/login"},50)</script>');
      default:
        return html(200, "other");
    }
  };
}

beforeAll(async () => {
  offHostServer = http.createServer((req, res) => {
    offHostHits.push(req.url ?? "");
    res.writeHead(200, { "content-type": "text/html" }).end(page(LOGOUT));
  });
  await new Promise<void>((resolve) => offHostServer.listen(0, "127.0.0.1", resolve));
  // "localhost" is a different host than 127.0.0.1, so it is off host for the probe.
  offHostOrigin = `http://localhost:${(offHostServer.address() as AddressInfo).port}`;

  server = http.createServer(handle("A"));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  serverB = http.createServer(handle("B"));
  await new Promise<void>((resolve) => serverB.listen(0, "127.0.0.2", resolve));
  originB = `http://127.0.0.2:${(serverB.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  await new Promise((resolve) => serverB.close(resolve));
  await new Promise((resolve) => offHostServer.close(resolve));
});

const target: SessionProbeTarget = {
  provider: "fictiv",
  adapterKind: "portal",
  landingUrl: null,
  allowedHosts: ["127.0.0.1", "127.0.0.2"],
};
const cookie = (name: string, value: string, domain: string) => ({
  name, value, domain, path: "/", expires: -1, httpOnly: true, secure: false, sameSite: "Lax" as const,
});
const storageState = {
  cookies: [cookie("session", SECRET_SENTINEL, "127.0.0.1")],
  origins: [] as Array<Record<string, unknown>>,
};
/** Host B state: host only cookies of 127.0.0.2 and a localStorage token on its origin. */
function crossHostState() {
  return {
    cookies: [
      ...storageState.cookies,
      cookie("idp", "idp-ok", "127.0.0.2"),
      cookie("www_session", "www-ok", "127.0.0.2"),
    ],
    origins: [{ origin: originB, localStorage: [{ name: "token", value: "tok-ok" }] }],
  };
}
const fixedNow = () => new Date("2026-10-12T00:00:00.000Z");

function probe(path: string, probeTarget: SessionProbeTarget = target, state = storageState) {
  hits.length = 0;
  hitCookies.length = 0;
  offHostHits.length = 0;
  return runBoundedBrowserSessionProbe({
    target: probeTarget,
    storageState: state,
    sandbox,
    executablePath,
    landingUrlOverride: `${origin}${path}`,
    allowLoopbackHttp: true,
    timeoutMs: 8_000,
    settleMs: 400,
    confirmMs: 900,
    now: fixedNow,
  });
}

const pageHits = () => hits.filter((hit) => !hit.includes("favicon"));
const cookiesSentTo = (prefix: string) =>
  hits.flatMap((hit, index) => (hit.startsWith(prefix) ? [hitCookies[index] ?? ""] : []));

describe("provider session probe target resolution", () => {
  it("derives landing URL and hosts from the catalog for every supported provider", () => {
    expect(SESSION_PROBE_PROVIDERS).toEqual(["fictiv", "quickparts", "geomiq", "rmfg"]);
    const fictiv = resolveSessionProbeTarget("fictiv");
    expect(fictiv.landingUrl).toBe("https://app.fictiv.com/pages/quotes/upload");
    expect(fictiv.allowedHosts).toEqual(["fictiv.com"]);
    expect(resolveSessionProbeTarget("geomiq").allowedHosts).toEqual(["geomiq.com"]);
    expect(resolveSessionProbeTarget("rmfg").adapterKind).toBe("api");
  });

  it("lands Quickparts on the QuickQuote app host, not the marketing page", () => {
    const quickparts = resolveSessionProbeTarget("quickparts");
    expect(quickparts.landingUrl).toBe("https://quickquote.quickparts.com/");
    expect(quickparts.allowedHosts).toEqual(["quickparts.com"]);
    expect(isAllowedProbeUrl(quickparts.landingUrl as string, quickparts)).toBe(true);
  });

  it("rejects weerg, xometry and unknown providers", () => {
    for (const name of ["weerg", "xometry", "nope"]) {
      expect(() => resolveSessionProbeTarget(name)).toThrow(/Unsupported provider/);
    }
  });

  it("allows only https first party hosts and subdomains", () => {
    const policy = { allowedHosts: ["fictiv.com"] };
    expect(isAllowedProbeUrl("https://app.fictiv.com/x", policy)).toBe(true);
    expect(isAllowedProbeUrl("https://fictiv.com.evil.example/x", policy)).toBe(false);
    expect(isAllowedProbeUrl("https://evilfictiv.com/x", policy)).toBe(false);
    expect(probeUrlFailure("http://app.fictiv.com/x", policy)).toBe("non_https_target");
    expect(probeUrlFailure("https://evil.example/x", policy)).toBe("off_host_redirect");
    for (const inline of ["about:blank", "data:text/html,hi", "javascript:alert(1)", "blob:https://app.fictiv.com/x"]) {
      expect(probeUrlFailure(inline, policy)).toBe("non_https_target");
    }
    const loopback = { allowedHosts: ["127.0.0.1", "127.0.0.2", "127.0.0.3"], allowLoopbackHttp: true };
    expect(isAllowedProbeUrl("http://127.0.0.2:9/x", loopback)).toBe(true);
    expect(probeUrlFailure("http://127.0.0.3:9/x", loopback)).toBe("non_https_target");
    expect(probeUrlFailure("http://127.0.0.1:9/x", { allowedHosts: ["127.0.0.1"] })).toBe("non_https_target");
  });

  it("parses CLI arguments and requires exactly one credential source", () => {
    expect(parseProbeCliArgs(["fictiv", "--secret", "fictiv-storage-state"])).toMatchObject({
      provider: "fictiv", secretName: "fictiv-storage-state",
    });
    expect(() => parseProbeCliArgs(["fictiv"])).toThrow(/--storage-state/);
    expect(() => parseProbeCliArgs(["fictiv", "--secret", "a", "--storage-state", "b"])).toThrow(/not both/);
    expect(() => parseProbeCliArgs(["rmfg", "--storage-state", "b"])).toThrow(/API key/);
    expect(() => parseProbeCliArgs(["weerg", "--secret", "a"])).toThrow(/Unsupported/);
  });
});

describe("browser session probe against local fixtures", () => {
  it("reports authenticated with one navigation and no state changing request", async () => {
    const evidence = await probe("/app");
    expect(evidence).toMatchObject({
      provider: "fictiv", outcome: "authenticated", reason: "authenticated_marker_found",
      finalHost: "127.0.0.1", httpStatus: 200, navigations: 1,
      timestamp: "2026-10-12T00:00:00.000Z",
    });
    expect(pageHits()).toEqual(["A GET /app"]);
    expect(Object.keys(evidence).sort()).toEqual(
      ["blockedRequests", "finalHost", "httpStatus", "navigations", "outcome", "provider", "reason", "timestamp"],
    );
  }, 30_000);

  it("reports logged_out for a password form, a login redirect, a hash login route and a missing marker", async () => {
    expect(await probe("/login")).toMatchObject({ outcome: "logged_out", reason: "login_form" });
    expect(await probe("/app-login-form")).toMatchObject({ outcome: "logged_out", reason: "login_form" });
    expect(await probe("/redirect-login")).toMatchObject({ outcome: "logged_out", reason: "login_form" });
    expect(await probe("/hash-login")).toMatchObject({ outcome: "logged_out", reason: "login_form" });
    expect(await probe("/public")).toMatchObject({ outcome: "logged_out", reason: "no_authenticated_marker" });
  }, 60_000);

  it("reports blocked for a Cloudflare interstitial, a denial title, 403, 429 and 503", async () => {
    expect(await probe("/challenge")).toMatchObject({ outcome: "blocked", reason: "challenge_page" });
    expect(await probe("/denied")).toMatchObject({ outcome: "blocked", reason: "access_denied" });
    expect(await probe("/forbidden")).toMatchObject({ outcome: "blocked", reason: "http_forbidden", httpStatus: 403 });
    expect(await probe("/limited")).toMatchObject({ outcome: "blocked", reason: "http_rate_limited", httpStatus: 429 });
    expect(await probe("/cf-503")).toMatchObject({ outcome: "blocked", reason: "challenge_page", httpStatus: 503 });
  }, 60_000);

  it("classes a challenge by its title alone and by a Cloudflare marker alone", async () => {
    expect(await probe("/challenge-title")).toMatchObject({ outcome: "blocked", reason: "challenge_page", httpStatus: 200 });
    expect(await probe("/challenge-cf-marker")).toMatchObject({ outcome: "blocked", reason: "challenge_page", httpStatus: 200 });
    expect(await probe("/turnstile-only")).toMatchObject({ outcome: "blocked", reason: "challenge_page" });
  }, 60_000);

  it("lets a present log out control win over a CAPTCHA widget alone, but not over a real challenge", async () => {
    expect(await probe("/turnstile-app")).toMatchObject({ outcome: "authenticated", reason: "authenticated_marker_found" });
    expect(await probe("/turnstile-only")).toMatchObject({ outcome: "blocked", reason: "challenge_page" });
    expect(await probe("/challenge-with-marker")).toMatchObject({ outcome: "blocked", reason: "challenge_page" });
    expect(await probe("/forbidden-with-marker")).toMatchObject({ outcome: "blocked", reason: "http_forbidden" });
  }, 60_000);

  it("counts a log out control in a closed menu as the marker", async () => {
    expect(await probe("/menu-logout")).toMatchObject({ outcome: "authenticated", reason: "authenticated_marker_found" });
  }, 30_000);

  it("waits for a single page app that flashes a password form before its session check finishes", async () => {
    expect(await probe("/spa-form-flash")).toMatchObject({ outcome: "authenticated", reason: "authenticated_marker_found" });
  }, 30_000);

  it("reads a redirect to an off host login or identity host as logged_out with only the host name, and never requests it", async () => {
    for (const pathname of ["/off-host-login", "/chain-off-login"]) {
      const evidence = await probe(pathname);
      expect(evidence).toMatchObject({ outcome: "logged_out", reason: "login_redirect_off_host", offHost: "localhost" });
      expect(JSON.stringify(evidence)).not.toContain("secret-path");
      expect(offHostHits).toEqual([]);
    }
    const sso = await probe("/off-host-sso", { ...target, allowedHosts: ["127.0.0.1"] });
    expect(sso).toMatchObject({ outcome: "logged_out", reason: "login_redirect_off_host", offHost: "sso.localhost" });
    const script = await probe("/off-host-login-nav");
    expect(script).toMatchObject({ outcome: "logged_out", reason: "login_redirect_off_host", offHost: "localhost" });
    expect(offHostHits).toEqual([]);
    // A plain off host landing that is not a login still reads as a block.
    expect(await probe("/off-host")).toMatchObject({ outcome: "blocked", reason: "off_host_redirect" });
  }, 60_000);

  it("reports browser_launch_failed when Chromium cannot start", async () => {
    const evidence = await runBoundedBrowserSessionProbe({
      target, storageState, sandbox, executablePath: "/nonexistent/chromium",
      landingUrlOverride: `${origin}/app`, allowLoopbackHttp: true, timeoutMs: 8_000, now: fixedNow,
    });
    expect(evidence).toMatchObject({ outcome: "error", reason: "browser_launch_failed" });
  }, 30_000);

  it("never blocks on body text: reCAPTCHA footers, Turnstile on a login form and the word Forbidden", async () => {
    expect(await probe("/recaptcha-app")).toMatchObject({ outcome: "authenticated", reason: "authenticated_marker_found" });
    expect(await probe("/recaptcha-login")).toMatchObject({ outcome: "logged_out", reason: "login_form" });
    expect(await probe("/turnstile-login")).toMatchObject({ outcome: "logged_out", reason: "login_form" });
    expect(await probe("/forbidden-text")).toMatchObject({ outcome: "authenticated", reason: "authenticated_marker_found" });
    expect(await probe("/spa-loading")).toMatchObject({ outcome: "authenticated", reason: "authenticated_marker_found" });
  }, 90_000);

  it("reports blocked for an off host redirect and never reaches the other host", async () => {
    const evidence = await probe("/off-host");
    expect(evidence).toMatchObject({ outcome: "blocked", reason: "off_host_redirect" });
    expect(offHostHits).toEqual([]);
  }, 30_000);

  it("checks every hop: an off host third hop is blocked and never reached", async () => {
    const evidence = await probe("/chain-off1");
    expect(evidence).toMatchObject({ outcome: "blocked", reason: "off_host_redirect" });
    expect(offHostHits).toEqual([]);
    expect(pageHits()).toEqual(["A GET /chain-off1", "A GET /chain-off2"]);
  }, 30_000);

  it("follows an all allowed chain with exactly one GET per hop and reports the final page", async () => {
    const evidence = await probe("/chain-ok1");
    expect(evidence).toMatchObject({
      outcome: "authenticated", reason: "authenticated_marker_found", finalHost: "127.0.0.1", httpStatus: 200, navigations: 1,
    });
    expect(pageHits()).toEqual(["A GET /chain-ok1", "A GET /chain-ok2", "A GET /chain-ok3", "A GET /app"]);
  }, 30_000);

  it("stops a redirect loop at the hop cap with a fixed reason", async () => {
    const evidence = await probe("/loop");
    expect(evidence).toMatchObject({ outcome: "blocked", reason: "redirect_limit_exceeded", navigations: 1 });
    expect(hits.filter((hit) => hit === "A GET /loop")).toHaveLength(MAX_REDIRECT_HOPS + 1);
  }, 30_000);

  it("blocks a redirect to http on another allowed host and to about:blank", async () => {
    const toHttp = await probe("/to-http", { ...target, allowedHosts: ["127.0.0.1", "localhost"] });
    expect(toHttp).toMatchObject({ outcome: "blocked", reason: "non_https_target" });
    expect(offHostHits).toEqual([]);
    expect(await probe("/to-about")).toMatchObject({ outcome: "blocked", reason: "non_https_target" });
  }, 30_000);

  it("never hands a 3xx body to the browser", async () => {
    // Both redirect bodies carry a log out link; neither may be rendered.
    expect(await probe("/redirect-body-off")).toMatchObject({ outcome: "blocked", reason: "off_host_redirect" });
    expect(await probe("/redirect-body-public")).toMatchObject({ outcome: "logged_out", reason: "no_authenticated_marker" });
    expect(pageHits()).toEqual(["A GET /redirect-body-public", "A GET /public"]);
  }, 30_000);

  describe("cookies and origin across hops behave as in a normal browser", () => {
    it("SSO round trip: host B gets only its own cookie and the callback cookie reaches the app", async () => {
      const evidence = await probe("/sso-start", target, crossHostState());
      expect(evidence).toMatchObject({
        outcome: "authenticated", reason: "authenticated_marker_found", finalHost: "127.0.0.1", navigations: 1,
      });
      expect(pageHits()).toEqual(["A GET /sso-start", "B GET /authorize", "A GET /callback?code=c1", "A GET /sso-app"]);
      // Host A's host only session cookie never leaks to host B, and B's never to A.
      expect(cookiesSentTo("B ").join(";")).not.toContain(SECRET_SENTINEL);
      expect(cookiesSentTo("A ").join(";")).not.toContain("idp-ok");
    }, 30_000);

    it("apex to www: the host only session cookie of the target host is sent", async () => {
      const evidence = await probe("/apex", target, crossHostState());
      expect(evidence).toMatchObject({ outcome: "authenticated", finalHost: "127.0.0.2", navigations: 1 });
      expect(cookiesSentTo("B ").join(";")).not.toContain(SECRET_SENTINEL);
    }, 30_000);

    it("a cookie set by one hop is sent on the next hop", async () => {
      const evidence = await probe("/set-hop");
      expect(evidence).toMatchObject({ outcome: "authenticated", finalHost: "127.0.0.1" });
      expect(pageHits()).toEqual(["A GET /set-hop", "A GET /need-hop"]);
    }, 30_000);

    it("the final document runs on its own origin, with its localStorage and same origin API", async () => {
      const evidence = await probe("/to-ls-app", target, crossHostState());
      expect(evidence).toMatchObject({ outcome: "authenticated", reason: "authenticated_marker_found", finalHost: "127.0.0.2" });
      expect(pageHits()).toEqual(["A GET /to-ls-app", "B GET /ls-app", "B GET /api/me"]);
    }, 30_000);

    it("reads logged_out when the target host has no session", async () => {
      const evidence = await probe("/apex");
      expect(evidence).toMatchObject({ outcome: "logged_out", reason: "login_form", finalHost: "127.0.0.2" });
    }, 30_000);
  });

  it("records a blocked non GET main frame navigation instead of dropping it silently", async () => {
    const evidence = await probe("/post-nav");
    expect(evidence).toMatchObject({ outcome: "blocked", reason: "non_get_navigation" });
    expect(hits.some((hit) => hit.includes("POST"))).toBe(false);
  }, 30_000);

  it("counts a same host popup navigation toward the navigation cap and never sends it", async () => {
    const evidence = await probe("/popup");
    expect(evidence).toMatchObject({ outcome: "blocked", reason: "unexpected_extra_navigation", navigations: 2 });
    expect(hits).not.toContain("A GET /popup-target");
    expect(hits.some((hit) => hit.includes("POST"))).toBe(false);
  }, 30_000);

  it("aborts requests outside the allowed hosts and every non GET request", async () => {
    const evidence = await probe("/with-subresource");
    expect(evidence.outcome).toBe("authenticated");
    expect(evidence.blockedRequests).toBeGreaterThanOrEqual(2);
    expect(offHostHits).toEqual([]);
    expect(hits.some((hit) => hit.includes("POST"))).toBe(false);
  }, 30_000);

  it("aborts and counts a failed subresource redirect hop while the run continues", async () => {
    const evidence = await probe("/with-subresource-redirect");
    expect(evidence).toMatchObject({ outcome: "authenticated", navigations: 1 });
    expect(evidence.blockedRequests).toBeGreaterThanOrEqual(1);
    expect(offHostHits).toEqual([]);
    expect(hits).toContain("B GET /pixel.png");
  }, 30_000);

  it("enforces a single navigation and reports a script driven login bounce as logged_out", async () => {
    const second = await probe("/second-nav");
    expect(second).toMatchObject({ outcome: "blocked", reason: "unexpected_extra_navigation", navigations: 2 });
    expect(hits).not.toContain("A GET /app-second");
    const login = await probe("/login-nav");
    expect(login.outcome).toBe("logged_out");
    expect(hits).not.toContain("A GET /login");
  }, 60_000);

  it("never logs or returns the secret value", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((name) =>
      vi.spyOn(console, name).mockImplementation(() => undefined),
    );
    const loadSecret = vi.fn(async (name: string) => {
      expect(name).toBe("fictiv-storage-state");
      return JSON.stringify(storageState);
    });
    const loaded = await loadStorageState({ secret: "fictiv-storage-state" }, loadSecret);
    const evidence = await runBoundedBrowserSessionProbe({
      target, storageState: loaded, sandbox,
      executablePath, landingUrlOverride: `${origin}/app`,
      allowLoopbackHttp: true, timeoutMs: 8_000, now: fixedNow,
    });
    expect(loadSecret).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(evidence)).not.toContain(SECRET_SENTINEL);
    for (const spy of spies) expect(JSON.stringify(spy.mock.calls)).not.toContain(SECRET_SENTINEL);
  }, 30_000);
});

describe("probe under tsx", () => {
  // vitest's transform does not keep function names, but tsx does. A named inner
  // function sent to the page would break there, so run the real runtime too.
  const tsx = [
    path.resolve(import.meta.dirname, "../node_modules/.bin/tsx"),
    path.resolve(import.meta.dirname, "../../node_modules/.bin/tsx"),
  ].find((candidate) => fs.existsSync(candidate));
  const driver = path.resolve(import.meta.dirname, "tools/_providerSessionProbeTsxDriver.ts");

  async function runUnderTsx(pathname: string) {
    const { stdout } = await promisify(execFile)(tsx as string, [driver, `${origin}${pathname}`, executablePath ?? ""], {
      cwd: path.resolve(import.meta.dirname, ".."),
      timeout: 60_000,
    });
    return JSON.parse(stdout.trim().split("\n").pop() as string);
  }

  it("finds the marker, a challenge, a rate limit and a redirect chain without page evaluation errors", async () => {
    expect(tsx).toBeDefined();
    expect(await runUnderTsx("/app")).toMatchObject({ outcome: "authenticated", reason: "authenticated_marker_found" });
    expect(await runUnderTsx("/challenge")).toMatchObject({ outcome: "blocked", reason: "challenge_page" });
    expect(await runUnderTsx("/limited")).toMatchObject({ outcome: "blocked", reason: "http_rate_limited" });
    expect(await runUnderTsx("/chain-ok1")).toMatchObject({ outcome: "authenticated", navigations: 1 });
  }, 120_000);
});

describe("probe CLI wrapper under tsx", () => {
  const tsx = [
    path.resolve(import.meta.dirname, "../node_modules/.bin/tsx"),
    path.resolve(import.meta.dirname, "../../node_modules/.bin/tsx"),
  ].find((candidate) => fs.existsSync(candidate));
  const cli = path.resolve(import.meta.dirname, "tools/probeProviderSession.ts");

  async function runCli(loopbackUrl: string) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "probe-cli-"));
    const argsFile = path.join(dir, "gcloud-args.txt");
    const outFile = path.join(dir, "out.json");
    const fakeGcloud = path.join(dir, "gcloud");
    fs.writeFileSync(
      fakeGcloud,
      `#!/bin/sh\necho "$@" > "${argsFile}"\ncat <<'JSON'\n${JSON.stringify(storageState)}\nJSON\n`,
      { mode: 0o755 },
    );
    try {
      const result = await promisify(execFile)(
        tsx as string,
        [cli, "fictiv", "--secret", "fictiv-storage-state", "--project", "fixture-project", "--out", outFile],
        {
          cwd: path.resolve(import.meta.dirname, ".."),
          timeout: 90_000,
          env: {
            ...process.env,
            // Only the fake gcloud is reachable: GCLOUD_PATH is tried first and
            // PATH holds nothing else named gcloud ahead of it.
            PATH: `${dir}:${process.env.PATH ?? ""}`,
            GCLOUD_PATH: fakeGcloud,
            PROBE_TEST_LOOPBACK_URL: loopbackUrl,
            PROBE_TEST_CHROMIUM_EXECUTABLE: executablePath ?? "",
            PLAYWRIGHT_DISABLE_SANDBOX: "1",
          },
        },
      ).then((value) => ({ code: 0, ...value }), (error) => ({ code: error.code as number, stdout: error.stdout as string, stderr: error.stderr as string }));
      return {
        ...result,
        gcloudArgs: fs.existsSync(argsFile) ? fs.readFileSync(argsFile, "utf8").trim() : null,
        outRecord: fs.existsSync(outFile) ? fs.readFileSync(outFile, "utf8") : null,
        outMode: fs.existsSync(outFile) ? fs.statSync(outFile).mode & 0o777 : null,
      };
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  it("loads the secret through gcloud, probes only the loopback fixture and writes a clean record", async () => {
    expect(tsx).toBeDefined();
    hits.length = 0;
    offHostHits.length = 0;
    const ok = await runCli(`${origin}/app`);
    expect(ok.code).toBe(0);
    expect(JSON.parse(ok.stdout.trim())).toMatchObject({ provider: "fictiv", outcome: "authenticated", finalHost: "127.0.0.1" });
    expect(ok.gcloudArgs).toBe("secrets versions access latest --secret=fictiv-storage-state --project=fixture-project");
    expect(ok.outRecord).toBe(`${ok.stdout.trim()}\n`);
    expect(ok.outMode).toBe(0o600);
    expect(`${ok.stdout}${ok.stderr}${ok.outRecord}`).not.toContain(SECRET_SENTINEL);
    expect(pageHits()).toEqual(["A GET /app"]);

    const blocked = await runCli(`${origin}/challenge`);
    expect(blocked.code).toBe(1);
    expect(JSON.parse(blocked.stdout.trim())).toMatchObject({ outcome: "blocked", reason: "challenge_page" });
    expect(`${blocked.stdout}${blocked.stderr}`).not.toContain(SECRET_SENTINEL);
  }, 180_000);

  it("fails closed on a fixture URL that is not plain loopback http, before reading any secret", async () => {
    const rejected = await runCli("https://example.com/x");
    expect(rejected.code).toBe(1);
    expect(rejected.stdout.trim()).toBe("");
    expect(JSON.parse(rejected.stderr.trim())).toEqual({ outcome: "error", reason: "probe_failed" });
    expect(rejected.gcloudArgs).toBeNull();
    expect(rejected.outRecord).toBeNull();
  }, 90_000);

  it("throws in process for a rejected fixture URL instead of using the real landing page", async () => {
    const loadSecret = vi.fn(async () => {
      throw new Error("must not be called");
    });
    for (const bad of ["https://example.com/x", "http://127.0.0.2:1/x", "http://localhost:1/x", ""]) {
      await expect(
        runSessionProbe(
          { provider: "fictiv", secretName: "fictiv-storage-state" },
          { loadSecret, sandbox, loopbackFixtureUrl: bad, now: fixedNow },
        ),
      ).rejects.toThrow(/loopback fixture URL/);
    }
    expect(loadSecret).not.toHaveBeenCalled();
  });
});

describe("gcloud lookup", () => {
  const saved = process.env.GCLOUD_PATH;
  afterAll(() => {
    if (saved === undefined) delete process.env.GCLOUD_PATH;
    else process.env.GCLOUD_PATH = saved;
  });

  it("fails closed when GCLOUD_PATH is set but not executable, relative or missing", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "probe-gcloud-"));
    try {
      const plain = path.join(dir, "gcloud");
      fs.writeFileSync(plain, "#!/bin/sh\n", { mode: 0o644 });
      const exec = path.join(dir, "gcloud-ok");
      fs.writeFileSync(exec, "#!/bin/sh\n", { mode: 0o755 });
      process.env.GCLOUD_PATH = plain;
      expect(await findGcloud()).toBeNull();
      process.env.GCLOUD_PATH = path.join(dir, "missing");
      expect(await findGcloud()).toBeNull();
      process.env.GCLOUD_PATH = "gcloud";
      expect(await findGcloud()).toBeNull();
      process.env.GCLOUD_PATH = exec;
      expect(await findGcloud()).toBe(exec);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("storage state loading", () => {
  it("reports a malformed cookie list as storage_state_invalid", async () => {
    const evidence = await runBoundedBrowserSessionProbe({
      target, storageState: { cookies: [{ name: 1 }], origins: [] }, sandbox, executablePath,
      landingUrlOverride: `${origin}/app`, allowLoopbackHttp: true, timeoutMs: 8_000, now: fixedNow,
    });
    expect(evidence).toMatchObject({ outcome: "error", reason: "storage_state_invalid" });
  }, 30_000);

  it("fails closed with a fixed reason and no secret text", async () => {
    const failing = async () => { throw new Error(`boom ${SECRET_SENTINEL}`); };
    const evidence = await runSessionProbe(
      { provider: "fictiv", secretName: "fictiv-storage-state" },
      { loadSecret: failing, sandbox, now: fixedNow },
    );
    expect(evidence).toMatchObject({ outcome: "error", reason: "secret_unavailable" });
    expect(JSON.stringify(evidence)).not.toContain(SECRET_SENTINEL);
    const malformed = await runSessionProbe(
      { provider: "geomiq", secretName: "geomiq-storage-state" },
      { loadSecret: async () => `{"not":"state ${SECRET_SENTINEL}"}`, sandbox, now: fixedNow },
    );
    expect(malformed).toMatchObject({ outcome: "error", reason: "storage_state_invalid" });
    expect(JSON.stringify(malformed)).not.toContain(SECRET_SENTINEL);
  });
});

describe("rmfg api key probe", () => {
  const endpointUrl = "https://api.rmfg.com/v1/probe-fixture";
  const apiKey = "rmfg_test_key_12345";

  it("authenticates on 200 with exactly one request", async () => {
    const transport = vi.fn(async () => ({ status: 200 }));
    const evidence = await runBoundedRmfgSessionProbe({ apiKey, endpointUrl, transport, now: fixedNow });
    expect(evidence).toMatchObject({ provider: "rmfg", outcome: "authenticated", httpStatus: 200, finalHost: "api.rmfg.com" });
    expect(transport).toHaveBeenCalledTimes(1);
    expect(transport.mock.calls[0]?.[0]).toMatchObject({ method: "GET", url: endpointUrl });
    expect(JSON.stringify(evidence)).not.toContain(apiKey);
  });

  it("treats 401 and 429 as blocked and never retries", async () => {
    for (const [status, reason] of [[401, "http_unauthorized"], [429, "http_rate_limited"]] as const) {
      const transport = vi.fn(async () => ({ status }));
      const evidence = await runBoundedRmfgSessionProbe({ apiKey, endpointUrl, transport, now: fixedNow });
      expect(evidence).toMatchObject({ outcome: "blocked", reason, httpStatus: status });
      expect(transport).toHaveBeenCalledTimes(1);
    }
  });

  it("refuses http, off domain endpoints and malformed keys without a request", async () => {
    const transport = vi.fn(async () => ({ status: 200 }));
    for (const bad of ["http://api.rmfg.com/v1/x", "https://api.rmfg.com.evil.example/v1/x"]) {
      const evidence = await runBoundedRmfgSessionProbe({ apiKey, endpointUrl: bad, transport, now: fixedNow });
      expect(evidence.outcome).toBe("error");
    }
    const badKey = await runBoundedRmfgSessionProbe({ apiKey: "bad key", endpointUrl, transport, now: fixedNow });
    expect(badKey).toMatchObject({ outcome: "error", reason: "rmfg_key_invalid" });
    expect(transport).not.toHaveBeenCalled();
  });

  it("makes no call and reads no secret while the documented endpoint is still a TODO", async () => {
    const transport = vi.fn(async () => ({ status: 200 }));
    const loadSecret = vi.fn(async () => apiKey);
    const evidence = await runSessionProbe(
      { provider: "rmfg", secretName: "rmfg-api-key" },
      { loadSecret, sandbox, rmfgTransport: transport, now: fixedNow },
    );
    expect(evidence).toMatchObject({ outcome: "error", reason: "rmfg_endpoint_not_configured" });
    expect(transport).not.toHaveBeenCalled();
    expect(loadSecret).not.toHaveBeenCalled();
  });
});
