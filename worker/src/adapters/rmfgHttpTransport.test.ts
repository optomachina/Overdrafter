// @vitest-environment node

import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { LIVE_AUTOMATION_VENDORS } from "../types.js";
import { createRmfgHttpTransport, RMFG_API_ORIGIN } from "./rmfgHttpTransport.js";
import { runRmfgQuoteOnly, type RmfgQuoteInput } from "./rmfgQuoteTransport.js";

const API_KEY = "synthetic-key-not-a-secret";
const input: RmfgQuoteInput = {
  file: { name: "synthetic.step", bytes: new Uint8Array([1, 2, 3]) },
  quantity: 10,
  selections: { "part-a": { materialId: "catalog-stock-a" } },
  analyzeKey: "analysis-synthetic-1", quoteKey: "quote-synthetic-1",
};
const design = {
  id: "design-synthetic", status: "ready",
  parts: [{ id: "part-a", analysis_status: "ready", instance_count: 2, suggested_process: "sheet_metal" }],
};
const readyQuote = {
  id: "quote-synthetic", status: "ready", currency: "usd", requirements: [],
  items: [{ design_id: "design-synthetic", quantity: 10, status: "ready",
    unit_amount_cents: 1250, amount_cents: 12500, requirements: [],
    dfm: { design_id: "design-synthetic", status: "ready", requirements: [],
      configuration: { parts: [{ part_id: "part-a", material_id: "catalog-stock-a" }] },
      parts: [{ part_id: "part-a", status: "ready", issues: [] }] } }],
};

type Seen = { method: string; url: string; authorization: string | undefined; idempotency: string | undefined };
let server: Server | undefined;

async function stub(handler: (request: IncomingMessage, seen: Seen[]) => { status: number; body: unknown }) {
  const seen: Seen[] = [];
  server = createServer((request, response) => {
    seen.push({ method: request.method ?? "", url: request.url ?? "",
      authorization: request.headers.authorization, idempotency: request.headers["idempotency-key"] as string | undefined });
    request.resume();
    request.on("end", () => {
      const reply = handler(request, seen);
      response.writeHead(reply.status, { "content-type": "application/json" });
      response.end(JSON.stringify(reply.body));
    });
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  return { seen, baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

const happyPath = (request: IncomingMessage) => {
  if (request.url === "/v1/analyze") return { status: 202, body: design };
  if (request.url === "/v1/materials") return { status: 200, body: { data: [{ id: "catalog-stock-a" }], has_more: false } };
  if (request.url === "/v1/quotes") return { status: 201, body: readyQuote };
  return { status: 404, body: {} };
};

afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = undefined;
});

describe("RMFG HTTP transport against a local stub", () => {
  it("runs the documented quote path with a bearer key and idempotency keys only", async () => {
    const { seen, baseUrl } = await stub(happyPath);
    const transport = createRmfgHttpTransport({ apiKey: API_KEY, baseUrl });
    const outcome = await runRmfgQuoteOnly(input, transport);
    expect(outcome).toMatchObject({ state: "ready", offer: { totalPriceUsd: 125, currency: "USD" } });
    expect(seen.map((entry) => `${entry.method} ${entry.url}`)).toEqual([
      "POST /v1/analyze", "GET /v1/materials", "POST /v1/quotes",
    ]);
    expect(seen.every((entry) => entry.authorization === `Bearer ${API_KEY}`)).toBe(true);
    expect(seen[0].idempotency).toBe("analysis-synthetic-1");
    expect(seen[2].idempotency).toBe("quote-synthetic-1");
    expect(JSON.stringify(outcome)).not.toContain(API_KEY);
    expect(transport.blockedReason()).toBeNull();
  });

  it.each([[401, "authorization_required"], [403, "authorization_required"], [429, "rate_limited"]] as const)(
    "stops on HTTP %i and never retries or makes another request",
    async (status, reason) => {
      const { seen, baseUrl } = await stub(() => ({ status, body: { error: "synthetic" } }));
      const transport = createRmfgHttpTransport({ apiKey: API_KEY, baseUrl });
      const first = await runRmfgQuoteOnly(input, transport);
      expect(first).toMatchObject({ state: "error", reason });
      expect(seen).toHaveLength(1);
      expect(transport.blockedReason()).toBe(reason);
      const second = await runRmfgQuoteOnly({ ...input, analyzeKey: "analysis-2", quoteKey: "quote-2" }, transport);
      expect(second.state).toBe("error");
      expect(seen).toHaveLength(1);
    },
  );

  it("enforces the daily quote cap locally and resets on a new UTC day", async () => {
    const { seen, baseUrl } = await stub(happyPath);
    let clock = new Date("2026-10-12T10:00:00Z");
    const transport = createRmfgHttpTransport({ apiKey: API_KEY, baseUrl, dailyQuoteCap: 2, now: () => clock });
    for (const n of [1, 2]) {
      expect((await runRmfgQuoteOnly({ ...input, analyzeKey: `a${n}`, quoteKey: `q${n}` }, transport)).state).toBe("ready");
    }
    const requestsAtCap = seen.length;
    const over = await runRmfgQuoteOnly({ ...input, analyzeKey: "a3", quoteKey: "q3" }, transport);
    expect(over).toMatchObject({ state: "error", reason: "rate_limited" });
    expect(seen).toHaveLength(requestsAtCap);
    clock = new Date("2026-10-13T00:00:01Z");
    expect((await runRmfgQuoteOnly({ ...input, analyzeKey: "a4", quoteKey: "q4" }, transport)).state).toBe("ready");
  });

  it("makes no request while the kill switch or export block callback is set", async () => {
    const { seen, baseUrl } = await stub(happyPath);
    const transport = createRmfgHttpTransport({ apiKey: API_KEY, baseUrl, isBlocked: () => true });
    expect((await runRmfgQuoteOnly(input, transport)).state).toBe("error");
    expect(seen).toHaveLength(0);
  });

  it("refuses redirects instead of following them with the key", async () => {
    const { seen, baseUrl } = await stub(() => ({ status: 200, body: {} }));
    server!.removeAllListeners("request");
    server!.on("request", (request, response) => {
      seen.push({ method: request.method ?? "", url: request.url ?? "", authorization: request.headers.authorization, idempotency: undefined });
      response.writeHead(302, { location: "http://127.0.0.1:1/elsewhere" });
      response.end();
    });
    const transport = createRmfgHttpTransport({ apiKey: API_KEY, baseUrl });
    expect((await runRmfgQuoteOnly(input, transport)).state).toBe("error");
    expect(seen).toHaveLength(1);
  });

  it("validates the key and pins the origin", () => {
    expect(() => createRmfgHttpTransport({ apiKey: "" })).toThrow("API key");
    expect(() => createRmfgHttpTransport({ apiKey: "a\nb" })).toThrow("API key");
    expect(() => createRmfgHttpTransport({ apiKey: API_KEY, baseUrl: "https://example.com" })).toThrow("origin");
    expect(() => createRmfgHttpTransport({ apiKey: API_KEY, baseUrl: "http://api.rmfg.com" })).toThrow("origin");
    expect(() => createRmfgHttpTransport({ apiKey: API_KEY, baseUrl: RMFG_API_ORIGIN })).not.toThrow();
    expect(LIVE_AUTOMATION_VENDORS).not.toContain("rmfg");
  });
});
