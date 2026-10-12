import type { RmfgQuoteRequest, RmfgQuoteTransport } from "./rmfgQuoteTransport.js";

/**
 * Default-off HTTP transport for the RMFG REST quote path (OVD-678). It is not
 * registered in any adapter registry and nothing constructs it in production.
 * It implements only the closed `RmfgQuoteRequest` union, so cart, checkout and
 * order endpoints are unreachable. The API key is held in a closure, sent only
 * as a bearer header to the pinned host, and never logged or returned.
 */
export const RMFG_HTTP_TRANSPORT_REVISION = "rmfg-http-transport.v1" as const;
export const RMFG_API_ORIGIN = "https://api.rmfg.com";
export const RMFG_DAILY_QUOTE_CAP = 20;
const REQUEST_TIMEOUT_MS = 10_000;

export type RmfgBlockReason = "authorization_required" | "rate_limited";

export type RmfgHttpTransportOptions = {
  /** Resolved from Secret Manager by the caller; never read from a default or logged. */
  apiKey: string;
  /** Local stub servers only: must be a loopback http origin. Defaults to the pinned RMFG origin. */
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  dailyQuoteCap?: number;
  /** Optional operator kill switch (OVD-722) and export control block (OVD-723). Checked before every call. */
  isBlocked?: () => boolean;
};

export type RmfgHttpTransport = RmfgQuoteTransport & {
  /** Set after any 401, 403 or 429; every later call is refused without a request. */
  blockedReason(): RmfgBlockReason | null;
  quotesStartedToday(): number;
};

function resolveOrigin(baseUrl: string | undefined): string {
  if (baseUrl === undefined) return RMFG_API_ORIGIN;
  const url = new URL(baseUrl);
  const loopback = url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "localhost");
  if (!loopback && url.origin !== RMFG_API_ORIGIN) {
    throw new Error("RMFG transport base URL must be the RMFG API origin or a loopback stub.");
  }
  return url.origin;
}

function allowedPath(request: RmfgQuoteRequest, pathname: string): boolean {
  switch (request.endpoint) {
    case "analyze": return pathname === "/v1/analyze";
    case "design": return /^\/v1\/designs\/[^/]+$/.test(pathname);
    case "materials": return pathname === "/v1/materials";
    case "tube_profiles": return pathname === "/v1/tube-profiles";
    case "quote": return pathname === "/v1/quotes";
    case "quote_status": return /^\/v1\/quotes\/[^/]+$/.test(pathname);
  }
}

function dayKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function buildRequest(request: RmfgQuoteRequest, apiKey: string): { path: string; init: RequestInit } {
  const headers: Record<string, string> = { authorization: `Bearer ${apiKey}`, accept: "application/json" };
  switch (request.endpoint) {
    case "analyze": {
      const form = new FormData();
      form.set("file", new Blob([request.file.bytes as BlobPart]), request.file.name);
      headers["idempotency-key"] = request.idempotencyKey;
      return { path: "/v1/analyze", init: { method: "POST", headers, body: form } };
    }
    case "quote":
      headers["idempotency-key"] = request.idempotencyKey;
      headers["content-type"] = "application/json";
      return { path: "/v1/quotes", init: { method: "POST", headers, body: JSON.stringify(request.body) } };
    case "materials":
    case "tube_profiles": {
      const query = request.cursor ? `?cursor=${encodeURIComponent(request.cursor)}` : "";
      return { path: `${request.path}${query}`, init: { method: "GET", headers } };
    }
    case "design":
    case "quote_status":
      return { path: request.path, init: { method: "GET", headers } };
  }
}

export function createRmfgHttpTransport(options: RmfgHttpTransportOptions): RmfgHttpTransport {
  const apiKey = options.apiKey;
  if (typeof apiKey !== "string" || apiKey.trim().length === 0 || /[\r\n]/.test(apiKey)) {
    throw new Error("RMFG API key is missing or malformed.");
  }
  const origin = resolveOrigin(options.baseUrl);
  const doFetch = options.fetchImpl ?? fetch;
  const now = options.now ?? (() => new Date());
  const cap = options.dailyQuoteCap ?? RMFG_DAILY_QUOTE_CAP;
  let blocked: RmfgBlockReason | null = null;
  let quoteDay = dayKey(now());
  let quotesToday = 0;

  const transport: RmfgHttpTransport = Object.assign(
    async (request: RmfgQuoteRequest) => {
      if (blocked) return { status: blocked === "rate_limited" ? 429 : 403, body: null };
      if (options.isBlocked?.()) return { status: 403, body: null };
      if (request.endpoint === "analyze") {
        const today = dayKey(now());
        if (today !== quoteDay) { quoteDay = today; quotesToday = 0; }
        // One analyze starts one quote attempt, so the cap counts attempts, not polls.
        if (quotesToday >= cap) return { status: 429, body: null };
        quotesToday += 1;
      }
      const { path, init } = buildRequest(request, apiKey);
      const url = new URL(path, `${origin}/`);
      if (!path.startsWith("/") || url.origin !== origin || !allowedPath(request, url.pathname)) {
        return { status: 0, body: null };
      }
      const response = await doFetch(url, {
        ...init, redirect: "error", signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (response.status === 401 || response.status === 403) blocked = "authorization_required";
      if (response.status === 429) blocked = "rate_limited";
      let body: unknown = null;
      try { body = await response.json(); } catch { body = null; }
      return { status: response.status, body };
    },
    {
      blockedReason: () => blocked,
      quotesStartedToday: () => quotesToday,
    },
  );
  return transport;
}
