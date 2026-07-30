import {
  MOBILE_AUTH_LIMITS,
  containsAsciiControlCharacters,
} from "./contract";

const RETURN_ROUTE_SEGMENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const ENCODED_OR_AMBIGUOUS_PATH_PATTERN = /[%\\?#]/;
const SINGLE_SEGMENT_ROUTES = new Set(["parts", "quotes", "search"]);
const RESOURCE_ROUTES = new Set(["parts", "quotes", "projects"]);

export class MobileAuthReturnRouteError extends Error {
  readonly code = "mobile_auth_invalid_request" as const;

  constructor() {
    super("The requested mobile return route is not allowed.");
    this.name = "MobileAuthReturnRouteError";
  }
}

function isSafeRouteSegment(segment: string): boolean {
  if (!RETURN_ROUTE_SEGMENT_PATTERN.test(segment)) {
    return false;
  }

  return segment !== "." && segment !== "..";
}

export function isAllowlistedMobileReturnRoute(value: string): boolean {
  if (
    value.length === 0 ||
    value.length > MOBILE_AUTH_LIMITS.returnRouteBytes ||
    containsAsciiControlCharacters(value) ||
    ENCODED_OR_AMBIGUOUS_PATH_PATTERN.test(value) ||
    !value.startsWith("/") ||
    value.startsWith("//") ||
    value.endsWith("/")
  ) {
    return false;
  }

  const segments = value.slice(1).split("/");

  if (segments.length === 1) {
    return SINGLE_SEGMENT_ROUTES.has(segments[0]);
  }

  if (segments.length !== 2 || !isSafeRouteSegment(segments[1])) {
    return false;
  }

  return RESOURCE_ROUTES.has(segments[0]);
}

/**
 * Returns an allowlisted in-app destination, defaulting omitted routes to the
 * quote workspace so authentication can resume the product's primary flow.
 */
export function parseMobileReturnRoute(value: string | null = "/quotes"): string {
  const candidate = value ?? "/quotes";

  if (!isAllowlistedMobileReturnRoute(candidate)) {
    throw new MobileAuthReturnRouteError();
  }

  return candidate;
}
