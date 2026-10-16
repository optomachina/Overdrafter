// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import {
  AgentApiKeyRepositoryError,
  createAgentApiKeyRepositoryFromClient,
  type AgentApiKeyRpcClient,
} from "./supabase-repository";

const KEY_ID = "00000000-0000-4000-8000-0000008311a1";
const ORG = "00000000-0000-4000-8000-0000008310a0";

function client(data: unknown, error: { message: string } | null = null) {
  const rpc = vi.fn(async () => ({ data, error }));
  return { rpc, repository: createAgentApiKeyRepositoryFromClient({ rpc } as AgentApiKeyRpcClient) };
}

describe("Supabase agent API key repository", () => {
  it("looks a key up by prefix only and parses the row", async () => {
    const { rpc, repository } = client({
      id: KEY_ID, orgId: ORG, keyHash: "a".repeat(64), scopes: ["quotes:read"],
      expiresAt: "2027-01-01T00:00:00+00:00", revokedAt: null,
    });
    const record = await repository.getByPrefix("0123456789abcdef");
    expect(rpc).toHaveBeenCalledWith("api_service_get_agent_api_key", { p_key_prefix: "0123456789abcdef" });
    expect(record).toEqual({
      id: KEY_ID, orgId: ORG, keyHash: "a".repeat(64), scopes: ["quotes:read"],
      expiresAt: new Date("2027-01-01T00:00:00Z"), revokedAt: null,
    });
  });

  it("returns null for an unknown prefix", async () => {
    expect(await client(null).repository.getByPrefix("0123456789abcdef")).toBeNull();
  });

  it.each([
    [{ id: KEY_ID, orgId: ORG, keyHash: "a".repeat(64), scopes: ["admin"], expiresAt: "2027-01-01T00:00:00Z", revokedAt: null }],
    [{ id: KEY_ID, orgId: ORG, keyHash: "a".repeat(64), scopes: [], expiresAt: "2027-01-01T00:00:00Z", revokedAt: null }],
    [{ id: KEY_ID, orgId: ORG, keyHash: "a".repeat(64), scopes: ["quotes:read"], expiresAt: null, revokedAt: null }],
    [{ id: KEY_ID, orgId: ORG, keyHash: "a".repeat(64), scopes: ["quotes:read"], expiresAt: "2027-01-01T00:00:00Z", revokedAt: "bad" }],
    [["not", "a", "record"]],
  ])("fails closed on a malformed row %#", async (data) => {
    await expect(client(data).repository.getByPrefix("0123456789abcdef")).rejects.toBeInstanceOf(AgentApiKeyRepositoryError);
  });

  it("admits a use with rate-limit parameters and parses the decision", async () => {
    const { rpc, repository } = client({ allowed: false, result: "rate_limited_org", retryAfterSeconds: 12 });
    const decision = await repository.admitUse({ keyId: KEY_ID, endpoint: "quotes.read", windowSeconds: 60, perKeyLimit: 60, perOrgLimit: 300 });
    expect(rpc).toHaveBeenCalledWith("api_service_admit_agent_api_key_use", {
      p_key_id: KEY_ID, p_endpoint: "quotes.read", p_window_seconds: 60, p_key_limit: 60, p_org_limit: 300,
    });
    expect(decision).toEqual({ allowed: false, result: "rate_limited_org", retryAfterSeconds: 12 });
  });

  it.each([
    [{ allowed: true, result: "revoked", retryAfterSeconds: 0 }],
    [{ allowed: false, result: "something_else", retryAfterSeconds: 0 }],
    [{ allowed: true, result: "allowed", retryAfterSeconds: -1 }],
  ])("fails closed on an inconsistent admit decision %#", async (data) => {
    await expect(
      client(data).repository.admitUse({ keyId: KEY_ID, endpoint: "quotes.read", windowSeconds: 60, perKeyLimit: 1, perOrgLimit: 1 }),
    ).rejects.toBeInstanceOf(AgentApiKeyRepositoryError);
  });

  it("records a refusal by key id, endpoint and result only", async () => {
    const { rpc, repository } = client(null);
    await repository.recordRefusal({ keyId: KEY_ID, endpoint: "quotes.read", result: "invalid_secret" });
    expect(rpc).toHaveBeenCalledWith("api_service_record_agent_api_key_refusal", {
      p_key_id: KEY_ID, p_endpoint: "quotes.read", p_result: "invalid_secret",
    });
  });

  it("wraps RPC errors in a fixed message that does not echo the upstream text", async () => {
    const error = await client(null, { message: "permission denied for function" }).repository
      .getByPrefix("0123456789abcdef")
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AgentApiKeyRepositoryError);
    expect((error as Error).message).toBe("The agent API key persistence boundary is unavailable.");
  });
});
