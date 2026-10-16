import type { RmfgQuoteRequest, RmfgQuoteTransport } from "./rmfgQuoteTransport.js";
import {
  claimProviderDailyQuote,
  isValidProviderDailyQuoteCap,
  PROVIDER_DAILY_QUOTE_CAP_DEFAULT,
  providerDailyQuotesToday,
  resetProviderDailyQuoteCapsForTests,
  type ProviderDailyQuoteCap,
} from "../providerDailyQuoteCap.js";

/**
 * Default-off HTTP transport for the RMFG REST quote path (OVD-678). Only the
 * default-off RmfgAdapter (rmfg.ts) constructs it, after every dispatch gate.
 * It implements only the closed `RmfgQuoteRequest` union, so cart, checkout and
 * order endpoints are unreachable. The API key is held in a closure, sent only
 * as a bearer header to the pinned host, and never logged or returned.
 */
export const RMFG_HTTP_TRANSPORT_REVISION = "rmfg-http-transport.v1" as const;
export const RMFG_API_ORIGIN = "https://api.rmfg.com";
/** OVD-828: only the default; the per-supplier admin setting can raise it or make it unlimited. */
export const RMFG_DEFAULT_DAILY_QUOTE_CAP = PROVIDER_DAILY_QUOTE_CAP_DEFAULT;
const PROVIDER_KEY = "rmfg";
const REQUEST_TIMEOUT_MS = 10_000;

export type RmfgBlockReason = "authorization_required" | "rate_limited";

export type RmfgHttpTransportOptions = {
  /** Resolved from Secret Manager by the caller; never read from a default or logged. */
  apiKey: string;
  /** Defaults to the pinned RMFG origin. A loopback http stub is accepted only with `allowInsecureLoopbackForTests`. */
  baseUrl?: string;
  /** Test and fixture callers only. Production construction must leave this unset so the key is never sent over plain http. */
  allowInsecureLoopbackForTests?: boolean;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  /** Any positive integer or "unlimited"; the adapter passes the setting it read for this dispatch. */
  dailyQuoteCap?: ProviderDailyQuoteCap;
  /** Optional operator kill switch (OVD-722) and export control block (OVD-723). Awaited before every call, so it may read a database row. */
  isBlocked?: () => boolean | Promise<boolean>;
};

export type RmfgHttpTransport = RmfgQuoteTransport & {
  /** Set after any 401, 403 or 429; every later call is refused without a request. */
  blockedReason(): RmfgBlockReason | null;
  quotesStartedToday(): number;
};

/**
 * The block latch and the daily attempt count (the shared
 * `providerDailyQuoteCap` count) are per process, keyed by provider, so
 * constructing a second transport cannot reset either one.
 */
type ProviderState = { blocked: RmfgBlockReason | null };
const providerState = new Map<string, ProviderState>();

function stateFor(provider: string): ProviderState {
  let state = providerState.get(provider);
  if (!state) {
    state = { blocked: null };
    providerState.set(provider, state);
  }
  return state;
}

/** Test hook: clears the process wide block latch and daily count. */
export function resetRmfgProcessStateForTests(): void {
  for (const state of providerState.values()) {
    state.blocked = null;
  }
  resetProviderDailyQuoteCapsForTests();
}

function resolveOrigin(baseUrl: string | undefined, allowInsecureLoopback: boolean): string {
  if (baseUrl === undefined) return RMFG_API_ORIGIN;
  const url = new URL(baseUrl);
  const loopback = allowInsecureLoopback && url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "localhost");
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

function hasControlCharacter(value: string): boolean {
  for (const char of value) {
    const code = char.codePointAt(0)!;
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return true;
  }
  return false;
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
  if (typeof apiKey !== "string" || apiKey.length === 0 || apiKey !== apiKey.trim() || hasControlCharacter(apiKey)) {
    throw new Error("RMFG API key is missing or malformed: it must be non empty, with no control characters or surrounding whitespace.");
  }
  const origin = resolveOrigin(options.baseUrl, options.allowInsecureLoopbackForTests === true);
  const doFetch = options.fetchImpl ?? fetch;
  const now = options.now ?? (() => new Date());
  const cap = options.dailyQuoteCap ?? RMFG_DEFAULT_DAILY_QUOTE_CAP;
  if (!isValidProviderDailyQuoteCap(cap)) {
    throw new Error('RMFG daily quote cap must be a positive integer or "unlimited".');
  }
  const state = stateFor(PROVIDER_KEY);

  const transport: RmfgHttpTransport = Object.assign(
    async (request: RmfgQuoteRequest) => {
      if (state.blocked) return { status: state.blocked === "rate_limited" ? 429 : 403, body: null };
      if (options.isBlocked && (await options.isBlocked())) return { status: 403, body: null };
      if (state.blocked) return { status: state.blocked === "rate_limited" ? 429 : 403, body: null };
      if (request.endpoint === "analyze") {
        // One analyze starts one quote attempt, so the cap counts attempts, not polls.
        if (claimProviderDailyQuote(PROVIDER_KEY, cap, now())) return { status: 429, body: null };
      }
      const { path, init } = buildRequest(request, apiKey);
      const url = new URL(path, `${origin}/`);
      if (!path.startsWith("/") || url.origin !== origin || !allowedPath(request, url.pathname)) {
        return { status: 0, body: null };
      }
      const response = await doFetch(url, {
        ...init, redirect: "error", signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (response.status === 401 || response.status === 403) state.blocked = "authorization_required";
      if (response.status === 429) state.blocked = "rate_limited";
      let body: unknown = null;
      try { body = await response.json(); } catch { body = null; }
      return { status: response.status, body };
    },
    {
      blockedReason: () => state.blocked,
      quotesStartedToday: () => providerDailyQuotesToday(PROVIDER_KEY, now()),
    },
  );
  return transport;
}
