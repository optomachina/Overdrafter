// @vitest-environment node

import { describe, expect, it, vi } from "vitest";

import {
  buildProviderKillRequest,
  parseProviderKillArgs,
  ProviderKillUsageError,
  resolveAdminSession,
  runProviderKill,
} from "./provider-kill.mjs";

const jwt = (role) => `h.${Buffer.from(JSON.stringify({ role })).toString("base64url")}.s`;
const env = {
  SUPABASE_URL: "https://project.example.test/",
  SUPABASE_PUBLISHABLE_KEY: jwt("anon"),
  OVERDRAFTER_ADMIN_ACCESS_TOKEN: jwt("authenticated"),
};
const okResponse = (body) => ({ ok: true, status: 200, text: async () => JSON.stringify(body) });

describe("provider:kill argument parsing (OVD-722)", () => {
  it("parses a provider flip and a global flip", () => {
    expect(parseProviderKillArgs(["fictiv", "--on", "--reason", "cease and desist received"])).toEqual({
      list: false, target: { kind: "provider", provider: "fictiv" }, engaged: true, reason: "cease and desist received", yes: false,
    });
    expect(parseProviderKillArgs(["--all", "--off", "--reason=incident resolved now", "--yes"])).toMatchObject({
      target: { kind: "global" }, engaged: false, yes: true,
    });
    expect(parseProviderKillArgs(["--list"])).toEqual({ list: true });
  });

  it.each([
    [["fictiv", "--on"]],
    [["fictiv", "--on", "--reason", "short"]],
    [["fictiv", "--on", "--reason", "         padded   "]],
    [["--on", "--reason", "cease and desist received"]],
    [["fictiv", "--reason", "cease and desist received"]],
    [["fictiv", "--on", "--off", "--reason", "cease and desist received"]],
    [["fictiv", "--all", "--on", "--reason", "cease and desist received"]],
    [["Fictiv;drop", "--on", "--reason", "cease and desist received"]],
    [["--list", "fictiv"]],
    [["fictiv", "--on", "--reason", "cease and desist received", "--force"]],
  ])("refuses %j", (argv) => {
    expect(() => parseProviderKillArgs(argv)).toThrow(ProviderKillUsageError);
  });
});

describe("provider:kill uses the admin's own session, never the service role (OVD-722)", () => {
  it("refuses a service_role key or token", () => {
    expect(() => resolveAdminSession({ ...env, SUPABASE_PUBLISHABLE_KEY: jwt("service_role") })).toThrow(/service_role/);
    expect(() => resolveAdminSession({ ...env, OVERDRAFTER_ADMIN_ACCESS_TOKEN: jwt("service_role") })).toThrow(/service_role/);
    expect(() => resolveAdminSession({ ...env, SUPABASE_SERVICE_ROLE_KEY: env.OVERDRAFTER_ADMIN_ACCESS_TOKEN })).toThrow(/service_role/);
  });

  it("refuses a missing or anonymous session", () => {
    expect(() => resolveAdminSession({ ...env, OVERDRAFTER_ADMIN_ACCESS_TOKEN: undefined })).toThrow(ProviderKillUsageError);
    expect(() => resolveAdminSession({ ...env, OVERDRAFTER_ADMIN_ACCESS_TOKEN: jwt("anon") })).toThrow(/authenticated/);
  });

  it("maps commands to the admin RPCs", () => {
    expect(buildProviderKillRequest(parseProviderKillArgs(["weerg", "--on", "--reason", "cease and desist received"]))).toEqual({
      rpc: "api_admin_set_provider_kill_switch",
      body: { p_provider: "weerg", p_engaged: true, p_reason: "cease and desist received" },
    });
    expect(buildProviderKillRequest(parseProviderKillArgs(["--all", "--on", "--reason", "cease and desist received"]))).toEqual({
      rpc: "api_admin_set_global_kill_switch", body: { p_engaged: true, p_reason: "cease and desist received" },
    });
  });
});

describe("provider:kill confirmation and call (OVD-722)", () => {
  it("does nothing unless the provider key is typed back", async () => {
    const fetchImpl = vi.fn();
    const result = await runProviderKill(["fictiv", "--on", "--reason", "cease and desist received"], {
      env, fetchImpl, confirm: async () => "nope", log: () => undefined,
    });
    expect(result).toEqual({ changed: false });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("calls the RPC with the admin bearer token after confirmation", async () => {
    const fetchImpl = vi.fn(async () => okResponse({ provider: "fictiv", engaged: true }));
    const result = await runProviderKill(["fictiv", "--on", "--reason", "cease and desist received"], {
      env, fetchImpl, confirm: async () => "fictiv", log: () => undefined,
    });
    expect(result).toMatchObject({ changed: true, data: { provider: "fictiv", engaged: true } });
    expect(fetchImpl).toHaveBeenCalledWith("https://project.example.test/rest/v1/rpc/api_admin_set_provider_kill_switch",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ authorization: `Bearer ${env.OVERDRAFTER_ADMIN_ACCESS_TOKEN}` }),
        body: JSON.stringify({ p_provider: "fictiv", p_engaged: true, p_reason: "cease and desist received" }),
      }));
  });

  it("surfaces a database refusal (for example a non-admin) as an error", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 403, text: async () => JSON.stringify({ message: "platform_admin_required" }) }));
    await expect(runProviderKill(["--all", "--on", "--reason", "cease and desist received", "--yes"], {
      env, fetchImpl, log: () => undefined,
    })).rejects.toThrow(/platform_admin_required/);
  });
});
