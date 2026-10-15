// @vitest-environment node

import { describe, expect, it, vi } from "vitest";

import {
  buildProviderKillRequest,
  main,
  parseProviderKillArgs,
  ProviderKillUsageError,
  redactSecret,
  resolveServiceKey,
  resolveServiceSession,
  runProviderKill,
} from "./provider-kill.mjs";

// Test-only placeholders; no real credential is ever read here.
const jwt = (role) => `h.${Buffer.from(JSON.stringify({ role })).toString("base64url")}.s`;
const SERVICE_KEY = "sb_secret_TEST_ONLY_NOT_A_REAL_SECRET";
const env = {
  SUPABASE_URL: "https://project.example.test/",
  SUPABASE_SERVICE_ROLE_KEY: SERVICE_KEY,
};
const OP = ["--operator", "oncall-blaine"];
const okResponse = (body) => ({ ok: true, status: 200, text: async () => JSON.stringify(body) });

describe("provider:kill argument parsing (OVD-722, OVD-771)", () => {
  it("parses a provider flip and a global flip", () => {
    expect(parseProviderKillArgs(["fictiv", "--on", "--reason", "cease and desist received", ...OP])).toEqual({
      list: false,
      target: { kind: "provider", provider: "fictiv" },
      engaged: true,
      reason: "cease and desist received",
      operator: "oncall-blaine",
      yes: false,
      secretName: null,
      secretProject: null,
    });
    expect(parseProviderKillArgs(["--all", "--off", "--reason=incident resolved now", "--operator= Blaine W ", "--yes"])).toMatchObject({
      target: { kind: "global" }, engaged: false, operator: "Blaine W", yes: true,
    });
    expect(parseProviderKillArgs(["--list"])).toEqual({ list: true, secretName: null, secretProject: null });
    expect(parseProviderKillArgs(["--list", "--secret-name", "supabase-service-role-key", "--secret-project=overdrafter-worker-9133"]))
      .toEqual({ list: true, secretName: "supabase-service-role-key", secretProject: "overdrafter-worker-9133" });
  });

  it.each([
    [["fictiv", "--on", ...OP]],
    [["fictiv", "--on", "--reason", "short", ...OP]],
    [["fictiv", "--on", "--reason", "         padded   ", ...OP]],
    [["--on", "--reason", "cease and desist received", ...OP]],
    [["fictiv", "--reason", "cease and desist received", ...OP]],
    [["fictiv", "--on", "--off", "--reason", "cease and desist received", ...OP]],
    [["fictiv", "--all", "--on", "--reason", "cease and desist received", ...OP]],
    [["Fictiv;drop", "--on", "--reason", "cease and desist received", ...OP]],
    [["--list", "fictiv"]],
    [["--list", ...OP]],
    [["fictiv", "--on", "--reason", "cease and desist received", "--force", ...OP]],
    // OVD-771: the operator is required, non-blank, and printable.
    [["fictiv", "--on", "--reason", "cease and desist received"]],
    [["fictiv", "--on", "--reason", "cease and desist received", "--operator", "  "]],
    [["fictiv", "--on", "--reason", "cease and desist received", "--operator"]],
    [["fictiv", "--on", "--reason", "cease and desist received", "--operator", "x"]],
    [["fictiv", "--on", "--reason", "cease and desist received", "--operator", "bad\nname"]],
    [["fictiv", "--on", "--reason", "cease and desist received", "--operator", "o".repeat(121)]],
    [["--list", "--secret-name"]],
  ])("refuses %j", (argv) => {
    expect(() => parseProviderKillArgs(argv)).toThrow(ProviderKillUsageError);
  });
});

describe("provider:kill uses the service role, never an admin session (OVD-771)", () => {
  it("accepts an sb_secret key or a service_role JWT", () => {
    expect(resolveServiceSession(env, SERVICE_KEY)).toEqual({
      url: "https://project.example.test", apiKey: SERVICE_KEY, accessToken: SERVICE_KEY,
    });
    const legacy = jwt("service_role");
    expect(resolveServiceSession({ VITE_SUPABASE_URL: "https://project.example.test" }, legacy))
      .toMatchObject({ apiKey: legacy, accessToken: legacy });
  });

  it("refuses a missing URL, a publishable key, or a user session token", () => {
    expect(() => resolveServiceSession({}, SERVICE_KEY)).toThrow(/SUPABASE_URL/);
    expect(() => resolveServiceSession(env, jwt("anon"))).toThrow(/not a service role/);
    expect(() => resolveServiceSession(env, jwt("authenticated"))).toThrow(/not a service role/);
    expect(() => resolveServiceSession(env, "sb_publishable_abc")).toThrow(/not a service role/);
  });

  it("reads the key from SUPABASE_SERVICE_ROLE_KEY, or from Secret Manager by name", async () => {
    const readSecret = vi.fn(async () => `${SERVICE_KEY}\n`);
    await expect(resolveServiceKey({}, env, readSecret)).resolves.toBe(SERVICE_KEY);
    expect(readSecret).not.toHaveBeenCalled();

    // A secret name wins over the env key: it is the explicit choice.
    await expect(resolveServiceKey({ secretName: "supabase-service-role-key", secretProject: "overdrafter-worker-9133" }, env, readSecret))
      .resolves.toBe(SERVICE_KEY);
    expect(readSecret).toHaveBeenLastCalledWith("supabase-service-role-key", "overdrafter-worker-9133");
    await expect(resolveServiceKey({}, { OVERDRAFTER_SERVICE_ROLE_SECRET_NAME: "supabase-service-role-key" }, readSecret))
      .resolves.toBe(SERVICE_KEY);
    expect(readSecret).toHaveBeenLastCalledWith("supabase-service-role-key", null);
  });

  it("refuses an invalid secret name or project, and reports a failed read without gcloud output", async () => {
    const readSecret = vi.fn(async () => SERVICE_KEY);
    await expect(resolveServiceKey({ secretName: "bad name;rm" }, {}, readSecret)).rejects.toThrow(ProviderKillUsageError);
    await expect(resolveServiceKey({ secretName: "ok-name", secretProject: "Bad_Project" }, {}, readSecret)).rejects.toThrow(ProviderKillUsageError);
    expect(readSecret).not.toHaveBeenCalled();

    const failing = vi.fn(async () => {
      throw new Error(`gcloud stderr that must not be echoed ${SERVICE_KEY}`);
    });
    const error = await resolveServiceKey({ secretName: "supabase-service-role-key" }, {}, failing).catch((caught) => caught);
    expect(error.message).toMatch(/Could not read Secret Manager secret supabase-service-role-key/);
    expect(error.message).not.toContain(SERVICE_KEY);
    await expect(resolveServiceKey({ secretName: "empty" }, {}, async () => "  \n")).rejects.toThrow(/empty or malformed/);
  });

  it("ignores an admin access token entirely", async () => {
    const fetchImpl = vi.fn(async () => okResponse({ provider: "fictiv", engaged: true }));
    await runProviderKill(["fictiv", "--on", "--reason", "cease and desist received", ...OP, "--yes"], {
      env: { ...env, OVERDRAFTER_ADMIN_ACCESS_TOKEN: jwt("authenticated") }, fetchImpl, log: () => undefined,
    });
    expect(fetchImpl.mock.calls[0][1].headers.authorization).toBe(`Bearer ${SERVICE_KEY}`);
  });

  it("maps commands to the service RPCs with the operator", () => {
    expect(buildProviderKillRequest(parseProviderKillArgs(["weerg", "--on", "--reason", "cease and desist received", ...OP]))).toEqual({
      rpc: "api_service_set_provider_kill_switch",
      body: { p_provider: "weerg", p_engaged: true, p_reason: "cease and desist received", p_operator: "oncall-blaine" },
    });
    expect(buildProviderKillRequest(parseProviderKillArgs(["--all", "--on", "--reason", "cease and desist received", ...OP]))).toEqual({
      rpc: "api_service_set_global_kill_switch",
      body: { p_engaged: true, p_reason: "cease and desist received", p_operator: "oncall-blaine" },
    });
    expect(buildProviderKillRequest(parseProviderKillArgs(["--all", "--off", "--reason", "incident resolved now", ...OP]), 9)).toEqual({
      rpc: "api_service_set_global_kill_switch",
      body: { p_engaged: false, p_reason: "incident resolved now", p_operator: "oncall-blaine", p_expected_version: 9 },
    });
    expect(buildProviderKillRequest({ list: true })).toEqual({ rpc: "api_service_list_provider_kill_switches", body: {} });
  });
});

describe("provider:kill confirmation and call (OVD-722, OVD-771)", () => {
  it("does nothing unless the provider key is typed back", async () => {
    const fetchImpl = vi.fn();
    const lines = [];
    const result = await runProviderKill(["fictiv", "--on", "--reason", "cease and desist received", ...OP], {
      env, fetchImpl, confirm: async () => "nope", log: (line) => lines.push(line),
    });
    expect(result).toEqual({ changed: false });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(lines.join("\n")).toMatch(/operator: oncall-blaine/);
  });

  it("calls the service RPC with the service key after confirmation", async () => {
    const fetchImpl = vi.fn(async () => okResponse({ provider: "fictiv", engaged: true }));
    const result = await runProviderKill(["fictiv", "--on", "--reason", "cease and desist received", ...OP], {
      env, fetchImpl, confirm: async () => "fictiv", log: () => undefined,
    });
    expect(result).toMatchObject({ changed: true, data: { provider: "fictiv", engaged: true } });
    expect(fetchImpl).toHaveBeenCalledWith("https://project.example.test/rest/v1/rpc/api_service_set_provider_kill_switch",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ apikey: SERVICE_KEY, authorization: `Bearer ${SERVICE_KEY}` }),
        body: JSON.stringify({
          p_provider: "fictiv", p_engaged: true, p_reason: "cease and desist received", p_operator: "oncall-blaine",
        }),
      }));
  });

  it("engage sends no version and does not read state first", async () => {
    const fetchImpl = vi.fn(async () => okResponse({ provider: "fictiv", engaged: true }));
    await runProviderKill(["fictiv", "--on", "--reason", "cease and desist received", ...OP, "--yes"], {
      env, fetchImpl, log: () => undefined,
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).not.toHaveProperty("p_expected_version");
  });

  it("release reads the current row, shows it, and sends that version", async () => {
    const list = {
      schema: "provider-kill-switch-service.v1",
      global: { engaged: false, version: 2 },
      providers: [{
        provider: "fictiv", engaged: true, reason: "cease and desist received", changedBy: null, operator: "oncall-a",
        changedAt: "t", version: 6,
      }],
    };
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(okResponse(list))
      .mockResolvedValueOnce(okResponse({ provider: "fictiv", engaged: false, version: 7 }));
    const lines = [];
    await runProviderKill(["fictiv", "--off", "--reason", "counsel cleared the provider", ...OP], {
      env, fetchImpl, confirm: async () => "fictiv", log: (line) => lines.push(line),
    });
    expect(fetchImpl.mock.calls[0][0]).toMatch(/api_service_list_provider_kill_switches$/);
    expect(lines.join("\n")).toMatch(/ENGAGED since t by oncall-a \(version 6\)/);
    expect(JSON.parse(fetchImpl.mock.calls[1][1].body)).toEqual({
      p_provider: "fictiv",
      p_engaged: false,
      p_reason: "counsel cleared the provider",
      p_operator: "oncall-blaine",
      p_expected_version: 6,
    });
  });

  it("a stale release is reported, and an unreadable version changes nothing", async () => {
    const list = { providers: [{ provider: "fictiv", engaged: true, version: 6 }], global: { engaged: false, version: 0 } };
    const conflict = { ok: false, status: 400, text: async () => JSON.stringify({ message: "kill_switch_version_conflict" }) };
    const fetchImpl = vi.fn().mockResolvedValueOnce(okResponse(list)).mockResolvedValueOnce(conflict);
    await expect(runProviderKill(["fictiv", "--off", "--reason", "counsel cleared the provider", ...OP, "--yes"], {
      env, fetchImpl, log: () => undefined,
    })).rejects.toThrow(/changed after it was read/);

    const noVersion = vi.fn().mockResolvedValueOnce(okResponse({ providers: [{ provider: "fictiv", engaged: true }] }));
    await expect(runProviderKill(["fictiv", "--off", "--reason", "counsel cleared the provider", ...OP, "--yes"], {
      env, fetchImpl: noVersion, log: () => undefined,
    })).rejects.toThrow(/nothing changed/);
    expect(noVersion).toHaveBeenCalledOnce();
  });

  it("surfaces a database refusal as an error", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 400, text: async () => JSON.stringify({ message: "operator_required" }) }));
    await expect(runProviderKill(["--all", "--on", "--reason", "cease and desist received", ...OP, "--yes"], {
      env, fetchImpl, log: () => undefined,
    })).rejects.toThrow(/operator_required/);
  });

  it("points at the pending migration when the service RPC does not exist", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 404, text: async () => JSON.stringify({ message: "Could not find the function" }) }));
    await expect(runProviderKill(["--all", "--on", "--reason", "cease and desist received", ...OP, "--yes"], {
      env, fetchImpl, log: () => undefined,
    })).rejects.toThrow(/OVD-771 service kill switch migration/);
  });

  it("never sends a request when the service key is missing", async () => {
    const fetchImpl = vi.fn();
    await expect(runProviderKill(["--all", "--on", "--reason", "cease and desist received", ...OP, "--yes"], {
      env: { SUPABASE_URL: env.SUPABASE_URL }, fetchImpl, log: () => undefined,
    })).rejects.toThrow(ProviderKillUsageError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("provider:kill exit codes and redaction (OVD-771)", () => {
  const FLIP = ["fictiv", "--on", "--reason", "cease and desist received", ...OP, "--yes"];

  it("a missing key exits non-zero with a clear message and sends nothing", async () => {
    const fetchImpl = vi.fn();
    const stderr = vi.fn();
    const code = await main(FLIP, { env: { SUPABASE_URL: env.SUPABASE_URL }, fetchImpl, stderr, log: () => undefined });
    expect(code).toBe(2);
    expect(stderr.mock.calls.join("")).toMatch(/No service role key\. Set SUPABASE_SERVICE_ROLE_KEY, or pass --secret-name/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("redacts the key from error output when a response echoes it", async () => {
    const echo = { ok: false, status: 401, text: async () => JSON.stringify({ message: `Invalid API key ${SERVICE_KEY}` }) };
    const stderr = vi.fn();
    const code = await main(FLIP, { env, fetchImpl: vi.fn(async () => echo), stderr, log: () => undefined });
    expect(code).toBe(1);
    const output = stderr.mock.calls.join("");
    expect(output).toContain("Invalid API key [REDACTED]");
    expect(output).not.toContain(SERVICE_KEY);
  });

  it("redacts the key from logged output", async () => {
    const lines = [];
    const fetchImpl = vi.fn(async () => okResponse({ provider: "fictiv", engaged: true, note: SERVICE_KEY }));
    await runProviderKill(FLIP, { env, fetchImpl, log: (line) => lines.push(line) });
    expect(lines.join("\n")).not.toContain(SERVICE_KEY);
    expect(lines.join("\n")).toContain("[REDACTED]");
  });

  it("a key read from Secret Manager is sent but never printed", async () => {
    const lines = [];
    const stderr = vi.fn();
    const fetchImpl = vi.fn(async () => okResponse({ provider: "fictiv", engaged: true, operator: "oncall-blaine" }));
    const code = await main([...FLIP, "--secret-name", "supabase-service-role-key"], {
      env: { SUPABASE_URL: env.SUPABASE_URL },
      readSecret: async () => `${SERVICE_KEY}\n`,
      fetchImpl,
      stderr,
      log: (line) => lines.push(line),
    });
    expect(code).toBe(0);
    expect(fetchImpl).toHaveBeenCalledWith("https://project.example.test/rest/v1/rpc/api_service_set_provider_kill_switch",
      expect.objectContaining({
        headers: expect.objectContaining({ apikey: SERVICE_KEY, authorization: `Bearer ${SERVICE_KEY}` }),
        body: JSON.stringify({
          p_provider: "fictiv", p_engaged: true, p_reason: "cease and desist received", p_operator: "oncall-blaine",
        }),
      }));
    expect([...lines, ...stderr.mock.calls.flat()].join("\n")).not.toContain(SERVICE_KEY);
  });

  it("redactSecret replaces every occurrence and passes text through without a key", () => {
    expect(redactSecret(`a ${SERVICE_KEY} b ${SERVICE_KEY}`, SERVICE_KEY)).toBe("a [REDACTED] b [REDACTED]");
    expect(redactSecret("plain", undefined)).toBe("plain");
  });
});
