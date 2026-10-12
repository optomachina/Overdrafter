import { execFile } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { promisify } from "node:util";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  isAllowedProbeUrl,
  loadStorageState,
  parseProbeCliArgs,
  resolveSessionProbeTarget,
  runBoundedBrowserSessionProbe,
  runBoundedRmfgSessionProbe,
  runSessionProbe,
  SESSION_PROBE_PROVIDERS,
  type SessionProbeTarget,
} from "./providerSessionProbe.js";

const SECRET_SENTINEL = "SECRET-COOKIE-VALUE-DO-NOT-LOG";
const executablePath = process.env.PROBE_TEST_CHROMIUM_EXECUTABLE || undefined;
const sandbox = { playwrightDisableSandbox: true, playwrightDisableDevShmUsage: false };

const page = (body: string, title = "Fixture") => `<!doctype html><title>${title}</title><body>${body}</body>`;

let server: http.Server;
let origin = "";
let offHostOrigin = "";
let offHostServer: http.Server;
const hits: string[] = [];
const offHostHits: string[] = [];

beforeAll(async () => {
  offHostServer = http.createServer((req, res) => {
    offHostHits.push(req.url ?? "");
    res.writeHead(200, { "content-type": "text/html" }).end(page("off host"));
  });
  await new Promise<void>((resolve) => offHostServer.listen(0, "127.0.0.1", resolve));
  // "localhost" is a different host than 127.0.0.1, so it is off host for the probe.
  offHostOrigin = `http://localhost:${(offHostServer.address() as AddressInfo).port}`;

  server = http.createServer((req, res) => {
    const url = req.url ?? "/";
    hits.push(`${req.method} ${url}`);
    const html = (status: number, body: string) =>
      res.writeHead(status, { "content-type": "text/html" }).end(page(body));
    switch (url) {
      case "/app":
        return html(200, '<nav><a href="/account/logout">Log out</a></nav><h1>Upload</h1>');
      case "/public":
        return html(200, "<h1>Welcome</h1>");
      case "/login":
        return html(200, '<form action="/login" method="post"><input type="password" name="p"></form>');
      case "/app-login-form":
        return html(200, '<form><input type="password" name="p"></form><a href="/logout">Log out</a>');
      case "/challenge":
        return html(200, "<h1>Just a moment...</h1><p>Verify you are human</p>");
      case "/denied":
        return html(200, "<h1>Access denied</h1>");
      case "/forbidden":
        return html(403, "<h1>nope</h1>");
      case "/limited":
        return html(429, "<h1>slow down</h1>");
      case "/off-host":
        return res.writeHead(302, { location: `${offHostOrigin}/landed` }).end();
      case "/redirect-login":
        return res.writeHead(302, { location: "/login" }).end();
      case "/with-subresource":
        return html(
          200,
          `<a href="/logout">Log out</a><img src="${offHostOrigin}/pixel.png"><form id="f" method="post" action="/submit"></form><script>fetch("/submit",{method:"POST",body:"x"}).catch(()=>{});</script>`,
        );
      case "/second-nav":
        return html(200, '<a href="/logout">Log out</a><script>setTimeout(()=>{location.href="/app-second"},50)</script>');
      case "/login-nav":
        return html(200, '<script>setTimeout(()=>{location.href="/login"},50)</script>');
      default:
        return html(200, "other");
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  await new Promise((resolve) => offHostServer.close(resolve));
});

const target: SessionProbeTarget = {
  provider: "fictiv",
  adapterKind: "portal",
  landingUrl: null,
  allowedHosts: ["127.0.0.1"],
};
const storageState = {
  cookies: [
    {
      name: "session", value: SECRET_SENTINEL, domain: "127.0.0.1", path: "/",
      expires: -1, httpOnly: true, secure: false, sameSite: "Lax" as const,
    },
  ],
  origins: [],
};
const fixedNow = () => new Date("2026-10-12T00:00:00.000Z");

function probe(path: string) {
  hits.length = 0;
  offHostHits.length = 0;
  return runBoundedBrowserSessionProbe({
    target,
    storageState,
    sandbox,
    executablePath,
    landingUrlOverride: `${origin}${path}`,
    allowLoopbackHttp: true,
    timeoutMs: 8_000,
    settleMs: 400,
    now: fixedNow,
  });
}

describe("provider session probe target resolution", () => {
  it("derives landing URL and hosts from the catalog for every supported provider", () => {
    expect(SESSION_PROBE_PROVIDERS).toEqual(["fictiv", "quickparts", "geomiq", "rmfg"]);
    const fictiv = resolveSessionProbeTarget("fictiv");
    expect(fictiv.landingUrl).toBe("https://app.fictiv.com/pages/quotes/upload");
    expect(fictiv.allowedHosts).toEqual(["fictiv.com"]);
    expect(resolveSessionProbeTarget("quickparts").landingUrl).toBe("https://quickparts.com/quickquote/");
    expect(resolveSessionProbeTarget("geomiq").allowedHosts).toEqual(["geomiq.com"]);
    expect(resolveSessionProbeTarget("rmfg").adapterKind).toBe("api");
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
    expect(isAllowedProbeUrl("http://app.fictiv.com/x", policy)).toBe(false);
    expect(isAllowedProbeUrl("data:text/html,hi", policy)).toBe(false);
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
    expect(hits.filter((hit) => !hit.includes("favicon"))).toEqual(["GET /app"]);
    expect(Object.keys(evidence).sort()).toEqual(
      ["blockedRequests", "finalHost", "httpStatus", "navigations", "outcome", "provider", "reason", "timestamp"],
    );
  }, 30_000);

  it("reports logged_out for a password form, a login redirect and a missing marker", async () => {
    expect(await probe("/login")).toMatchObject({ outcome: "logged_out", reason: "login_form" });
    expect(await probe("/app-login-form")).toMatchObject({ outcome: "logged_out", reason: "login_form" });
    expect(await probe("/redirect-login")).toMatchObject({ outcome: "logged_out", reason: "login_form" });
    expect(await probe("/public")).toMatchObject({ outcome: "logged_out", reason: "no_authenticated_marker" });
  }, 60_000);

  it("reports blocked for challenge, denied, 403 and 429 pages", async () => {
    expect(await probe("/challenge")).toMatchObject({ outcome: "blocked", reason: "challenge_page" });
    expect(await probe("/denied")).toMatchObject({ outcome: "blocked", reason: "access_denied" });
    expect(await probe("/forbidden")).toMatchObject({ outcome: "blocked", reason: "http_forbidden", httpStatus: 403 });
    expect(await probe("/limited")).toMatchObject({ outcome: "blocked", reason: "http_rate_limited", httpStatus: 429 });
  }, 60_000);

  it("reports blocked for an off host redirect and never reaches the other host", async () => {
    const evidence = await probe("/off-host");
    expect(evidence).toMatchObject({ outcome: "blocked", reason: "off_host_redirect" });
    expect(offHostHits).toEqual([]);
  }, 30_000);

  it("aborts requests outside the allowed hosts and every non GET request", async () => {
    const evidence = await probe("/with-subresource");
    expect(evidence.outcome).toBe("authenticated");
    expect(evidence.blockedRequests).toBeGreaterThanOrEqual(2);
    expect(offHostHits).toEqual([]);
    expect(hits.some((hit) => hit.startsWith("POST"))).toBe(false);
  }, 30_000);

  it("enforces a single navigation and reports a script driven login bounce as logged_out", async () => {
    const second = await probe("/second-nav");
    expect(second).toMatchObject({ outcome: "blocked", reason: "unexpected_extra_navigation", navigations: 2 });
    expect(hits).not.toContain("GET /app-second");
    const login = await probe("/login-nav");
    expect(login.outcome).toBe("logged_out");
    expect(hits).not.toContain("GET /login");
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

  it("finds the marker, a challenge and a rate limit without page evaluation errors", async () => {
    expect(tsx).toBeDefined();
    expect(await runUnderTsx("/app")).toMatchObject({ outcome: "authenticated", reason: "authenticated_marker_found" });
    expect(await runUnderTsx("/challenge")).toMatchObject({ outcome: "blocked", reason: "challenge_page" });
    expect(await runUnderTsx("/limited")).toMatchObject({ outcome: "blocked", reason: "http_rate_limited" });
  }, 120_000);
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
