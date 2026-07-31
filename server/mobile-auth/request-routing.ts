import { isIP } from "node:net";
import { MOBILE_AUTH_PATHS } from "./contract.js";

export type MobileAuthAction =
  | "start"
  | "provider-callback"
  | "complete"
  | "callback"
  | "bootstrap"
  | "cleanup";

const API_PATH = "/api/mobile-auth";
const ACTION_BY_PATH = new Map<string, MobileAuthAction>([
  [MOBILE_AUTH_PATHS.start, "start"],
  [MOBILE_AUTH_PATHS.providerCallback, "provider-callback"],
  [MOBILE_AUTH_PATHS.complete, "complete"],
  [MOBILE_AUTH_PATHS.callback, "callback"],
  [MOBILE_AUTH_PATHS.bootstrap, "bootstrap"],
]);

const PATH_BY_ACTION = new Map<MobileAuthAction, string>([
  ["start", MOBILE_AUTH_PATHS.start],
  ["provider-callback", MOBILE_AUTH_PATHS.providerCallback],
  ["complete", MOBILE_AUTH_PATHS.complete],
  ["callback", MOBILE_AUTH_PATHS.callback],
  ["bootstrap", MOBILE_AUTH_PATHS.bootstrap],
  ["cleanup", API_PATH],
]);

export class MobileAuthRoutingError extends Error {
  readonly code = "mobile_auth_invalid_request" as const;

  constructor() {
    super("The mobile authentication route is invalid.");
    this.name = "MobileAuthRoutingError";
  }
}

function isAction(value: string): value is MobileAuthAction {
  return (
    value === "start" ||
    value === "provider-callback" ||
    value === "complete" ||
    value === "callback" ||
    value === "bootstrap" ||
    value === "cleanup"
  );
}

export interface ResolvedMobileAuthRoute {
  readonly action: MobileAuthAction;
  readonly publicUrl: URL;
}

/**
 * Accepts both Vercel's rewritten function URL and the original public URL.
 * The returned URL always uses the public contract path and excludes the
 * internal dispatcher parameter before strict endpoint parsing.
 */
export function resolveMobileAuthRoute(requestUrl: string | URL): ResolvedMobileAuthRoute {
  let url: URL;
  try {
    url = requestUrl instanceof URL ? new URL(requestUrl.toString()) : new URL(requestUrl);
  } catch {
    throw new MobileAuthRoutingError();
  }

  if (url.hash || url.username || url.password) {
    throw new MobileAuthRoutingError();
  }

  const actionValues = url.searchParams.getAll("action");
  if (actionValues.length > 1) {
    throw new MobileAuthRoutingError();
  }

  const pathAction = ACTION_BY_PATH.get(url.pathname);
  const queryActionValue = actionValues[0];
  const queryAction =
    queryActionValue !== undefined && isAction(queryActionValue) ? queryActionValue : undefined;

  if (queryActionValue !== undefined && !queryAction) {
    throw new MobileAuthRoutingError();
  }

  let action: MobileAuthAction;
  if (url.pathname === API_PATH && queryAction) {
    action = queryAction;
  } else if (pathAction && (!queryAction || queryAction === pathAction)) {
    action = pathAction;
  } else {
    throw new MobileAuthRoutingError();
  }

  if (action === "cleanup" && url.pathname !== API_PATH) {
    throw new MobileAuthRoutingError();
  }

  url.searchParams.delete("action");
  url.pathname = PATH_BY_ACTION.get(action) ?? API_PATH;

  return Object.freeze({ action, publicUrl: url });
}

/**
 * Returns only a platform-provided IP value suitable for pseudonymous rate
 * bucketing. Invalid or absent values collapse into one non-identifying bucket.
 */
export function readTrustedClientIp(headers: Headers): string {
  const forwarded = headers.get("x-vercel-forwarded-for");
  if (!forwarded || forwarded.length > 256) {
    return "unknown";
  }

  const candidate = forwarded.split(",", 1)[0]?.trim() ?? "";
  if (candidate.length === 0 || candidate.length > 64 || isIP(candidate) === 0) {
    return "unknown";
  }

  return candidate;
}
