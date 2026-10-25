// @vitest-environment node

import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { REVIEWED_PROVIDER_DISPATCH_ENVELOPES } from "../providerDispatchEnvelope.js";
import { createRmfgHttpTransport, resetRmfgProcessStateForTests, RMFG_API_ORIGIN } from "./rmfgHttpTransport.js";
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
  amount_subtotal_cents: 12500, amount_shipping_cents: null, amount_tax_cents: null, amount_total_cents: 12500,
  items: [{ design_id: "design-synthetic", quantity: 10, status: "ready",
    unit_amount_cents: 1250, amount_cents: 12500, requirements: [],
    line_items: [{ part_id: "part-a", process: "sheet_metal", quantity: 20, material_id: "catalog-stock-a",
      unit_amount_cents: 625, amount_cents: 12500 }],
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

beforeEach(() => resetRmfgProcessStateForTests());

afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = undefined;
});

describe("RMFG HTTP transport against a local stub", () => {
  it("runs the documented quote path with a bearer key and idempotency keys only", async () => {
    const { seen, baseUrl } = await stub(happyPath);
    const transport = createRmfgHttpTransport({ apiKey: API_KEY, baseUrl, allowInsecureLoopbackForTests: true });
    const outcome = await runRmfgQuoteOnly(input, transport);
    expect(outcome).toMatchObject({ state: "ready", offer: { totalPriceUsd: 125, currency: "USD" } });
    expect(seen.map((entry) => `${entry.method} ${entry.url}`)).toEqual([
      "POST /v1/analyze", "GET /v1/materials", "POST /v1/quotes",
    ]);
    expect(seen.every((entry) => entry.authorization === `Bearer ${API_KEY}`)).toBe(true);
    expect(seen[0].idempotency).toBe("analysis-synthetic-1");
    expect(seen[2].idempotency).toMatch(/^quote-synthetic-1-[0-9a-f]{16}$/);
    expect(JSON.stringify(outcome)).not.toContain(API_KEY);
    expect(transport.blockedReason()).toBeNull();
  });

  it.each([[401, "authorization_required"], [402, "account_action_required"], [403, "authorization_required"],
    [429, "rate_limited"]] as const)(
    "stops on HTTP %i and never retries or makes another request",
    async (status, reason) => {
      const { seen, baseUrl } = await stub(() => ({ status, body: { error: "synthetic" } }));
      const transport = createRmfgHttpTransport({ apiKey: API_KEY, baseUrl, allowInsecureLoopbackForTests: true });
      const first = await runRmfgQuoteOnly(input, transport);
      expect(first).toMatchObject({ state: "error", reason });
      expect(seen).toHaveLength(1);
      expect(transport.blockedReason()).toBe(reason);
      const second = await runRmfgQuoteOnly({ ...input, analyzeKey: "analysis-2", quoteKey: "quote-2" }, transport);
      expect(second.state).toBe("error");
      expect(seen).toHaveLength(1);
    },
  );

  it("polls a queued design without asking RMFG to create a review link", async () => {
    let polls = 0;
    const { seen, baseUrl } = await stub((request) => {
      if (request.url === "/v1/analyze") return { status: 202, body: { ...design, status: "queued" } };
      if (request.url?.startsWith("/v1/designs/")) {
        polls += 1;
        return { status: 200, body: polls < 2 ? { ...design, status: "processing" } : design };
      }
      return happyPath(request);
    });
    const transport = createRmfgHttpTransport({ apiKey: API_KEY, baseUrl, allowInsecureLoopbackForTests: true });
    expect((await runRmfgQuoteOnly(input, transport)).state).toBe("ready");
    expect(seen.map((entry) => `${entry.method} ${entry.url}`)).toEqual([
      "POST /v1/analyze",
      "GET /v1/designs/design-synthetic?include_review_link=false",
      "GET /v1/designs/design-synthetic?include_review_link=false",
      "GET /v1/materials", "POST /v1/quotes",
    ]);
  });

  it("keeps no daily quote cap of its own; the shared supplier settings gate counts dispatches (OVD-829)", async () => {
    const { seen, baseUrl } = await stub(happyPath);
    const transport = createRmfgHttpTransport({ apiKey: API_KEY, baseUrl, allowInsecureLoopbackForTests: true });
    for (let n = 1; n <= 21; n += 1) {
      expect((await runRmfgQuoteOnly({ ...input, analyzeKey: `a${n}`, quoteKey: `q${n}` }, transport)).state).toBe("ready");
    }
    expect(seen.filter((request) => request.url === "/v1/analyze")).toHaveLength(21);
  });

  it("makes no request while the kill switch or export block callback is set", async () => {
    const { seen, baseUrl } = await stub(happyPath);
    const transport = createRmfgHttpTransport({ apiKey: API_KEY, baseUrl, allowInsecureLoopbackForTests: true, isBlocked: () => true });
    expect((await runRmfgQuoteOnly(input, transport)).state).toBe("error");
    expect(seen).toHaveLength(0);
  });

  it("refuses redirects instead of following them with the key", async () => {
    const target = await stub(() => ({ status: 200, body: {} }));
    const targetServer = server!;
    server = undefined;
    const origin = await stub(() => ({ status: 200, body: {} }));
    const originServer = server!;
    originServer.removeAllListeners("request");
    originServer.on("request", (request, response) => {
      origin.seen.push({ method: request.method ?? "", url: request.url ?? "", authorization: request.headers.authorization, idempotency: undefined });
      response.writeHead(302, { location: `${target.baseUrl}/elsewhere` });
      response.end();
    });
    try {
      const transport = createRmfgHttpTransport({ apiKey: API_KEY, baseUrl: origin.baseUrl, allowInsecureLoopbackForTests: true });
      expect((await runRmfgQuoteOnly(input, transport)).state).toBe("error");
      expect(origin.seen).toHaveLength(1);
      expect(target.seen).toHaveLength(0);
    } finally {
      await new Promise<void>((resolve) => targetServer.close(() => resolve()));
    }
  });

  it("rejects a hostile request path before any request is made", async () => {
    const { seen, baseUrl } = await stub(happyPath);
    const transport = createRmfgHttpTransport({ apiKey: API_KEY, baseUrl, allowInsecureLoopbackForTests: true });
    for (const path of [".attacker.example/", "//attacker.example/v1/quotes/x", "/v1/checkout", "/v1/quotes/a/b"]) {
      const outcome = await transport({ endpoint: "quote_status", method: "GET", path, quoteId: "x" });
      expect(outcome).toEqual({ status: 0, body: null });
    }
    expect(seen).toHaveLength(0);
  });

  it("validates the key and pins the origin", () => {
    expect(() => createRmfgHttpTransport({ apiKey: "" })).toThrow("API key");
    expect(() => createRmfgHttpTransport({ apiKey: "a\nb" })).toThrow("API key");
    expect(() => createRmfgHttpTransport({ apiKey: API_KEY, baseUrl: "https://example.com" })).toThrow("origin");
    expect(() => createRmfgHttpTransport({ apiKey: API_KEY, baseUrl: "http://api.rmfg.com" })).toThrow("origin");
    expect(() => createRmfgHttpTransport({ apiKey: API_KEY, baseUrl: RMFG_API_ORIGIN })).not.toThrow();
    // OVD-678 lists rmfg for live automation; its dispatch envelope stays unreviewed.
    expect(REVIEWED_PROVIDER_DISPATCH_ENVELOPES.some((reviewed) => reviewed.provider === "rmfg")).toBe(false);
  });

  it.each(["a\u0000b", "a\u007fb", "a\tb", "a\u0085b", " key", "key ", "key\n", "\u0000"])(
    "rejects API key %j with control characters or surrounding whitespace",
    (apiKey) => {
      expect(() => createRmfgHttpTransport({ apiKey })).toThrow("API key");
    },
  );

  it("requires https unless the explicit test flag is passed", () => {
    for (const baseUrl of ["http://127.0.0.1:8080", "http://localhost:8080"]) {
      expect(() => createRmfgHttpTransport({ apiKey: API_KEY, baseUrl })).toThrow("origin");
      expect(() => createRmfgHttpTransport({ apiKey: API_KEY, baseUrl, allowInsecureLoopbackForTests: true })).not.toThrow();
    }
    expect(() => createRmfgHttpTransport({
      apiKey: API_KEY, baseUrl: "http://api.rmfg.com", allowInsecureLoopbackForTests: true,
    })).toThrow("origin");
  });

  it("shares the block latch across transport instances", async () => {
    const { seen, baseUrl } = await stub(() => ({ status: 429, body: {} }));
    const first = createRmfgHttpTransport({ apiKey: API_KEY, baseUrl, allowInsecureLoopbackForTests: true });
    expect((await runRmfgQuoteOnly(input, first)).state).toBe("error");
    expect(seen).toHaveLength(1);
    const second = createRmfgHttpTransport({ apiKey: API_KEY, baseUrl, allowInsecureLoopbackForTests: true });
    expect(second.blockedReason()).toBe("rate_limited");
    expect((await runRmfgQuoteOnly({ ...input, analyzeKey: "a2", quoteKey: "q2" }, second)).state).toBe("error");
    expect(seen).toHaveLength(1);
    resetRmfgProcessStateForTests();
    expect(second.blockedReason()).toBeNull();
  });

  it("awaits an async isBlocked hook before every request and reads it fresh", async () => {
    const { seen, baseUrl } = await stub(happyPath);
    let blocked = false;
    let reads = 0;
    const transport = createRmfgHttpTransport({
      apiKey: API_KEY, baseUrl, allowInsecureLoopbackForTests: true,
      isBlocked: async () => { reads += 1; await Promise.resolve(); return blocked; },
    });
    expect((await runRmfgQuoteOnly(input, transport)).state).toBe("ready");
    expect(reads).toBe(seen.length);
    blocked = true;
    const before = seen.length;
    expect((await runRmfgQuoteOnly({ ...input, analyzeKey: "a2", quoteKey: "q2" }, transport)).state).toBe("error");
    expect(seen).toHaveLength(before);
  });
});
