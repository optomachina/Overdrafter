// @vitest-environment node

import { randomBytes } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMobileAuthHandler } from "../server/mobile-auth/handler";
import { loadMobileAuthRuntimeConfig } from "../server/mobile-auth/runtime-config";
import { createSupabaseMobileAuthRepository } from "../server/mobile-auth/supabase-repository";
import { createTransferSessionVerifier } from "../server/mobile-auth/supabase-transfer";

// The entry adapter owns only lazy, cached wiring and a fail-closed 503. The
// four collaborators are replaced so these tests pin the adapter itself:
// when it initialises, what it passes on, what it caches, and what it leaks.
vi.mock("../server/mobile-auth/runtime-config", () => ({
  loadMobileAuthRuntimeConfig: vi.fn(),
}));
vi.mock("../server/mobile-auth/supabase-repository", () => ({
  createSupabaseMobileAuthRepository: vi.fn(),
}));
vi.mock("../server/mobile-auth/supabase-transfer", () => ({
  createTransferSessionVerifier: vi.fn(),
}));
vi.mock("../server/mobile-auth/handler", () => ({
  createMobileAuthHandler: vi.fn(),
}));

const SECRET = "sb_secret_DO_NOT_LEAK_0123456789";
const SUPABASE_ORIGIN = "https://project.supabase.co";
const START_URL = "https://app.example.com/auth/mobile/start";

const config = {
  supabaseOrigin: SUPABASE_ORIGIN,
  supabaseServiceRoleKey: SECRET,
  supabasePublishableKey: "publishable-key",
};
const repository = { tag: "repository" };
const transferVerifier = { tag: "transfer-verifier" };

type InnerHandler = (request: Request) => Promise<Response>;

function startRequest(): Request {
  return new Request(START_URL);
}

function okHandler(): InnerHandler {
  return vi.fn(async () => new Response("ok", { status: 200 }));
}

// The entry caches its handler at module scope, so every test needs a fresh
// module instance. Mocked modules keep their registry across resets.
async function freshEntry() {
  vi.resetModules();
  return (await import("./mobile-auth")).default;
}

function completeEnvironment(): Record<string, string> {
  return {
    MOBILE_AUTH_APP_ORIGIN: "https://app.example.com",
    MOBILE_AUTH_ENVIRONMENT: "production",
    MOBILE_AUTH_KEYRING: JSON.stringify({
      1: randomBytes(32).toString("base64url"),
    }),
    MOBILE_AUTH_CURRENT_KEY_VERSION: "1",
    MOBILE_AUTH_ALLOW_INSECURE_LOCALHOST: "0",
    SUPABASE_URL: SUPABASE_ORIGIN,
    SUPABASE_PUBLISHABLE_KEY: "publishable-key",
    VITE_SUPABASE_URL: SUPABASE_ORIGIN,
    VITE_SUPABASE_PUBLISHABLE_KEY: "publishable-key",
    SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
    CRON_SECRET: randomBytes(32).toString("base64url"),
  };
}

async function withEnvironment<T>(
  values: Record<string, string | undefined>,
  run: () => Promise<T>,
): Promise<T> {
  const previous = new Map<string, string | undefined>();
  for (const [name, value] of Object.entries(values)) {
    previous.set(name, process.env[name]);
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
  try {
    return await run();
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  }
}

let errorSpy: ReturnType<typeof vi.spyOn>;
let otherConsoleSpies: ReturnType<typeof vi.spyOn>[];

// Every output channel, not only console.error: a leak through log, info,
// warn or debug would be just as much a credential disclosure.
function otherConsoleOutput(): unknown[][] {
  return otherConsoleSpies.flatMap((spy) => spy.mock.calls);
}

// vite.config.ts sets mockReset/restoreMocks, so implementations are
// installed per test rather than once at module scope.
beforeEach(() => {
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  otherConsoleSpies = (["log", "info", "warn", "debug"] as const).map((method) =>
    vi.spyOn(console, method).mockImplementation(() => {}),
  );
  vi.mocked(loadMobileAuthRuntimeConfig).mockReturnValue(config as never);
  vi.mocked(createSupabaseMobileAuthRepository).mockReturnValue(
    repository as never,
  );
  vi.mocked(createTransferSessionVerifier).mockReturnValue(
    transferVerifier as never,
  );
  vi.mocked(createMobileAuthHandler).mockReturnValue(okHandler());
});

describe("Vercel mobile authentication function", () => {
  it("exports the Web-standard fetch adapter expected by the Node runtime", async () => {
    const mobileAuth = await freshEntry();

    expect(mobileAuth).toEqual({
      fetch: expect.any(Function),
    });
  });

  describe("initialisation", () => {
    it("initialises configuration, repository and transfer verifier once and reuses the cached handler", async () => {
      const inner = okHandler();
      vi.mocked(createMobileAuthHandler).mockReturnValue(inner);
      const mobileAuth = await freshEntry();

      await mobileAuth.fetch(startRequest());
      await mobileAuth.fetch(startRequest());

      expect(loadMobileAuthRuntimeConfig).toHaveBeenCalledTimes(1);
      expect(loadMobileAuthRuntimeConfig).toHaveBeenCalledWith(process.env);
      // The service-role key goes to the repository only; the transfer
      // verifier receives the publishable key.
      expect(createSupabaseMobileAuthRepository).toHaveBeenCalledTimes(1);
      expect(createSupabaseMobileAuthRepository).toHaveBeenCalledWith(
        SUPABASE_ORIGIN,
        SECRET,
      );
      expect(createTransferSessionVerifier).toHaveBeenCalledTimes(1);
      expect(createTransferSessionVerifier).toHaveBeenCalledWith(
        SUPABASE_ORIGIN,
        "publishable-key",
      );
      expect(createMobileAuthHandler).toHaveBeenCalledTimes(1);
      expect(createMobileAuthHandler).toHaveBeenCalledWith({
        config,
        repository,
        transferVerifier,
      });
      expect(inner).toHaveBeenCalledTimes(2);
    });

    it("initialises once under simultaneous first requests", async () => {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      vi.mocked(createMobileAuthHandler).mockReturnValue(
        vi.fn(async () => {
          await gate;
          return new Response("ok", { status: 200 });
        }),
      );
      const mobileAuth = await freshEntry();

      const pending = Array.from({ length: 5 }, () =>
        mobileAuth.fetch(startRequest()),
      );
      release();
      const responses = await Promise.all(pending);

      expect(responses.map((response) => response.status)).toEqual([
        200, 200, 200, 200, 200,
      ]);
      expect(loadMobileAuthRuntimeConfig).toHaveBeenCalledTimes(1);
      expect(createMobileAuthHandler).toHaveBeenCalledTimes(1);
    });

    it("does not cache a failed configuration load and recovers once configuration is valid", async () => {
      vi.mocked(loadMobileAuthRuntimeConfig).mockImplementationOnce(() => {
        throw new Error(`MOBILE_AUTH_KEYRING is missing or invalid. ${SECRET}`);
      });
      const mobileAuth = await freshEntry();

      const first = await mobileAuth.fetch(startRequest());

      expect(first.status).toBe(503);
      expect(createSupabaseMobileAuthRepository).not.toHaveBeenCalled();
      expect(createMobileAuthHandler).not.toHaveBeenCalled();

      const second = await mobileAuth.fetch(startRequest());

      expect(second.status).toBe(200);
      expect(loadMobileAuthRuntimeConfig).toHaveBeenCalledTimes(2);
    });

    it("does not retain a partially initialised handler when construction fails", async () => {
      vi.mocked(createMobileAuthHandler)
        .mockImplementationOnce(() => {
          throw new Error("construction failed");
        })
        .mockReturnValue(okHandler());
      const mobileAuth = await freshEntry();

      expect((await mobileAuth.fetch(startRequest())).status).toBe(503);
      expect((await mobileAuth.fetch(startRequest())).status).toBe(200);

      expect(loadMobileAuthRuntimeConfig).toHaveBeenCalledTimes(2);
      expect(createSupabaseMobileAuthRepository).toHaveBeenCalledTimes(2);
    });

    it("keeps the cached configuration until the next deployment", async () => {
      const mobileAuth = await freshEntry();
      await mobileAuth.fetch(startRequest());

      // Key rotation is deploy-driven: a warm instance never re-reads the
      // environment, so a changed variable must not rebuild the handler.
      await withEnvironment({ MOBILE_AUTH_CURRENT_KEY_VERSION: "99" }, () =>
        mobileAuth.fetch(startRequest()),
      );

      expect(loadMobileAuthRuntimeConfig).toHaveBeenCalledTimes(1);
      expect(createMobileAuthHandler).toHaveBeenCalledTimes(1);
    });
  });

  describe("delegation", () => {
    it("passes the request through and returns the delegated response unchanged", async () => {
      const delegated = new Response("<p>continue</p>", {
        status: 303,
        headers: {
          Location: "https://app.example.com/auth/mobile/callback#code=abc",
          "Set-Cookie": "__Host-ovd-mobile-auth=value; Path=/; Secure; HttpOnly",
        },
      });
      const inner = vi.fn(async () => delegated);
      vi.mocked(createMobileAuthHandler).mockReturnValue(inner);
      const mobileAuth = await freshEntry();
      const request = new Request(
        "https://app.example.com/auth/mobile/complete",
        { method: "POST", body: "a=b" },
      );

      const response = await mobileAuth.fetch(request);

      expect(inner).toHaveBeenCalledWith(request);
      // Identity, not equality: rebuilding the Response risks dropping the
      // cookie, redirect or CSP headers the inner handler set.
      expect(response).toBe(delegated);
      expect(errorSpy).not.toHaveBeenCalled();
      expect(otherConsoleOutput()).toEqual([]);
    });

    it.each([
      [
        "rejects",
        () =>
          vi.fn(async () => {
            throw new Error(`upstream ${SECRET}`);
          }),
      ],
      [
        "throws synchronously",
        () =>
          vi.fn(() => {
            throw new Error(`upstream ${SECRET}`);
          }),
      ],
      [
        "rejects with a TypeError (the fetch failed class)",
        () =>
          vi.fn(async () => {
            throw new TypeError(`upstream fetch failed ${SECRET}`);
          }),
      ],
      [
        "rejects with a non-Error value",
        () =>
          // The catch-all must also hold for a non-Error rejection.
          vi.fn(() => Promise.reject({ detail: `upstream ${SECRET}` })),
      ],
    ])("redacts delegation failures when the handler %s", async (_label, build) => {
      vi.mocked(createMobileAuthHandler).mockReturnValue(build() as never);
      const mobileAuth = await freshEntry();

      const response = await mobileAuth.fetch(
        new Request("https://app.example.com/auth/mobile/bootstrap", {
          method: "POST",
        }),
      );
      const body = await response.text();

      expect(response.status).toBe(503);
      expect(body).not.toContain(SECRET);
      expect(body).not.toContain("upstream");
      expect(errorSpy.mock.calls).toEqual([
        ["mobile-auth: request handling failed"],
      ]);
      expect(JSON.stringify(errorSpy.mock.calls)).not.toContain(SECRET);
      expect(otherConsoleOutput()).toEqual([]);

      // A request-time failure leaves the cached handler in place.
      await mobileAuth.fetch(startRequest());
      expect(createMobileAuthHandler).toHaveBeenCalledTimes(1);
    });
  });

  describe("service unavailable response", () => {
    it("returns a redacted, script-free 503 when the keyring is missing", async () => {
      const mobileAuth = await freshEntry();
      const actual = await vi.importActual<
        typeof import("../server/mobile-auth/runtime-config")
      >("../server/mobile-auth/runtime-config");
      vi.mocked(loadMobileAuthRuntimeConfig).mockImplementation(
        actual.loadMobileAuthRuntimeConfig,
      );
      const environment = completeEnvironment();

      // Control: the same environment loads when the keyring is present, so
      // the 503 below is caused by the missing keyring and nothing else.
      expect(() => actual.loadMobileAuthRuntimeConfig(environment)).not.toThrow();

      const response = await withEnvironment(
        { ...environment, MOBILE_AUTH_KEYRING: undefined },
        () => mobileAuth.fetch(startRequest()),
      );
      const body = await response.text();

      expect(response.status).toBe(503);
      expect(response.headers.get("cache-control")).toContain("no-store");
      expect(response.headers.get("content-security-policy")).toContain(
        "script-src 'none'",
      );
      expect(body).toContain("Sign in is temporarily unavailable");
      expect(body).not.toContain("MOBILE_AUTH_KEYRING");
      expect(body).not.toContain("SUPABASE_SERVICE_ROLE_KEY");
      expect(errorSpy.mock.calls).toEqual([
        ["mobile-auth: request handling failed"],
      ]);
    });

    it("serves a script-free, non-cacheable 503 that cannot advance authentication", async () => {
      vi.mocked(loadMobileAuthRuntimeConfig).mockImplementation(() => {
        throw new Error("configuration unavailable");
      });
      const mobileAuth = await freshEntry();

      const response = await mobileAuth.fetch(
        new Request("https://app.example.com/auth/mobile/bootstrap", {
          method: "POST",
        }),
      );
      const body = await response.text();

      expect(response.status).toBe(503);
      expect([...response.headers.keys()].sort()).toEqual([
        "cache-control",
        "content-security-policy",
        "content-type",
        "pragma",
        "referrer-policy",
        "x-content-type-options",
        "x-frame-options",
      ]);
      expect(response.headers.get("cache-control")).toBe(
        "no-store, max-age=0",
      );
      expect(response.headers.get("pragma")).toBe("no-cache");
      expect(response.headers.get("content-type")).toBe(
        "text/html; charset=utf-8",
      );
      expect(response.headers.get("referrer-policy")).toBe("no-referrer");
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      expect(response.headers.get("x-frame-options")).toBe("DENY");
      // The whole policy, so weakening any single directive (including
      // base-uri, img-src, style-src and object-src) fails here.
      expect(response.headers.get("content-security-policy")).toBe(
        "default-src 'none'; script-src 'none'; style-src 'none'; connect-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; img-src 'none'; object-src 'none';",
      );
      // No cookie, redirect, script, or "ready" signal: a native client
      // cannot mistake this page for a completed sign-in.
      expect(response.headers.get("set-cookie")).toBeNull();
      expect(response.headers.get("location")).toBeNull();
      expect(body).not.toMatch(/<script/i);
      expect(body).not.toContain("ready");
    });
  });
});
