// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createOverdrafterChatGptServer, type ChatGptReadDependencies } from "./tools";

const jobId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const orgId = "22222222-2222-4222-8222-222222222222";
const otherId = "33333333-3333-4333-8333-333333333333";
const principal = { userId: otherId, organizationId: orgId, scopes: ["overdrafter:read"] };
const snapshot = {
  organizationId: orgId,
  job: { id: jobId, status: "quoting", privateFilename: "secret.step" },
  quotes: [{ id: otherId, vendor: "Synthetic vendor", status: "pending", quantity: 1,
    totalPriceUsd: null, leadTimeBusinessDays: null, rawPayload: "secret" }],
  token: "secret-token",
};
const close: Array<() => Promise<void>> = [];
afterEach(async () => { await Promise.all(close.splice(0).map((fn) => fn())); });
async function connect(overrides: Partial<ChatGptReadDependencies> = {}, disabledDefault = false) {
  const dependencies = {
    isEnabled: vi.fn(() => true),
    resolvePrincipal: vi.fn(async () => principal),
    readAuthorizedJob: vi.fn(async () => snapshot),
    ...overrides,
  };
  const server = createOverdrafterChatGptServer(disabledDefault ? undefined : dependencies);
  const client = new Client({ name: "synthetic-test", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  close.push(() => client.close(), () => server.close());
  return { client, dependencies };
}

describe("Overdrafter MCP foundation", () => {
  it("negotiates MCP and exposes only the two read-only tools", async () => {
    const { client } = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual(["get_job_status", "list_job_quotes"]);
    for (const tool of tools) {
      expect(tool.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false, openWorldHint: false });
      expect(tool.inputSchema.additionalProperties).toBe(false);
      expect(tool._meta?.securitySchemes).toEqual([{ type: "oauth2", scopes: ["overdrafter:read"] }]);
    }
  });
  it("is disabled by default and never resolves or reads when explicitly disabled", async () => {
    const { client } = await connect({}, true);
    expect(await client.callTool({ name: "get_job_status", arguments: { jobId } })).toMatchObject({ isError: true });
    const explicit = await connect({ isEnabled: () => false });
    await explicit.client.callTool({ name: "get_job_status", arguments: { jobId } });
    expect(explicit.dependencies.resolvePrincipal).not.toHaveBeenCalled();
    expect(explicit.dependencies.readAuthorizedJob).not.toHaveBeenCalled();
  });
  it("sanitizes flag failures before authorization or data access", async () => {
    const { client, dependencies } = await connect({ isEnabled: () => { throw new Error("secret flag"); } });
    const result = await client.callTool({ name: "get_job_status", arguments: { jobId } });
    expect(result).toMatchObject({ isError: true, content: [{ type: "text", text: "Overdrafter data is temporarily unavailable." }] });
    expect(dependencies.resolvePrincipal).not.toHaveBeenCalled();
    expect(dependencies.readAuthorizedJob).not.toHaveBeenCalled();
  });
  it("returns a minimal quote projection preserving unknown values", async () => {
    const { client } = await connect();
    const result = await client.callTool({ name: "list_job_quotes", arguments: { jobId } });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toEqual({ job: { id: jobId, status: "quoting" }, quotes: [{
      id: otherId, vendor: "Synthetic vendor", status: "pending", quantity: 1,
      totalPriceUsd: null, leadTimeBusinessDays: null,
    }] });
    expect(JSON.stringify(result)).not.toContain("secret");
    const status = await client.callTool({ name: "get_job_status", arguments: { jobId } });
    expect(status.structuredContent).toEqual({ job: { id: jobId, status: "quoting" } });
  });
  it.each([null, { ...principal, scopes: [] }, { ...principal, userId: "invalid" }])("rejects unauthorized principals before data access: %j", async (resolved) => {
    const { client, dependencies } = await connect({ resolvePrincipal: async () => resolved });
    expect(await client.callTool({ name: "list_job_quotes", arguments: { jobId } })).toMatchObject({ isError: true });
    expect(dependencies.readAuthorizedJob).not.toHaveBeenCalled();
  });
  it("canonicalizes valid uppercase job UUIDs", async () => {
    const { client, dependencies } = await connect();
    const result = await client.callTool({ name: "get_job_status", arguments: { jobId: jobId.toUpperCase() } });
    expect(result.isError).not.toBe(true);
    expect(dependencies.readAuthorizedJob).toHaveBeenCalledWith(principal, jobId);
  });
  it("reauthorizes every call so revocation is effective", async () => {
    const resolvePrincipal = vi.fn().mockResolvedValueOnce(principal).mockResolvedValueOnce(null);
    const { client, dependencies } = await connect({ resolvePrincipal });
    expect((await client.callTool({ name: "get_job_status", arguments: { jobId } })).isError).not.toBe(true);
    expect((await client.callTool({ name: "get_job_status", arguments: { jobId } })).isError).toBe(true);
    expect(dependencies.readAuthorizedJob).toHaveBeenCalledTimes(1);
  });
  it.each([{ jobId: "bad" }, { jobId, organizationId: otherId }, { jobId, token: "injected" }])("rejects invalid input before reads: %j", async (args) => {
    const { client, dependencies } = await connect();
    expect(await client.callTool({ name: "get_job_status", arguments: args })).toMatchObject({ isError: true });
    expect(dependencies.readAuthorizedJob).not.toHaveBeenCalled();
  });
  it.each([null, { ...snapshot, organizationId: otherId }, { ...snapshot, job: { id: otherId, status: "quoting" } }])("does not distinguish missing and out-of-scope jobs", async (record) => {
    const { client } = await connect({ readAuthorizedJob: async () => record });
    expect(await client.callTool({ name: "list_job_quotes", arguments: { jobId } })).toMatchObject({
      isError: true, content: [{ type: "text", text: "Job not found or unavailable." }],
    });
  });
  it("contains malformed/upstream failures without leaking data", async () => {
    for (const readAuthorizedJob of [async () => ({ ...snapshot, quotes: [{ totalPriceUsd: -1 }] }), async () => { throw new Error("secret token"); }]) {
      const { client } = await connect({ readAuthorizedJob });
      const result = await client.callTool({ name: "list_job_quotes", arguments: { jobId } });
      expect(result).toMatchObject({ isError: true });
      expect(JSON.stringify(result)).not.toContain("secret");
      expect(result.structuredContent).toBeUndefined();
    }
  });
});
