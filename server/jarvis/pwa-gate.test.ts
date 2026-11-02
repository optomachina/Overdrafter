// @vitest-environment node
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import gate from "../../api/jarvis/gate";
import miss from "../../api/jarvis/miss";
import {
  createJarvisPwaDeps,
  createJarvisPwaHandler,
  isJarvisPwaEnabled,
  jarvisNotFoundResponse,
  type JarvisGateDeps,
  type JarvisPwaRoute,
} from "./pwa-gate";

const TOKEN = "synthetic-jarvis-gate-token";
const USER_ID = "00000000-0000-4000-8000-0000000000b1";
const CANARY = "synthetic-service-role-must-not-leak";
const ENV = {
  JARVIS_PWA_ENABLED: "1",
  SUPABASE_URL: "https://database.invalid",
  SUPABASE_ANON_KEY: "synthetic-anon-key",
  SUPABASE_SERVICE_ROLE_KEY: CANARY,
};

function request(path = "/api/jarvis/session", init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  if (!headers.has("authorization")) headers.set("authorization", `Bearer ${TOKEN}`);
  return new Request(`https://app.example.invalid${path}`, { ...init, headers });
}

async function shape(response: Response) {
  return {
    status: response.status,
    body: await response.text(),
    headers: [...response.headers.entries()].sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1])),
  };
}

function deps(caller: { allowlisted: boolean; aal2: boolean } | null, enabled = true): JarvisGateDeps & { lookup: ReturnType<typeof vi.fn> } {
  const lookup = vi.fn(async () => (caller === null ? null : { userId: USER_ID, ...caller }));
  return { enabled, lookup };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("Jarvis PWA flag", () => {
  it("is on only for the exact string 1", () => {
    expect(["1"].map(isJarvisPwaEnabled)).toEqual([true]);
    for (const value of [undefined, "", "0", "true", "TRUE", "yes", " 1", "1 "]) {
      expect(isJarvisPwaEnabled(value)).toBe(false);
    }
  });
});

describe("Jarvis PWA admission", () => {
  const absent = () => shape(jarvisNotFoundResponse());

  it("keeps the flag-off route identical to a missing path, with no lookup", async () => {
    const gateDeps = deps({ allowlisted: true, aal2: true }, false);
    const response = await createJarvisPwaHandler(gateDeps, "session")(request());
    expect(await shape(response)).toEqual(await absent());
    expect(gateDeps.lookup).not.toHaveBeenCalled();
  });

  it.each([
    ["no header", request("/api/jarvis/session", { headers: { authorization: "" } })],
    ["short token", request("/api/jarvis/session", { headers: { authorization: "Bearer short" } })],
    ["forged role header and no bearer", request("/api/jarvis/session", { headers: { "x-jarvis-role": "admin", authorization: "" } })],
  ])("returns 401 with no body when signed out (%s)", async (_label, incoming) => {
    const gateDeps = deps({ allowlisted: true, aal2: true });
    const response = await createJarvisPwaHandler(gateDeps, "session")(incoming);
    expect(response.status).toBe(401);
    expect(await response.text()).toBe("");
    expect(gateDeps.lookup).not.toHaveBeenCalled();
  });

  it("returns 401 when the auth server rejects the token", async () => {
    const gateDeps = deps(null);
    const response = await createJarvisPwaHandler(gateDeps, "session")(request());
    expect(response.status).toBe(401);
    expect(await response.text()).toBe("");
  });

  it("gives anyone who is not allowlisted one 404, at AAL1 and at AAL2, on every jarvis path", async () => {
    const expected = await absent();
    for (const aal2 of [false, true]) {
      for (const route of ["session", "other"] as const) {
        const gateDeps = deps({ allowlisted: false, aal2 });
        const response = await createJarvisPwaHandler(gateDeps, route)(
          request("/api/jarvis/session?role=admin", { headers: { "x-jarvis-role": "platform_admin", authorization: `Bearer ${TOKEN}` } }),
        );
        const actual = await shape(response);
        expect(actual).toEqual(expected);
        expect(JSON.stringify(actual)).not.toContain(USER_ID);
      }
    }
  });

  it("asks an allowlisted AAL1 caller for AAL2 and returns no thread", async () => {
    const response = await createJarvisPwaHandler(deps({ allowlisted: true, aal2: false }), "session")(request());
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "aal2_required" });
  });

  it("loads an empty thread for an allowlisted AAL2 caller and nowhere else", async () => {
    const admitted = await createJarvisPwaHandler(deps({ allowlisted: true, aal2: true }), "session")(request());
    expect(admitted.status).toBe(200);
    expect(await admitted.json()).toEqual({ thread: { state: "empty" } });

    const posted = await createJarvisPwaHandler(deps({ allowlisted: true, aal2: true }), "session")(request("/api/jarvis/session", { method: "POST" }));
    const other = await createJarvisPwaHandler(deps({ allowlisted: true, aal2: true }), "other")(request("/api/jarvis/thread"));
    const expected = await absent();
    expect(await shape(posted)).toEqual(expected);
    expect(await shape(other)).toEqual(expected);
  });

  it("hides lookup failures behind the same 404 and never echoes the failure", async () => {
    const lookup = vi.fn(async () => {
      throw new Error(`boom ${CANARY}`);
    });
    const response = await createJarvisPwaHandler({ enabled: true, lookup }, "session")(request());
    const body = await response.text();
    expect(response.status).toBe(404);
    expect(body).toBe("Not found\n");
    expect(body).not.toContain(CANARY);
  });
});

describe("Jarvis PWA upstream", () => {
  function install(options: { userStatus?: number; user?: unknown; admin?: unknown; aal2?: unknown }) {
    const calls: { pathname: string; authorization: string | null; apikey: string | null }[] = [];
    const send = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      const headers = new Headers(init?.headers);
      calls.push({
        pathname: url.pathname,
        authorization: headers.get("authorization"),
        apikey: headers.get("apikey"),
      });
      expect(headers.get("authorization")).not.toContain(CANARY);
      expect(headers.get("apikey")).not.toBe(CANARY);
      if (url.pathname === "/auth/v1/user") {
        return new Response(JSON.stringify(options.user ?? { message: "no" }), { status: options.userStatus ?? 401 });
      }
      if (url.pathname.endsWith("/api_get_is_platform_admin")) return Response.json(options.admin ?? false);
      if (url.pathname.endsWith("/current_user_has_aal2")) return Response.json(options.aal2 ?? false);
      return new Response("no", { status: 404 });
    });
    return { send, calls, handler: (route: JarvisPwaRoute) => createJarvisPwaHandler(createJarvisPwaDeps(ENV, send), route) };
  }

  it("checks the platform admin allowlist and AAL2 on the server for a real user", async () => {
    const upstream = install({ userStatus: 200, user: { id: USER_ID, email: "person@example.invalid" }, admin: true, aal2: true });
    const response = await upstream.handler("session")(request());
    expect(response.status).toBe(200);
    const body = await response.json() as { thread: { state: string } };
    expect(body).toEqual({ thread: { state: "empty" } });
    expect(JSON.stringify(body)).not.toContain("person@example.invalid");
    expect(upstream.calls.map((call) => call.pathname)).toEqual([
      "/auth/v1/user",
      "/rest/v1/rpc/api_get_is_platform_admin",
      "/rest/v1/rpc/current_user_has_aal2",
    ]);
    expect(upstream.calls.every((call) => call.apikey === "synthetic-anon-key")).toBe(true);
  });

  it("still asks both checks when the allowlist says no, and treats non-boolean answers as no", async () => {
    for (const admin of [false, "true", 1, { allowlisted: true }, null]) {
      const upstream = install({ userStatus: 200, user: { id: USER_ID }, admin, aal2: true });
      const response = await upstream.handler("session")(request("/api/jarvis/session", {
        headers: { authorization: `Bearer ${TOKEN}`, "x-jarvis-role": "admin" },
      }));
      expect(response.status).toBe(404);
      expect(upstream.calls.map((call) => call.pathname)).toEqual([
        "/auth/v1/user",
        "/rest/v1/rpc/api_get_is_platform_admin",
        "/rest/v1/rpc/current_user_has_aal2",
      ]);
    }
  });

  it("returns 403 aal2_required only after the allowlist admits and AAL2 is not exactly true", async () => {
    const upstream = install({ userStatus: 200, user: { id: USER_ID }, admin: true, aal2: "aal2" });
    const response = await upstream.handler("session")(request());
    expect(await response.json()).toEqual({ error: "aal2_required" });
  });

  it("maps a rejected token to 401 and does not call the allowlist", async () => {
    const upstream = install({ userStatus: 401 });
    const response = await upstream.handler("session")(request());
    expect(response.status).toBe(401);
    expect(upstream.calls.map((call) => call.pathname)).toEqual(["/auth/v1/user"]);
  });

  it("maps an upstream failure to the same 404 and does not echo it", async () => {
    const send = vi.fn(async () => {
      throw new Error(CANARY);
    });
    const response = await createJarvisPwaHandler(createJarvisPwaDeps(ENV, send), "session")(request());
    const body = await response.text();
    expect(response.status).toBe(404);
    expect(body).not.toContain(CANARY);
  });

  it("refuses a non-https Supabase URL without calling the network", async () => {
    const send = vi.fn();
    const response = await createJarvisPwaHandler(
      createJarvisPwaDeps({ ...ENV, SUPABASE_URL: "http://database.invalid" }, send),
      "session",
    )(request());
    expect(response.status).toBe(404);
    expect(send).not.toHaveBeenCalled();
  });
});

describe("Jarvis PWA deployment wiring", () => {
  it("sends /api/jarvis/session to the gate and every other jarvis path to the miss handler, ahead of the SPA fallback", () => {
    const config = JSON.parse(readFileSync(new URL("../../vercel.json", import.meta.url), "utf8")) as {
      rewrites: { source: string; destination: string }[];
    };
    const fallback = config.rewrites.findIndex((entry) => entry.source === "/(.*)");
    const session = config.rewrites.findIndex((entry) => entry.source === "/api/jarvis/session");
    const root = config.rewrites.findIndex((entry) => entry.source === "/api/jarvis");
    const rest = config.rewrites.findIndex((entry) => entry.source === "/api/jarvis/:path*");
    expect(session).toBeGreaterThanOrEqual(0);
    expect(session).toBeLessThan(rest);
    expect(rest).toBeLessThan(fallback);
    expect(root).toBeGreaterThanOrEqual(0);
    expect(root).toBeLessThan(fallback);
    expect(config.rewrites[session].destination).toBe("/api/jarvis/gate");
    expect(config.rewrites[rest].destination).toBe("/api/jarvis/miss");
  });

  it("serves the session document from the gate module and a uniform 404 from the miss module", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      if (url.pathname === "/auth/v1/user") return Response.json({ id: USER_ID });
      if (url.pathname.endsWith("/api_get_is_platform_admin")) return Response.json(false);
      if (url.pathname.endsWith("/current_user_has_aal2")) return Response.json(true);
      return new Response("no", { status: 404 });
    }));
    vi.stubEnv("JARVIS_PWA_ENABLED", "1");
    vi.stubEnv("SUPABASE_URL", "https://database.invalid");
    vi.stubEnv("SUPABASE_ANON_KEY", "synthetic-anon-key");
    const denied = await gate.fetch(request());
    const unknown = await miss.fetch(request("/api/jarvis/thread"));
    expect(await shape(denied)).toEqual(await shape(unknown));
    expect(denied.status).toBe(404);
  });
});
