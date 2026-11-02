import type { RmfgQuoteRequest, RmfgQuoteTransport } from "./rmfgQuoteTransport.js";

/**
 * Default-off HTTP transport for the RMFG REST quote path (OVD-678). Only the
 * default-off RmfgAdapter (rmfg.ts) constructs it, after every dispatch gate.
 * It implements only the closed `RmfgQuoteRequest` union, so cart, checkout and
 * order endpoints are unreachable. The API key is held in a closure, sent only
 * as a bearer header to the pinned host, and never logged or returned.
 */
export const RMFG_HTTP_TRANSPORT_REVISION = "rmfg-http-transport.v1" as const;
export const RMFG_API_ORIGIN = "https://api.rmfg.com";
const PROVIDER_KEY = "rmfg";
/**
 * Kept under the quote runner's ten second budget for a whole step, which also
 * covers the kill switch read (two seconds at most). A production export
 * control recheck before analyze shares that budget too, so a slow one ends
 * the step as a transport error rather than leaving a request behind.
 */
const REQUEST_TIMEOUT_MS = 7_000;

export type RmfgBlockReason = "authorization_required" | "rate_limited" | "account_action_required";

export type RmfgHttpTransportOptions = {
  /** Resolved from Secret Manager by the caller; never read from a default or logged. */
  apiKey: string;
  /** Defaults to the pinned RMFG origin. A loopback http stub is accepted only with `allowInsecureLoopbackForTests`. */
  baseUrl?: string;
  /** Test and fixture callers only. Production construction must leave this unset so the key is never sent over plain http. */
  allowInsecureLoopbackForTests?: boolean;
  fetchImpl?: typeof fetch;
  /** Optional operator kill switch (OVD-722) and export control block (OVD-723). Awaited before every call, so it may read a database row. */
  isBlocked?: () => boolean | Promise<boolean>;
};

export type RmfgHttpTransport = RmfgQuoteTransport & {
  /** Set after any 401, 402, 403 or 429; every later call is refused without a request. */
  blockedReason(): RmfgBlockReason | null;
};

/**
 * The block latch is per process, keyed by provider, so constructing a second
 * transport cannot reset it. The daily quote cap is not here: the worker's
 * shared supplier settings gate (OVD-829) counts every dispatch durably.
 */
type ProviderState = { blocked: RmfgBlockReason | null };
const providerState = new Map<string, ProviderState>();

const BLOCKED_STATUS: Record<RmfgBlockReason, number> = {
  authorization_required: 403, rate_limited: 429, account_action_required: 402,
};

function stateFor(provider: string): ProviderState {
  let state = providerState.get(provider);
  if (!state) {
    state = { blocked: null };
    providerState.set(provider, state);
  }
  return state;
}

/** Test hook: clears the process wide block latch. */
export function resetRmfgProcessStateForTests(): void {
  for (const state of providerState.values()) {
    state.blocked = null;
  }
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
      // Polling skips the website review link, which RMFG would otherwise create.
      return { path: `${request.path}?include_review_link=false`, init: { method: "GET", headers } };
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
  const state = stateFor(PROVIDER_KEY);

  const transport: RmfgHttpTransport = Object.assign(
    async (request: RmfgQuoteRequest) => {
      if (state.blocked) return { status: BLOCKED_STATUS[state.blocked], body: null };
      if (options.isBlocked && (await options.isBlocked())) return { status: 403, body: null };
      if (state.blocked) return { status: BLOCKED_STATUS[state.blocked], body: null };
      const { path, init } = buildRequest(request, apiKey);
      const url = new URL(path, `${origin}/`);
      if (!path.startsWith("/") || url.origin !== origin || !allowedPath(request, url.pathname)) {
        return { status: 0, body: null };
      }
      const response = await doFetch(url, {
        ...init, redirect: "error", signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (response.status === 401 || response.status === 403) state.blocked = "authorization_required";
      // A payment, plan or terms demand is never answered by this client.
      if (response.status === 402) state.blocked = "account_action_required";
      if (response.status === 429) state.blocked = "rate_limited";
      // A body that never finished arriving (a timeout mid read) is a transport error, not a page.
      let text: string;
      try { text = await response.text(); } catch { return { status: 0, body: null }; }
      let body: unknown = null;
      try { body = JSON.parse(text); } catch { body = null; }
      return { status: response.status, body };
    },
    {
      blockedReason: () => state.blocked,
    },
  );
  return transport;
}
