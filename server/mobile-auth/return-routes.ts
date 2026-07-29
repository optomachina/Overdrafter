import {
  MOBILE_AUTH_LIMITS,
  containsAsciiControlCharacters,
} from "./contract";

const RETURN_ROUTE_SEGMENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const ENCODED_OR_AMBIGUOUS_PATH_PATTERN = /[%\\?#]/;

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
    return segments[0] === "parts" || segments[0] === "quotes" || segments[0] === "search";
  }

  if (segments.length !== 2 || !isSafeRouteSegment(segments[1])) {
    return false;
  }

  return segments[0] === "parts" || segments[0] === "quotes" || segments[0] === "projects";
}

export function parseMobileReturnRoute(value: string | null | undefined): string {
  const candidate = value ?? "/quotes";

  if (!isAllowlistedMobileReturnRoute(candidate)) {
    throw new MobileAuthReturnRouteError();
  }

  return candidate;
}
