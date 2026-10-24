// @vitest-environment node

import fs from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { classifyProviderPortalSnapshot, type ProviderPortalDefinition } from "../adapters/providerPortalKernel";
import { checkVendorSession, refreshVendorSession, sessionStatePath, type VendorSessionDeps, type VendorSessionProfile } from "./vendorSession";

/**
 * OVD-1060: `session:check` and `session:refresh` through the real bounded
 * probe, against a loopback server with synthetic pages. Only the loopback
 * test seam (plain http on 127.0.0.1) differs from the CLI.
 */

const TIMEOUT_MS = 60_000;
const CONTENT = "Upload a part to get an instant quote. Recent quotes: bracket rev B, enclosure lid, mounting plate.";
const hits: string[] = [];
let server: http.Server;
let origin = "";
let stateDir: string;

function signedIn(req: http.IncomingMessage): boolean {
  return (req.headers.cookie ?? "").split(";").some((part) => part.trim() === "sid=ok");
}

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const url = req.url ?? "/";
    hits.push(`${req.method} ${url}`);
    const send = (status: number, body: string, headers: Record<string, string> = {}) => {
      res.writeHead(status, { "content-type": "text/html", ...headers });
      res.end(body);
    };
    if (req.method !== "GET" && req.method !== "HEAD") return send(405, "");
    if (url === "/login") return send(200, '<!doctype html><title>Sign in</title><form><input type="password" name="password"></form>');
    // A public page: it renders the same for everyone, signed in or not.
    if (url === "/public") return send(200, `<!doctype html><title>Fixture</title><body><h1>${CONTENT}</h1></body>`);
    if (!signedIn(req)) return send(302, "", { location: "/login" });
    if (url === "/app") {
      // A page that would POST and open a socket, and rotates a cookie on the way.
      return send(200, `<!doctype html><title>Fixture app</title><body><h1>Upload a part</h1><a href="/logout">Log out</a>
        <script>fetch("/api/beacon", { method: "POST", body: "x" }).catch(() => {});</script></body>`, { "set-cookie": "rot=2; Path=/; HttpOnly" });
    }
    // A second-factor page that already shows the account's log out control.
    if (url === "/mfa") {
      return send(200, `<!doctype html><title>Fixture app</title><body><h1>Enter the verification code we sent to your phone</h1>
        <input name="code" autocomplete="one-time-code"><a href="/logout">Log out</a></body>`);
    }
    const stopPages: Record<string, string> = {
      "/approval": "Approve the sign-in request on your phone to continue",
      "/error": "An error occurred. Please try again",
      "/loading": "Loading… Please wait",
    };
    const stopText = stopPages[url];
    if (stopText) return send(200, `<!doctype html><body><h1>${stopText}</h1><a href="/logout">Log out</a></body>`, { "set-cookie": "rot=2; Path=/; HttpOnly" });
    if (url === "/plain") return send(200, `<!doctype html><title>Fixture app</title><body><h1>${CONTENT}</h1></body>`);
    return send(404, "");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(async () => {
  hits.length = 0;
  stateDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "ovd-vendor-session-browser-")));
});

afterEach(async () => {
  await fs.rm(stateDir, { recursive: true, force: true });
});

const signals: ProviderPortalDefinition["terminalSignals"] = {
  login: [/login|sign[ -]?in/i], captcha: [/captcha|verify you are human/i],
  manualReview: [/manual review/i], configurationRequired: [/select material/i], unavailable: [/service unavailable/i],
};

/** A loopback stand-in for a vendor definition: only the fields the session tools read. */
function loopbackProfile(landingPath: string): VendorSessionProfile {
  const definition = {
    provider: "quickparts",
    allowedHosts: ["127.0.0.1"],
    hooks: { classifyPortalState: (snapshot) => classifyProviderPortalSnapshot(snapshot, signals) },
  } as Pick<ProviderPortalDefinition, "provider" | "allowedHosts" | "hooks"> as ProviderPortalDefinition;
  return {
    vendor: "quickparts",
    displayName: "Quickparts",
    loginUrl: `${origin}/login`,
    landingUrl: `${origin}${landingPath}`,
    sessionHosts: ["127.0.0.1"],
    probeHosts: ["127.0.0.1"],
    definition,
  };
}

const deps: VendorSessionDeps = {
  sandbox: { playwrightDisableSandbox: true, playwrightDisableDevShmUsage: false },
  probeOverrides: {
    allowLoopbackHttp: true,
    executablePath: process.env.PROBE_TEST_CHROMIUM_EXECUTABLE || undefined,
    settleMs: 300,
    confirmMs: 400,
    timeoutMs: 8_000,
  },
};

const sessionCookie = { name: "sid", value: "ok", domain: "127.0.0.1", path: "/", expires: -1, httpOnly: true, secure: false, sameSite: "Lax" as const };

async function writeSession(cookies: unknown[]) {
  await fs.writeFile(sessionStatePath(stateDir, "quickparts"), JSON.stringify({ cookies, origins: [] }), { mode: 0o600 });
}

describe("session tools through the GET-only probe", () => {
  it("reports valid on a log out control, refreshes the rotated cookie, and never sends a POST", async () => {
    await writeSession([sessionCookie]);
    const result = await refreshVendorSession(loopbackProfile("/app"), stateDir, { ...deps, env: {} });
    expect(result).toMatchObject({ state: "valid", reason: "authenticated_marker_found", refreshed: true });
    const saved = JSON.parse(await fs.readFile(sessionStatePath(stateDir, "quickparts"), "utf8"));
    expect(saved.cookies.map((cookie: { name: string }) => cookie.name).sort()).toEqual(["rot", "sid"]);
    expect(hits.filter((hit) => !hit.startsWith("GET ") && !hit.startsWith("HEAD "))).toEqual([]);
  }, TIMEOUT_MS);

  it("reports valid from the definition's terminal signals when the page has no log out control", async () => {
    await writeSession([sessionCookie]);
    await expect(checkVendorSession(loopbackProfile("/plain"), stateDir, deps))
      .resolves.toMatchObject({ state: "valid", reason: "terminal_signals_ready" });
  }, TIMEOUT_MS);

  it("never reports a second-factor page with a log out control as valid, and leaves the file alone", async () => {
    await writeSession([sessionCookie]);
    const before = await fs.readFile(sessionStatePath(stateDir, "quickparts"), "utf8");
    const result = await refreshVendorSession(loopbackProfile("/mfa"), stateDir, { ...deps, env: {} });
    expect(result).toMatchObject({ state: "check_failed", reason: "settled_page_indeterminate", refreshed: false });
    expect(await fs.readFile(sessionStatePath(stateDir, "quickparts"), "utf8")).toBe(before);
  }, TIMEOUT_MS);

  it("reports a landing page that looks the same without a session as unconfirmable", async () => {
    await writeSession([sessionCookie]);
    await expect(checkVendorSession(loopbackProfile("/public"), stateDir, deps))
      .resolves.toMatchObject({ state: "check_failed", reason: "unconfirmable_public_landing" });
  }, TIMEOUT_MS);

  it.each(["/approval", "/error", "/loading"])("does not refresh storage on %s even with a logout control", async (landingPath) => {
    await writeSession([sessionCookie]);
    const before = await fs.readFile(sessionStatePath(stateDir, "quickparts"), "utf8");
    const result = await refreshVendorSession(loopbackProfile(landingPath), stateDir, { ...deps, env: {} });
    expect(result).toMatchObject({ state: "check_failed", reason: "settled_page_indeterminate", refreshed: false });
    expect(await fs.readFile(sessionStatePath(stateDir, "quickparts"), "utf8")).toBe(before);
  }, TIMEOUT_MS);

  it("reports login_required for an expired session and leaves the file alone", async () => {
    await writeSession([{ ...sessionCookie, value: "expired" }]);
    const before = await fs.readFile(sessionStatePath(stateDir, "quickparts"), "utf8");
    const result = await refreshVendorSession(loopbackProfile("/app"), stateDir, { ...deps, env: {} });
    expect(result).toMatchObject({ state: "login_required", refreshed: false });
    expect(await fs.readFile(sessionStatePath(stateDir, "quickparts"), "utf8")).toBe(before);
  }, TIMEOUT_MS);
});
