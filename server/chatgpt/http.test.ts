// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createLocalChatGptHttp } from "./http";
import { startLocalChatGptDemo } from "./local-demo";
import { createSyntheticChatGptReader, syntheticJobId } from "./synthetic-fixture";

const origin = "http://127.0.0.1:8123";
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
const request = (overrides: RequestInit = {}, url = `${origin}/mcp`) => new Request(url, {
  method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }), ...overrides,
});

describe("local HTTP MCP composition", () => {
  it("starts disabled and rejects non-loopback configuration", async () => {
    const authorize = vi.fn(async () => createSyntheticChatGptReader());
    const handler = createLocalChatGptHttp({ origin, isEnabled: () => false, authorize });
    expect((await handler(request())).status).toBe(404);
    expect(authorize).not.toHaveBeenCalled();
    expect(() => createLocalChatGptHttp({ origin: "https://overdrafter.com", isEnabled: () => true, authorize })).toThrow();
    await expect(startLocalChatGptDemo()).rejects.toThrow();
  });
  it("rejects cross-origin, host spoofing and missing auth before data access", async () => {
    const authorize = vi.fn(async () => null);
    const handler = createLocalChatGptHttp({ origin, isEnabled: () => true, authorize });
    for (const headers of ([{ origin: "https://evil.test" }, { host: "evil.test" }, { forwarded: "host=evil.test" }] as Record<string, string>[])) {
      expect((await handler(request({ headers }))).status).toBe(403);
    }
    expect(authorize).not.toHaveBeenCalled();
    expect((await handler(request())).status).toBe(401);
  });
  it("bounds input and sanitizes infrastructure failures", async () => {
    const handler = createLocalChatGptHttp({ origin, isEnabled: () => true, authorize: async () => createSyntheticChatGptReader() });
    expect((await handler(request({ body: "x".repeat(65537) }))).status).toBe(413);
    expect((await handler(request({ body: "{" }))).status).toBe(400);
    expect((await handler(request({ method: "GET", body: undefined }))).status).toBe(405);
    const broken = createLocalChatGptHttp({ origin, isEnabled: () => { throw new Error("secret"); }, authorize: async () => null });
    const response = await broken(request());
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("secret");
  });
  it("rejects a never-ending body even after it contains valid JSON", async () => {
    vi.useFakeTimers();
    try {
      const dependencies = createSyntheticChatGptReader();
      dependencies.resolvePrincipal = vi.fn(dependencies.resolvePrincipal);
      const handler = createLocalChatGptHttp({ origin, isEnabled: () => true, authorize: async () => dependencies });
      const body = new ReadableStream<Uint8Array>({ start(controller) {
        controller.enqueue(new TextEncoder().encode(JSON.stringify({ jsonrpc: "2.0", id: 1,
          method: "tools/call", params: { name: "get_job_status", arguments: { jobId: syntheticJobId } } })));
      } });
      const pending = handler(request({ body, duplex: "half" } as RequestInit));
      await vi.advanceTimersByTimeAsync(5001);
      expect((await pending).status).toBe(408);
      expect(dependencies.resolvePrincipal).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });
  it("negotiates over real loopback HTTP through the existing-service reader to synthetic quotes", async () => {
    const demo = await startLocalChatGptDemo(true);
    const client = new Client({ name: "local-e2e", version: "1" });
    cleanups.push(() => client.close(), demo.close);
    const transport = new StreamableHTTPClientTransport(new URL(`${demo.origin}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${demo.bearer}` } },
    });
    await client.connect(transport);
    expect((await client.listTools()).tools).toHaveLength(2);
    const result = await client.callTool({ name: "list_job_quotes", arguments: { jobId: syntheticJobId } });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({ quotes: [{ totalPriceUsd: 125, leadTimeBusinessDays: 7 }] });
    expect(JSON.stringify(result)).not.toContain("must not escape");
    expect((await client.callTool({ name: "get_job_status", arguments: { jobId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee" } })).isError).toBe(true);
    expect((await fetch(`${demo.origin}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status).toBe(401);
  });
});
